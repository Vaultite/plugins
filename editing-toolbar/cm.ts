// The editor's side: room for the bar in each note being edited, as a top panel or a tooltip over the selection, and
// none above a phone's keyboard (Host draws that one). Switched in place when the settings or the window change.
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state"
import { EditorView, showPanel, showTooltip, ViewPlugin, type Panel, type Tooltip } from "@codemirror/view"
import { isDesktop } from "@vaultite"
import { editors, mount } from "./mounts"
import { current, modeOf, subscribe, type Mode } from "./settings"

const editable = (s: EditorState) => s.facet(EditorView.editable) && !s.readOnly

const topPanel = (view: EditorView): Panel => {
  const dom = document.createElement("div")
  return { dom, top: true, destroy: mount(view, dom, "top") }
}
const top = [
  showPanel.compute([EditorView.editable, EditorState.readOnly], (s) => (editable(s) ? topPanel : null)),
  EditorView.theme({ ".cm-panels": { backgroundColor: "var(--background)", color: "inherit" }, ".cm-panels-top": { borderBottom: "0.5px solid var(--border)" } }),
]

// Near the selection: once it's made (not while the mouse still drags it out), while the note has the keyboard.
const held = StateEffect.define<boolean>()
const focused = StateEffect.define<boolean>()
const status = StateField.define({
  create: () => ({ held: false, focused: false }),
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(held)) v = { ...v, held: e.value }
      if (e.is(focused)) v = { ...v, focused: e.value }
    }
    return v
  },
})
const createTip = (view: EditorView) => {
  const dom = document.createElement("div")
  // (the bar draws its own box)
  dom.style.background = "transparent"; dom.style.border = "none"
  return { dom, destroy: mount(view, dom, "floating") }
}
function tipFor(s: EditorState): Tooltip | null {
  const r = s.selection.main, st = s.field(status)
  if (r.empty || st.held || !st.focused || !editable(s)) return null
  // (the same `create` each time, so CodeMirror moves the bar rather than making it again)
  return { pos: r.from, above: true, create: createTip }
}
const tip = StateField.define<Tooltip | null>({
  create: tipFor,
  update: (t, tr) => (tr.docChanged || tr.selection || tr.effects.length || tr.reconfigured ? tipFor(tr.state) : t),
  provide: (f) => showTooltip.from(f),
})
const floating = [
  status, tip,
  EditorView.focusChangeEffect.of((_s, on) => focused.of(on)),
  // (switched on while the note already has the keyboard: no focus change says so)
  ViewPlugin.define((view) => {
    const t = setTimeout(() => { if (view.hasFocus) view.dispatch({ effects: focused.of(true) }) })
    return { destroy: () => clearTimeout(t) }
  }),
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0) return false
      view.dispatch({ effects: held.of(true) })
      const up = () => { removeEventListener("mouseup", up, true); if (!view.dom.isConnected) return; view.dispatch({ effects: held.of(false) }) }
      addEventListener("mouseup", up, true)
      return false
    },
  }),
]
// Above the keyboard: the cursor's line is kept clear of the bar.
const keyboard = EditorView.scrollMargins.of(() => ({ bottom: 56 }))

const parts = (m: Mode): Extension => (m === "top" ? top : m === "floating" ? floating : m === "keyboard" ? keyboard : [])
const mode = new Compartment()
let now: Mode | null = null
const modeNow = () => modeOf(current(), isDesktop())

function follow() {
  const m = modeNow()
  if (m === now) return
  now = m
  for (const v of editors) v.dispatch({ effects: mode.reconfigure(parts(m)) })
}
const track = ViewPlugin.define((view) => {
  editors.add(view)
  return { destroy: () => { editors.delete(view) } }
})

/** What a note's editor gets. */
export function toolbar(): Extension {
  if (now === null) { subscribe(follow); addEventListener("resize", follow) }
  now = modeNow()
  return [track, mode.of(parts(now))]
}
