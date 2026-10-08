// Screen sharing: another computer's screen in a tab through VNC; the page's socket is relayed here to the screen's VNC port
// (a browser can't open TCP). Screens, settings and the sockets' messages: its CLAUDE.md.
import { execFile } from "node:child_process"
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { type RawData, WebSocket } from "ws"
import { bullets, HTTPError, type Machine, machineSocket, pipeSockets, Plugin, section, splitMachine } from "@vaultite/core/plugins.ts"
import { Pump } from "./rfb.ts"

export const plugin = new Plugin(import.meta.url)

const REFUSED = 4003 // close code: this request may not have the screen (the page shows why and doesn't retry)
const UNREACHABLE = 4004 // close code: the VNC port doesn't answer (the page shows why, and can try again)
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
export const SCREEN_ID = /^[a-z0-9][a-z0-9-]{0,62}(@[a-z0-9][a-z0-9-]{0,62})?$/
const HOST = os.hostname().replace(/\.local$/, "")

type Screen = { id: string; label: string; host: string; port: number }

/** The screens this machine reaches: its own (on a Mac), then the settings' (checked: an id, a host, each id once). */
function screens(): Screen[] {
  const set = plugin.settings({})
  const port = Number(set.localPort) > 0 ? Number(set.localPort) : 5900
  const out: Screen[] = process.platform === "darwin" ? [{ id: "local", label: HOST, host: "127.0.0.1", port }] : []
  for (const s of Array.isArray(set.screens) ? set.screens : []) {
    const id = String(s?.id ?? "").toLowerCase(), host = String(s?.host ?? "").trim()
    if (!ID.test(id) || id === "local" || !host || /[\s/]/.test(host) || out.some((o) => o.id === id)) continue
    out.push({ id, label: String(s.label || id), host, port: Number(s.port) > 0 ? Number(s.port) : 5900 })
  }
  return out
}

/** Whether a port answers (a connection opens within 1.5 s). */
function answers(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const sock = net.connect({ host, port })
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(1500, () => done(false))
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}

const listScreens = () => plugin.memo(5, async function listScreens() {
  return Promise.all(screens().map(async (s) => ({ ...s, online: await answers(s.host, s.port) })))
})
plugin.route("GET", "screens", listScreens)

// ```block-screens as text: this machine's screens (another machine's own come through its app).
plugin.block("screens", async () => {
  const list = await listScreens()
  return section("Screens", bullets(list.map((s) => `${s.id === "local" ? `${s.label} (this Mac)` : s.label}: ${s.online ? "answering" : "not answering"}, ${s.host}:${s.port}, tab view:screen/${s.id}`),
    "No screens: turn on Screen Sharing, or add VNC servers to .vaultite/plugins/screens/data.json."))
})

// --- logins this machine remembers (data/config.json: screens.<id>)
function loginOf(id: string): { username: string; password: string } | null {
  const l = plugin.secrets()[plugin.id]?.[id]
  return l && typeof l.password === "string" ? { username: String(l.username ?? ""), password: l.password } : null
}
function remember(id: string, login: { username: string; password: string } | null) {
  const all = { ...(plugin.secrets()[plugin.id] ?? {}) }
  if (login) all[id] = login; else delete all[id]
  plugin.saveSecrets(Object.keys(all).length ? all : null)
}

// --- who may have the screen: only this Mac's owner (core/owner.ts), checked in the socket so the page hears why.
async function allowed(ws: WebSocket, req: IncomingMessage) {
  const why = await plugin.refusal(req, "screen sharing")
  if (why) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "refused", reason: why }))
    ws.close(REFUSED, "refused")
    return false
  }
  return ws.readyState === ws.OPEN
}

const toBuf = (data: RawData) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer))
const machineOf = (id: string) => plugin.ask<Machine | null>("machines:machine", null, id)

/** Joins this socket to the same one on machine `m`, with the page's query (?pipeline=0). */
function joinRemote(ws: WebSocket, m: Machine | null, at: string, sub: string, query: Record<string, string>) {
  if (!m || !m.online || !m.plugins?.includes(plugin.id)) {
    const reason = !m ? `there's no machine '${at}'` : !m.online ? `${m.label} isn't answering` : `${m.label} doesn't have screen sharing on`
    ws.send(JSON.stringify({ t: m ? "error" : "refused", reason }))
    return ws.close(m ? UNREACHABLE : REFUSED, "unavailable")
  }
  pipeSockets(ws, machineSocket(m, `screens/${sub}`, query), () => {
    ws.send(JSON.stringify({ t: "error", reason: `${m.label} isn't answering` }))
    ws.close(UNREACHABLE, "unreachable")
  })
}

/** Where a socket goes: this machine's screen, or null when it was handed to another machine (or refused). */
async function route(ws: WebSocket, req: IncomingMessage, full: string, kind: "vnc" | "windows", query: Record<string, string> = {}): Promise<Screen | "unsupported" | null> {
  if (!(await allowed(ws, req))) return null
  const [id, at] = splitMachine(full)
  if (at) {
    const m = await machineOf(at)
    if (!m?.self) { joinRemote(ws, m, at, `${kind}/${encodeURIComponent(id)}`, query); return null }
  }
  const s = screens().find((x) => x.id === id)
  if (!s) {
    ws.send(JSON.stringify({ t: "refused", reason: id === "local" ? "this machine isn't a Mac" : `there's no screen '${id}' in the settings` }))
    ws.close(REFUSED, "refused")
    return null
  }
  return kind === "windows" && (s.id !== "local" || process.platform !== "darwin") ? "unsupported" : s
}

const accept = (_req: IncomingMessage, { wild }: { wild: string[] }) => {
  if (!SCREEN_ID.test(wild[0])) throw new HTTPError(400, "a screen id is letters, digits and - (then @machine for another machine's)")
}

/** A relay now: what GET /api/screens/stats and the page's stats overlay show. */
type Relay = { id: number; screen: string; since: number; down: number; up: number; pauses: number; pausedMs: number; pump: Pump | null
  ws: WebSocket }
const relays = new Set<Relay>()
let relayIds = 1
/** How much may wait in the page's socket: past it the relay stops asking ahead, and past 4 MB it stops reading. */
const ROOM = 512 << 10

function relayStats(r: Relay) {
  const secs = Math.max(1, (Date.now() - r.since) / 1000)
  return { id: r.id, screen: r.screen, seconds: Math.round(secs), down: r.down, up: r.up, downKbps: Math.round(r.down / 1024 / secs),
    buffered: r.ws.bufferedAmount, pauses: r.pauses, pausedMs: r.pausedMs, ...(r.pump?.stats ?? { pipeline: false, why: "turned off" }) }
}
plugin.route("GET", "screens/stats", () => [...relays].map(relayStats))

plugin.socket("screens/vnc/*", async (ws, req, { wild, query }) => {
  const s = await route(ws, req, wild[0], "vnc", query)
  if (!s || s === "unsupported") return
  const tcp = net.connect({ host: s.host, port: s.port })
  tcp.setNoDelay(true)
  let open = false
  // Asking for updates ahead of the page (rfb.ts); ?pipeline=0 (or the settings' "pipeline": false) turns it off.
  const piped = query.pipeline !== "0" && plugin.settings({}).pipeline !== false
  const relay: Relay = { id: relayIds++, screen: wild[0], since: Date.now(), down: 0, up: 0, pauses: 0, pausedMs: 0, ws,
    pump: piped ? new Pump((b) => { if (open) { tcp.write(b); relay.up += b.length } }, () => ws.bufferedAmount < ROOM,
      Number(query.depth) >= 1 && Number(query.depth) <= 16 ? Number(query.depth) : undefined) : null }
  relays.add(relay)
  let statsTimer: ReturnType<typeof setInterval> | null = null
  tcp.once("connect", () => {
    open = true
    if (ws.readyState !== ws.OPEN) return tcp.destroy()
    ws.send(JSON.stringify({ t: "ready", label: s.label, login: loginOf(s.id) }))
  })
  let paused = 0
  tcp.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) return
    relay.down += chunk.length
    ws.send(chunk, { binary: true })
    relay.pump?.fromServer(chunk)
    // The page reads slower than the screen changes (a phone on a slow link): stop reading until it caught up.
    if (ws.bufferedAmount > 4 << 20 && !paused) {
      tcp.pause()
      paused = Date.now()
      relay.pauses++
      const t = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount < 1 << 20) {
          clearInterval(t)
          relay.pausedMs += Date.now() - paused
          paused = 0
          tcp.resume()
          relay.pump?.drained()
        }
      }, 50)
    }
  })
  tcp.on("error", (e) => {
    if (ws.readyState !== ws.OPEN) return
    if (!open) {
      const why = s.id === "local" ? "Screen Sharing isn't on (System Settings > General > Sharing)" : `${s.host}:${s.port} doesn't answer (${(e as NodeJS.ErrnoException).code ?? e.message})`
      ws.send(JSON.stringify({ t: "error", reason: why }))
      ws.close(UNREACHABLE, "unreachable")
    } else ws.close(1011, "lost the screen")
  })
  tcp.on("close", () => { if (open && ws.readyState === ws.OPEN) ws.close(1000, "closed") })
  ws.on("message", (data: RawData, binary: boolean) => {
    const buf = toBuf(data)
    if (binary) {
      if (!open) return
      if (relay.pump && !relay.pump.fromClient(buf)) return
      relay.up += buf.length
      tcp.write(buf)
      return
    }
    let msg: { t?: string; username?: unknown; password?: unknown; on?: unknown }
    try { msg = JSON.parse(buf.toString("utf8")) } catch { return }
    try {
      if (msg.t === "remember" && typeof msg.password === "string") remember(s.id, { username: String(msg.username ?? ""), password: msg.password })
      else if (msg.t === "forget") remember(s.id, null)
      else if (msg.t === "stats") {
        // The page's stats overlay: the relay's numbers every second, as text (the page tells them from the screen's).
        if (statsTimer) clearInterval(statsTimer)
        statsTimer = msg.on ? setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "stats", ...relayStats(relay) })) }, 1000) : null
      }
    } catch (e) { console.error("screens: couldn't save the login:", (e as Error).message) }
  })
  ws.on("close", () => { tcp.destroy(); relays.delete(relay); if (statsTimer) clearInterval(statsTimer) })
}, { accept })

// --- what's on this Mac's screen (app mode), asked while anyone watches
const WINDOWS_JS = path.join(plugin.dir, "windows.js")
const watchers = new Set<WebSocket>()
let last = ""
let poll: ReturnType<typeof setInterval> | null = null

function onScreen(): Promise<string> {
  return new Promise((resolve) => execFile("/usr/bin/osascript", ["-l", "JavaScript", WINDOWS_JS], { timeout: 5000, maxBuffer: 4 << 20 },
    (err, out) => resolve(err ? "" : out.trim())))
}

/** The apps in /Applications and /System/Applications (one level, and Utilities), which app mode can start. */
const installed = () => plugin.memo(300, function installed() {
  const out: { name: string; path: string }[] = []
  for (const dir of ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", path.join(os.homedir(), "Applications")]) {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) if (n.endsWith(".app")) out.push({ name: n.slice(0, -4), path: path.join(dir, n) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
})

async function sendWindows(to?: WebSocket) {
  const text = await onScreen()
  if (!text) return
  let data: object
  try { data = JSON.parse(text) } catch { return }
  const msg = JSON.stringify({ t: "windows", ...data, installed: await installed() })
  if (!to && msg === last) return
  last = msg
  for (const ws of to ? [to] : watchers) if (ws.readyState === ws.OPEN) ws.send(msg)
}

plugin.socket("screens/windows/*", async (ws, req, { wild }) => {
  const s = await route(ws, req, wild[0], "windows")
  if (!s) return
  if (s === "unsupported") { ws.send(JSON.stringify({ t: "windows", unsupported: true })); return }
  watchers.add(ws)
  void sendWindows(ws)
  poll ??= setInterval(() => void sendWindows(), 1500)
  ws.on("message", (data: RawData) => {
    let msg: { t?: string; app?: unknown }
    try { msg = JSON.parse(toBuf(data).toString("utf8")) } catch { return }
    if (msg.t !== "open" || typeof msg.app !== "string" || !msg.app || msg.app.length > 200) return
    // An app installed here (its path) or running (its name): `open -a` brings it to the front, starting it if needed.
    const app = installed().then((list) => list.find((a) => a.name === msg.app)?.path ?? String(msg.app))
    app.then((a) => execFile("/usr/bin/open", ["-a", a], { timeout: 10000 }, (err) => {
      if (err && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "error", reason: `couldn't open ${msg.app}` }))
      else setTimeout(() => void sendWindows(), 300)
    }))
  })
  ws.on("close", () => {
    watchers.delete(ws)
    if (!watchers.size && poll) { clearInterval(poll); poll = null; last = "" }
  })
}, { accept })

plugin.onUnload(() => { if (poll) clearInterval(poll) })
