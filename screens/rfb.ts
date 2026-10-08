// The relay reads a VNC connection along (forwarding every byte) to ask for the next update ahead of the page: else one
// update per round trip. At most DEPTH updates and BYTES on their way; anything it can't read turns it off (a plain relay).

/** How many updates, and how many of their bytes, may be on their way to the page, unanswered, while the relay asks for
 *  more (.test/qa/screensbench.mjs: 4 covers a 60 ms link at 60 updates a second; 2 already doubles a nearby one). */
export const DEPTH = 4
export const BYTES = 384 << 10

/** What the parser asks for: n bytes to read, or n to skip. */
type Need = { read: number } | { skip: number }
type Parser = Generator<Need, void, Buffer>

const ENC = { raw: 0, copyRect: 1, rre: 2, hextile: 5, zlib: 6, tight: 7, zrle: 16, tightPng: -260, h264: 50,
  desktopSize: -223, lastRect: -224, cursor: -239, xcursor: -240, qemuKey: -258, qemuLed: -261, desktopName: -307,
  extDesktopSize: -308, xvp: -309, fence: -312, continuous: -313, extMouse: -316, vmwareCursor: 0x574d5664 }

export class Unreadable extends Error {}

/** Counters the stats overlay shows (plugin.ts adds its own). */
export type PumpStats = { frames: number; ahead: number; acks: number; inflight: number; pipeline: boolean; why: string
  /** From a request reaching the server to its update's first byte, ms (the screen encoding it, or waiting for a change). */
  serverMs: number }

export class Pump {
  /** Bytes from the server so far, and where ServerInit starts (the last one-byte client message). */
  private down = 0
  private initAt = -1
  /** The server's bytes kept until parsing starts (the handshake: small). */
  private early: Buffer[] = []
  private earlyLen = 0
  private parser: Parser | null = null
  private need: Need | null = null
  private pending: Buffer[] = []
  private pendingLen = 0
  private bpp = 4
  private tpixel = 3
  /** The screen's size (ServerInit, then DesktopSize). */
  private fbW = 0
  private fbH = 0
  /** Where the parser is in the server's bytes, and where the last update ended: what's between is never much bigger
   *  than the whole screen as raw pixels (a check that it still reads the stream right). */
  private pos = 0
  private lastEnd = 0
  /** The sizes of the updates on their way to the page, oldest first. */
  private flying: number[] = []
  private on = true
  private armed = false
  /** The request the relay sends: the page's own, as incremental. */
  private request: Buffer | null = null
  stats: PumpStats = { frames: 0, ahead: 0, acks: 0, inflight: 0, pipeline: false, why: "starting", serverMs: 0 }
  /** When the request the server is answering went to it. */
  private askedAt = 0

  /** `send` writes to the VNC server; `room` says whether the page's socket has room for more (backpressure). */
  private send: (buf: Buffer) => void
  private room: () => boolean
  /** How many updates may be on their way (DEPTH unless the page asks for another, to compare). */
  private depth: number
  constructor(send: (buf: Buffer) => void, room: () => boolean, depth = DEPTH) {
    this.send = send
    this.room = room
    this.depth = depth
  }

  /** Bytes from the server, read along (they're forwarded as they are, whatever this does). */
  fromServer(chunk: Buffer) {
    if (!this.on) return
    try {
      if (!this.parser) {
        this.down += chunk.length
        this.early.push(chunk)
        this.earlyLen += chunk.length
        if (this.earlyLen > 1 << 20) this.off("the handshake was longer than expected")
        return
      }
      this.feed(chunk)
    } catch (e) {
      this.off(e instanceof Unreadable ? e.message : `couldn't read the screen's messages (${(e as Error).message})`)
    }
  }

  /** A message from the page: whether to pass it on to the server (false: the relay answered it). */
  fromClient(buf: Buffer): boolean {
    if (!this.on) return true
    try {
      return this.client(buf)
    } catch (e) {
      this.off(e instanceof Unreadable ? e.message : `couldn't read the page's messages (${(e as Error).message})`)
      return true
    }
  }
  private client(buf: Buffer): boolean {
    if (!this.parser) {
      if (buf.length === 1) this.initAt = this.down
      else if (buf.length === 20 && buf[0] === 0 && this.initAt >= 0) this.begin(buf)
      return true
    }
    if (buf.length === 20 && buf[0] === 0) this.pixelFormat(buf)
    if (buf.length !== 10 || buf[0] !== 3) return true
    const incremental = buf[1] !== 0
    this.request = Buffer.from(buf)
    this.request[1] = 1
    if (!incremental) { this.armed = true; this.askedAt ||= Date.now(); return true }
    // The page finished an update and asks for the next: it has caught up by one.
    this.stats.acks++
    this.flying.shift()
    this.stats.inflight = this.flying.length
    if (this.armed) return false
    this.armed = true
    this.askedAt ||= Date.now()
    return true
  }

  /** The page's socket drained: ask again if it was holding back. */
  drained() { if (this.on && this.parser) this.arm() }

  private arm() {
    if (this.armed || !this.request || this.flying.length >= this.depth || !this.room()) return
    if (this.flying.reduce((a, b) => a + b, 0) >= BYTES) return
    this.armed = true
    this.askedAt ||= Date.now()
    this.stats.ahead++
    this.send(this.request)
  }

  private off(why: string) {
    if (!this.on) return
    this.on = false
    this.stats.pipeline = false
    this.stats.why = why
    this.parser = null
    this.early = []
    this.pending = []
    // The page may be waiting on a request the relay kept: send one, and it goes on as a plain relay.
    if (this.request) this.send(this.request)
  }

  private pixelFormat(buf: Buffer) {
    const bpp = buf[4], depth = buf[5]
    if (![8, 16, 32].includes(bpp)) throw new Unreadable(`a pixel format of ${bpp} bits`)
    this.bpp = bpp / 8
    this.tpixel = bpp === 32 && depth === 24 ? 3 : this.bpp
  }

  // Parsing starts at noVNC's SetPixelFormat: the server's bytes since the last one-byte client message (ClientInit) are
  // ServerInit, then normal messages; each noVNC message is one WebSocket message.
  private begin(setPixelFormat: Buffer) {
    const all = Buffer.concat(this.early)
    const from = this.initAt - (this.down - all.length)
    this.early = []
    if (from < 0 || from > all.length) return this.off("lost track of the handshake")
    this.pixelFormat(setPixelFormat)
    this.parser = this.messages()
    this.need = this.parser.next().value as Need
    this.stats.pipeline = true
    this.stats.why = ""
    this.feed(all.subarray(from))
  }

  /** Runs the parser over a chunk: hands it what it asked for, as it comes. */
  private feed(chunk: Buffer) {
    const base = this.pos
    if (this.fbW && base + chunk.length - this.lastEnd > this.fbW * this.fbH * 8 + (8 << 20)) throw new Unreadable("lost track of the screen's messages")
    let at = 0
    while (this.parser && this.need) {
      this.pos = base + at
      const need = this.need
      if ("skip" in need) {
        const n = Math.min(need.skip, chunk.length - at)
        at += n
        need.skip -= n
        if (need.skip > 0) break
        this.pos = base + at
        this.step(Buffer.alloc(0))
        continue
      }
      const want = need.read - this.pendingLen
      const n = Math.min(want, chunk.length - at)
      if (n > 0) { this.pending.push(chunk.subarray(at, at + n)); this.pendingLen += n; at += n }
      if (this.pendingLen < need.read) break
      this.pos = base + at
      const got = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending)
      this.pending = []
      this.pendingLen = 0
      this.step(got)
    }
    this.pos = base + chunk.length
  }
  private step(buf: Buffer) {
    const r = this.parser!.next(buf)
    if (r.done) throw new Unreadable("the parser stopped")
    this.need = r.value
  }

  /** An update was read to its end: it's on its way to the page; ask for the next if there's room. */
  private updated() {
    this.flying.push(this.pos - this.lastEnd)
    this.lastEnd = this.pos
    this.stats.frames++
    this.armed = false
    this.stats.inflight = this.flying.length
    this.arm()
  }

  // --- the server's messages (RFC 6143 and the extensions noVNC asks for)
  private *messages(): Parser {
    const init = yield { read: 24 }
    this.fbW = init.readUInt16BE(0)
    this.fbH = init.readUInt16BE(2)
    const name = init.readUInt32BE(20)
    if (name > 1 << 20) throw new Unreadable("a ServerInit it can't read")
    yield { skip: name }
    for (;;) {
      const type = (yield { read: 1 })[0]
      if (type === 0) yield* this.update()
      else if (type === 1) { const h = yield { read: 5 }; yield { skip: h.readUInt16BE(3) * 6 } }
      else if (type === 2) continue
      else if (type === 3) { const h = yield { read: 7 }; yield { skip: Math.abs(h.readInt32BE(3)) } }
      else if (type === 150) throw new Unreadable("the screen sends updates by itself (continuous updates)")
      else if (type === 248) { const h = yield { read: 8 }; yield { skip: h[7] } }
      else if (type === 250) yield { skip: 3 }
      else throw new Unreadable(`a message of type ${type}`)
    }
  }

  private *update(): Parser {
    if (this.askedAt) {
      const ms = Date.now() - this.askedAt
      this.stats.serverMs = this.stats.serverMs ? Math.round(this.stats.serverMs * 0.8 + ms * 0.2) : ms
      this.askedAt = 0
    }
    const h = yield { read: 3 }
    let rects = h.readUInt16BE(1)
    while (rects-- > 0) {
      const r = yield { read: 12 }
      const w = r.readUInt16BE(4), hh = r.readUInt16BE(6), enc = r.readInt32BE(8)
      if (enc === ENC.lastRect) break
      yield* this.rect(enc, w, hh)
    }
    this.updated()
  }

  /** A compact length (Tight's): 1 to 3 bytes, 7 bits each. */
  private *compact(): Generator<Need, number, Buffer> {
    let n = 0
    for (let i = 0; i < 3; i++) {
      const b = (yield { read: 1 })[0]
      n |= (i < 2 ? b & 0x7f : b) << (7 * i)
      if (i < 2 && !(b & 0x80)) break
    }
    return n
  }

  /** A length the screen sent for a rectangle's data, checked: compressed, it's never much more than raw. */
  private len(n: number, w: number, h: number) {
    if (n > w * h * 8 + 65536) throw new Unreadable("lost track of the screen's messages")
    return n
  }

  private *rect(enc: number, w: number, h: number): Parser {
    const bpp = this.bpp
    if (enc >= 0 && enc < 0x1000 && (w > this.fbW || h > this.fbH)) throw new Unreadable("a rectangle bigger than the screen")
    switch (enc) {
      case ENC.raw: yield { skip: w * h * bpp }; return
      case ENC.copyRect: yield { skip: 4 }; return
      case ENC.rre: { const n = (yield { read: 4 }).readUInt32BE(0); yield { skip: bpp + n * (bpp + 8) }; return }
      case ENC.hextile: yield* this.hextile(w, h); return
      case ENC.zlib: case ENC.zrle: { const n = (yield { read: 4 }).readUInt32BE(0); yield { skip: this.len(n, w, h) }; return }
      case ENC.tight: case ENC.tightPng: yield* this.tight(w, h, enc === ENC.tightPng); return
      case ENC.h264: { const n = (yield { read: 8 }).readUInt32BE(0); yield { skip: this.len(n, w, h) }; return }
      case ENC.cursor: yield { skip: w * h * bpp + Math.floor((w + 7) / 8) * h }; return
      case ENC.xcursor: if (w * h) yield { skip: 6 + Math.floor((w + 7) / 8) * h * 2 }; return
      case ENC.vmwareCursor: { const t = (yield { read: 2 })[0]; yield { skip: t === 0 ? w * h * 8 : w * h * 4 }; return }
      case ENC.qemuLed: yield { skip: 1 }; return
      case ENC.extDesktopSize: { const n = (yield { read: 4 })[0]; yield { skip: n * 16 }; this.resized(w, h); return }
      case ENC.desktopName: { const n = (yield { read: 4 }).readUInt32BE(0); yield { skip: n }; return }
      case ENC.desktopSize: this.resized(w, h); return
      case ENC.qemuKey: case ENC.xvp: case ENC.fence: case ENC.extMouse: return
      case ENC.continuous: throw new Unreadable("the screen sends updates by itself (continuous updates)")
      default: throw new Unreadable(`a rectangle encoded as ${enc}`)
    }
  }

  private resized(w: number, h: number) {
    if (w && h) { this.fbW = w; this.fbH = h }
  }

  private *hextile(w: number, h: number): Parser {
    const bpp = this.bpp
    for (let y = 0; y < h; y += 16) {
      for (let x = 0; x < w; x += 16) {
        const tw = Math.min(16, w - x), th = Math.min(16, h - y)
        const sub = (yield { read: 1 })[0]
        if (sub & 1) { yield { skip: tw * th * bpp }; continue }
        let n = (sub & 2 ? bpp : 0) + (sub & 4 ? bpp : 0)
        if (n) yield { skip: n }
        if (sub & 8) {
          n = (yield { read: 1 })[0]
          yield { skip: n * ((sub & 16 ? bpp : 0) + 2) }
        }
      }
    }
  }

  private *tight(w: number, h: number, png: boolean): Parser {
    const ctl = (yield { read: 1 })[0] >> 4
    const tp = this.tpixel
    if (ctl === 8) { yield { skip: tp }; return }
    if (ctl === 9 || (png && ctl === 10)) { yield { skip: this.len(yield* this.compact(), w, h) }; return }
    if (ctl & 8) throw new Unreadable(`a Tight rectangle of kind ${ctl}`)
    const filter = ctl & 4 ? (yield { read: 1 })[0] : 0
    let size: number
    if (filter === 1) {
      const colors = (yield { read: 1 })[0] + 1
      yield { skip: colors * tp }
      size = Math.floor((w * (colors <= 2 ? 1 : 8) + 7) / 8) * h
    } else if (filter === 0 || filter === 2) size = w * h * tp
    else throw new Unreadable(`a Tight filter ${filter}`)
    if (!size) return
    yield { skip: size < 12 ? size : this.len(yield* this.compact(), w, h) }
  }
}
