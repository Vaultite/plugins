// In a note: ticking a task (its checkbox, or Toggle checklist) writes the done date and a recurring task's next
// occurrence, in the same edit so one Undo takes both back; [/] and [-] get boxes of their own, as [x] has.
import { EditorState, type Extension, RangeSetBuilder, Transaction, type TransactionSpec } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view"
import { localToday } from "./dates.ts"
import { prefs } from "./prefs.ts"
import { changeStatus, LINE, parseTask, toggled } from "./task.ts"

/** The lines whose only change is the status: [ ] to [x] and back. */
const completion = EditorState.transactionFilter.of((tr) => {
  const ev = tr.annotation(Transaction.userEvent)
  if (!tr.docChanged || (ev !== "input.toggle" && ev !== "input") || tr.startState.doc.lines !== tr.newDoc.lines) return tr
  const touched = new Set<number>()
  tr.changes.iterChangedRanges((_a, _b, from, to) => {
    for (let n = tr.newDoc.lineAt(from).number; n <= tr.newDoc.lineAt(to).number; n++) touched.add(n)
  })
  const changes: { from: number; to: number; insert: string }[] = []
  for (const n of touched) {
    const was = tr.startState.doc.line(n).text, now = tr.newDoc.line(n)
    const a = parseTask(was), b = parseTask(now.text)
    if (!a || !b || a.symbol === b.symbol) continue
    const at = was.indexOf(`[${a.symbol}]`)
    if (now.text !== `${was.slice(0, at)}[${b.symbol}]${was.slice(at + 3)}`) continue
    const lines = changeStatus(was, b.symbol, localToday(), prefs)
    if (!lines.length) changes.push({ from: now.from, to: Math.min(now.to + 1, tr.newDoc.length), insert: "" })
    else if (lines.join("\n") !== now.text) changes.push({ from: now.from, to: now.to, insert: lines.join("\n") })
  }
  if (!changes.length) return tr
  const spec: TransactionSpec = { changes, sequential: true }
  return [tr, spec]
})

/** Toggle the task on the line at `pos` the way a click does (done, or back to todo). */
export function toggleAt(view: EditorView, pos: number) {
  const l = view.state.doc.lineAt(pos)
  const t = parseTask(l.text)
  if (!t) return false
  const lines = changeStatus(l.text, toggled(t.symbol), localToday(), prefs)
  const to = lines.length ? l.to : Math.min(l.to + 1, view.state.doc.length)
  view.dispatch({ changes: { from: l.from, to, insert: lines.join("\n") }, userEvent: "input.tasks" })
  return true
}

/** A box for the statuses Markdown doesn't draw: in progress (half full) and cancelled (a dash). */
class StatusBox extends WidgetType {
  symbol: string; at: number
  constructor(symbol: string, at: number) { super(); this.symbol = symbol; this.at = at }
  eq(o: StatusBox) { return o.symbol === this.symbol && o.at === this.at }
  toDOM(view: EditorView) {
    const box = document.createElement("input")
    box.type = "checkbox"
    box.className = "cm-task tasks-box"
    box.dataset.status = this.symbol
    box.setAttribute("aria-label", this.symbol === "/" ? "In progress" : "Cancelled")
    box.addEventListener("mousedown", (e) => e.preventDefault())
    box.addEventListener("click", (e) => {
      e.preventDefault()
      if (view.state.readOnly) return
      toggleAt(view, this.at)
    })
    return box
  }
  ignoreEvent() { return true }
}

const shownOn = (view: EditorView, from: number, to: number) =>
  view.hasFocus && view.state.selection.ranges.some((r) => r.to >= from && r.from <= to)

function boxes(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const l = view.state.doc.lineAt(pos)
      pos = l.to + 1
      const m = /\[[/-]\]/.test(l.text) ? LINE.exec(l.text) : null
      if (!m || (m[3] !== "/" && m[3] !== "-") || shownOn(view, l.from, l.to)) continue
      const mark = l.from + m[1].length, box = l.from + l.text.indexOf("[", m[1].length + m[2].length) + 3
      if (m[3] === "-") b.add(l.from, l.from, Decoration.line({ class: "cm-task-done" }))
      b.add(mark, box, Decoration.replace({ widget: new StatusBox(m[3], l.from) }))
      const text = box + (l.text[box - l.from] === " " ? 1 : 0)
      if (m[3] === "-" && text < l.to) b.add(text, l.to, Decoration.mark({ class: "cm-task-strike" }))
    }
  }
  return b.finish()
}

const statusBoxes = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = boxes(view) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = boxes(u.view)
  }
}, { decorations: (v) => v.decorations })

const theme = EditorView.baseTheme({
  ".tasks-box[data-status='/']": { background: "linear-gradient(to right, var(--notes) 50%, transparent 50%)", borderColor: "var(--notes)" },
  ".tasks-box[data-status='-']": { background: "linear-gradient(var(--muted-foreground), var(--muted-foreground)) center / 9px 2px no-repeat" },
})

/** Everything Tasks adds to a note's editor (none to source view's whole file: it shows the text as it is). */
export function taskEditor(source: boolean): Extension {
  return source ? [completion] : [completion, statusBoxes, theme]
}
