// What every object parser gets: the text, and the container it's parsing in (its contents' bounds).
import { node, type OrgChild, type OrgNode } from "../ast.ts"
import type { Ctx } from "../driver.ts"

export type Lex = {
  ctx: Ctx
  s: string
  /** The container's contents: an object can't reach outside them, and their start counts as a line's start. */
  begin: number
  end: number
}

/** An object starting at `pos`, or null. Its `end` is before the spaces after it (the caller adds `postBlank`). */
export type ObjectParser = (L: Lex, pos: number) => OrgNode | null

export const obj = (type: string, begin: number, end: number, props: Partial<OrgNode> = {}) => node(type, begin, end, props)

/** An object holding objects: its contents parsed with its own type's restriction. */
export function withContents(L: Lex, type: string, begin: number, end: number, cb: number, ce: number, props: Partial<OrgNode> = {}): OrgNode {
  return node(type, begin, end, { contentsBegin: cb, contentsEnd: ce, ...props, children: L.ctx.objects(cb, ce, type) })
}

export const text = (s: string, begin: number, end: number): OrgChild => ({ type: "plain-text", value: s.slice(begin, end), begin, end })

/** A sticky regex matched at `pos` within [pos, end), as if the text ended at `end` (a container's end). */
export function match(re: RegExp, s: string, pos: number, end: number): RegExpExecArray | null {
  re.lastIndex = pos
  const m = re.exec(s)
  if (!m || pos + m[0].length <= end) return m
  // Too long: match again on the text cut at `end` (rare, so the copy is cheap overall).
  re.lastIndex = 0
  return re.exec(s.slice(pos, end))
}

const memos = new WeakMap<Ctx, Map<string, unknown>>()

/** A value computed once per document (indexes over its text), under `key`. */
export function memo<T>(L: Lex, key: string, build: () => T): T {
  let m = memos.get(L.ctx)
  if (!m) memos.set(L.ctx, m = new Map())
  if (!m.has(key)) m.set(key, build())
  return m.get(key) as T
}

/** Where brackets opened at `pos` (s[pos] is `open`) close, balanced, before L.end; -1 if they don't (or nest deeper). */
export function balanced(L: Lex, pos: number, open: string, close: string, maxDepth = Infinity): number {
  const c = memo(L, `pairs${open}`, () => pairs(L.s, open, close)).get(pos) ?? -1
  if (c < 0 || c >= L.end) return -1
  for (let i = pos, depth = 0; maxDepth < Infinity && i < c; i++) {
    if (L.s[i] === open) depth++
    else if (L.s[i] === close) depth--
    if (depth > maxDepth) return -1
  }
  return c
}

/** Each opening bracket's matching closing one, counting only that kind of bracket. */
function pairs(s: string, open: string, close: string): Map<number, number> {
  const out = new Map<number, number>(), stack: number[] = []
  for (let i = s.indexOf(open), j = s.indexOf(close); i >= 0 || j >= 0;) {
    if (i >= 0 && (j < 0 || i < j)) { stack.push(i); i = s.indexOf(open, i + 1) }
    else { if (stack.length) out.set(stack.pop()!, j); j = s.indexOf(close, j + 1) }
  }
  return out
}

/** The next `needle` at or after `from` (or -1): remembered, so scanning forward stays linear. */
export function nextIndex(L: Lex, needle: string, from: number): number {
  const m = memo(L, `next${needle}`, () => ({ from: Infinity, at: -1 }))
  if (from >= m.from && (m.at < 0 || m.at >= from)) return m.at
  m.from = from
  m.at = L.s.indexOf(needle, from)
  return m.at
}
