// Text markup (bold, italic, underline, strike-through, verbatim, code) and subscripts and superscripts.
import type { OrgNode } from "../ast.ts"
import { cpAt, cpBefore, isSpace } from "./chars.ts"
import { balanced, match, memo, obj, withContents, type Lex } from "./lex.ts"

const TYPES: Record<string, string> = { "*": "bold", "/": "italic", "_": "underline", "+": "strike-through", "=": "verbatim", "~": "code" }
const PRE = new Set(["-", "(", "{", "'", '"'].map((c) => c.charCodeAt(0)))
const POST = new Set(["-", ".", ",", ":", "!", "?", ";", "'", '"', ")", "}", "\\", "["].map((c) => c.charCodeAt(0)))

/** Markup at `pos` (s[pos] is a marker): it closes at the first marker after a non-blank that a border may follow. */
export function emphasis(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L, m = s[pos], type = TYPES[m]
  const before = cpBefore(s, pos, L.begin)
  if (before >= 0 && !isSpace(before) && !PRE.has(before)) return null
  if (pos + 1 >= end || isSpace(cpAt(s, pos + 1))) return null
  const q = closer(L, m, pos + 2)
  if (q < 0) return null
  if (m === "=" || m === "~") return obj(type, pos, q + 1, { value: s.slice(pos + 1, q) })
  return withContents(L, type, pos, q + 1, pos + 1, q)
}

const closes = (s: string, q: number, end: number) =>
  !isSpace(cpBefore(s, q)) && (q + 1 >= end || isSpace(cpAt(s, q + 1)) || POST.has(cpAt(s, q + 1)))

/** The first marker `m` from `from` that may close markup: after a non-blank, before a border or the container's end. */
function closer(L: Lex, m: string, from: number): number {
  const { s, end } = L
  // Indexed once per document (the container's end aside), so unclosed markers don't rescan the rest.
  const all = memo(L, `closers${m}`, () => {
    const out: number[] = []
    for (let q = s.indexOf(m, 1); q >= 0; q = s.indexOf(m, q + 1)) if (closes(s, q, s.length)) out.push(q)
    return out
  })
  let lo = 0, hi = all.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] < from) lo = mid + 1; else hi = mid }
  const q = lo < all.length && all[lo] < end ? all[lo] : -1
  const last = end - 1
  return s[last] === m && last >= from && (q < 0 || last < q) && closes(s, last, end) ? last : q
}

const SCRIPT = /[+-]?[\p{L}\p{Nd},.\\]*[\p{L}\p{Nd}]/uy

/** A subscript or superscript at `pos` (s[pos] is `_` or `^`), after a character that isn't blank. */
export function script(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L, type = s[pos] === "_" ? "subscript" : "superscript"
  const before = cpBefore(s, pos, L.begin)
  if (before < 0 || isSpace(before) || pos + 1 >= end) return null
  const c = s[pos + 1]
  if (c === "*") return withContents(L, type, pos, pos + 2, pos + 1, pos + 2)
  if (c === "{" || c === "(") {
    const close = balanced(L, pos + 1, c, c === "{" ? "}" : ")", 3)
    if (close < 0) return null
    return c === "{" ? withContents(L, type, pos, close + 1, pos + 2, close, { useBracketsP: true })
      : withContents(L, type, pos, close + 1, pos + 1, close + 1)
  }
  // A superscript is only looked for when a sign, a dot, a comma or a letter or digit follows the caret.
  if (type === "superscript" && c === "\\") return null
  const m = match(SCRIPT, s, pos + 1, end)
  if (!m) return null
  const e = pos + 1 + m[0].length
  return withContents(L, type, pos, e, pos + 1, e)
}
