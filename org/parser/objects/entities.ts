// What starts with a backslash or a dollar: entities (\alpha), LaTeX fragments (\cmd{..}, \(..\), $..$) and line breaks.
import type { OrgNode } from "../ast.ts"
import { cpAt, cpBefore, isAlpha, isSpace, syntax, width } from "./chars.ts"
import { ENTITIES } from "./entities-data.ts"
import { match, nextIndex, obj, type Lex } from "./lex.ts"

const BY_NAME = new Map<string, (typeof ENTITIES)[number]>()
for (const e of ENTITIES) if (!BY_NAME.has(e[0])) BY_NAME.set(e[0], e)
// Names with digits are tried first, then the letters: the first followed by `{}` or no letter is the name.
const DIGIT_NAMES = ENTITIES.map((e) => e[0]).filter((n) => /\d/.test(n))
const LETTERS = /\\([A-Za-z]+)/y
const SPACES = /\\_( +)/y

/** An entity at `pos`: a known name, then `{}` or anything but a letter. */
export function entity(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  const sp = match(SPACES, s, pos, end)
  if (sp) {
    const e = BY_NAME.get("_" + sp[1])
    return e ? make(e, pos, pos + 2 + sp[1].length, false) : null
  }
  const letters = match(LETTERS, s, pos, end)?.[1]
  if (!letters) return null
  for (const name of [...DIGIT_NAMES.filter((n) => s.startsWith(n, pos + 1) && pos + 1 + n.length <= end), letters]) {
    const after = pos + 1 + name.length, brackets = s.startsWith("{}", after) && after + 2 <= end
    if (!brackets && after < end && isAlpha(cpAt(s, after))) continue
    const e = BY_NAME.get(name)
    return e ? make(e, pos, after + (brackets ? 2 : 0), brackets) : null
  }
  return null
}

function make(e: (typeof ENTITIES)[number], begin: number, end: number, brackets: boolean): OrgNode {
  const [name, latex, latexMathP, html, ascii, latin1, utf8] = e
  return obj("entity", begin, end, { name, latex, latexMathP, html, ascii, latin1, utf8, useBracketsP: brackets })
}

const COMMAND = /\\[A-Za-z]+\*?(?:\[[^{}[\]\n]*\]|\{[^{}\n]*\})*/y

/** A LaTeX fragment at `pos` (s[pos] is `\` or `$`). */
export function latexFragment(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  let e = -1
  if (s[pos] === "$") e = dollars(L, pos)
  else if (s[pos + 1] === "(" || s[pos + 1] === "[") {
    const close = nextIndex(L, s[pos + 1] === "(" ? "\\)" : "\\]", pos + 2)
    if (close >= 0 && close + 2 <= end) e = close + 2
  } else {
    const m = match(COMMAND, s, pos, end)
    if (m) e = pos + m[0].length
  }
  return e < 0 ? null : obj("latex-fragment", pos, e, { value: s.slice(pos, e) })
}

const NOT_BORDER = new Set([".", ",", ";", "$"].map((c) => c.charCodeAt(0)))

/** `$$..$$`, `$c$` or `$b..b$`: where it ends, or -1. */
function dollars(L: Lex, pos: number): number {
  const { s, end } = L
  if (s[pos + 1] === "$") {
    const close = nextIndex(L, "$$", pos + 2)
    return close >= 0 && close + 2 <= end ? close + 2 : -1
  }
  if (cpBefore(s, pos, L.begin) === 36) return -1
  const first = cpAt(s, pos + 1), w = width(first)
  if (pos + 1 >= end || isSpace(first) || NOT_BORDER.has(first)) return -1
  const close = nextIndex(L, "$", pos + 1 + w)
  if (close < 0 || close >= end) return -1
  // One character, or a body whose last character isn't blank, `.` or `,`.
  if (close > pos + 1 + w) {
    const last = cpBefore(s, close)
    if (isSpace(last) || last === 46 || last === 44) return -1
  }
  const after = close + 1 < end ? cpAt(s, close + 1) : -1
  return after < 0 || postDollar(after) ? close + 1 : -1
}

/** What may follow a closing `$`: punctuation, brackets, quotes, blanks. */
function postDollar(c: number) {
  const k = syntax(c)
  return k === "." || k === " " || k === "(" || k === ")" || k === '"' || c === 39
}

const LINE_BREAK = /\\\\[ \t]*(\n)?/y

/** A line break `\\` at the end of a line, not after another backslash. */
export function lineBreak(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  if (cpBefore(s, pos, L.begin) === 92) return null
  const m = match(LINE_BREAK, s, pos, end)
  // The container's end counts as a line's end.
  return m && (m[1] || pos + m[0].length >= end) ? obj("line-break", pos, pos + m[0].length) : null
}
