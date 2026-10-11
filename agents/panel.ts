// Each thread's diff panel: open or not, what it shows (a turn, the whole thread, what isn't committed) and the file to
// scroll to. A turn's card and the header both open it, so it lives here rather than in one component.
import { useSyncExternalStore } from "react"

/** A turn's user entry index, "all" the whole thread, "uncommitted" the checkout against its last commit. */
export type Scope = number | "all" | "uncommitted"
export type DiffPanel = { open: boolean; scope: Scope; file: string; nonce: number }

const CLOSED: DiffPanel = { open: false, scope: "all", file: "", nonce: 0 }
const panels = new Map<string, DiffPanel>()
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
/** The thread whose chat was used last: where the palette's Toggle diff goes. */
export let lastThread = ""
export const usedThread = (id: string) => { if (id) lastThread = id }

export const usePanel = (id: string) => useSyncExternalStore(subscribe, () => panels.get(id) ?? CLOSED)

export function setPanel(id: string, p: Partial<DiffPanel>) {
  const was = panels.get(id) ?? CLOSED
  panels.set(id, { ...was, ...p, nonce: p.file !== undefined ? was.nonce + 1 : was.nonce })
  subs.forEach((f) => f())
}
export const openDiff = (id: string, scope: Scope, file = "") => setPanel(id, { open: true, scope, file })
export const toggleDiff = (id: string) => setPanel(id, { open: !(panels.get(id) ?? CLOSED).open })
