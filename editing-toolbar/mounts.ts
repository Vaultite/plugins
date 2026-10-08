// Where the editor's extension made room for a bar (a top panel, a tooltip), and the editors that have it: Host draws
// the bars into these with portals, so they're React like the rest of the app.
import { useSyncExternalStore } from "react"
import type { EditorView } from "@codemirror/view"

export type Mount = { key: number; view: EditorView; dom: HTMLElement; place: "top" | "floating" }

let mounts: Mount[] = []
let n = 0
const subs = new Set<() => void>()
const changed = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function mount(view: EditorView, dom: HTMLElement, place: Mount["place"]) {
  const m = { key: ++n, view, dom, place }
  mounts = [...mounts, m]
  changed()
  return () => { mounts = mounts.filter((x) => x !== m); changed() }
}
export const useMounts = () => useSyncExternalStore(subscribe, () => mounts)

/** The editors with the toolbar's extension (notes), for the bar above a phone's keyboard. */
export const editors = new Set<EditorView>()
