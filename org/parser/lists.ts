// Plain lists and their items: bullets, counters, checkboxes, tags, and where each item and list ends.
// A list's structure (every item of it and of the lists nested in it) is scanned once, then handed down.
import { node, type OrgNode } from "./ast.ts"
import type { Affiliated, Ctx } from "./driver.ts"
import { at, backBlank, blankLine, eol, nextLine, skipBlank } from "./text.ts"

/** One item as the scan finds it. `end` is where it stops, before the blank lines that close it. */
type Item = {
  begin: number
  ind: number
  bullet: string
  ordered: boolean
  counter: number | null
  checkbox: "on" | "off" | "trans" | null
  tag: [number, number] | null
  /** Past the bullet, counter, checkbox and tag (and the blanks after them). */
  prefixEnd: number
  end: number
  /** The item after it in the same list. */
  next: Item | null
}

/** The items of a list and of every list nested in it, by where they start. */
class ListStruct {
  items = new Map<number, Item>()
}

const BULLET = /[ \t]*(?:([-+*])|\d+[.)])(?:[ \t]+|(?=\n|$))/y
const COUNTER = /\[@(?:start:)?(\d+|[A-Za-z])\][ \t]*/y
const CHECKBOX = /\[([ xX-])\](?:[ \t]+|(?=\n|$))/y
const TAG = /^(.+)[ \t]+::(?:[ \t]+|$)/
// A lower-case [x] is taken as a checkbox's syntax but gives no state.
const CHECK: Record<string, Item["checkbox"]> = { " ": "off", X: "on", "-": "trans", x: null }

/** Indentation in columns: a space is one, a tab eight wherever it is. */
function indentation(s: string, pos: number) {
  let col = 0
  for (let i = pos; s[i] === " " || s[i] === "\t"; i++) col += s[i] === " " ? 1 : 8
  return col
}

/** The item starting on the line at `pos` (a line's start), or null. */
function itemLine(s: string, pos: number): Item | null {
  const m = at(BULLET, s, pos)
  if (!m || (m[1] === "*" && s[pos] === "*")) return null
  const ind = indentation(s, pos), bulletAt = pos + m[0].search(/\S/)
  let q = pos + m[0].length
  const bullet = s.slice(bulletAt, q)
  let counter: number | null = null, checkbox: Item["checkbox"] = null, tag: Item["tag"] = null
  const c = at(COUNTER, s, q)
  if (c) {
    counter = /\d/.test(c[1]) ? Number(c[1]) : c[1].toLowerCase().charCodeAt(0) - 96
    q += c[0].length
  }
  const b = at(CHECKBOX, s, q)
  if (b) { checkbox = CHECK[b[1]]; q += b[0].length }
  const ordered = !m[1]
  if (!ordered) {
    const e = eol(s, q), t = TAG.exec(s.slice(q, e))
    if (t) { tag = [q, q + t[1].length]; q += t[0].length }
  }
  return { begin: pos, ind, bullet, ordered, counter, checkbox, tag, prefixEnd: q, end: pos, next: null }
}

const BLOCK = /[ \t]*#\+begin(?:_(\S+)|:)/iy
const DRAWER = /[ \t]*:[\p{L}\p{N}_-]+:[ \t]*(?=\n|$)/uy
const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Where the closing lines of blocks and drawers are, searched once per kind of closing line for a whole list. */
class Closers {
  private found = new Map<string, number>()
  private s: string
  private limit: number
  constructor(s: string, limit: number) { this.s = s; this.limit = limit }

  /** Past the first line matching `re` (made for `key`) after the line at `pos`, or -1. */
  after(key: string, make: () => RegExp, pos: number) {
    const from = nextLine(this.s, pos)
    let i = this.found.get(key)
    if (i === undefined || i < from) {
      const re = make()
      re.lastIndex = from
      const m = re.exec(this.s)
      this.found.set(key, i = m && m.index < this.limit ? m.index : Infinity)
    }
    return i === Infinity ? -1 : Math.min(nextLine(this.s, i), this.limit)
  }
}

/** Past a block or drawer starting at `pos` (lines a list doesn't look into), or -1. */
function skipRegion(s: string, pos: number, closers: Closers) {
  const b = at(BLOCK, s, pos)
  if (b) {
    const name = b[1]?.toLowerCase()
    return closers.after(`#${name ?? ":"}`, () => new RegExp(`^[ \\t]*#\\+end${name ? `_${escape(name)}` : ":"}[ \\t]*$`, "gim"), pos)
  }
  if (at(DRAWER, s, pos)) return closers.after(":end:", () => /^[ \t]*:end:[ \t]*$/gim, pos)
  return -1
}

/** Every item of the list starting at `pos`, nested ones too, with where each ends. A line ends the items indented as
 *  much or more (headlines and inline tasks, at column 0, end them all); two blank lines end the whole list. */
function scan(s: string, pos: number, limit: number): ListStruct {
  const st = new ListStruct(), open: Item[] = [], closers = new Closers(s, limit)
  const close = (it: Item, at: number) => { it.end = backBlank(s, at, it.begin) }
  let p = pos, blanks = 0, stop = limit
  while (p < limit) {
    if (blankLine(s, p)) {
      if (++blanks === 2) { stop = p; break }
      p = nextLine(s, p)
      continue
    }
    blanks = 0
    const it = itemLine(s, p)
    if (it) {
      let last: Item | null = null
      while (open.length && open[open.length - 1].ind >= it.ind) close(last = open.pop()!, p)
      if (last && last.ind === it.ind) last.next = it
      else if (!open.length && st.items.size) { stop = p; break }
      open.push(it)
      st.items.set(p, it)
    } else {
      const ind = indentation(s, p)
      while (open.length && open[open.length - 1].ind >= ind) close(open.pop()!, p)
      if (!open.length) { stop = p; break }
      const past = skipRegion(s, p, closers)
      if (past > p) { p = past; continue }
    }
    p = nextLine(s, p)
  }
  for (const it of open) close(it, stop)
  return st
}

/** The plain list starting at `pos`, or null when no item starts there. Its `struct` is handed to its items. */
export function plainListAt(ctx: Ctx, pos: number, limit: number, aff: Affiliated, struct?: unknown): OrgNode | null {
  const st = struct instanceof ListStruct && struct.items.has(pos) ? struct : itemLine(ctx.s, pos) ? scan(ctx.s, pos, limit) : null
  if (!st) return null
  const first = st.items.get(pos)!
  let last = first
  while (last.next) last = last.next
  const [end, postBlank] = skipBlank(ctx.s, last.end, limit)
  const kind = first.ordered ? "ordered" : first.tag ? "descriptive" : "unordered"
  return node("plain-list", aff.begin, end, { contentsBegin: pos, contentsEnd: last.end, postBlank, postAffiliated: pos, ...aff.props,
    kind, struct: st })
}

const newlines = (s: string, from: number, to: number) => {
  let n = 0
  for (let i = s.indexOf("\n", from); i >= 0 && i < to; i = s.indexOf("\n", i + 1)) n++
  return n
}

/** The item at `pos` of the list whose structure is `struct`. */
export function item(ctx: Ctx, pos: number, limit: number, struct: unknown): OrgNode {
  const s = ctx.s
  const it = (struct instanceof ListStruct ? struct : scan(s, pos, limit)).items.get(pos)
  if (!it) throw new Error(`org: no item at ${pos}`)
  const end = it.next ? it.next.begin : it.end
  // Contents start after the bullet's line prefix, or on the next line that isn't blank.
  let contentsBegin: number | null = it.prefixEnd
  if (contentsBegin >= eol(s, it.begin)) contentsBegin = skipBlank(s, nextLine(s, it.begin), it.end)[0]
  if (contentsBegin >= it.end) contentsBegin = null
  const contentsEnd = contentsBegin === null ? null : it.end
  return node("item", pos, end, { contentsBegin, contentsEnd, postBlank: newlines(s, contentsEnd ?? it.prefixEnd, end), postAffiliated: pos,
    bullet: it.bullet, checkbox: it.checkbox, counter: it.counter, preBlank: contentsBegin === null ? 0 : newlines(s, it.prefixEnd, contentsBegin),
    tag: it.tag ? ctx.objects(it.tag[0], it.tag[1], "item") : null, struct })
}

/** An item's line ends a paragraph before it; so does an unindented `*` bullet, though it's no item. */
export function starts(ctx: Ctx, pos: number, limit: number) {
  return pos < limit && !!at(BULLET, ctx.s, pos)
}
