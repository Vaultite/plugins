// Editing an Org file: its text in a CodeMirror editor drawn as the app's live preview (editor/live.ts). What's typed
// goes to `onChange`; the file changed elsewhere (another machine, an agent) comes in keeping the cursor and undo.
import { useEffect, useRef } from "react"
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands"
import { Compartment, EditorState, Prec, Transaction, type Extension } from "@codemirror/state"
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view"
import * as vaultite from "@vaultite"
import type { EditorCtx, OpenEditor, Store } from "@vaultite"
import { findable, orgLive } from "../editor/live.ts"
import "../org.css"

/** The smallest change from `a` to `b`: what differs between their common start and end. */
function changeOf(a: string, b: string) {
  let s = 0
  const n = Math.min(a.length, b.length)
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++
  let e = 0
  while (e < n - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) }
}

// The other plugins' extensions (find, Vim, dictation), from apps that give them to a plugin's own editor.
const pluginExtensions = (vaultite as { pluginEditorExtensions?: (ctx: EditorCtx) => Promise<Extension[]> }).pluginEditorExtensions
// The app's list of open editors (where ⌘F, dictation and Vim's commands find the one in use), from apps that let a
// plugin's own editor in.
const registerEditor = (vaultite as { registerEditor?: (e: OpenEditor) => () => void }).registerEditor

export function LiveEditor({ text, path, store, onChange }: { text: string; path: string; store?: Store; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const last = useRef(text)
  const changed = useRef(onChange)
  changed.current = onChange

  useEffect(() => {
    const plugged = new Compartment()
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          Prec.highest(plugged.of([])),
          history(), drawSelection(), EditorView.lineWrapping, placeholder("Start writing"),
          EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
          orgLive(path, store),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.every((t) => !t.docChanged || t.annotation(Transaction.remote))) return
            last.current = u.state.doc.toString()
            changed.current(last.current)
          }),
        ],
      }),
    })
    view.current = v
    let live = true
    pluginExtensions?.({ kind: "text", path, source: false }).then((ext) => { if (live) v.dispatch({ effects: plugged.reconfigure(ext) }) }, () => {})
    const unlist = registerEditor?.({ view: v, kind: "text", path, source: false, undo: () => undo(v), redo: () => redo(v), findable })
    return () => { live = false; unlist?.(); v.destroy(); view.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one editor per file: the format keys it by path
  }, [])

  // The file changed elsewhere: only what differs is replaced, outside undo.
  useEffect(() => {
    const v = view.current
    if (!v || text === last.current) return
    last.current = text
    const now = v.state.doc.toString()
    if (now === text) return
    v.dispatch({ changes: changeOf(now, text), annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] })
  }, [text])

  return <div ref={host} className="vau-editor org-live" data-org-live />
}
