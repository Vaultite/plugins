// A Markdown list as a tree of lines: an item is its line and the lines under it indented deeper (its text's next
// lines, its children). Pure, on an array of lines, so the tests run it without an editor.
const ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+(\[.\][ \t]+)?|$)/

/** A change: lines `from`..`to` (0-based, `to` not included) become `lines`; a place in the item that moved goes `d`
 *  lines down (up when negative) and `shift` columns right. */
export type Edit = { from: number; to: number; lines: string[]; d: number; shift: number }

const indentOf = (l: string) => /^[ \t]*/.exec(l)![0]
const cols = (s: string) => { let n = 0; for (const c of s) n = c === "\t" ? n + 4 - (n % 4) : n + 1; return n }
const blank = (l: string) => !l.trim()
export const isItem = (l: string) => ITEM.test(l)
/** Where the item's text starts on its line (after the marker and a task's checkbox). */
export const textStart = (l: string) => ITEM.exec(l)?.[0].length ?? 0

/** The end of item `k`'s block: the first line after it (its own trailing blank lines left out). */
export function end(lines: string[], k: number) {
  const at = cols(indentOf(lines[k]))
  let last = k
  for (let j = k + 1; j < lines.length; j++) {
    if (blank(lines[j])) continue
    if (cols(indentOf(lines[j])) <= at) break
    last = j
  }
  return last + 1
}

/** The item line `n` belongs to (its own line, or the item it's under), or -1. */
export function itemAt(lines: string[], n: number) {
  for (let k = n; k >= 0; k--) {
    if (isItem(lines[k]) && end(lines, k) > n) return k
    if (!blank(lines[k]) && !isItem(lines[k]) && cols(indentOf(lines[k])) === 0 && k < n) return -1
  }
  return -1
}

/** The item before `k` at its level with nothing between them (its sibling), or -1. */
export function previous(lines: string[], k: number) {
  const at = cols(indentOf(lines[k]))
  for (let j = k - 1; j >= 0; j--) {
    if (blank(lines[j])) continue
    const c = cols(indentOf(lines[j]))
    if (c < at) return -1
    if (c === at) return isItem(lines[j]) ? j : -1
  }
  return -1
}
export function next(lines: string[], k: number) {
  let j = end(lines, k)
  while (j < lines.length && blank(lines[j])) j++
  return j < lines.length && isItem(lines[j]) && cols(indentOf(lines[j])) === cols(indentOf(lines[k])) ? j : -1
}
/** The item `k` is a child of, or -1. */
export function parent(lines: string[], k: number) {
  const at = cols(indentOf(lines[k]))
  for (let j = k - 1; j >= 0; j--) {
    if (blank(lines[j])) continue
    const c = cols(indentOf(lines[j]))
    if (c < at) return isItem(lines[j]) ? j : -1
  }
  return -1
}

/** Item `a` and its next sibling `b` swapped, their numbers (an ordered list's) staying in place. */
function swap(lines: string[], a: number, b: number): Edit {
  const ae = end(lines, a), be = end(lines, b)
  const A = lines.slice(a, ae), gap = lines.slice(ae, b), B = lines.slice(b, be)
  const num = (l: string) => /^[ \t]*(\d+)[.)]/.exec(l)?.[1]
  const na = num(A[0]), nb = num(B[0])
  if (na && nb) { A[0] = A[0].replace(na, nb); B[0] = B[0].replace(nb, na) }
  return { from: a, to: be, lines: [...B, ...gap, ...A], d: 0, shift: 0 }
}

/** Item `n` is in, with its children, moved above its previous sibling (`dir` -1) or below its next. */
export function move(lines: string[], n: number, dir: -1 | 1): Edit | null {
  const k = itemAt(lines, n)
  const o = k < 0 ? -1 : dir < 0 ? previous(lines, k) : next(lines, k)
  if (o < 0) return null
  const e = dir < 0 ? swap(lines, o, k) : swap(lines, k, o)
  return { ...e, d: dir < 0 ? o - k : end(lines, o) - end(lines, k) }
}

/** Lines `a`..`b` with the indent `was` (each one's start) made `now`. */
const reindent = (lines: string[], a: number, b: number, was: string, now: string) =>
  lines.slice(a, b).map((l) => (blank(l) || !l.startsWith(was) ? l : now + l.slice(was.length)))

/** Item `n` is in, with its children, made the last child of its previous sibling (indented as that one's children
 *  are, or under its text). */
export function indent(lines: string[], n: number): Edit | null {
  const k = itemAt(lines, n)
  const p = k < 0 ? -1 : previous(lines, k)
  if (p < 0) return null
  const child = lines.slice(p + 1, k).find((l) => !blank(l) && isItem(l))
  const was = indentOf(lines[k]), e = end(lines, k)
  // (tabs where these lines indent with them; else spaces to the sibling's text)
  const tabs = lines.slice(p, e).some((l) => indentOf(l).includes("\t"))
  const now = child ? indentOf(child) : indentOf(lines[p]) + (tabs ? "\t" : " ".repeat(ITEM.exec(lines[p])![2].length + 1))
  return { from: k, to: e, lines: reindent(lines, k, e, was, now), d: 0, shift: now.length - was.length }
}

/** Item `n` is in, with its children, made its parent's next sibling: after the parent's other children. */
export function outdent(lines: string[], n: number): Edit | null {
  const k = itemAt(lines, n)
  const p = k < 0 ? -1 : parent(lines, k)
  if (p < 0) return null
  const was = indentOf(lines[k]), now = indentOf(lines[p])
  const e = end(lines, k), pe = end(lines, p)
  const rest = lines.slice(e, pe)
  return { from: k, to: pe, lines: [...rest, ...reindent(lines, k, e, was, now)], d: rest.length, shift: now.length - was.length }
}

/** The whole list item `n` is in: from its first top-level item to the end of its last. */
export function list(lines: string[], n: number): [number, number] | null {
  let k = itemAt(lines, n)
  if (k < 0) return null
  for (let p = parent(lines, k); p >= 0; p = parent(lines, k)) k = p
  let a = k, b = k
  for (let s = previous(lines, a); s >= 0; s = previous(lines, a)) a = s
  for (let s = next(lines, b); s >= 0; s = next(lines, b)) b = s
  return [a, end(lines, b)]
}
