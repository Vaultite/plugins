// Objects in brackets or with a keyword: footnote references, citations, statistics cookies, macros, export
// snippets, inline babel calls and inline source blocks.
import type { OrgChild, OrgNode } from "../ast.ts"
import { cpAt, cpBefore, isWord, width, wordStart } from "./chars.ts"
import { balanced, match, nextIndex, obj, text, withContents, type Lex } from "./lex.ts"

/** `[fn:label]`, `[fn:label:definition]` or `[fn::definition]` (brackets balanced in the definition). */
export function footnoteReference(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  if (!s.startsWith("[fn:", pos)) return null
  let i = pos + 4
  for (let c = cpAt(s, i); i < end && (c === 45 || c === 95 || isWord(c)); c = cpAt(s, i)) i += width(c)
  const label = i > pos + 4 ? s.slice(pos + 4, i) : null
  if (i >= end) return null
  if (s[i] === "]" && label) return obj("footnote-reference", pos, i + 1, { label, kind: "standard" })
  if (s[i] !== ":") return null
  const close = balanced(L, pos, "[", "]")
  if (close < 0) return null
  return withContents(L, "footnote-reference", pos, close + 1, i + 1, close, { label, kind: "inline" })
}

const STATS = /\[(?:\d*%|\d*\/\d*)\]/y

export function statisticsCookie(L: Lex, pos: number): OrgNode | null {
  const m = match(STATS, L.s, pos, L.end)
  return m ? obj("statistics-cookie", pos, pos + m[0].length, { value: m[0] }) : null
}

const CITE = /\[cite(?:\/([-/_\p{L}\p{Nd}]+))?:[ \t\n]*/uy
const KEY = /[-!#-+./:<>-@^-`{-~\p{L}\p{Nd}\p{M}]+/uy

/** `[cite/style: prefix; refs; suffix]`: the prefix ends at the last `;` before the first `@key`, the suffix starts
 * after the last `;` when no key follows; between them each key and its text up to a `;` is a reference. */
export function citation(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  const m = match(CITE, s, pos, end)
  if (!m) return null
  const close = balanced(L, pos, "[", "]")
  if (close < 0) return null
  const cb = pos + m[0].length
  let ce = close
  while (ce > cb && /[ \t\n]/.test(s[ce - 1])) ce--
  const first = keyAt(L, cb, ce)
  if (!first) return null
  const semi = lastIn(s, cb, first.at), refsBegin = semi >= 0 ? semi + 1 : cb
  const last = lastIn(s, cb, ce), hasSuffix = last >= refsBegin && !keyAt(L, last + 1, ce), refsEnd = hasSuffix ? last + 1 : ce
  const refs: OrgChild[] = []
  for (let start = refsBegin, key = keyAt(L, start, refsEnd); start < refsEnd; key = keyAt(L, start, refsEnd)) {
    // Text after the last reference with no key of its own stays as it is.
    if (!key) { refs.push(text(s, start, refsEnd)); break }
    const sep = nextIndex(L, ";", key.end), stop = sep >= 0 && sep < refsEnd ? sep : refsEnd, e = stop < refsEnd ? stop + 1 : refsEnd
    refs.push(obj("citation-reference", start, e, { key: key.key, prefix: secondary(L, start, key.at), suffix: secondary(L, key.end, stop) }))
    start = e
  }
  return obj("citation", pos, close + 1, { contentsBegin: refsBegin, contentsEnd: refsEnd, style: m[1] ?? null,
    prefix: semi >= 0 ? secondary(L, cb, semi) : null, suffix: hasSuffix ? secondary(L, last + 1, ce) : null, children: refs })
}

/** The last `;` in [from, to), or -1. */
function lastIn(s: string, from: number, to: number) {
  for (let i = to - 1; i >= from; i--) if (s[i] === ";") return i
  return -1
}

/** The first `@key` in [from, to). */
function keyAt(L: Lex, from: number, to: number) {
  for (let at = nextIndex(L, "@", from); at >= 0 && at < to; at = nextIndex(L, "@", at + 1)) {
    const k = match(KEY, L.s, at + 1, to)
    if (k) return { at, end: at + 1 + k[0].length, key: k[0] }
  }
  return null
}

const secondary = (L: Lex, b: number, e: number) => (b < e ? L.ctx.objects(b, e, "citation-reference") : null)

const MACRO = /\{\{\{([A-Za-z][-\w]*)(\}\}\}|\()/y

/** `{{{name}}}` or `{{{name(args)}}}` (up to the first `)}}}`): arguments split at commas not escaped by a backslash. */
export function macro(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  const m = match(MACRO, s, pos, end)
  if (!m) return null
  let e = pos + m[0].length, args: string[] | null = null
  if (m[2] === "(") {
    const close = nextIndex(L, ")}}}", e)
    if (close < 0 || close + 4 > end) return null
    args = macroArgs(s.slice(e, close))
    e = close + 4
  }
  return obj("macro", pos, e, { key: m[1].toLowerCase(), value: s.slice(pos, e), args })
}

function macroArgs(raw: string): string[] {
  const t = raw.replace(/\s+/g, " ").trim(), out: string[] = []
  let cur = ""
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\") {
      let j = i
      while (t[j] === "\\") j++
      const n = j - i
      if (t[j] === ",") { cur += "\\".repeat(n >> 1) + (n & 1 ? "," : ""); if (!(n & 1)) { out.push(cur); cur = "" } i = j; continue }
      cur += t.slice(i, j); i = j - 1; continue
    }
    if (t[i] === ",") { out.push(cur); cur = ""; continue }
    cur += t[i]
  }
  out.push(cur)
  return out
}

const SNIPPET = /@@([-A-Za-z0-9]+):/y

/** `@@back-end:value@@`, up to the first `@@`. */
export function exportSnippet(L: Lex, pos: number): OrgNode | null {
  const m = match(SNIPPET, L.s, pos, L.end)
  if (!m) return null
  const close = nextIndex(L, "@@", pos + m[0].length)
  return close < 0 || close + 2 > L.end ? null
    : obj("export-snippet", pos, close + 2, { backEnd: m[1], value: L.s.slice(pos + m[0].length, close) })
}

const CALL = /call_([^\s[(]+)/y

/** `call_name[header](args)[header]`: brackets and parentheses balanced. */
export function inlineBabelCall(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  if (!wordStart(cpBefore(s, pos, L.begin), s.charCodeAt(pos))) return null
  const m = match(CALL, s, pos, end)
  if (!m) return null
  let i = pos + m[0].length
  const inside = group(L, i, "[", "]")
  if (inside) i = inside.end
  const args = group(L, i, "(", ")")
  if (!args) return null
  i = args.end
  const after = group(L, i, "[", "]")
  if (after) i = after.end
  return obj("inline-babel-call", pos, i, { call: m[1], insideHeader: header(inside), arguments: args.value || null,
    endHeader: header(after), value: s.slice(pos, i) })
}

const SRC = /src_([^\s[{]+)/y

/** `src_lang[headers]{body}`: brackets and braces balanced. */
export function inlineSrcBlock(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  if (!wordStart(cpBefore(s, pos, L.begin), s.charCodeAt(pos))) return null
  const m = match(SRC, s, pos, end)
  if (!m) return null
  let i = pos + m[0].length
  const params = group(L, i, "[", "]")
  if (params) i = params.end
  const body = group(L, i, "{", "}")
  if (!body) return null
  return obj("inline-src-block", pos, body.end, { language: m[1], value: body.value, parameters: header(params) })
}

/** Header arguments on one line: a newline and the indentation after it are a space; trimmed; null when empty. */
const header = (g: { value: string } | null) => g?.value.replace(/\n[ \t]*/g, " ").trim() || null

/** A balanced group opening at `pos`: its inside and where it ends. */
function group(L: Lex, pos: number, open: string, close: string) {
  if (L.s[pos] !== open) return null
  const c = balanced(L, pos, open, close)
  return c < 0 ? null : { value: L.s.slice(pos + 1, c), end: c + 1 }
}
