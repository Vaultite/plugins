// How fast a screen's connection is: each update from first byte to decoded, its wait, script time, bytes, encodings,
// and input-to-update time. Shown by Screen.tsx's overlay; .test/qa/screensbench.mjs reads window.__vauScreens().

/** One screen update, as measured. Times in ms. */
/** `input`: when the first input before it was sent, then (once drawn) the time from it to the update on screen. */
type Frame = { t: number; wait: number | null; span: number; js: number; bytes: number; rects: number; input: number | null
  /** When it was drawn (its pictures decoded and on the canvas), or null while it isn't yet. */
  shown: number | null; start: number }

/** The last seconds of a connection, summed up. */
export type Summary = {
  seconds: number
  fps: number
  /** Kilobytes a second from the screen. */
  kbps: number
  /** From an update asked for to its first byte (the round trip plus the screen's encoding): median, 95th. */
  wait: [number, number] | null
  /** From an update's first byte to its last decoded (its transfer and decoding). */
  span: [number, number]
  /** From an update's first byte to it on screen (its pictures decoded and drawn too). */
  draw: [number, number] | null
  /** Script time per update (noVNC decoding it). */
  js: number
  /** The time between updates: median, 95th (how even they come). */
  gap: [number, number] | null
  /** From input sent to the next update on screen: median, 95th. */
  input: [number, number] | null
  /** Rectangles by encoding, most used first: "tight 82%, copyrect 18%". */
  encodings: string
  /** Average bytes per update. */
  frameKb: number
  /** Updates the relay asked for ahead of the page (plugin.ts: the server's pipeline). */
  ahead: number
  /** The relay's own numbers (plugin.ts sends them every second while stats are wanted). */
  relay?: Record<string, number | string | boolean>
}

const KEEP = 4000
const ENC: Record<number, string> = { 0: "raw", 1: "copyrect", 2: "rre", 5: "hextile", 6: "zlib", 7: "tight", [-260]: "tightpng", 16: "zrle", 21: "jpeg", 50: "h264" }

const quantiles = (xs: number[]): [number, number] | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return [s[Math.floor((s.length - 1) * 0.5)], s[Math.floor((s.length - 1) * 0.95)]]
}

export class Meter {
  bytesIn = 0
  bytesOut = 0
  ahead = 0
  relay: Summary["relay"]
  private frames: Frame[] = []
  private encs = new Map<number, number>()
  private start = 0
  private startBytes = 0
  private js = 0
  private rects = 0
  private asked: number | null = null
  private input: number | null = null

  /** An update was asked for (noVNC asks for the next one when it finished the last). */
  requested() { if (this.asked === null) this.asked = performance.now() }
  /** Input went to the screen: the next update is timed from the first input since the last update. */
  inputSent() { if (this.input === null) this.input = performance.now() }
  /** An update's first byte came. */
  begin() {
    this.start = performance.now()
    this.startBytes = this.bytesIn
    this.js = 0
    this.rects = 0
  }
  rect(encoding: number) {
    this.rects++
    this.encs.set(encoding, (this.encs.get(encoding) ?? 0) + 1)
  }
  /** Script time spent reading the socket (decoding), added to the update under way. */
  spent(ms: number) { this.js += ms }
  /** The update is decoded (its pictures may still be drawn: a JPEG decodes on its own). */
  end() {
    const t = performance.now()
    this.frames.push({ t, wait: this.asked === null ? null : this.start - this.asked, span: t - this.start, js: this.js,
      bytes: this.bytesIn - this.startBytes, rects: this.rects, input: this.input === null ? null : this.input, shown: null, start: this.start })
    this.asked = null
    this.input = null
    while (this.frames.length && this.frames[0].t < t - KEEP * 4) this.frames.shift()
  }

  /** The updates of the last seconds, as measured (the benchmark's details). */
  recent(seconds = KEEP / 1000) {
    const from = performance.now() - seconds * 1000
    return this.frames.filter((f) => f.t >= from).map((f) => ({ ...f }))
  }
  /** The oldest update not drawn yet is on screen now (input is timed to here). */
  painted() {
    const t = performance.now()
    const f = this.frames.find((x) => x.shown === null)
    if (!f) return
    f.shown = t
    if (f.input !== null) f.input = t - f.input
  }

  summary(seconds = KEEP / 1000): Summary {
    const now = performance.now(), from = now - seconds * 1000
    const fs = this.frames.filter((f) => f.t >= from)
    const drawn = fs.filter((f) => f.shown !== null)
    const gaps: number[] = []
    for (let i = 1; i < drawn.length; i++) gaps.push(drawn[i].shown! - drawn[i - 1].shown!)
    const bytes = fs.reduce((n, f) => n + f.bytes, 0)
    const total = [...this.encs.values()].reduce((a, b) => a + b, 0)
    const encodings = [...this.encs].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([e, n]) => `${ENC[e] ?? e} ${Math.round((n / total) * 100)}%`).join(", ")
    const round = (q: [number, number] | null) => (q ? [Math.round(q[0]), Math.round(q[1])] as [number, number] : null)
    return {
      seconds,
      fps: Math.round((drawn.length / seconds) * 10) / 10,
      kbps: Math.round(bytes / 1024 / seconds),
      wait: round(quantiles(fs.flatMap((f) => (f.wait === null ? [] : [f.wait])))),
      span: round(quantiles(fs.map((f) => f.span))) ?? [0, 0],
      draw: round(quantiles(drawn.map((f) => f.shown! - f.start))),
      js: fs.length ? Math.round((fs.reduce((n, f) => n + f.js, 0) / fs.length) * 10) / 10 : 0,
      gap: round(quantiles(gaps)),
      input: round(quantiles(drawn.flatMap((f) => (f.input === null ? [] : [f.input])))),
      encodings,
      frameKb: fs.length ? Math.round(bytes / fs.length / 1024) : 0,
      ahead: this.ahead,
      relay: this.relay,
    }
  }
}
