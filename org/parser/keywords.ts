// Keywords (#+KEY: value), babel calls (#+CALL:), and the affiliated keywords an element collects above it.
import { node, type OrgNode } from "./ast.ts"
import type { Affiliated, Ctx } from "./driver.ts"
import { at, eol, nextLine, skipBlank } from "./text.ts"

const AFFILIATED = new RegExp(String.raw`[ \t]*#\+(?:(caption|results)\[([^\n]*)\]|(caption|data|header|headers|label|name|plot|resname|result|results|source|srcname|tblname|attr_[-_A-Za-z0-9]+)):[ \t]*`, "iy")
const ALIAS: Record<string, string> = { DATA: "NAME", LABEL: "NAME", RESNAME: "NAME", SOURCE: "NAME", SRCNAME: "NAME", TBLNAME: "NAME",
  RESULT: "RESULTS", HEADERS: "HEADER" }
const KEYWORD = /[ \t]*#\+(\S+):[ \t]*/y
const TRAIL = /[ \t\r\f\v]+$/

/** Where a line's value ends once trailing whitespace is dropped. */
function trimEnd(s: string, from: number) {
  let e = eol(s, from)
  while (e > from && /[ \t\r\f\v]/.test(s[e - 1])) e--
  return e
}

export const noAffiliated = (pos: number): Affiliated => ({ begin: pos, at: pos, props: {} })

/** The affiliated keywords from `pos`: where they start (`begin`), where the element after them is (`at`), their props. */
export function collectAffiliated(ctx: Ctx, pos: number, limit: number): Affiliated {
  const s = ctx.s, props: Record<string, unknown> = {}
  let p = pos
  for (let m; p < limit && (m = at(AFFILIATED, s, p)); p = nextLine(s, p)) {
    const raw = (m[1] ?? m[3]).toUpperCase(), key = ALIAS[raw] ?? raw
    const vBegin = p + m[0].length, vEnd = trimEnd(s, vBegin), value = s.slice(vBegin, vEnd)
    const optAt = m[2] === undefined ? -1 : p + m[0].indexOf("[") + 1
    if (key === "CAPTION") {
      const val = value ? ctx.objects(vBegin, vEnd, "keyword") : null
      const short = m[2] ? ctx.objects(optAt, optAt + m[2].length, "keyword") : null
      const list = (props.caption ??= []) as unknown[]
      list.push(val || short ? [val, ...(short ?? [])] : null)
    } else if (key === "RESULTS") props.results = m[2] ? [value, m[2]] : [value]
    else if (key === "HEADER") ((props.header ??= []) as string[]).push(value)
    else if (key.startsWith("ATTR_")) {
      const attrs = (props.properties ??= {}) as Record<string, string[]>
      ;(attrs[key.toLowerCase()] ??= []).push(value)
    }
    else props[key.toLowerCase()] = value
  }
  return { begin: pos, at: p, props }
}

/** Whether the line at `pos` is a keyword line (`#+KEY:`) that ends a paragraph above it. */
export function keywordStarts(s: string, pos: number) {
  const m = at(KEYWORD, s, pos)
  if (!m) return false
  // A non-dual key with an [option] doesn't.
  const opt = /^(\S+?)\[.*\]$/.exec(m[1])
  return !opt || /^(caption|results)$/i.test(opt[1])
}

/** The keyword line at `pos` (#+KEY: value), or a babel call for #+CALL:. */
export function keywordAt(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode | null {
  const m = at(KEYWORD, ctx.s, pos)
  if (!m) return null
  return m[1].toUpperCase() === "CALL" ? babelCall(ctx, pos, limit, aff) : keyword(ctx, pos, limit, aff)
}

export function keyword(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode {
  const s = ctx.s, m = at(KEYWORD, s, pos)!
  const vBegin = pos + m[0].length
  const [end, postBlank] = skipBlank(s, nextLine(s, pos), limit)
  return node("keyword", aff.begin, end, { postBlank, postAffiliated: pos, ...aff.props,
    key: m[1].toUpperCase(), value: s.slice(vBegin, eol(s, vBegin)).replace(TRAIL, "") })
}

const closers = new WeakMap<Ctx, Map<number, number>>()

/** The bracketed text from `open` (at `[` or `(`), nesting of its own kind counted, across lines: [inside, after], or
 *  null. Every bracket's match is found in one pass, the first time one is asked for. */
function balanced(ctx: Ctx, open: number): [string, number] | null {
  const s = ctx.s
  let m = closers.get(ctx)
  if (!m) {
    m = new Map()
    const round: number[] = [], square: number[] = []
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === "(") round.push(i)
      else if (c === "[") square.push(i)
      else if (c === ")" && round.length) m.set(round.pop()!, i)
      else if (c === "]" && square.length) m.set(square.pop()!, i)
    }
    closers.set(ctx, m)
  }
  const close = m.get(open)
  return close === undefined ? null : [s.slice(open + 1, close), close + 1]
}

/** #+CALL: name[inside](arguments)[end]. A name filling its line takes the newline, and what follows on the next line. */
function babelCall(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode {
  const s = ctx.s, colon = s.indexOf(":", pos) + 1, lineEnd = eol(s, pos)
  const value = s.slice(colon, lineEnd).trim()
  let p = colon
  while (s[p] === " " || s[p] === "\t") p++
  const nameAt = p
  while (p < lineEnd && !"[]()".includes(s[p])) p++
  let call: string | null = s.slice(nameAt, p)
  if (p === lineEnd) {
    if (p < s.length) { call += "\n"; p++ }
    if (!call.trim()) call = null
  } else if (!call) call = null
  let inside: string | null = null, args: string | null = null
  const ih = s[p] === "[" ? balanced(ctx, p) : null
  if (ih) [inside, p] = ih
  const ar = s[p] === "(" ? balanced(ctx, p) : null
  if (ar) { args = ar[0] || null; p = ar[1] }
  const rest = s.slice(p, eol(s, p)).trim()
  const last = nextLine(s, p > lineEnd ? p : pos)
  const [end] = skipBlank(s, last, limit)
  const postBlank = countLines(s, nextLine(s, pos), end)
  return node("babel-call", aff.begin, end, { postBlank, postAffiliated: pos, ...aff.props,
    call, insideHeader: inside, arguments: args, endHeader: rest || null, value })
}

function countLines(s: string, from: number, to: number) {
  let n = 0
  for (let p = from; p < to; p = nextLine(s, p)) n++
  return n
}
