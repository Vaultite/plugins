// Templater in the app: the cursor goes where a template's tp.file.cursor() was (as Templater's jump), and the active
// note's commands can run in place. The Templates plugin's own commands make and insert notes; the server runs them.
import { FileCode2, TextCursorInput } from "lucide-react"
import { ViewPlugin, type EditorView } from "@codemirror/view"
import { activeFile, currentEditor, definePlugin, get, notify, notifyError, post } from "@vaultite"

const MARK = /<%\s*tp\.file\.cursor\((\d*)\)\s*%>/
const MARKS = new RegExp(MARK.source, "g")

/** The cursor to the first mark (lowest number first), which goes. */
function jump(view: EditorView) {
  const m = [...view.state.doc.toString().matchAll(MARKS)].sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0))[0]
  if (!m) return false
  view.dispatch({ changes: { from: m.index, to: m.index + m[0].length }, selection: { anchor: m.index }, scrollIntoView: true })
  view.focus()
  return true
}

let folder: Promise<string> | null = null
const templates = () => folder ??= get<{ folder: string }>("templates").then((t) => t.folder, () => "Templates")

/** Run the commands in the note being edited, as Templater's "Replace templates in the active file". */
async function replaceInActive() {
  const f = activeFile()
  if (!f) return
  try {
    const text = f.text()
    const r = await post<{ text: string; notice?: string } | null>("templates/expand", { text, template: f.path, path: f.path, mode: "insert" })
    if (r && r.text !== text) f.setText(r.text)
    if (r?.notice) notify(r.notice)
  } catch (e) { notifyError(e, "Couldn't run the note's commands") }
}

export default definePlugin({
  icon: FileCode2,
  commands: [
    { id: "templater:jump", name: "Jump to next cursor location", keys: ["Alt+E"], when: () => !!currentEditor(), run: () => { const e = currentEditor(); if (e) jump(e.view) }, icon: TextCursorInput },
    { id: "templater:replace", name: "Replace templates in the active file", when: () => !!activeFile(), run: () => void replaceInActive() },
  ],
  // A note made or filled from a template opens with its mark, or gets one inserted: the cursor goes there (not in templates).
  editor: async (ctx) => !ctx.path || ctx.path.startsWith(`${await templates()}/`) ? [] : ViewPlugin.define((view) => {
    setTimeout(() => jump(view))
    return {
      update(u) {
        let marked = false
        if (u.docChanged) u.changes.iterChanges((_a, _b, _c, _d, text) => { marked ||= MARK.test(text.toString()) })
        if (marked) setTimeout(() => jump(u.view))
      },
    }
  }),
})
