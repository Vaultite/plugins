// The screens this page is connected to and a way to end each, kept apart from the connections (connection.ts, with
// noVNC) so the sidebar can show them without loading noVNC.
import { useSyncExternalStore } from "react"

/** One connection, as the rest of the plugin sees it. `shown`: a tab draws it now (else it's in the background, kept
 *  for a while so coming back to it is instant). */
export type Live = { id: number; screen: string; state: "connecting" | "connected" | "login" | "closed"; shown: boolean; since: number }
type Entry = Live & { end: () => void }

const entries = new Map<number, Entry>()
const subs = new Set<() => void>()
let snapshot: Live[] = []

export function report(e: Entry) {
  entries.set(e.id, e)
  changed()
}
export function unreport(id: number) {
  if (entries.delete(id)) changed()
}
function changed() {
  snapshot = [...entries.values()].map((e) => ({ id: e.id, screen: e.screen, state: e.state, shown: e.shown, since: e.since }))
  for (const f of subs) f()
}

/** Every connection this page has, redrawn as they change. */
export function useLive(): Live[] {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => snapshot)
}

/** What a screen's connections add up to: connected (and whether a tab shows it), connecting, or none. */
export function stateOf(list: Live[], screen: string): { state: "connected" | "connecting" | "none"; shown: boolean; since: number } {
  const mine = list.filter((l) => l.screen === screen && l.state !== "closed")
  const on = mine.filter((l) => l.state === "connected")
  if (on.length) return { state: "connected", shown: on.some((l) => l.shown), since: Math.min(...on.map((l) => l.since)) }
  return { state: mine.length ? "connecting" : "none", shown: mine.some((l) => l.shown), since: 0 }
}

/** End every connection to a screen (a tab showing one says so and offers to connect again). */
export function disconnect(screen: string) {
  for (const e of [...entries.values()]) if (e.screen === screen) e.end()
}
