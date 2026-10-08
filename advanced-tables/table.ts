// A Markdown table as cells, and back as aligned text: pure, so the tests run it without an editor.
export type Align = "" | "left" | "center" | "right"
/** `rows[0]` is the header; the separator row is `aligns`. Every row has as many cells as there are columns. */
export type Table = { rows: string[][]; aligns: Align[] }

/** A row's cells: split on pipes not escaped with \, the outer pipes optional, each cell trimmed. */
export function cells(line: string): string[] {
  const out: string[] = []
  let cur = ""
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") { cur += "\\|"; i++ } else if (line[i] === "|") { out.push(cur); cur = "" } else cur += line[i]
  }
  out.push(cur)
  if (/^\s*$/.test(out[0]) && out.length > 1) out.shift()
  if (/^\s*$/.test(out[out.length - 1]) && out.length > 1 && /\|\s*$/.test(line)) out.pop()
  return out.map((c) => c.trim())
}

const SEP = /^\s*:?-+:?\s*$/
export const isSeparator = (line: string) => { const c = cells(line); return c.length > 0 && c.every((x) => SEP.test(x)) }
const alignOf = (c: string): Align => (c.startsWith(":") ? (c.endsWith(":") ? "center" : "left") : c.endsWith(":") ? "right" : "")

/** The table in `lines` (its header, separator and rows); without a separator, the first line as a header (a table
 *  being started: `| a | b |` then Tab). */
export function parse(lines: string[]): Table {
  const sep = lines.length > 1 && isSeparator(lines[1])
  const rows = [lines[0], ...lines.slice(sep ? 2 : 1)].map(cells)
  const n = Math.max(...rows.map((r) => r.length), sep ? cells(lines[1]).length : 0)
  const aligns = sep ? cells(lines[1]).map(alignOf) : []
  return { rows: rows.map((r) => pad(r, n, "")), aligns: pad(aligns, n, "" as Align) }
}
const pad = <T>(xs: T[], n: number, fill: T) => [...xs, ...Array<T>(Math.max(0, n - xs.length)).fill(fill)]

const wide = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic}|\p{Regional_Indicator}/u
const segmenter = new Intl.Segmenter()
/** How many columns text takes in a monospace font: CJK and emoji two, combining marks none. */
export function width(s: string) {
  let w = 0
  for (const { segment } of segmenter.segment(s)) w += wide.test(segment) ? 2 : 1
  return w
}

/** The table as aligned lines: every column as wide as its widest cell (at least 3), padded as it's aligned. */
export function format(t: Table): string[] {
  const ws = t.aligns.map((_, c) => Math.max(3, ...t.rows.map((r) => width(r[c]))))
  const line = (cs: string[]) => `| ${cs.join(" | ")} |`
  const cell = (s: string, c: number) => {
    const gap = ws[c] - width(s)
    if (t.aligns[c] === "right") return " ".repeat(gap) + s
    if (t.aligns[c] === "center") return " ".repeat(gap >> 1) + s + " ".repeat(gap - (gap >> 1))
    return s + " ".repeat(gap)
  }
  const sep = t.aligns.map((a, c) => (a === "left" || a === "center" ? ":" : "-") + "-".repeat(ws[c] - 2) + (a === "right" || a === "center" ? ":" : "-"))
  return [line(t.rows[0].map(cell)), line(sep), ...t.rows.slice(1).map((r) => line(r.map(cell)))]
}

/** Cell `c`'s text in a line (0 the first; the line starts with a pipe), trimmed: an empty one is the place after `| `. */
export function cellSpan(line: string, c: number) {
  let from = -1
  for (let i = 0, n = -1; i <= line.length; i++) {
    if (line[i] === "\\") i++
    else if (i === line.length || line[i] === "|") {
      if (from >= 0) {
        const text = line.slice(from, i)
        const a = from + text.length - text.trimStart().length, b = from + text.trimEnd().length
        return a < b ? { from: a, to: b } : { from: Math.min(from + 1, i), to: Math.min(from + 1, i) }
      }
      if (++n === c) from = i + 1
    }
  }
  return { from: line.length, to: line.length }
}

/** The cell a column of `line` is in (0 the first), counting unescaped pipes before it. */
export function cellAt(line: string, ch: number) {
  let n = 0
  const lead = /^\s*\|/.test(line)
  for (let i = 0; i < ch && i < line.length; i++) { if (line[i] === "\\") i++; else if (line[i] === "|") n++ }
  return Math.max(0, lead ? n - 1 : n)
}

// ---------- changes, each a new table ----------
const blank = (t: Table) => t.aligns.map(() => "")
export const insertRow = (t: Table, at: number): Table => ({ ...t, rows: [...t.rows.slice(0, at), blank(t), ...t.rows.slice(at)] })
export const deleteRow = (t: Table, r: number): Table => ({ ...t, rows: t.rows.filter((_, i) => i !== r) })
export const insertColumn = (t: Table, at: number): Table => ({
  rows: t.rows.map((r) => [...r.slice(0, at), "", ...r.slice(at)]), aligns: [...t.aligns.slice(0, at), "", ...t.aligns.slice(at)],
})
export const deleteColumn = (t: Table, c: number): Table => ({ rows: t.rows.map((r) => r.filter((_, i) => i !== c)), aligns: t.aligns.filter((_, i) => i !== c) })
const swap = <T>(xs: T[], a: number, b: number) => { const ys = [...xs]; [ys[a], ys[b]] = [ys[b], ys[a]]; return ys }
/** Row `r` (a body row: 1 or more) swapped with the one `d` away, if that's a body row too. */
export const moveRow = (t: Table, r: number, d: number): Table | null => (r < 1 || r + d < 1 || r + d >= t.rows.length ? null : { ...t, rows: swap(t.rows, r, r + d) })
export const moveColumn = (t: Table, c: number, d: number): Table | null => (c + d < 0 || c + d >= t.aligns.length ? null
  : { rows: t.rows.map((r) => swap(r, c, c + d)), aligns: swap(t.aligns, c, c + d) })
export const align = (t: Table, c: number, a: Align): Table => ({ ...t, aligns: t.aligns.map((x, i) => (i === c ? a : x)) })
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
/** The body rows sorted by column `c` (numbers as numbers), stable; empty cells last either way. */
export function sort(t: Table, c: number, desc = false): Table {
  const body = t.rows.slice(1).map((r, i) => ({ r, i }))
  body.sort((a, b) => {
    const x = a.r[c], y = b.r[c]
    if (!x || !y) return (x ? -1 : y ? 1 : 0) || a.i - b.i
    const nx = Number(x.replace(/,/g, "")), ny = Number(y.replace(/,/g, ""))
    const d = !isNaN(nx) && !isNaN(ny) ? nx - ny : collator.compare(x, y)
    return (desc ? -d : d) || a.i - b.i
  })
  return { ...t, rows: [t.rows[0], ...body.map((b) => b.r)] }
}
