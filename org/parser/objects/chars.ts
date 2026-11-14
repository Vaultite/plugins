// Character classes as Emacs sees them in an Org buffer: syntax classes (whitespace, word...) from its syntax table,
// letters and digits from Unicode, line-breakable characters. All take a code point.
import { BREAKABLE, CATEGORIES, COMBINING, SCRIPTS, SEPARATING, SYNTAX } from "./chars-data.ts"

const ASCII = new Array<string>(128).fill("w")
for (const [k, r] of Object.entries(SYNTAX)) for (let i = 0; i < r.length; i += 2) for (let c = r[i]; c <= Math.min(r[i + 1], 127); c++) ASCII[c] = k
// The other characters' runs, sorted: flat [start, end] pairs, and each one's class.
const RUNS: number[] = [], RUN_CLASS: string[] = []
for (const [a, b, k] of Object.entries(SYNTAX).flatMap(([k, r]) => r.flatMap((_, i) => (i % 2 ? [] : [[r[i], r[i + 1], k] as const])))
  .filter(([, b]) => b > 127).sort((x, y) => x[0] - y[0])) { RUNS.push(a, b); RUN_CLASS.push(k) }

/** Which run of sorted, flat [start, end, ...] groups of `stride` numbers holds `c`, or -1. */
function runOf(r: readonly number[], c: number, stride = 2): number {
  let lo = 0, hi = r.length / stride - 1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (c < r[stride * m]) hi = m - 1
    else if (c > r[stride * m + 1]) lo = m + 1
    else return m
  }
  return -1
}

/** The syntax class of a character: " " whitespace, "w" word, "_" symbol, "." punctuation, "(" ")" brackets, '"' string... */
export function syntax(c: number): string {
  if (c < 128) return ASCII[c]
  const i = runOf(RUNS, c)
  return i < 0 ? "w" : RUN_CLASS[i]
}

/** Emacs's [:space:]: whitespace syntax. */
export const isSpace = (c: number) => c >= 0 && syntax(c) === " "
/** Emacs's [:word:] (\w). */
export const isWord = (c: number) => c >= 0 && syntax(c) === "w"

const ALPHA = /\p{L}/u, ALNUM = /[\p{L}\p{Nd}]/u
/** Emacs's [:alpha:] and [:alnum:]: Unicode letters (and decimal digits). */
export const isAlpha = (c: number) => c >= 0 && (c < 128 ? (c | 32) >= 97 && (c | 32) <= 122 : ALPHA.test(String.fromCodePoint(c)))
export const isAlnum = (c: number) => c >= 0 && (c < 128 ? isAlpha(c) || (c >= 48 && c <= 57) : ALNUM.test(String.fromCodePoint(c)))
/** Emacs's [:punct:]: ASCII punctuation; any other character without word syntax. */
export const isPunct = (c: number) => c >= 0 && (c < 128 ? c > 32 && c < 127 && !isAlnum(c) : syntax(c) !== "w")
/** A character a line may break at (CJK and the like). */
export const isBreakable = (c: number) => c >= 128 && runOf(BREAKABLE, c) >= 0
/** The same, as the inside of a regex character class (for the `u` flag). */
export const BREAKABLE_CLASS = BREAKABLE.map((c, i) => (i % 2 ? "-" : "") + `\\u{${c.toString(16)}}`).join("")

function scriptOf(c: number): number {
  const i = runOf(SCRIPTS, c, 3)
  return i < 0 ? -1 : SCRIPTS[3 * i + 2]
}
const hasCat = (c: number, k: string) => k === "" || (!!CATEGORIES[k] && runOf(CATEGORIES[k], c) >= 0)
const pairIn = (pairs: [string, string][], a: number, b: number) => pairs.some(([x, y]) => hasCat(a, x) && hasCat(b, y))

/** Emacs's \< : a word starts at `c` after `before` (-1 at the start). Scripts change inside words of mixed text. */
export function wordStart(before: number, c: number): boolean {
  if (!isWord(c)) return false
  if (before < 0 || !isWord(before)) return true
  if (before < 128 && c < 128) return false
  return scriptOf(before) === scriptOf(c) ? pairIn(SEPARATING, before, c) : !pairIn(COMBINING, before, c)
}

/** The code point at `i` (UTF-16 index), or -1 out of range. */
export function cpAt(s: string, i: number): number {
  return i >= 0 && i < s.length ? s.codePointAt(i)! : -1
}

/** The code point ending just before `i`, or -1 at `floor`. */
export function cpBefore(s: string, i: number, floor = 0): number {
  if (i <= floor) return -1
  const c = s.charCodeAt(i - 1)
  if (c >= 0xdc00 && c <= 0xdfff && i - 2 >= floor) {
    const h = s.charCodeAt(i - 2)
    if (h >= 0xd800 && h <= 0xdbff) return (h - 0xd800) * 0x400 + c - 0xdc00 + 0x10000
  }
  return c
}

/** Width in UTF-16 units of the code point `c`. */
export const width = (c: number) => (c > 0xffff ? 2 : 1)
