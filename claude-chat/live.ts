// The app's side of Claude chat's socket (/api/claude-chat/live): the conversation list, and each conversation shown,
// entry by entry as Claude writes. One socket while any chat is on screen; what it changes goes over HTTP.
import { useEffect, useSyncExternalStore } from "react"
import { viewsChanged } from "@vaultite"

type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type Entry =
  | { kind: "user"; text: string; at: string; file?: string; images?: string[] }
  | { kind: "assistant"; text: string; at: string; open?: boolean }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; file?: string; result?: string; error?: boolean; patch?: Hunk[] }
  | { kind: "ask"; id: string; tool: string; input: Record<string, unknown>; text: string; at: string; file?: string; answer?: "allow" | "deny" | "gone" }
  | { kind: "note"; text: string; at: string; error?: boolean; signIn?: boolean }
export type Conv = { id: string; title: string; session: string; started: boolean; created: string; updated: string; entries: Entry[] }
export type Live = { running: boolean; status: string }
export type Summary = { id: string; title: string; updated: string; running: boolean; waiting: boolean }
export type Shown = { conv: Conv | null; live: Live; gone: boolean }

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
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/claude-chat/live`)
  sock = ws
  ws.onopen = () => { retry = 0; for (const id of watchers.keys()) say({ t: "watch", id }) }
  ws.onmessage = (m) => {
    let msg: { t?: string; [k: string]: unknown }
    try { msg = JSON.parse(String(m.data)) } catch { return }
    const id = typeof msg.id === "string" ? msg.id : ""
    if (msg.t === "list") { list = msg.list as Summary[]; viewsChanged() }
    else if (msg.t === "refused") refused = String(msg.reason ?? "refused")
    else if (msg.t === "conv") { const c = msg.conv as Conv; shown.set(c.id, { conv: c, live: msg.live as Live, gone: false }) }
    else if (msg.t === "gone") shown.set(id, { conv: null, live: IDLE, gone: true })
    else if (msg.t === "live") { const s = shown.get(id); if (s) shown.set(id, { ...s, live: msg.live as Live }) }
    else if (msg.t === "entry") {
      const s = shown.get(id)
      if (!s?.conv) return
      const entries = [...s.conv.entries]
      entries[msg.i as number] = msg.entry as Entry
      shown.set(id, { ...s, conv: { ...s.conv, entries } })
    } else return
    changed()
  }
  ws.onclose = () => {
    if (sock === ws) sock = null
    if (users > 0 && !timer && !refused) timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** retry++))
  }
}

/** Keep the socket while something shows a chat. */
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
export const titleOf = (id: string) => list?.find((c) => c.id === id)?.title ?? shown.get(id)?.conv?.title ?? ""

/** A conversation, followed while it's shown. */
export function useConv(id: string): Shown | null {
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
