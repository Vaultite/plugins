// The repository's state on the app's side: one request shared by the panel, the status bar and the file marks, asked
// again when the vault changes, the window comes back, every 30 s while shown, and after each action.
import { useSyncExternalStore } from "react"
import { get, notify, notifyError, op, useVaultChange } from "@vaultite"
import type { Committed, Snapshot, SyncResult } from "./types"

let snap: Snapshot | null = null
let error: string | null = null
let running: string | null = null // (an action started here, until it answers)
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

let inflight: Promise<void> | null = null
let again = false
export function refresh(): Promise<void> {
  if (inflight) { again = true; return inflight }
  inflight = get<Snapshot>("git/status").then((s) => { snap = s; error = null }, (e) => { error = String((e as Error).message ?? e) })
    .finally(() => { inflight = null; emit(); if (again) { again = false; void refresh() } })
  return inflight
}

let timer: ReturnType<typeof setTimeout> | null = null
const soon = (ms = 600) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void refresh() }, ms) }
let stop: (() => void) | null = null
function start() {
  void refresh()
  const tick = setInterval(() => { if (document.visibilityState === "visible") void refresh() }, 30_000)
  const back = () => { if (document.visibilityState === "visible") soon(100) }
  document.addEventListener("visibilitychange", back)
  addEventListener("focus", back)
  stop = () => { clearInterval(tick); document.removeEventListener("visibilitychange", back); removeEventListener("focus", back) }
}
function subscribe(f: () => void) {
  subs.add(f)
  if (subs.size === 1) start()
  return () => { subs.delete(f); if (!subs.size) { stop?.(); stop = null } }
}
type View = { snap: Snapshot | null; error: string | null; running: string | null }
let view: View = { snap, error, running }
const read = () => (view.snap === snap && view.error === error && view.running === running ? view : (view = { snap, error, running }))

/** The state as last asked (for code outside React: a command's `when`). */
export const currentSnap = () => snap

/** The repository's state, live (a change in the vault asks again, once for every view showing it). */
export function useGit() {
  useVaultChange((paths) => { if (!paths || paths.some((p) => !p.startsWith(".vaultite/cache"))) soon() })
  return useSyncExternalStore(subscribe, read)
}

/** Run an op (an action of the panel's), saying what happened; the state is asked again after. */
async function act<T>(what: string, id: string, params: Record<string, unknown>, said: (r: T) => string | null): Promise<T | null> {
  if (running) return null
  running = what; emit()
  try {
    const r = await op<T>(id, params)
    const text = said(r)
    if (text) notify(text)
    return r
  } catch (e) {
    notifyError(e, `Couldn't ${what.toLowerCase()}`)
    return null
  } finally {
    running = null
    await refresh()
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
const syncSaid = (r: SyncResult) => {
  if (r.conflicts.length) return `Merge conflicts in ${plural(r.conflicts.length, "file")}: nothing was lost. Fix them, then Commit`
  const parts = [r.committed && `committed ${plural(r.committed.files.length, "file")}`, r.pulled && `pulled ${plural(r.pulled, "commit")}`,
    r.pushed && `pushed ${plural(r.pushed, "commit")}`].filter(Boolean) as string[]
  const text = parts.length ? parts.join(", ") : r.remote ? "Already in step with the remote" : "Nothing to commit"
  return text[0].toUpperCase() + text.slice(1) + (!r.remote && r.committed ? " (no remote to sync with)" : "")
}

export const commit = (message: string) => act<{ committed: Committed }>("Commit", "git.commit", message.trim() ? { message } : {},
  (r) => (r.committed ? `Committed ${plural(r.committed.files.length, "file")}` : "Nothing to commit"))
export const commitAndSync = (message: string) => act<SyncResult>("Commit and sync", "git.sync", message.trim() ? { message } : {}, syncSaid)
export const pull = () => act<SyncResult>("Pull", "git.pull", {}, syncSaid)
export const push = () => act<SyncResult>("Push", "git.push", {}, (r) => (r.pushed ? `Pushed ${plural(r.pushed, "commit")}` : "Nothing to push"))
export const stage = (files?: string[]) => act("Stage", "git.stage", files ? { files } : {}, () => null)
export const unstage = (files?: string[]) => act("Unstage", "git.unstage", files ? { files } : {}, () => null)
export const discard = (files: string[]) => act<{ files: string[] }>("Discard", "git.discard", { files },
  (r) => (r.files.length ? `Discarded the changes to ${plural(r.files.length, "file")} (File history keeps what it had)` : "Nothing to discard"))
export const abortMerge = () => act("Abort the merge", "git.abort", {}, () => "Aborted the merge: the vault is as it was before the pull")
export const init = (force: boolean) => act<{ gitignore: boolean }>("Make a repository", "git.init", force ? { force } : {},
  (r) => `The vault is a git repository now${r.gitignore ? ", with a .gitignore" : ""}`)
export const setRemote = (url: string) => act("Set the remote", "git.remote", { url }, () => "Remote set: Commit and sync pushes there")
