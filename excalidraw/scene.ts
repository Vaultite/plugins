// A drawing as others read and change it: its elements as items, the scene as a compact text (ids, labels, arrows as
// "a -> b"), and typed actions checked against it before any is made. Shared by the server and the whiteboard.

/** An element as the file keeps it (excalidraw.com's JSON). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type El = Record<string, any>
export type Item = { id: string; type: string; x: number; y: number; w: number; h: number; text?: string; from?: string; to?: string }
export type Point = { x: number; y: number }

const SHAPES = new Set(["rectangle", "ellipse", "diamond"])
const LINES = new Set(["arrow", "line"])
const r = Math.round

/** What's drawn (not deleted): a shape's label is its text, not an item of its own. */
export function itemsOf(elements: readonly El[]): Item[] {
  const live = elements.filter((e) => !e.isDeleted)
  const labels = new Map(live.filter((e) => e.type === "text" && e.containerId).map((e) => [e.containerId as string, String(e.originalText ?? e.text ?? "")]))
  const out: Item[] = []
  for (const e of live) {
    if (e.type === "text" && e.containerId && live.some((c) => c.id === e.containerId)) continue
    const text = e.type === "text" ? String(e.originalText ?? e.text ?? "") : e.type === "frame" || e.type === "magicframe" ? String(e.name ?? "") : labels.get(e.id)
    const it: Item = { id: e.id, type: e.type, x: r(e.x ?? 0), y: r(e.y ?? 0), w: r(e.width ?? 0), h: r(e.height ?? 0), ...(text ? { text } : {}) }
    if (LINES.has(e.type)) {
      if (e.startBinding?.elementId) it.from = e.startBinding.elementId
      if (e.endBinding?.elementId) it.to = e.endBinding.elementId
    }
    out.push(it)
  }
  return out
}

const quote = (s: string, n = 80) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s)

/** An item in a few words: `r1 rectangle "Login" at 0,0 160x80`, `a1 arrow r1 -> r2 "yes"`. */
export function itemText(i: Item, all: Item[]) {
  const name = (id?: string) => { const o = id ? all.find((x) => x.id === id) : undefined; return o ? `${o.id}${o.text ? ` ${quote(o.text, 30)}` : ""}` : "" }
  const label = i.text ? ` ${quote(i.text)}` : ""
  if (LINES.has(i.type) && (i.from || i.to)) return `${i.id} ${i.type} ${name(i.from) || "(a free end)"} -> ${name(i.to) || "(a free end)"}${label}`
  return `${i.id} ${i.type}${label} at ${i.x},${i.y} ${i.w}x${i.h}`
}

/** Items nearest a point, closest first (by the distance to their box). */
export function nearestItems(items: Item[], p: Point, n = 4, within = 400) {
  const d = (i: Item) => Math.hypot(Math.max(i.x - p.x, 0, p.x - i.x - i.w), Math.max(i.y - p.y, 0, p.y - i.y - i.h))
  return items.map((i) => ({ i, d: d(i) })).filter((x) => x.d <= within).sort((a, b) => a.d - b.d).slice(0, n).map((x) => x.i)
}

const MOST = 150
/** The scene as an agent reads it: every item in reading order, then what's by the user's pointer and selected. */
export function describe(elements: readonly El[], at: { pointer?: Point | null; selected?: string[] } = {}) {
  const items = itemsOf(elements)
  if (!items.length) return "An empty drawing."
  const xs = items.flatMap((i) => [i.x, i.x + i.w]), ys = items.flatMap((i) => [i.y, i.y + i.h])
  const out = [`${items.length} items, x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}:`]
  const sorted = [...items].sort((a, b) => Number(LINES.has(a.type)) - Number(LINES.has(b.type)) || r(a.y / 40) - r(b.y / 40) || a.x - b.x)
  for (const i of sorted.slice(0, MOST)) out.push(`- ${itemText(i, items)}`)
  if (sorted.length > MOST) out.push(`- … and ${sorted.length - MOST} more`)
  const p = at.pointer
  if (p) {
    const near = nearestItems(items, p)
    out.push(`The user's pointer: ${r(p.x)},${r(p.y)}${near.length ? `, near ${near.map((i) => `${i.id}${i.text ? ` ${quote(i.text, 30)}` : ""}`).join(", ")}` : ""}.`)
  }
  const sel = (at.selected ?? []).map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i)
  if (sel.length) out.push(`Selected: ${sel.map((i) => itemText(i, items)).join("; ")}.`)
  return out.join("\n")
}

/** Where a place is in the scene: an item by id, else by its text (exact, then in part), or null. */
export function findItem(items: Item[], find: string) {
  const f = find.trim(), low = f.toLowerCase()
  return items.find((i) => i.id === f) ?? items.find((i) => i.text?.trim().toLowerCase() === low) ?? items.find((i) => !!i.text && i.text.toLowerCase().includes(low)) ?? null
}

// ---------- actions

/** Excalidraw's palette by name: a stroke and the fill that goes with it. */
const COLORS: Record<string, [string, string]> = {
  black: ["#1e1e1e", "#e9ecef"], gray: ["#868e96", "#e9ecef"], red: ["#e03131", "#ffc9c9"], pink: ["#c2255c", "#fcc2d7"],
  purple: ["#9c36b5", "#eebefa"], violet: ["#6741d9", "#d0bfff"], blue: ["#1971c2", "#a5d8ff"], cyan: ["#0c8599", "#99e9f2"],
  teal: ["#099268", "#96f2d7"], green: ["#2f9e44", "#b2f2bb"], yellow: ["#f08c00", "#ffec99"], orange: ["#e8590c", "#ffd8a8"],
}
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const ID = /^[\w-]{1,40}$/
const FONT = 20, LINE_HEIGHT = 1.25

/** One action, as the companion sends them (`vau docs excalidraw`). */
export type Action = { op: "add" | "move" | "change" | "delete"; id?: string; type?: string; x?: number; y?: number; dx?: number; dy?: number
  w?: number; h?: number; text?: string; label?: string; color?: string; fill?: string; from?: string | [number, number]; to?: string | [number, number] }

class Bad extends Error {}

/** A text's size before it's measured (the whiteboard measures it again). */
export function textSize(text: string, size = FONT) {
  const lines = text.split("\n")
  return { width: Math.max(10, r(Math.max(...lines.map((l) => l.length)) * size * 0.6)), height: r(lines.length * size * LINE_HEIGHT) }
}

const rand = () => Math.floor(Math.random() * 2 ** 31)
const newId = (taken: Set<string>) => { let id; do id = Math.random().toString(36).slice(2, 10); while (taken.has(id)); return id }

function base(type: string, id: string, x: number, y: number, w: number, h: number): El {
  return { id, type, x, y, width: w, height: h, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: type === "rectangle" ? { type: 3 } : type === "line" || type === "arrow" ? { type: 2 } : null,
    seed: rand(), version: 1, versionNonce: rand(), isDeleted: false, boundElements: [], updated: Date.now(), link: null, locked: false }
}

function textEl(id: string, text: string, x: number, y: number, containerId: string | null, color: string): El {
  const s = textSize(text)
  return { ...base("text", id, x, y, s.width, s.height), strokeColor: color, roundness: null, text, originalText: text, fontSize: FONT, fontFamily: 5,
    textAlign: containerId ? "center" : "left", verticalAlign: containerId ? "middle" : "top", containerId, autoResize: true, lineHeight: LINE_HEIGHT }
}

/** Where the line from a shape's centre towards `to` leaves it (its box, ellipse or diamond), `gap` further out. */
function edge(e: El, to: Point, gap = 6): Point {
  const c = { x: e.x + e.width / 2, y: e.y + e.height / 2 }, dx = to.x - c.x, dy = to.y - c.y
  const rx = e.width / 2 + gap, ry = e.height / 2 + gap
  if (!dx && !dy) return c
  const k = e.type === "ellipse" ? 1 / Math.hypot(dx / rx, dy / ry) : e.type === "diamond" ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
    : Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity)
  return { x: c.x + dx * Math.min(1, k), y: c.y + dy * Math.min(1, k) }
}

/** An arrow's ends again: a bound end on its shape's edge, towards the other end. */
function route(a: El, byId: Map<string, El>) {
  const pts: [number, number][] = a.points?.length >= 2 ? a.points : [[0, 0], [a.width || 100, a.height || 0]]
  let s: Point = { x: a.x + pts[0][0], y: a.y + pts[0][1] }, t: Point = { x: a.x + pts[pts.length - 1][0], y: a.y + pts[pts.length - 1][1] }
  const S = a.startBinding && byId.get(a.startBinding.elementId), T = a.endBinding && byId.get(a.endBinding.elementId)
  const mid = (e: El) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 })
  if (S && !S.isDeleted) s = edge(S, T && !T.isDeleted ? mid(T) : t)
  if (T && !T.isDeleted) t = edge(T, S && !S.isDeleted ? mid(S) : s)
  const inner = pts.slice(1, -1).map(([px, py]) => [a.x + px - s.x, a.y + py - s.y] as [number, number])
  const points: [number, number][] = [[0, 0], ...inner, [t.x - s.x, t.y - s.y]]
  Object.assign(a, { x: s.x, y: s.y, points, width: r(Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]))),
    height: r(Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]))) })
}

/** A label's place: the middle of its shape, or of its arrow. */
function placeLabel(t: El, c: El) {
  if (LINES.has(c.type)) {
    const pts = c.points ?? [[0, 0]], [px, py] = pts[Math.floor(pts.length / 2)] ?? [0, 0], [qx, qy] = pts[Math.floor((pts.length - 1) / 2)] ?? [0, 0]
    t.x = c.x + (px + qx) / 2 - t.width / 2
    t.y = c.y + (py + qy) / 2 - t.height / 2
  } else {
    t.x = c.x + (c.width - t.width) / 2
    t.y = c.y + (c.height - t.height) / 2
  }
}

/** Labels and arrows laid out again after their shapes changed (`ids`: those that did; none: all). */
export function layout(elements: El[], ids?: Set<string>) {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const hit = (id?: string) => !ids || (!!id && ids.has(id))
  for (const a of elements) if (!a.isDeleted && LINES.has(a.type) && (hit(a.id) || hit(a.startBinding?.elementId) || hit(a.endBinding?.elementId))) { route(a, byId); ids?.add(a.id) }
  for (const t of elements) {
    const c = t.type === "text" && t.containerId ? byId.get(t.containerId) : undefined
    if (c && !t.isDeleted && (hit(c.id) || hit(t.id))) placeLabel(t, c)
  }
  return elements
}

const num = (v: unknown, what: string) => {
  if (v === undefined) return undefined
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Bad(`${what} should be a number`)
  return v
}
function color(v: unknown, fill: boolean) {
  if (v === undefined) return undefined
  const s = String(v).trim().toLowerCase()
  if (fill && (s === "none" || s === "transparent")) return "transparent"
  if (HEX.test(s)) return s
  const c = COLORS[s]
  if (!c) throw new Bad(`${fill ? "fill" : "color"} "${v}": a name (${Object.keys(COLORS).join(", ")}${fill ? ", none" : ""}) or #hex`)
  return c[fill ? 1 : 0]
}

/** The drawing with `actions` made, in order, each checked first (an error names the action and why); the elements
 *  given aren't changed. `touched`: what they added or changed, in order. */
export function applyActions(elements: readonly El[], actions: unknown): { elements: El[]; touched: string[] } {
  if (!Array.isArray(actions) || !actions.length) throw new Error("actions: a list of at least one action ({\"op\": \"add\", ...})")
  const els = elements.map((e) => ({ ...e }))
  const byId = new Map(els.map((e) => [e.id as string, e]))
  const taken = new Set(byId.keys())
  const touched: string[] = [], moved = new Set<string>()
  const live = (id: unknown) => {
    const e = typeof id === "string" ? byId.get(id) : undefined
    if (!e || e.isDeleted) throw new Bad(`no element ${JSON.stringify(id ?? "")} (the drawing's text lists their ids)`)
    return e
  }
  const labelOf = (e: El) => els.find((t) => t.type === "text" && t.containerId === e.id && !t.isDeleted)
  const bump = (e: El) => { e.version = (e.version ?? 1) + 1; e.versionNonce = rand(); e.updated = Date.now(); if (!touched.includes(e.id)) touched.push(e.id) }
  const setLabel = (e: El, text: string) => {
    const t = labelOf(e)
    if (!text) { if (t) { t.isDeleted = true; bump(t); e.boundElements = (e.boundElements ?? []).filter((b: El) => b.id !== t.id) } return }
    if (t) { Object.assign(t, { text, originalText: text, ...textSize(text) }); bump(t); return }
    const nt = textEl(newId(taken), text, e.x, e.y, e.id, e.strokeColor ?? "#1e1e1e")
    taken.add(nt.id); els.push(nt); byId.set(nt.id, nt)
    e.boundElements = [...(e.boundElements ?? []), { id: nt.id, type: "text" }]
  }
  const unbind = (a: El) => {
    for (const b of [a.startBinding, a.endBinding]) {
      const s = b && byId.get(b.elementId)
      if (s) { s.boundElements = (s.boundElements ?? []).filter((x: El) => x.id !== a.id); bump(s) }
    }
    a.startBinding = null; a.endBinding = null
  }
  const end = (v: unknown, what: string): { el?: El; p?: Point } => {
    if (typeof v === "string") return { el: live(v) }
    if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))) return { p: { x: v[0], y: v[1] } }
    throw new Bad(`${what}: an element's id, or [x, y]`)
  }

  actions.forEach((raw, i) => {
    const a = raw as Action
    const op = a && typeof a === "object" ? a.op : undefined
    try {
      if (op === "add") {
        const type = String(a.type ?? (a.from !== undefined || a.to !== undefined ? "arrow" : a.text !== undefined && a.label === undefined ? "text" : "rectangle"))
        if (!SHAPES.has(type) && !LINES.has(type) && type !== "text") throw new Bad(`type "${type}": rectangle, ellipse, diamond, text, arrow or line`)
        if (a.id !== undefined && (typeof a.id !== "string" || !ID.test(a.id))) throw new Bad("id: letters, digits, - and _ (up to 40)")
        if (a.id && taken.has(a.id)) throw new Bad(`id "${a.id}" is taken`)
        const id = a.id || newId(taken)
        const text = String(a.label ?? a.text ?? "")
        const stroke = color(a.color, false) ?? "#1e1e1e", fill = color(a.fill, true)
        let e: El
        if (type === "text") {
          if (!text) throw new Bad("a text needs text")
          e = textEl(id, text, num(a.x, "x") ?? 0, num(a.y, "y") ?? 0, null, stroke)
        } else if (LINES.has(type)) {
          const from = a.from !== undefined ? end(a.from, "from") : { p: { x: num(a.x, "x") ?? 0, y: num(a.y, "y") ?? 0 } }
          const to = a.to !== undefined ? end(a.to, "to") : null
          if (!to && (a.w === undefined && a.h === undefined)) throw new Bad(`an ${type} needs to (an id or [x, y]), or w and h`)
          const s = from.p ?? { x: from.el!.x + from.el!.width / 2, y: from.el!.y + from.el!.height / 2 }
          const t = to ? to.p ?? { x: to.el!.x + to.el!.width / 2, y: to.el!.y + to.el!.height / 2 } : { x: s.x + (num(a.w, "w") ?? 0), y: s.y + (num(a.h, "h") ?? 0) }
          e = { ...base(type, id, s.x, s.y, 0, 0), strokeColor: stroke, points: [[0, 0], [t.x - s.x, t.y - s.y]], lastCommittedPoint: null,
            startArrowhead: null, endArrowhead: type === "arrow" ? "arrow" : null, elbowed: false,
            startBinding: from.el ? { elementId: from.el.id, focus: 0, gap: 6 } : null, endBinding: to?.el ? { elementId: to.el.id, focus: 0, gap: 6 } : null }
          for (const b of [from.el, to?.el]) if (b) { b.boundElements = [...(b.boundElements ?? []), { id, type: "arrow" }]; bump(b) }
        } else {
          const s = textSize(text)
          e = { ...base(type, id, num(a.x, "x") ?? 0, num(a.y, "y") ?? 0, num(a.w, "w") ?? Math.max(120, s.width + 40), num(a.h, "h") ?? Math.max(60, s.height + 30)), strokeColor: stroke,
            ...(fill ? { backgroundColor: fill } : {}) }
          if (e.width <= 0 || e.height <= 0) throw new Bad("w and h should be above 0")
        }
        taken.add(id); els.push(e); byId.set(id, e); touched.push(id)
        if (type !== "text" && text) setLabel(e, text)
        moved.add(id)
      } else if (op === "move") {
        const e = live(a.id)
        const x = num(a.x, "x"), y = num(a.y, "y"), dx = num(a.dx, "dx"), dy = num(a.dy, "dy")
        if (x === undefined && y === undefined && dx === undefined && dy === undefined) throw new Bad("give x and y (where its top left goes), or dx and dy")
        const nx = x ?? e.x + (dx ?? 0), ny = y ?? e.y + (dy ?? 0)
        const [mx, my] = [nx - e.x, ny - e.y]
        e.x = nx; e.y = ny; bump(e); moved.add(e.id)
        // (a free text moved with it isn't: only its own label, and an arrow's free ends)
        const t = labelOf(e)
        if (t) { t.x += mx; t.y += my; bump(t) }
        if (LINES.has(e.type)) unbind(e)
      } else if (op === "change") {
        const e = live(a.id)
        const stroke = color(a.color, false), fill = color(a.fill, true), w = num(a.w, "w"), h = num(a.h, "h")
        const text = a.label ?? a.text
        if (stroke === undefined && fill === undefined && w === undefined && h === undefined && text === undefined) throw new Bad("give what changes: label, color, fill, w or h")
        if (stroke) { e.strokeColor = stroke; const t = labelOf(e); if (t) { t.strokeColor = stroke; bump(t) } }
        if (fill !== undefined) { e.backgroundColor = fill; e.fillStyle = "solid" }
        if (w !== undefined || h !== undefined) {
          if ((w ?? 1) <= 0 || (h ?? 1) <= 0) throw new Bad("w and h should be above 0")
          if (e.type === "text") throw new Bad("a text's size follows its words")
          e.width = w ?? e.width; e.height = h ?? e.height; moved.add(e.id)
        }
        if (text !== undefined) {
          if (e.type === "text") { if (!String(text)) throw new Bad("a text can't be empty: delete it"); Object.assign(e, { text: String(text), originalText: String(text), ...textSize(String(text)) }) }
          else setLabel(e, String(text))
          moved.add(e.id)
        }
        bump(e)
      } else if (op === "delete") {
        const e = live(a.id)
        const gone = new Set([e.id, ...els.filter((t) => t.containerId === e.id).map((t) => t.id)])
        for (const x of els) {
          if (gone.has(x.id)) { x.isDeleted = true; bump(x); continue }
          if (x.boundElements?.some((b: El) => gone.has(b.id))) { x.boundElements = x.boundElements.filter((b: El) => !gone.has(b.id)); bump(x) }
          if (x.startBinding && gone.has(x.startBinding.elementId)) { x.startBinding = null; bump(x) }
          if (x.endBinding && gone.has(x.endBinding.elementId)) { x.endBinding = null; bump(x) }
        }
        if (e.containerId) { const c = byId.get(e.containerId); if (c) { c.boundElements = (c.boundElements ?? []).filter((b: El) => b.id !== e.id); bump(c) } }
      } else {
        throw new Bad(`op ${JSON.stringify(op ?? "")}: add, move, change or delete`)
      }
    } catch (err) {
      if (err instanceof Bad) throw new Error(`action ${i + 1}${op ? ` (${op})` : ""}: ${err.message}`)
      throw err
    }
  })
  layout(els, moved)
  return { elements: els, touched: touched.filter((id) => !byId.get(id)?.containerId) }
}
