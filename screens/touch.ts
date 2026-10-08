// A screen's fingers on a phone, read here (noVNC can't zoom in): trackpad mode moves the pointer and a tap clicks where
// it is; touch mode clicks where the finger is. Two fingers scroll, a pinch zooms in on the page.
import type { Conn } from "./connection"

export type TouchMode = "trackpad" | "touch"

const MOVED = 8 // px a finger goes before it's a move rather than a tap
const HOLD = 450 // ms held still: a drag (trackpad) or a right-click (touch)
const TAP = 300 // ms: longer isn't a tap
const NOTCH = 18 // px of two fingers' travel per scroll notch

type Pt = { x: number; y: number }
type One = { kind: "one"; start: Pt; last: Pt; lastT: number; t0: number; moved: boolean; held: boolean; spent: boolean; timer: number }
type Two = { kind: "two"; mode: "undecided" | "pinch" | "scroll"; d0: number; m0: Pt; dPrev: number; mPrev: Pt; acc: Pt; t0: number }
type Gesture = One | Two | { kind: "spent" }

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** Read the fingers on `el` (the tab's box) for the connection it shows. Returns what stops it. */
export function touchInput(el: HTMLElement, conn: () => Conn | null, mode: () => TouchMode) {
  const fingers = new Map<number, Pt>()
  let g: Gesture | null = null

  const two = () => { const [a, b] = [...fingers.values()]; return [a, b] as const }
  const ready = () => { const c = conn(); return c?.status.kind === "connected" ? c : null }

  const start = (e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    for (const t of Array.from(e.changedTouches)) fingers.set(t.identifier, { x: t.clientX, y: t.clientY })
    const c = ready()
    if (!c) return
    if (fingers.size === 1) {
      const p = [...fingers.values()][0]
      const one: One = { kind: "one", start: p, last: p, lastT: e.timeStamp, t0: e.timeStamp, moved: false, held: false, spent: false, timer: 0 }
      if (mode() === "touch") { c.move(c.toFb(p.x, p.y)); c.showPointer() }
      one.timer = window.setTimeout(() => {
        if (g !== one || one.moved) return
        if (mode() === "trackpad") { one.held = true; c.move(c.pointer, 1) } else { one.spent = true; c.click(4) }
      }, HOLD)
      g = one
    } else if (fingers.size === 2) {
      if (g?.kind === "one") {
        clearTimeout(g.timer)
        if (g.held || (mode() === "touch" && g.moved && !g.spent)) c.move(c.pointer, 0)
      }
      const [a, b] = two()
      const d = dist(a, b), m = mid(a, b)
      g = { kind: "two", mode: "undecided", d0: d, m0: m, dPrev: d, mPrev: m, acc: { x: 0, y: 0 }, t0: e.timeStamp }
    } else g = { kind: "spent" }
  }

  const move = (e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    for (const t of Array.from(e.changedTouches)) if (fingers.has(t.identifier)) fingers.set(t.identifier, { x: t.clientX, y: t.clientY })
    const c = ready()
    if (!c || !g) return
    if (g.kind === "one" && fingers.size === 1) {
      const p = [...fingers.values()][0]
      if (!g.moved && dist(p, g.start) < MOVED) return
      if (!g.moved) { g.moved = true; clearTimeout(g.timer) }
      if (g.spent) return
      if (mode() === "trackpad") {
        // Faster the faster the finger goes (a CSS pixel of finger is about one on the screen's picture as shown).
        const dt = Math.max(1, e.timeStamp - g.lastT), dx = p.x - g.last.x, dy = p.y - g.last.y
        const k = Math.min(2.6, 0.9 + (Math.hypot(dx, dy) / dt) * 0.9), s = c.scale()
        c.move({ x: c.pointer.x + (dx * k) / s, y: c.pointer.y + (dy * k) / s }, g.held ? 1 : undefined)
        c.follow(c.pointer)
      } else {
        // The first move presses the button where the finger came down; then it drags.
        if (dist(g.last, g.start) === 0) c.move(c.toFb(g.start.x, g.start.y), 1)
        c.move(c.toFb(p.x, p.y), 1)
      }
      c.showPointer()
      g.last = p
      g.lastT = e.timeStamp
    } else if (g.kind === "two" && fingers.size === 2) {
      const [a, b] = two()
      const d = dist(a, b), m = mid(a, b)
      if (g.mode === "undecided") {
        if (Math.abs(d - g.d0) > 24) g.mode = "pinch"
        else if (dist(m, g.m0) > 12) {
          g.mode = "scroll"
          if (mode() === "touch") c.move(c.toFb(g.m0.x, g.m0.y))
        } else return
        g.dPrev = d
        g.mPrev = m
        return
      }
      if (g.mode === "pinch") {
        c.zoomAt(d / g.dPrev, m.x, m.y)
        c.panBy(m.x - g.mPrev.x, m.y - g.mPrev.y)
        c.showPointer()
      } else {
        // Fingers going down scroll up, as on the phone itself.
        g.acc = { x: g.acc.x + m.x - g.mPrev.x, y: g.acc.y + m.y - g.mPrev.y }
        const ny = Math.trunc(g.acc.y / NOTCH), nx = Math.trunc(g.acc.x / NOTCH)
        if (ny || nx) { c.scroll(-ny, -nx); g.acc = { x: g.acc.x - nx * NOTCH, y: g.acc.y - ny * NOTCH } }
      }
      g.dPrev = d
      g.mPrev = m
    }
  }

  const end = (e: TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    for (const t of Array.from(e.changedTouches)) fingers.delete(t.identifier)
    const c = ready()
    if (g?.kind === "one") {
      clearTimeout(g.timer)
      if (c && !g.spent) {
        if (mode() === "trackpad") {
          if (g.held) c.move(c.pointer, 0)
          else if (!g.moved && e.timeStamp - g.t0 < TAP) c.click(1)
        } else if (g.moved) c.move(c.pointer, 0)
        else if (e.timeStamp - g.t0 < HOLD) c.click(1)
      }
      g = null
    } else if (g?.kind === "two") {
      // Two fingers that tapped: a right-click (where the pointer is; touch: where they were).
      if (c && g.mode === "undecided" && e.timeStamp - g.t0 < TAP) {
        if (mode() === "touch") c.move(c.toFb(g.m0.x, g.m0.y))
        c.click(4)
        c.showPointer()
      }
      g = { kind: "spent" }
    }
    if (!fingers.size) g = null
  }

  const opts = { capture: true, passive: false }
  el.addEventListener("touchstart", start, opts)
  el.addEventListener("touchmove", move, opts)
  el.addEventListener("touchend", end, opts)
  el.addEventListener("touchcancel", end, opts)
  return () => {
    if (g?.kind === "one") clearTimeout(g.timer)
    el.removeEventListener("touchstart", start, opts)
    el.removeEventListener("touchmove", move, opts)
    el.removeEventListener("touchend", end, opts)
    el.removeEventListener("touchcancel", end, opts)
  }
}
