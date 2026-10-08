// The table under the cursor in a note's editor: found in the syntax tree (so never in code), changed as cells
// (table.ts) and written back aligned, the cursor in the cell it was in or moved to.
import { completionStatus } from "@codemirror/autocomplete"
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language"
import type { ChangeSpec, EditorState, Range } from "@codemirror/state"
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import * as T from "./table"

/** A table's place: its lines (without what's before it on each: a quote's `> `, a list's indent), the cursor's row
 *  (0 the header, -1 the separator) and column, and how far into the cell's text the cursor is. */
type At = { from: number; to: number; prefix: string; lines: string[]; table: T.Table; row: number; col: number; offset: number }

const withPipe = (l: string) => (/^\s*\|/.test(l) ? l : `|${l}`)

function place(state: EditorState, from: number, to: number, pos: number): At | null {
  const first = state.doc.lineAt(from), last = state.doc.lineAt(to)
  const prefix = first.text.slice(0, from - first.from)
  const lines: string[] = []
  for (let n = first.number; n <= last.number; n++) {
    const t = state.doc.line(n).text
    if (!t.startsWith(prefix)) return null
    lines.push(t.slice(prefix.length))
  }
  const cur = state.doc.lineAt(pos), i = cur.number - first.number
  const line = withPipe(lines[i]), ch = pos - cur.from - prefix.length + line.length - lines[i].length
  const sep = lines.length > 1 && T.isSeparator(lines[1])
  const col = T.cellAt(line, ch)
  return { from: first.from, to: last.to, prefix, lines, table: T.parse(lines), row: sep && i === 1 ? -1 : sep && i > 1 ? i - 1 : i,
    col, offset: Math.max(0, ch - T.cellSpan(line, col).from) }
}

/** The table the cursor (one, nothing selected) is in; `start`: or a line `| like | this |` in a paragraph, to make one. */
export function tableAt(state: EditorState, start = false): At | null {
  const r = state.selection.main
  if (state.selection.ranges.length > 1) return null
  const tree = syntaxTree(state)
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(r.head, side); n; n = n.parent) {
      if (n.name === "Table") return state.doc.lineAt(r.anchor).number === state.doc.lineAt(r.head).number ? place(state, n.from, n.to, r.head) : null
    }
  }
  const line = state.doc.lineAt(r.head)
  if (!start || !r.empty || !/^\s*\|.*\|/.test(line.text)) return null
  const indent = /^\s*/.exec(line.text)![0].length
  const node = tree.resolveInner(line.from + indent, 1)
  return node.name === "Paragraph" && node.from === line.from + indent ? place(state, node.from, line.to, r.head) : null
}

/** Write `table` in `at`'s place, aligned, the cursor in cell (`row`, `col`): its text selected, or `offset` into it. */
export function put(view: EditorView, at: At, table: T.Table, row: number, col: number, offset?: number) {
  const lines = T.format(table).map((l) => at.prefix + l)
  const text = lines.join("\n")
  let pos = at.from
  const li = row <= 0 ? 0 : row + 1
  for (let i = 0; i < li; i++) pos += lines[i].length + 1
  const span = T.cellSpan(lines[li].slice(at.prefix.length), col)
  const a = pos + at.prefix.length + span.from, b = pos + at.prefix.length + span.to
  const anchor = offset === undefined ? a : Math.min(a + offset, b)
  view.dispatch({ changes: { from: at.from, to: at.to, insert: text }, selection: { anchor, head: offset === undefined ? b : anchor }, scrollIntoView: true, userEvent: "input" })
  return true
}

// ---------- keys ----------
const ready = (view: EditorView) => view.state.facet(EditorView.editable) && completionStatus(view.state) !== "active"

/** Tab: the next cell, or the next row's first; past the last, a new row. Shift-Tab: back. */
const tab = (back: boolean) => (view: EditorView) => {
  const at = ready(view) && tableAt(view.state, !back)
  if (!at) return false
  // (cells counted along the rows; from the separator, as if from the header's last cell or the next row's first)
  const n = at.table.aligns.length, rows = at.table.rows.length
  const to = Math.max(0, (at.row < 0 ? (back ? n : n - 1) : at.row * n + at.col) + (back ? -1 : 1))
  const row = Math.floor(to / n)
  return put(view, at, row < rows ? at.table : T.insertRow(at.table, rows), row, to % n)
}

/** Enter: the same column a row down; past the last, a new row, unless the last is empty: then it goes and the
 *  cursor leaves the table. */
function enter(view: EditorView) {
  const at = ready(view) && view.state.selection.main.empty && tableAt(view.state)
  if (!at) return false
  const rows = at.table.rows.length, row = Math.max(at.row, 0)
  if (row + 1 < rows) return put(view, at, at.table, row + 1, at.col)
  if (row > 0 && at.table.rows[row].every((c) => !c)) {
    const body = T.format(T.deleteRow(at.table, row)).map((l) => at.prefix + l).join("\n")
    const doc = view.state.doc
    // (onto the line after it when that's empty, else a new one)
    const blank = at.to < doc.length && !doc.lineAt(at.to + 1).text.trim()
    const insert = blank ? body : `${body}\n${at.prefix}`
    view.dispatch({ changes: { from: at.from, to: at.to, insert }, selection: { anchor: at.from + body.length + 1 + (blank ? 0 : at.prefix.length) }, scrollIntoView: true, userEvent: "input" })
    return true
  }
  return put(view, at, T.insertRow(at.table, rows), row + 1, at.col)
}

const keys = keymap.of([
  { key: "Tab", run: tab(false) }, { key: "Shift-Tab", run: tab(true) }, { key: "Enter", run: enter },
])

// A table's lines in a monospace font while its Markdown shows (live preview draws it otherwise), so the pipes line up.
const mono = Decoration.line({ class: "cm-vau-table-line" })
function monoLines(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = []
  const { doc } = view.state, { from, to } = view.viewport
  syntaxTree(view.state).iterate({ from, to, enter: (n) => {
    if (n.name !== "Table") return
    for (let l = doc.lineAt(n.from); ; l = doc.line(l.number + 1)) { out.push(mono.range(l.from)); if (l.to >= n.to) break }
    return false
  } })
  return Decoration.set(out)
}
const lines = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = monoLines(view) }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = monoLines(u.view) }
}, { decorations: (p) => p.decorations })

export const tableExtension = [keys, lines, EditorView.baseTheme({ ".cm-vau-table-line": { fontFamily: "var(--font-code)", fontSize: "0.9em" } })]

// ---------- commands ----------
/** A change to the table at the cursor (and the cell the cursor goes to), aligned as it's written. */
export function change(view: EditorView, fn: (t: T.Table, row: number, col: number) => [T.Table | null, number, number]) {
  const at = tableAt(view.state)
  if (!at) return
  const [t, row, col] = fn(at.table, Math.max(at.row, 0), at.col)
  if (t) put(view, at, t, Math.min(row, t.rows.length - 1), Math.max(0, Math.min(col, t.aligns.length - 1)), row === Math.max(at.row, 0) && col === at.col ? at.offset : undefined)
}

/** Every table in the note aligned, in one change. */
export function formatAll(view: EditorView) {
  const { state } = view
  const changes: ChangeSpec[] = []
  ensureSyntaxTree(state, state.doc.length, 1000)?.iterate({
    enter: (n) => {
      if (n.name !== "Table") return
      const at = place(state, n.from, n.to, n.from)
      if (at) {
        const text = T.format(at.table).map((l) => at.prefix + l).join("\n")
        if (text !== state.sliceDoc(at.from, at.to)) changes.push({ from: at.from, to: at.to, insert: text })
      }
      return false
    },
  })
  if (changes.length) view.dispatch({ changes, userEvent: "input" })
  return changes.length
}
