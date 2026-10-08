// Advanced tables: Tab, Shift-Tab and Enter move between a Markdown table's cells in the editor (new rows at its end),
// writing the table back aligned; commands change its rows and columns. Outside tables (and in code) keys are the editor's.
import { Table2 } from "lucide-react"
import { currentEditor, definePlugin, notify, type PluginCommand } from "@vaultite"
import { change, formatAll, tableAt, tableExtension } from "./editor"
import * as T from "./table"

/** The note being edited, if it can be. */
const note = () => { const ed = currentEditor(); return ed?.kind === "markdown" && !ed.view.state.readOnly ? ed.view : null }
const inTable = () => { const v = note(); return !!v && !!tableAt(v.state) }
type Fn = Parameters<typeof change>[1]
const cmd = (id: string, name: string, fn: Fn): PluginCommand => ({ id: `advanced-tables:${id}`, name, when: inTable, run: () => { const v = note(); if (v) { change(v, fn); v.focus() } } })
const aligned = (a: T.Align, name: string) => cmd(`align-${a || "none"}`, name, (t, r, c) => [T.align(t, c, a), r, c])

export default definePlugin({
  icon: Table2,
  editor: (ctx) => (ctx.kind === "markdown" ? tableExtension : []),
  commands: [
    cmd("format", "Format table", (t, r, c) => [t, r, c]),
    { id: "advanced-tables:format-all", name: "Format all tables in the note", when: () => !!note(), run: () => {
      const v = note()
      if (v) notify(((n) => (n ? `Formatted ${n} ${n === 1 ? "table" : "tables"}` : "Every table was already formatted"))(formatAll(v)))
    } },
    cmd("insert-row-above", "Insert row above", (t, r, c) => [T.insertRow(t, Math.max(1, r)), Math.max(1, r), c]),
    cmd("insert-row-below", "Insert row below", (t, r, c) => [T.insertRow(t, r + 1), r + 1, c]),
    cmd("delete-row", "Delete row", (t, r, c) => (r < 1 ? [null, r, c] : [T.deleteRow(t, r), Math.min(r, t.rows.length - 2), c])),
    cmd("move-row-up", "Move row up", (t, r, c) => [T.moveRow(t, r, -1), r - 1, c]),
    cmd("move-row-down", "Move row down", (t, r, c) => [T.moveRow(t, r, 1), r + 1, c]),
    cmd("insert-column-left", "Insert column left", (t, r, c) => [T.insertColumn(t, c), r, c]),
    cmd("insert-column-right", "Insert column right", (t, r, c) => [T.insertColumn(t, c + 1), r, c + 1]),
    cmd("delete-column", "Delete column", (t, r, c) => (t.aligns.length < 2 ? [null, r, c] : [T.deleteColumn(t, c), r, Math.min(c, t.aligns.length - 2)])),
    cmd("move-column-left", "Move column left", (t, r, c) => [T.moveColumn(t, c, -1), r, c - 1]),
    cmd("move-column-right", "Move column right", (t, r, c) => [T.moveColumn(t, c, 1), r, c + 1]),
    cmd("sort-ascending", "Sort rows by this column", (t, r, c) => [T.sort(t, c), r, c]),
    cmd("sort-descending", "Sort rows by this column, descending", (t, r, c) => [T.sort(t, c, true), r, c]),
    aligned("left", "Align column left"), aligned("center", "Align column center"), aligned("right", "Align column right"),
    aligned("", "Clear column alignment"),
  ],
})
