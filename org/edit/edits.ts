// What a click in the drawing does to the text, as small edits: a checkbox ticked (its parents and cookies following, as
// Emacs keeps them), a TODO keyword cycled (CLOSED with logdone, a repeating task moved to its next date).
import { isText, type OrgChild, type OrgNode } from "../parser/index.ts"

export type Edit = { from: number; to: number; insert: string }

export function applyEdits(text: string, edits: Edit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to)
  return out
}

const children = (n: OrgNode) => (n.children ?? []).filter((c): c is OrgNode => !isText(c))
const parents = (root: OrgNode) => {
  const up = new Map<OrgNode, OrgNode>()
  const go = (n: OrgNode) => { for (const c of children(n)) { up.set(c, n); go(c) } }
  go(root)
  return up
}

// ---- Checkboxes

type Box = "on" | "off" | "trans"
const BOX = /[ \t]*\S+[ \t]+(?:\[@[^\]\n]+\][ \t]+)?\[([ xX-])\]/y

/** Where an item's [ ] is in the text. */
function boxOf(text: string, item: OrgNode): { from: number; state: Box } | null {
  BOX.lastIndex = item.begin
  const m = BOX.exec(text)
  if (!m) return null
  return { from: BOX.lastIndex - 3, state: m[1] === " " ? "off" : m[1] === "-" ? "trans" : "on" }
}
const MARK: Record<Box, string> = { on: "X", off: " ", trans: "-" }

/** An item's list items one level down. */
const subItems = (item: OrgNode) => children(item).filter((c) => c.type === "plain-list").flatMap((l) => children(l).filter((i) => i.type === "item"))

function cookiesIn(cs: OrgChild[], out: OrgNode[] = []): OrgNode[] {
  for (const c of cs) {
    if (isText(c)) continue
    if (c.type === "statistics-cookie") out.push(c)
    else if (c.type !== "plain-list" && c.type !== "headline") cookiesIn(c.children ?? [], out)
  }
  return out
}

function cookieText(cookie: OrgNode, done: number, total: number) {
  return /%/.test(String(cookie.value ?? "")) ? `[${total ? Math.floor((100 * done) / total) : 0}%]` : `[${done}/${total}]`
}

function setCookie(text: string, cookie: OrgNode, done: number, total: number, edits: Edit[]) {
  const was = String(cookie.value ?? ""), at = text.indexOf(was, cookie.begin)
  const now = cookieText(cookie, done, total)
  if (at === cookie.begin && now !== was) edits.push({ from: at, to: at + was.length, insert: now })
}

/** Tick or untick an item: its sub-items follow, then each parent's box and every cookie counting them. */
export const toggleCheckbox = (text: string, doc: OrgNode, item: OrgNode) => applyEdits(text, checkboxEdits(text, doc, item))

export function checkboxEdits(text: string, doc: OrgNode, item: OrgNode): Edit[] {
  const box = boxOf(text, item)
  if (!box) return []
  const state = new Map<OrgNode, Box>()
  const want: Box = box.state === "on" ? "off" : "on"
  const down = (i: OrgNode) => { if (boxOf(text, i)) state.set(i, want); for (const s of subItems(i)) down(s) }
  down(item)
  const up = parents(doc)
  const boxed = (i: OrgNode) => state.get(i) ?? boxOf(text, i)?.state ?? null
  for (let p = up.get(item); p; p = up.get(p)) {
    if (p.type !== "item") continue
    const subs = subItems(p).map(boxed).filter((b): b is Box => b !== null)
    if (!subs.length || !boxOf(text, p)) continue
    state.set(p, subs.every((b) => b === "on") ? "on" : subs.every((b) => b === "off") ? "off" : "trans")
  }
  const edits: Edit[] = []
  for (const [i, b] of state) { const at = boxOf(text, i); if (at && at.state !== b) edits.push({ from: at.from + 1, to: at.from + 2, insert: MARK[b] }) }
  // Cookies: an item's count its sub-items; the entry's (its headline, its other paragraphs) the top-level items.
  const count = (items: OrgNode[]) => {
    const bs = items.map(boxed).filter((b): b is Box => b !== null)
    return [bs.filter((b) => b === "on").length, bs.length] as const
  }
  const recount = new Set<OrgNode>(state.keys())
  let section: OrgNode | null = null
  for (let p = up.get(item); p; p = up.get(p)) {
    if (p.type === "item") recount.add(p)
    if (p.type === "section") { section = p; break }
  }
  for (const i of recount) {
    const first = children(i)[0]
    for (const c of first && first.type === "paragraph" ? cookiesIn(first.children ?? []) : []) setCookie(text, c, ...count(subItems(i)), edits)
  }
  const top = section ?? doc
  const lists = children(top).filter((c) => c.type === "plain-list")
  const tops = lists.flatMap((l) => children(l).filter((i) => i.type === "item"))
  const [done, total] = count(tops)
  for (const c of children(top)) if (c.type !== "plain-list") for (const k of cookiesIn(c.children ?? [])) setCookie(text, k, done, total, edits)
  const head = section ? up.get(section) : null
  if (head?.type === "headline") for (const k of cookiesIn(Array.isArray(head.title) ? (head.title as OrgChild[]) : [])) setCookie(text, k, done, total, edits)
  return edits
}

// ---- TODO keywords

/** The file's keyword sequences (#+TODO: lines, each "TODO NEXT | DONE"), else Org's TODO | DONE. */
export function todoSequences(text: string): { todo: string[]; done: string[] }[] {
  const out: { todo: string[]; done: string[] }[] = []
  for (const m of text.matchAll(/^[ \t]*#\+(?:SEQ_|TYP_)?TODO:[ \t]*(.*)$/gim)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean).map((w) => (w === "|" ? w : w.replace(/\(.*\)$/, "")))
    if (!words.length) continue
    const bar = words.indexOf("|")
    out.push(bar >= 0 ? { todo: words.slice(0, bar), done: words.slice(bar + 1) } : { todo: words.slice(0, -1), done: words.slice(-1) })
  }
  return out.length ? out : [{ todo: ["TODO"], done: ["DONE"] }]
}

/** The keyword after `kw` ("" none): through its own sequence, then back to none (`wrap`: to its first again). */
export function nextKeyword(text: string, kw: string | null, wrap = false): string {
  const seqs = todoSequences(text)
  if (!kw) return seqs[0].todo[0] ?? seqs[0].done[0] ?? ""
  const seq = seqs.find((s) => s.todo.includes(kw) || s.done.includes(kw))
  if (!seq) return ""
  const all = [...seq.todo, ...seq.done], i = all.indexOf(kw)
  return all[i + 1] ?? (wrap ? all[0] : "")
}

const isDone = (text: string, kw: string) => todoSequences(text).some((s) => s.done.includes(kw))
const startup = (text: string) => [...text.matchAll(/^[ \t]*#\+STARTUP:[ \t]*(.*)$/gim)].flatMap((m) => m[1].trim().split(/\s+/))

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const pad = (n: number) => String(n).padStart(2, "0")
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const stamp = (d: Date, time: boolean) => `${ymd(d)} ${DAYS[d.getDay()]}${time ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ""}`

/** Moves a date by a repeater's step (+1w: a week). */
function step(d: Date, n: number, unit: string, sign = 1): Date {
  const r = new Date(d)
  if (unit === "h") r.setHours(r.getHours() + sign * n)
  else if (unit === "d") r.setDate(r.getDate() + sign * n)
  else if (unit === "w") r.setDate(r.getDate() + sign * 7 * n)
  else if (unit === "m") r.setMonth(r.getMonth() + sign * n)
  else if (unit === "y") r.setFullYear(r.getFullYear() + sign * n)
  return r
}

const REPEATER = /([.+]?\+)(\d+)([hdwmy])/
const DATE = /(\d{4})-(\d{2})-(\d{2})(?:[ \t]+[^\s\d>\]+.-]+)?/g

/** A repeating timestamp's text moved to its next date: +1w from its date, ++1w past today, .+1w from today. */
export function repeated(raw: string, now: Date): string | null {
  const r = REPEATER.exec(raw)
  if (!r) return null
  const [, kind, n, unit] = r
  const count = Number(n)
  if (!count) return null
  return raw.replace(DATE, (all: string, y: string, mo: string, d: string, off: number) => {
    const hm = /^[ \t]+(\d{1,2}):(\d{2})/.exec(raw.slice(off + all.length))
    let t = new Date(Number(y), Number(mo) - 1, Number(d), hm ? Number(hm[1]) : 0, hm ? Number(hm[2]) : 0)
    if (kind === ".+") t = step(new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.getHours(), t.getMinutes()), count, unit)
    else if (kind === "++") { do t = step(t, count, unit); while (t.getTime() <= now.getTime()) }
    else t = step(t, count, unit)
    return stamp(t, false)
  })
}

const KW_AT = /(\*+)[ \t]+/y

/** The headline with its keyword moved on: CLOSED added or taken away, a repeating one moved to its next date instead. */
export const cycleTodo = (text: string, headline: OrgNode, to: string | null = null, now = new Date()) => applyEdits(text, todoEdits(text, headline, to, now))

export function todoEdits(text: string, headline: OrgNode, to: string | null = null, now = new Date()): Edit[] {
  KW_AT.lastIndex = headline.begin
  const m = KW_AT.exec(text)
  if (!m) return []
  const after = KW_AT.lastIndex, was = typeof headline.todoKeyword === "string" ? headline.todoKeyword : null
  let next = to ?? nextKeyword(text, was)
  const edits: Edit[] = []
  const planning = planningOf(headline)
  const done = !!next && isDone(text, next), wasDone = !!was && isDone(text, was)
  if (done && !wasDone && planning) {
    // A repeating task: its dates move on and it stays to do.
    const moved = (["scheduled", "deadline"] as const).map((k) => planning[k]).filter((t): t is OrgNode => !!t)
      .map((t) => ({ t, raw: String(t.rawValue ?? ""), to: repeated(String(t.rawValue ?? ""), now) })).filter((x) => x.to)
    if (moved.length) {
      for (const x of moved) { const at = text.indexOf(x.raw, x.t.begin); if (at === x.t.begin) edits.push({ from: at, to: at + x.raw.length, insert: x.to! }) }
      next = was ?? todoSequences(text)[0].todo[0] ?? ""
      replaceKeyword(text, after, was, next, edits)
      return edits
    }
  }
  replaceKeyword(text, after, was, next, edits)
  const logdone = startup(text).some((w) => /^log(?:done|notedone)$/i.test(w))
  if (done && !wasDone && logdone) addClosed(text, headline, planning, now, edits)
  if (!done && wasDone && planning?.closed) removeClosed(text, planning, edits)
  return edits
}

function replaceKeyword(text: string, after: number, was: string | null, next: string, edits: Edit[]) {
  if (was && text.startsWith(was, after)) {
    let end = after + was.length
    if (!next) while (text[end] === " " || text[end] === "\t") end++
    edits.push({ from: after, to: end, insert: next })
  } else if (next) edits.push({ from: after, to: after, insert: `${next} ` })
}

type Planning = { node: OrgNode; closed: OrgNode | null; scheduled: OrgNode | null; deadline: OrgNode | null }
function planningOf(h: OrgNode): Planning | null {
  const section = children(h)[0]
  const p = section?.type === "section" ? children(section)[0] : null
  if (!p || p.type !== "planning") return null
  const ts = (k: string) => (p[k] && typeof p[k] === "object" ? (p[k] as OrgNode) : null)
  return { node: p, closed: ts("closed"), scheduled: ts("scheduled"), deadline: ts("deadline") }
}

function addClosed(text: string, h: OrgNode, planning: Planning | null, now: Date, edits: Edit[]) {
  const closed = `CLOSED: [${stamp(now, false)} ${pad(now.getHours())}:${pad(now.getMinutes())}]`
  if (planning) {
    const indent = /^[ \t]*/.exec(text.slice(planning.node.begin))![0]
    edits.push({ from: planning.node.begin + indent.length, to: planning.node.begin + indent.length, insert: `${closed} ` })
  } else {
    const eol = text.indexOf("\n", h.begin)
    if (eol < 0) edits.push({ from: text.length, to: text.length, insert: `\n${closed}` })
    else edits.push({ from: eol + 1, to: eol + 1, insert: `${closed}\n` })
  }
}

function removeClosed(text: string, planning: Planning, edits: Edit[]) {
  const line = planning.node, end = text.indexOf("\n", line.begin), stop = end < 0 ? text.length : end
  const rest = text.slice(line.begin, stop).replace(/CLOSED:[ \t]*\[[^\]\n]*\][ \t]*/, "")
  if (rest.trim()) edits.push({ from: line.begin, to: stop, insert: rest.replace(/[ \t]+$/, "") })
  else edits.push({ from: line.begin, to: Math.min(stop + 1, text.length), insert: "" })
}
