// The app's side of Agents' socket (/api/agents/live): the thread list, and each thread shown, entry by entry as the
// agent writes. One socket while anything of Agents is on screen; what it changes goes over HTTP.
import { useEffect, useSyncExternalStore } from "react"
import { viewsChanged } from "@vaultite"
import type { Entry, Live, Summary, Thread } from "./types"

export type Shown = { thread: Thread | null; live: Live; gone: boolean }

const IDLE: Live = { running: false, status: "" }
let list: Summary[] | null = null
let refused = ""
const shown = new Map<string, Shown>()
const watchers = new Map<string, number>()
const subs = new Set<() => void>()
const changed = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

let sock: WebSocket | null = null
let users = 0, retry = 0
let timer: ReturnType<typeof setTimeout> | null = null
const say = (m: unknown) => { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m)) }

function open() {
  timer = null
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/agents/live`)
  sock = ws
  ws.onopen = () => { retry = 0; for (const id of watchers.keys()) say({ t: "watch", id }) }
  ws.onmessage = (m) => {
    let msg: { t?: string; [k: string]: unknown }
    try { msg = JSON.parse(String(m.data)) } catch { return }
    const id = typeof msg.id === "string" ? msg.id : ""
    if (msg.t === "list") { list = msg.list as Summary[]; viewsChanged() }
    else if (msg.t === "refused") refused = String(msg.reason ?? "refused")
    else if (msg.t === "thread") { const t = msg.thread as Thread; shown.set(t.id, { thread: t, live: msg.live as Live, gone: false }) }
    else if (msg.t === "gone") shown.set(id, { thread: null, live: IDLE, gone: true })
    else if (msg.t === "live") { const s = shown.get(id); if (s) shown.set(id, { ...s, live: msg.live as Live }) }
    else if (msg.t === "entry") {
      const s = shown.get(id)
      if (!s?.thread) return
      const entries = [...s.thread.entries]
      entries[msg.i as number] = msg.entry as Entry
      shown.set(id, { ...s, thread: { ...s.thread, entries } })
    } else return
    changed()
  }
  ws.onclose = () => {
    if (sock === ws) sock = null
    if (users > 0 && !timer && !refused) timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** retry++))
  }
}

/** Keep the socket while something of Agents is on screen. */
export function useSocket() {
  useEffect(() => {
    if (users++ === 0 && !sock && !timer) open()
    return () => {
      if (--users > 0) return
      if (timer) { clearTimeout(timer); timer = null }
      sock?.close()
      sock = null
    }
  }, [])
}

export const useList = () => useSyncExternalStore(subscribe, () => list)
export const useRefused = () => useSyncExternalStore(subscribe, () => refused)
export const summaryOf = (id: string) => list?.find((t) => t.id === id) ?? null
export const titleOf = (id: string) => summaryOf(id)?.title ?? shown.get(id)?.thread?.title ?? ""

/** A thread, followed while it's shown. */
export function useThread(id: string): Shown | null {
  useEffect(() => {
    if (!id) return
    watchers.set(id, (watchers.get(id) ?? 0) + 1)
    say({ t: "watch", id })
    return () => {
      const n = (watchers.get(id) ?? 1) - 1
      if (n > 0) return void watchers.set(id, n)
      watchers.delete(id)
      say({ t: "unwatch", id })
      shown.delete(id)
    }
  }, [id])
  return useSyncExternalStore(subscribe, () => (id ? shown.get(id) ?? null : null))
}
