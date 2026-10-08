// Which line the form edits: one in an open editor (the command), or one a query showed (its pencil). Kept by a number
// in the sheet's address, so Back and Forward find it again while the page is open.
import type { EditorView } from "@codemirror/view"
import { openDetail } from "@vaultite"

export type Target = {
  /** The note, when the line is in one. */
  path?: string
  /** From 1. */
  line: number
  /** The line as it was when the form opened. */
  text: string
  /** The editor it's in, written there (so it's one Undo); a query's line is written through tasks.update. */
  view?: EditorView
}

const targets = new Map<string, Target>()
let n = 0
export const targetOf = (id: string) => targets.get(id) ?? null

export function editTask(t: Target) {
  const id = String(++n)
  targets.set(id, t)
  openDetail(`task/${id}`)
}
