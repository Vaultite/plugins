// Headlines and what belongs to them: inline tasks, planning lines, property drawers and their node properties, and
// what the document (org-data) takes from its top property drawer.
import { node, type OrgChild, type OrgNode } from "./ast.ts"
import type { Ctx } from "./driver.ts"
import { timestampAt } from "./objects.ts"
import { at, bol, eol, nextLine, skipBlank } from "./text.ts"

/** How many stars open the headline line at `pos` (stars then a space), or 0. */
export function starsAt(s: string, pos: number): number {
  let p = pos
  while (s.charCodeAt(p) === 42) p++
  return p > pos && s.charCodeAt(p) === 32 ? p - pos : 0
}

const minLevel = (ctx: Ctx) => ctx.settings.inlinetaskMinLevel

/** Whether the starred line at `pos` is an inline task (inline tasks on, and deep enough). */
export function isInlinetask(ctx: Ctx, pos: number) {
  const min = minLevel(ctx)
  return min !== null && starsAt(ctx.s, pos) >= min
}

/** The next line in (pos, limit) opening a headline at most `maxLevel` deep (any level when omitted), or `limit`. */
export function nextHeadline(ctx: Ctx, pos: number, limit: number, maxLevel = Infinity): number {
  const s = ctx.s, min = minLevel(ctx) ?? Infinity
  for (let i = s.indexOf("\n*", pos); i >= 0 && i + 1 < limit; i = s.indexOf("\n*", i + 1)) {
    const n = starsAt(s, i + 1)
    if (n && n <= maxLevel && n < min) return i + 1
  }
  return limit
}

// After the stars: [ \t]*, a keyword followed by a space or the line's end, a priority cookie anywhere further on,
// COMMENT, the title, then tags at the line's end.
const PRIORITY = /\[#([A-Za-z0-9]|[1-5][0-9]|6[0-4])\] ?/
const TAG_CHAR = /[\p{L}\p{N}\p{M}_@#%:]/u
const isSpace = (c: string | undefined) => c === " " || c === "\t"

type Title = {
  level: number; todoKeyword: string | null; todoType: string | null; priority: number | null; commentedp: boolean
  titleBegin: number; titleEnd: number; tags: string[] | null
}

/** A headline (or inline task) line's parts. */
function titleLine(ctx: Ctx, pos: number): Title {
  const s = ctx.s, end = eol(s, pos), level = starsAt(s, pos)
  let p = pos + level + 1
  while (p < end && isSpace(s[p])) p++
  let todoKeyword: string | null = null, todoType: string | null = null
  let q = p
  while (q < end && !isSpace(s[q])) q++
  const word = s.slice(p, q), type = q > p && (q === end || s[q] === " ") ? ctx.settings.todo.get(word) : undefined
  if (type) {
    todoKeyword = word
    todoType = type
    p = q
    while (p < end && isSpace(s[p])) p++
  }
  let priority: number | null = null
  const m = PRIORITY.exec(s.slice(p, end))
  if (m) {
    priority = /\d/.test(m[1]) ? Number(m[1]) : m[1].charCodeAt(0)
    p += m.index + m[0].length
  }
  const kw = ctx.settings.commentKeyword
  const commentedp = s.startsWith(kw, p) && (p + kw.length === end || s[p + kw.length] === " ")
  if (commentedp) p += kw.length
  while (p < end && isSpace(s[p])) p++
  // Tags: the longest run of tag characters and colons at the line's end, after a space, from and to a colon.
  let e = end
  while (e > pos && isSpace(s[e - 1])) e--
  let titleEnd = e, tags: string[] | null = null
  if (s[e - 1] === ":") {
    let j = e - 1
    while (j > pos && TAG_CHAR.test(s[j - 1])) j--
    if (s[j] === ":" && e - j >= 3 && isSpace(s[j - 1])) {
      tags = s.slice(j + 1, e - 1).split(":")
      titleEnd = j
      while (titleEnd > pos && isSpace(s[titleEnd - 1])) titleEnd--
    }
  }
  return { level, todoKeyword, todoType, priority, commentedp, titleBegin: p, titleEnd, tags }
}

/** The headline's title, raw and as objects: null when it's empty right where it starts, as Emacs gives. */
function titleProps(ctx: Ctx, t: Title, type = "headline") {
  const { titleBegin: b, titleEnd: e } = t
  const title: OrgChild[] | null = e > b ? ctx.objects(b, e, type) : e < b ? [{ type: "plain-text", value: "", begin: b, end: b }] : null
  return { rawValue: e > b ? ctx.s.slice(b, e) : "", title }
}

export function headline(ctx: Ctx, pos: number, limit: number): OrgNode {
  const s = ctx.s, t = titleLine(ctx, pos)
  const end = nextHeadline(ctx, pos, limit, t.level)
  const lineEnd = Math.min(nextLine(s, pos), end)
  const [contentsBegin, preBlank] = skipBlank(s, lineEnd, end)
  const empty = contentsBegin >= end
  const { rawValue, title } = titleProps(ctx, t)
  const n = node("headline", pos, end, {
    contentsBegin: empty ? null : contentsBegin, contentsEnd: empty ? null : end, postBlank: empty ? preBlank : 0, postAffiliated: pos,
    preBlank: empty ? 0 : preBlank, rawValue, title, level: t.level, priority: t.priority, tags: t.tags,
    todoKeyword: t.todoKeyword, todoType: t.todoType, footnoteSectionP: rawValue === ctx.settings.footnoteSection,
    archivedp: !!t.tags?.includes(ctx.settings.archiveTag), commentedp: t.commentedp,
  })
  if (!preBlank) attachPlanningAndProperties(ctx, n, lineEnd, end)
  return n
}

/** The planning line and property drawer right below a headline, copied onto it as Emacs does. */
function attachPlanningAndProperties(ctx: Ctx, n: OrgNode, pos: number, limit: number) {
  const s = ctx.s
  if (pos < limit && isPlanning(ctx, pos)) {
    const end = eol(s, pos)
    // Emacs's headline reads these keywords case-insensitively, and files any it doesn't spell exactly as CLOSED.
    for (const m of s.slice(pos, end).matchAll(/(SCHEDULED|DEADLINE|CLOSED):[ \t]*/gi)) {
      const ts = timestampAt(ctx, pos + m.index + m[0].length, end)
      if (ts) n[m[1] === "SCHEDULED" ? "scheduled" : m[1] === "DEADLINE" ? "deadline" : "closed"] = ts
    }
    pos = Math.min(nextLine(s, pos), limit)
  }
  const drawer = pos < limit ? drawerLines(ctx, pos, limit) : null
  if (drawer) n.properties = nodeProperties(ctx, drawer.contentsBegin, drawer.contentsEnd)
}

export function inlinetask(ctx: Ctx, pos: number, limit: number): OrgNode {
  const s = ctx.s, t = titleLine(ctx, pos), lineEnd = Math.min(nextLine(s, pos), limit)
  // Its contents run to an END line, when the next inline task line is one (and this one isn't).
  const next = isInlineEnd(ctx, pos) ? -1 : nextInlinetask(ctx, pos, limit)
  const close = next >= 0 && isInlineEnd(ctx, next) ? next : -1
  const [contentsBegin, preBlank] = close >= 0 ? skipBlank(s, lineEnd, close) : [lineEnd, 0]
  const [end, postBlank] = skipBlank(s, close >= 0 ? Math.min(nextLine(s, close), limit) : lineEnd, limit)
  const { rawValue, title } = titleProps(ctx, t, "inlinetask")
  const n = node("inlinetask", pos, end, {
    contentsBegin: close >= 0 ? contentsBegin : null, contentsEnd: close >= 0 ? close : null, postBlank, postAffiliated: pos, preBlank,
    rawValue, title, level: t.level, priority: t.priority, tags: t.tags, todoKeyword: t.todoKeyword, todoType: t.todoType,
    archivedp: !!t.tags?.includes(ctx.settings.archiveTag), commentedp: t.commentedp,
  })
  if (close >= 0 && !preBlank) attachPlanningAndProperties(ctx, n, lineEnd, close)
  n.childMode = preBlank ? null : "planning"
  return n
}
const INLINE_END = /\*+ [ \t]*END[ \t]*(?:\n|$)/y
const isInlineEnd = (ctx: Ctx, pos: number) => !!at(INLINE_END, ctx.s, pos)

/** The next inline task line after `pos`, before the next headline and `limit`, or -1. */
function nextInlinetask(ctx: Ctx, pos: number, limit: number) {
  const s = ctx.s, min = minLevel(ctx) ?? Infinity
  for (let i = s.indexOf("\n*", pos); i >= 0 && i + 1 < limit; i = s.indexOf("\n*", i + 1)) {
    const n = starsAt(s, i + 1)
    if (n >= min) return i + 1
    if (n) return -1
  }
  return -1
}

const PLANNING_LINE = /[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/iy

export const isPlanning = (ctx: Ctx, pos: number) => !!at(PLANNING_LINE, ctx.s, pos)

export function planning(ctx: Ctx, pos: number, limit: number): OrgNode {
  const s = ctx.s, lineEnd = eol(s, pos)
  const props: Record<string, OrgNode | null> = { closed: null, deadline: null, scheduled: null }
  for (const m of s.slice(pos, lineEnd).matchAll(/(SCHEDULED|DEADLINE|CLOSED):[ \t]*/g)) {
    const ts = timestampAt(ctx, pos + m.index + m[0].length, lineEnd)
    if (ts) props[m[1].toLowerCase()] = ts
  }
  const [end, postBlank] = skipBlank(s, Math.min(nextLine(s, pos), limit), limit)
  return node("planning", pos, end, { postBlank, postAffiliated: pos, ...props })
}

const DRAWER_OPEN = /[ \t]*:PROPERTIES:[ \t]*(?:\n|$)/iy
const DRAWER_CLOSE = /[ \t]*:END:[ \t]*(?:\n|$)/iy
// A node property: :KEY: or :KEY: value, the key any non-space run, the colon after it followed by a space or the end.
const NODE_PROPERTY = /[ \t]*:(\S+):(?=[ \t\n]|$)[ \t]*([^\n]*?)[ \t]*(?:\n|$)/y

/** A property drawer's lines from `pos`: where its node properties start and end, and the line after :END:. */
function drawerLines(ctx: Ctx, pos: number, limit: number) {
  const s = ctx.s
  if (!at(DRAWER_OPEN, s, pos)) return null
  const contentsBegin = nextLine(s, pos)
  for (let p = contentsBegin; p < limit; p = nextLine(s, p)) {
    if (at(DRAWER_CLOSE, s, p)) return { contentsBegin, contentsEnd: p, after: Math.min(nextLine(s, p), limit) }
    if (!at(NODE_PROPERTY, s, p)) return null
  }
  return null
}

/** The property drawer at `pos` (every line inside a node property, closed before `limit`), or null. */
export function propertyDrawerAt(ctx: Ctx, pos: number, limit: number): OrgNode | null {
  const d = drawerLines(ctx, pos, limit)
  if (!d) return null
  const [end, postBlank] = skipBlank(ctx.s, d.after, limit)
  const empty = d.contentsBegin >= d.contentsEnd
  return node("property-drawer", pos, end, { contentsBegin: empty ? null : d.contentsBegin, contentsEnd: empty ? null : d.contentsEnd,
    postBlank, postAffiliated: pos })
}

export function nodeProperty(ctx: Ctx, pos: number, limit: number): OrgNode {
  const m = at(NODE_PROPERTY, ctx.s, pos)
  return node("node-property", pos, Math.min(nextLine(ctx.s, pos), limit), { postAffiliated: pos, key: m?.[1] ?? "", value: m?.[2] ?? "" })
}

/** The node properties in [begin, end) as Emacs copies them onto their headline: keys upper case, the last one winning,
 *  except a repeated `KEY+`, whose values make a list. */
function nodeProperties(ctx: Ctx, begin: number, end: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (let p = begin; p < end; p = nextLine(ctx.s, p)) {
    const m = at(NODE_PROPERTY, ctx.s, p)
    if (!m) continue
    const key = m[1].toUpperCase(), had = out[key]
    out[key] = key.endsWith("+") && had !== undefined ? [...(Array.isArray(had) ? had : [had]), m[2]] : m[2]
  }
  return out
}

/** Whether the line before `pos` is a headline's own line (so planning and a property drawer may follow). */
export function afterHeadlineLine(ctx: Ctx, pos: number) {
  return pos > 0 && starsAt(ctx.s, bol(ctx.s, pos - 1)) > 0
}

/** After parsing: org-data's properties, from a property drawer at the top (after blank lines, or a comment right above). */
export function documentProperties(ctx: Ctx, doc: OrgNode) {
  const first = doc.children?.[0] as OrgNode | undefined
  if (first?.type !== "section") return
  const [a, b] = (first.children ?? []) as OrgNode[]
  const drawer = a?.type === "property-drawer" ? a : a?.type === "comment" && a.postBlank === 0 && b?.type === "property-drawer" ? b : null
  if (!drawer || drawer.contentsBegin === null) return
  const props = nodeProperties(ctx, drawer.contentsBegin, drawer.contentsEnd!)
  doc.properties = { ...doc.properties, ...props }
}
