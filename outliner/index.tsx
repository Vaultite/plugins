// Outliner: a list item moves, indents and outdents with its children (keys and commands), Enter on an empty item
// steps out a level, ⌘A takes the item's text and then the list, and ⌘↑/⌘↓ fold through the Folding plugin.
import { currentEditor, definePlugin, offeredCommand, runCommandById, type PluginCommand } from "@vaultite"
import { apply, foldable, itemHere, listKeys } from "./editor"
import * as L from "./tree"

/** The note being edited, if it can be. */
const note = () => { const ed = currentEditor(); return ed?.kind === "markdown" && !ed.view.state.readOnly ? ed.view : null }
const inItem = () => { const v = note(); return !!v && !!itemHere(v.state) }
const edit = (id: string, name: string, keys: string[] | undefined, op: (lines: string[], n: number) => L.Edit | null): PluginCommand =>
  ({ id: `outliner:${id}`, name, keys, when: inItem, run: () => { const v = note(); if (v) { apply(v, op); v.focus() } } })
/** Fold or unfold the item at the cursor with the Folding plugin's own command (it draws and remembers folds). */
const fold = (id: string, name: string, keys: string[], want: "open" | "folded"): PluginCommand => ({
  id: `outliner:${id}`, name, keys,
  when: () => { const v = note(); return !!v && foldable(v.state) === want && !!offeredCommand("folding:toggle") },
  run: () => { runCommandById("folding:toggle") },
})

export default definePlugin({
  editor: (ctx) => (ctx.kind === "markdown" ? listKeys : []),
  commands: [
    edit("move-up", "Move list item up", ["Mod+Shift+ArrowUp"], (l, n) => L.move(l, n, -1)),
    edit("move-down", "Move list item down", ["Mod+Shift+ArrowDown"], (l, n) => L.move(l, n, 1)),
    edit("indent", "Indent list item", undefined, L.indent),
    edit("outdent", "Outdent list item", undefined, L.outdent),
    fold("fold", "Fold list item", ["Mod+ArrowUp"], "open"),
    fold("unfold", "Unfold list item", ["Mod+ArrowDown"], "folded"),
  ],
})
