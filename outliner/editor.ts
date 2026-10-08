// The list item under the cursor in a note's editor: found in the syntax tree (so never in code or the frontmatter),
// moved and indented with its children as tree.ts says, the cursor going with it.
import { completionStatus } from "@codemirror/autocomplete"
import { foldedRanges, syntaxTree } from "@codemirror/language"
import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import * as L from "./tree"

const linesOf = (state: EditorState) => state.doc.toString().split("\n")

/** Whether line `n` (0-based) starts a list item in the syntax tree. */
function listLine(state: EditorState, n: number) {
  const line = state.doc.line(n + 1)
  const at = line.from + /^[ \t]*/.exec(line.text)![0].length
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1); node && node.from === at; node = node.parent) {
    if (node.name === "ListItem") return true
  }
  return false
}

/** The item the cursor's line is in (0-based line numbers), if it's a list item; nothing when there are several cursors. */
export function itemHere(state: EditorState) {
  if (state.selection.ranges.length > 1) return null
  const n = state.doc.lineAt(state.selection.main.head).number - 1
  const lines = linesOf(state)
  const k = L.itemAt(lines, n)
  return k >= 0 && listLine(state, k) ? { lines, n, k } : null
}

/** Apply `op` to the item at the cursor; whether it applied (false: no item there, or nothing it can do). */
export function apply(view: EditorView, op: (lines: string[], n: number) => L.Edit | null) {
  const here = itemHere(view.state)
  const e = here && op(here.lines, here.n)
  if (!e) return false
  const { doc } = view.state
  const from = doc.line(e.from + 1).from, to = doc.line(e.to).to
  const changes = view.state.changes({ from, to, insert: e.lines.join("\n") })
  const starts = [from]
  for (const l of e.lines) starts.push(starts[starts.length - 1] + l.length + 1)
  // A place in the item goes with it (line by line, shifted as its indent is); others as the change maps them.
  const a = here.k, b = L.end(here.lines, a)
  const place = (pos: number) => {
    const l = doc.lineAt(pos), i = l.number - 1
    if (i < a || i >= b) return changes.mapPos(pos)
    const j = i + e.d - e.from
    return Math.min(starts[j] + Math.max(0, pos - l.from + e.shift), starts[j + 1] - 1)
  }
  const r = view.state.selection.main
  view.dispatch({ changes, selection: EditorSelection.range(place(r.anchor), place(r.head)), scrollIntoView: true, userEvent: "input" })
  return true
}

const ready = (view: EditorView) => view.state.facet(EditorView.editable) && completionStatus(view.state) !== "active"
/** One line selected at most: several are the editor's (its Tab indents each). */
const oneLine = (r: SelectionRange, state: EditorState) => state.doc.lineAt(r.from).number === state.doc.lineAt(r.to).number

/** Tab and Shift-Tab in an item: it and its children; where it can't go, nothing (rather than a line out of the list). */
const tab = (op: typeof L.indent) => (view: EditorView) => {
  if (!ready(view) || !oneLine(view.state.selection.main, view.state) || !itemHere(view.state)) return false
  apply(view, op)
  return true
}

const EMPTY = /^[ \t]*([-*+]|\d+[.)])([ \t]+\[.\])?[ \t]*$/
/** Enter on an empty item: out a level, or out of the list from the top level. */
function enter(view: EditorView) {
  const { state } = view, r = state.selection.main
  const line = state.doc.lineAt(r.head)
  if (!ready(view) || !r.empty || r.head !== line.to || !EMPTY.test(line.text) || !itemHere(state)) return false
  if (apply(view, L.outdent)) return true
  view.dispatch({ changes: { from: line.from, to: line.to }, userEvent: "delete" })
  return true
}

/** ⌘A in an item: its text, then the whole list, then (the editor's) everything. */
function selectAll(view: EditorView) {
  const { state } = view, r = state.selection.main
  const here = itemHere(state)
  if (!here) return false
  const line = state.doc.line(here.k + 1)
  const text = EditorSelection.range(line.from + L.textStart(line.text), line.to)
  const [a, b] = L.list(here.lines, here.n)!
  const all = EditorSelection.range(state.doc.line(a + 1).from, state.doc.line(b).to)
  const has = (s: SelectionRange) => r.from <= s.from && r.to >= s.to
  const pick = !has(text) ? text : !has(all) ? all : null
  if (!pick) return false
  view.dispatch({ selection: pick, userEvent: "select" })
  return true
}

export const listKeys = keymap.of([
  { key: "Tab", run: tab(L.indent) }, { key: "Shift-Tab", run: tab(L.outdent) },
  { key: "Enter", run: enter }, { key: "Mod-a", run: selectAll },
])

/** Whether the cursor's line is folded (the Folding plugin's fold), or could be: an item with lines under it. */
export function foldable(state: EditorState) {
  const here = itemHere(state)
  if (!here || here.k !== here.n) return null
  const at = state.doc.line(here.n + 1).to
  let folded = false
  foldedRanges(state).between(at, at, (from) => { if (from === at) folded = true })
  return folded ? "folded" : L.end(here.lines, here.k) > here.k + 1 ? "open" : null
}
