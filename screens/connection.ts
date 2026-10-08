// A screen's connection, kept apart from the tab that borrows it (and LINGER after the last one let go), showing one
// rectangle of the picture (whole screen, an app's window, or zoomed), with faster JPEG and tile decoding than noVNC's.
import RFB from "@novnc/novnc"
import { report, unreport } from "./live"
import { Meter, type Summary } from "./meter"

export const REFUSED = 4003
export const UNREACHABLE = 4004
/** How long a connection no tab shows is kept. */
const LINGER = 10 * 60_000

export type Login = { username: string; password: string }
export type Status =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "login"; types: string[]; error?: string }
  | { kind: "error"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "closed"; reason: string; lost?: boolean }
  | { kind: "off" }
/** Part of the picture, in its pixels (perPoint: pixels per point of the Mac's screen). */
export type Crop = { x: number; y: number; w: number; h: number; perPoint: number }
type Point = { x: number; y: number }

/* noVNC's private parts this uses (pinned version: see novnc.d.ts). */
type Display = { _renderQ: unknown[]; _renderQPush(action: object): void; flip(fromQueue?: boolean): void
  imageRect(x: number, y: number, w: number, h: number, mime: string, data: Uint8Array): void; drawImage(img: CanvasImageSource, ...rest: number[]): void
  clipViewport: boolean; width: number; height: number; scale: number; _viewportLoc: { x: number; y: number; w: number; h: number }
  viewportChangeSize(w: number, h: number): void; viewportChangePos(dx: number, dy: number): void }
type CursorImage = { rgbaPixels: Uint8Array | Uint8ClampedArray; w: number; h: number; hotx: number; hoty: number }
type Decoder = { decodeRect(x: number, y: number, w: number, h: number, sock: unknown, display: unknown, depth: number): boolean }
type Internals = {
  _sock: object; _framebufferUpdate(): boolean; _decoders: Record<number, Decoder>
  _handleDataRect(): boolean; _FBU: { encoding: number | null }
  _display: Display; _canvas: HTMLCanvasElement; _updateClip(): void; _updateScale(): void; _screenSize(): { w: number; h: number }
  _setClippingViewport(on: boolean): void; _handleMouseButton(x: number, y: number, mask: number): void; _handleMouseMove(x: number, y: number): void
  _mouseButtonMask: number; _cursorImage: CursorImage; _refreshCursor(): void
  _cursor: { move(x: number, y: number): void; _hideCursor(): void; _hotSpot: Point }
}

const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/${path}`
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The arrow shown until the screen sends its own pointer (a Mac sends it only once it changes, so it would be
 *  invisible until the pointer passed over a link or a text field), as other VNC viewers do. */
const ARROW: CursorImage = (() => {
  const w = 13, h = 20, c = document.createElement("canvas")
  c.width = w; c.height = h
  const g = c.getContext("2d")
  if (!g) return { rgbaPixels: new Uint8Array(), w: 0, h: 0, hotx: 0, hoty: 0 }
  g.beginPath()
  for (const [x, y] of [[1, 1], [1, 16], [4.6, 12.6], [7, 18.5], [9.4, 17.5], [7, 11.8], [12, 11.8]]) g.lineTo(x, y)
  g.closePath()
  g.fillStyle = "#000"; g.fill()
  g.lineWidth = 1.2; g.strokeStyle = "#fff"; g.stroke()
  return { rgbaPixels: g.getImageData(0, 0, w, h).data, w, h, hotx: 1, hoty: 1 }
})()

/** Each noVNC socket's meter: noVNC's messages are shared functions taking the socket, wrapped once here to time update
 *  requests and input (not plain pointer moves, which change nothing on screen). */
const meters = new WeakMap<object, Meter>()
{
  const messages = (RFB as unknown as { messages: Record<string, (sock: object, ...rest: number[]) => void> }).messages
  const wrap = (name: string, mark: (m: Meter, rest: number[]) => void) => {
    const send = messages[name]
    if (typeof send !== "function") return
    messages[name] = function (this: unknown, sock: object, ...rest: number[]) {
      const m = meters.get(sock)
      if (m) mark(m, rest)
      return send.call(this, sock, ...rest)
    }
  }
  wrap("fbUpdateRequest", (m) => m.requested())
  wrap("keyEvent", (m) => m.inputSent())
  wrap("QEMUExtendedKeyEvent", (m) => m.inputSent())
  wrap("pointerEvent", (m, [, , mask]) => { if (mask) m.inputSent() })
  wrap("extendedPointerEvent", (m, [, , mask]) => { if (mask) m.inputSent() })
}
/** Per-device switches for comparing (.test/qa/screensbench.mjs), in localStorage: "screens:pipeline" = "off",
 *  "screens:depth" = n, "screens:images" = "novnc", "screens:tiles" = "novnc". */
const off = (key: string, value: string) => { try { return localStorage.getItem(key) === value } catch { return false } }
const pipelineOff = () => off("screens:pipeline", "off")
const depthAsked = () => { try { return Number(localStorage.getItem("screens:depth")) || 0 } catch { return 0 } }

/** What the benchmark (.test/qa/screensbench.mjs) and the console read: each connection's last seconds. */
;(globalThis as { __vauScreens?: (seconds?: number) => unknown }).__vauScreens = (seconds?: number) =>
  [...pool].map((c) => ({ id: c.id, screen: c.screen, status: c.status.kind, shown: c.shown, fb: c.fb, ...c.meter.summary(seconds), frames: c.meter.recent(seconds) }))

/** JPEG rectangles decoded off the main thread with createImageBitmap, rather than noVNC's base64 <img> per rectangle;
 *  what its render queue gets looks like the <img> it expects. */
type Pending = { complete: boolean; width: number; height: number; bitmap: ImageBitmap | null; failed: boolean
  waiting: (() => void)[]; addEventListener(type: string, f: () => void): void; removeEventListener(): void; src: string }
function fastImages(d: Display) {
  if (typeof createImageBitmap !== "function") return
  d.imageRect = (x, y, width, height, mime, data) => {
    if (!width || !height) return
    const img: Pending = { complete: false, width: 0, height: 0, bitmap: null, failed: false, waiting: [],
      addEventListener(_type, f) { this.waiting.push(f) },
      removeEventListener() {},
      set src(_: string) { this.bitmap?.close(); this.bitmap = null },
      get src() { return "" } }
    const done = () => { img.complete = true; for (const f of img.waiting.splice(0)) f.call(img) }
    createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime })).then((b) => {
      img.bitmap = b; img.width = b.width; img.height = b.height; done()
    }, () => { img.failed = true; img.width = width; img.height = height; done() })
    d._renderQPush({ type: "img", img, x, y, width, height })
  }
  const draw = d.drawImage.bind(d)
  d.drawImage = (img, ...rest) => {
    const p = img as unknown as Partial<Pending>
    if (!("waiting" in p)) return draw(img, ...rest)
    if (p.bitmap) draw(p.bitmap, ...rest)
  }
}

/** ZRLE and Hextile rectangles drawn into one buffer and put on the canvas once, rather than one putImageData per tile
 *  (hundreds per update: most of their decoding time). */
function wholeRects(r: Internals) {
  let pool = new Uint8Array(0)
  for (const enc of [5, 16]) {
    const dec = r._decoders[enc]
    if (!dec) continue
    const decode = dec.decodeRect.bind(dec)
    let rect: { x: number; y: number; w: number; h: number; buf: Uint8Array } | null = null
    const stage = {
      blitImage(tx: number, ty: number, tw: number, th: number, arr: Uint8Array, offset = 0) {
        if (!rect) return
        const { x, y, w, buf } = rect, row = tw * 4
        for (let j = 0; j < th; j++) buf.set(arr.subarray(offset + j * row, offset + (j + 1) * row), ((ty - y + j) * w + (tx - x)) * 4)
      },
      fillRect(tx: number, ty: number, tw: number, th: number, color: ArrayLike<number>) {
        if (!rect) return
        const { x, y, w, buf } = rect
        const c = (255 << 24) | (color[2] << 16) | (color[1] << 8) | color[0]
        const px = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2)
        for (let j = 0; j < th; j++) { const at = (ty - y + j) * w + (tx - x); px.fill(c, at, at + tw) }
      },
    }
    dec.decodeRect = (x, y, w, h, sock, display, depth) => {
      if (!rect || rect.x !== x || rect.y !== y || rect.w !== w || rect.h !== h) {
        if (pool.length < w * h * 4) pool = new Uint8Array(w * h * 4)
        rect = { x, y, w, h, buf: pool.subarray(0, w * h * 4) }
      }
      const done = decode(x, y, w, h, sock, stage, depth)
      if (done) {
        (display as Display & { blitImage(x: number, y: number, w: number, h: number, a: Uint8Array, o: number, q: boolean): void }).blitImage(x, y, w, h, rect.buf, 0, false)
        rect = null
      }
      return done
    }
  }
}

/** Logins typed on this page, by screen (memory only: gone when the page is). */
const typed = new Map<string, Login>()
const pool = new Set<Conn>()
let ids = 1

/** A connection for a tab to show: one of this screen's no tab shows (the newest), else a new one. */
export function acquire(screen: string): Conn {
  const idle = [...pool].filter((c) => c.screen === screen && !c.shown).sort((a, b) => b.left - a.left)[0]
  if (idle) { idle.take(); return idle }
  const c = new Conn(screen)
  pool.add(c)
  c.take()
  return c
}

// A phone coming back to the page (iOS drops sockets while it's away): the connections a tab shows connect again.
if (typeof document !== "undefined") {
  const back = () => { if (!document.hidden) for (const c of pool) if (c.shown && c.status.kind === "closed" && c.status.lost) c.connect() }
  document.addEventListener("visibilitychange", back)
  window.addEventListener("online", back)
}

export class Conn {
  readonly id = ids++
  readonly screen: string
  /** What noVNC draws into; a tab puts it in its pane. */
  readonly host = document.createElement("div")
  status: Status = { kind: "connecting" }
  /** The picture's size, in its pixels. */
  fb = { w: 0, h: 0 }
  since = 0
  shown = false
  /** When the last tab let go of it. */
  left = 0
  crop: Crop | null = null
  zoom = 1
  center: Point = { x: 0, y: 0 }
  /** Where the pointer is, in the picture's pixels (the trackpad moves it). */
  pointer: Point = { x: 0, y: 0 }
  /** How fast it is (meter.ts): new for each connection. */
  meter = new Meter()
  /** Whether the stats overlay wants the relay's numbers too. */
  private statsWanted = false
  private rfb: RFB | null = null
  private ws: WebSocket | null = null
  private attempt = 0
  private retry = 0
  private login: Login | null = null
  private keep = false
  private linger = 0
  private subs = new Set<() => void>()
  private version = 0

  constructor(screen: string) {
    this.screen = screen
    this.host.style.cssText = "position:absolute;inset:0"
    this.connect()
  }

  // --- for React (useSyncExternalStore)
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f) } }
  snapshot = () => this.version
  private changed() {
    this.version++
    for (const f of this.subs) f()
    report({ id: this.id, screen: this.screen, shown: this.shown, since: this.since, end: () => this.end(),
      state: this.status.kind === "connected" ? "connected" : this.status.kind === "connecting" ? "connecting" : this.status.kind === "login" ? "login" : "closed" })
  }
  private set(status: Status) {
    this.status = status
    this.changed()
  }

  // --- tabs borrow it
  take() {
    clearTimeout(this.linger)
    this.shown = true
    this.changed()
  }
  /** The tab let go: kept a while (unless it's not connected: then it goes at once). */
  release() {
    this.shown = false
    this.left = Date.now()
    this.zoom = 1
    ;(this.rfb as unknown as Internals | null)?._cursor._hideCursor()
    if (this.status.kind !== "connected" && this.status.kind !== "connecting") return this.dispose()
    clearTimeout(this.linger)
    this.linger = window.setTimeout(() => this.dispose(), LINGER)
    this.changed()
  }
  /** Draw in `el` (the tab's box). */
  attach(el: HTMLElement) {
    if (this.host.parentNode !== el) el.appendChild(this.host)
    requestAnimationFrame(() => this.layout())
  }
  detach(el: HTMLElement) {
    if (this.host.parentNode === el) this.host.remove()
  }
  private dispose() {
    clearTimeout(this.linger)
    this.teardown()
    pool.delete(this)
    unreport(this.id)
  }

  // --- the connection: the socket first says where it got (a login it remembers), then noVNC takes it over
  connect() {
    this.teardown()
    const attempt = ++this.attempt
    const live = () => attempt === this.attempt
    this.set({ kind: "connecting" })
    const ws = new WebSocket(wsUrl(`screens/vnc/${encodeURIComponent(this.screen)}${pipelineOff() ? "?pipeline=0" : depthAsked() ? `?depth=${depthAsked()}` : ""}`))
    ws.binaryType = "arraybuffer"
    this.ws = ws
    let started = false
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || !live()) return
      let msg: { t?: string; reason?: string; login?: Login | null }
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.t === "refused") this.set({ kind: "refused", reason: msg.reason ?? "" })
      else if (msg.t === "error") this.set({ kind: "error", reason: msg.reason ?? "" })
      else if (msg.t === "ready") {
        started = true
        this.login = typed.get(this.screen) ?? msg.login ?? null
        this.start(ws, live)
      }
    }
    ws.onclose = (e) => {
      if (!live() || started || e.code === REFUSED || e.code === UNREACHABLE) return
      this.set({ kind: "closed", reason: "couldn't reach the server", lost: true })
    }
  }

  private start(ws: WebSocket, live: () => boolean) {
    const rfb = new RFB(this.host, ws, { shared: true, credentials: this.login ?? undefined })
    this.rfb = rfb
    const r = rfb as unknown as Internals
    this.measure(ws, r)
    r._updateClip = () => this.layout()
    r._updateScale = () => {}
    rfb.resizeSession = false
    rfb.background = "transparent"
    rfb.focusOnClick = true
    r._cursorImage = ARROW
    r._refreshCursor()
    const used = this.login
    rfb.addEventListener("connect", () => {
      if (!live()) return
      this.retry = 0
      this.since = Date.now()
      if (this.keep && this.login && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "remember", ...this.login }))
      if (this.keep && this.login) typed.set(this.screen, this.login)
      this.keep = false
      this.sized()
      this.pointer = { x: this.fb.w / 2, y: this.fb.h / 2 }
      this.set({ kind: "connected" })
    })
    rfb.addEventListener("credentialsrequired", (e) => {
      if (!live()) return
      const types = (e as CustomEvent<{ types: string[] }>).detail.types
      if (this.login && this.login !== used) rfb.sendCredentials(this.login)
      else this.set({ kind: "login", types })
    })
    rfb.addEventListener("securityfailure", (e) => {
      if (!live()) return
      const reason = (e as CustomEvent<{ reason?: string }>).detail.reason
      this.login = null
      typed.delete(this.screen)
      this.set({ kind: "login", types: ["username", "password"],
        error: !reason || /authentication|authorization/i.test(reason) ? "That user name and password didn't work." : reason })
    })
    rfb.addEventListener("desktopname", () => { if (live()) this.sized() })
    rfb.addEventListener("clipboard", (e) => {
      const text = (e as CustomEvent<{ text: string }>).detail.text
      navigator.clipboard?.writeText(text).catch(() => {})
    })
    rfb.addEventListener("disconnect", (e) => {
      if (!live()) return
      this.rfb = null
      const clean = (e as CustomEvent<{ clean: boolean }>).detail.clean
      const was = this.status.kind
      if (was === "login" || was === "off") return
      // Lost while shown: try again (a phone's network changing); lost in the background: let it go.
      if (!clean && was === "connected" && this.shown && this.retry++ < 3) {
        this.set({ kind: "connecting" })
        window.setTimeout(() => { if (live()) this.connect() }, 1000 * this.retry)
        return
      }
      this.set(clean ? { kind: "closed", reason: "the screen ended the session" } : { kind: "closed", reason: "the connection was lost", lost: true })
      if (!this.shown) this.dispose()
    })
  }

  /** Hooks noVNC to measure it (meter.ts), and takes the relay's text messages (its stats) off what noVNC reads. */
  private measure(ws: WebSocket, r: Internals) {
    const m = (this.meter = new Meter())
    meters.set(r._sock, m)
    const read = ws.onmessage
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        try { const msg = JSON.parse(e.data); if (msg.t === "stats") { delete msg.t; m.relay = msg; m.ahead = msg.ahead ?? 0 } } catch { /* not ours */ }
        return
      }
      m.bytesIn += (e.data as ArrayBuffer).byteLength
      read?.call(ws, e)
    }
    // An update from its first byte to its end, and noVNC's decoding time; on screen when its flip runs (at its end, or
    // later from noVNC's render queue).
    const update = r._framebufferUpdate.bind(r)
    let within = false, flipped = false
    r._framebufferUpdate = () => {
      if (!within) { within = true; m.begin() }
      const t = performance.now()
      const done = update()
      m.spent(performance.now() - t)
      if (done) {
        within = false
        m.end()
        if (flipped) { flipped = false; m.painted() }
      }
      return done
    }
    const d = r._display, flip = d.flip.bind(d)
    d.flip = (fromQueue?: boolean) => {
      const queued = !fromQueue && d._renderQ.length !== 0
      flip(fromQueue)
      if (fromQueue) m.painted()
      else if (within && !queued) flipped = true
    }
    if (!off("screens:images", "novnc")) fastImages(d)
    if (!off("screens:tiles", "novnc")) wholeRects(r)
    const rect = r._handleDataRect.bind(r)
    r._handleDataRect = () => {
      const enc = r._FBU.encoding
      const done = rect()
      if (done && enc !== null) m.rect(enc)
      return done
    }
    if (this.statsWanted) this.wantStats(true)
  }
  /** The stats overlay is up: the relay sends its numbers every second (meter.relay). */
  wantStats(on: boolean) {
    this.statsWanted = on
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "stats", on }))
  }
  stats(): Summary { return this.meter.summary() }

  private teardown() {
    this.attempt++
    const rfb = this.rfb, ws = this.ws
    this.rfb = null
    this.ws = null
    rfb?.disconnect()
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
    this.host.replaceChildren()
  }

  /** The user ended it: the tab says so, and can connect again. */
  end() {
    if (this.status.kind === "off") return
    this.teardown()
    this.set({ kind: "off" })
    if (!this.shown) this.dispose()
  }

  /** The login form's answer. */
  submit(login: Login, remember: boolean) {
    this.login = login
    this.keep = remember
    typed.set(this.screen, login)
    if (this.rfb) { this.set({ kind: "connecting" }); this.rfb.sendCredentials(login) } else this.connect()
  }

  /** The picture's size changed (a Mac's resolution switched). */
  sized() {
    const d = (this.rfb as unknown as Internals | null)?._display
    if (!d || (d.width === this.fb.w && d.height === this.fb.h)) return
    this.fb = { w: d.width, h: d.height }
    this.changed()
    this.layout()
  }

  // --- what's shown
  /** The rectangle zoom 1 shows: the app's window, or the whole picture. */
  private base(d: Display): Crop {
    return this.crop ?? { x: 0, y: 0, w: d.width, h: d.height, perPoint: 0 }
  }
  /** The scale that fits the base in the pane (a small window stays its own size: a point of it is a CSS pixel). */
  private fit(d: Display, size: { w: number; h: number }) {
    const b = this.base(d)
    const fit = Math.min(size.w / b.w, size.h / b.h)
    return b.perPoint && fit > 1 / b.perPoint ? 1 / b.perPoint : fit
  }
  maxZoom() {
    const r = this.rfb as unknown as Internals | null
    if (!r?._display.width) return 1
    return Math.max(1, 3 / this.fit(r._display, r._screenSize()))
  }

  /** Show what crop and zoom say, fitted to the pane. */
  layout() {
    const r = this.rfb as unknown as Internals | null
    if (!r) return
    const d = r._display, size = r._screenSize()
    if (!d.width || !d.height || !size.w || !size.h) return
    const b = this.base(d)
    this.zoom = clamp(this.zoom, 1, this.maxZoom())
    const scale = this.fit(d, size) * this.zoom
    const vw = Math.min(b.w, size.w / scale), vh = Math.min(b.h, size.h / scale)
    this.center = { x: clamp(this.center.x, b.x + vw / 2, b.x + b.w - vw / 2), y: clamp(this.center.y, b.y + vh / 2, b.y + b.h - vh / 2) }
    if (!d.clipViewport) d.clipViewport = true
    d.viewportChangeSize(vw, vh)
    const vp = d._viewportLoc
    d.viewportChangePos(this.center.x - vw / 2 - vp.x, this.center.y - vh / 2 - vp.y)
    r._setClippingViewport(false)
    d.scale = scale
  }
  setCrop(crop: Crop | null) {
    const same = (a: Crop | null, b: Crop | null) => a === b || !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
    if (same(crop, this.crop)) return
    if (!!crop !== !!this.crop) this.zoom = 1
    this.crop = crop
    this.layout()
  }

  /** Zoom by `factor` keeping the point under (clientX, clientY) where it is. */
  zoomAt(factor: number, clientX: number, clientY: number) {
    const r = this.rfb as unknown as Internals | null
    if (!r?._display.width) return
    const d = r._display, size = r._screenSize(), box = r._canvas.parentElement!.getBoundingClientRect()
    const p = this.toFb(clientX, clientY)
    const zoom = clamp(this.zoom * factor, 1, this.maxZoom())
    const b = this.base(d), scale = this.fit(d, size) * zoom
    const vw = Math.min(b.w, size.w / scale), vh = Math.min(b.h, size.h / scale)
    const left = box.left + (size.w - vw * scale) / 2, top = box.top + (size.h - vh * scale) / 2
    this.zoom = zoom
    this.center = { x: p.x - (clientX - left) / scale + vw / 2, y: p.y - (clientY - top) / scale + vh / 2 }
    this.layout()
    this.changed()
  }
  /** Move what's shown with a finger (dx, dy in CSS pixels). */
  panBy(dx: number, dy: number) {
    const d = (this.rfb as unknown as Internals | null)?._display
    if (!d || this.zoom <= 1) return
    this.center = { x: this.center.x - dx / d.scale, y: this.center.y - dy / d.scale }
    this.layout()
  }
  resetZoom() {
    this.zoom = 1
    this.layout()
    this.changed()
  }
  /** Keep a point of the picture in view (the trackpad's pointer, when zoomed in), with a margin. */
  follow(p: Point) {
    const d = (this.rfb as unknown as Internals | null)?._display
    if (!d || this.zoom <= 1) return
    const vp = d._viewportLoc, mx = vp.w * 0.12, my = vp.h * 0.12
    let { x, y } = this.center
    if (p.x < vp.x + mx) x -= vp.x + mx - p.x
    else if (p.x > vp.x + vp.w - mx) x += p.x - (vp.x + vp.w - mx)
    if (p.y < vp.y + my) y -= vp.y + my - p.y
    else if (p.y > vp.y + vp.h - my) y += p.y - (vp.y + vp.h - my)
    if (x === this.center.x && y === this.center.y) return
    this.center = { x, y }
    this.layout()
  }

  // --- input (phones: touch.ts)
  /** A point on the page, in the picture's pixels. */
  toFb(clientX: number, clientY: number): Point {
    const r = this.rfb as unknown as Internals | null
    if (!r) return { x: 0, y: 0 }
    const rect = r._canvas.getBoundingClientRect(), d = r._display
    return { x: (clientX - rect.left) / (d.scale || 1) + d._viewportLoc.x, y: (clientY - rect.top) / (d.scale || 1) + d._viewportLoc.y }
  }
  toClient(p: Point): Point {
    const r = this.rfb as unknown as Internals | null
    if (!r) return { x: 0, y: 0 }
    const rect = r._canvas.getBoundingClientRect(), d = r._display
    return { x: rect.left + (p.x - d._viewportLoc.x) * d.scale, y: rect.top + (p.y - d._viewportLoc.y) * d.scale }
  }
  /** The bounds the pointer stays in: the app's window, or the whole picture. */
  bounds(): Crop {
    const d = (this.rfb as unknown as Internals | null)?._display
    return d ? this.base(d) : { x: 0, y: 0, w: 0, h: 0, perPoint: 0 }
  }
  /** Move the pointer to `p` (picture pixels) with these buttons held (1 left, 4 right; 0 none). */
  move(p: Point, buttons?: number) {
    const r = this.rfb as unknown as Internals | null
    if (!r) return
    const b = this.bounds()
    this.pointer = { x: clamp(p.x, b.x, b.x + b.w - 1), y: clamp(p.y, b.y, b.y + b.h - 1) }
    const d = r._display, ex = (this.pointer.x - d._viewportLoc.x) * d.scale, ey = (this.pointer.y - d._viewportLoc.y) * d.scale
    if (buttons === undefined || buttons === r._mouseButtonMask) r._handleMouseMove(ex, ey)
    else r._handleMouseButton(ex, ey, buttons)
  }
  /** Press and let go of a button where the pointer is. */
  click(button = 1) {
    this.move(this.pointer, button)
    this.move(this.pointer, 0)
  }
  /** Scroll where the pointer is: `steps` notches (positive: down / right). */
  scroll(dy: number, dx = 0) {
    for (let i = 0; i < Math.abs(dy); i++) { this.move(this.pointer, dy > 0 ? 0x10 : 0x8); this.move(this.pointer, 0) }
    for (let i = 0; i < Math.abs(dx); i++) { this.move(this.pointer, dx > 0 ? 0x40 : 0x20); this.move(this.pointer, 0) }
  }
  /** Draw the screen's pointer where it is (phones: noVNC draws it itself only for its own touch handling). */
  showPointer() {
    const r = this.rfb as unknown as Internals | null
    if (!r || this.status.kind !== "connected") return
    const c = this.toClient(this.pointer)
    r._cursor.move(c.x - r._cursor._hotSpot.x, c.y - r._cursor._hotSpot.y)
  }
  hidePointer() {
    (this.rfb as unknown as Internals | null)?._cursor._hideCursor()
  }

  // --- the rest of what a tab does with it
  focus() { this.rfb?.focus({ preventScroll: true }) }
  sendKey(keysym: number, code: string | null, down?: boolean) { this.rfb?.sendKey(keysym, code, down) }
  paste(text: string) { this.rfb?.clipboardPasteFrom(text) }
  /** The picture's pixels per CSS pixel now (for the trackpad's speed). */
  scale() { return (this.rfb as unknown as Internals | null)?._display.scale || 1 }
}
