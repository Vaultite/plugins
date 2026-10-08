// herdr (herdr.dev): the one already running on this machine, over its socket API, as a Terminal backend (its panes are
// terminals, its own agent detection marks them) and GET /api/herdr for the panel. its CLAUDE.md.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { HTTPError, Plugin } from "@vaultite/core/plugins.ts"

export const plugin = new Plugin(import.meta.url)

// Terminal's types (plugins/core/terminal/backend.ts), as far as this uses them.
type AgentRun = { command: string; cwd?: string | null }
type Spec = { shell: string; run: AgentRun | null; cwd: string; env: Record<string, string>; ctx: Record<string, string>; cols: number; rows: number }
type Exit = { code: number; signal: number } | null
type Link = { readonly cols: number; readonly rows: number; write(b: Buffer): void; resize(c: number, r: number): void; onData(fn: (d: string) => void): void
  onExit(fn: (e: Exit) => void): void; snapshot?(fn: (p: string) => void): void; close(): void }
type Listed = { id: string; pid?: number; process: string; created: number; attached: number; title?: string; state?: string; external?: boolean }
type IPty = { pid: number; cols: number; rows: number; write(d: string): void; resize(c: number, r: number): void; kill(s?: string): void
  onData(fn: (d: string) => void): void; onExit(fn: (e: { exitCode: number; signal?: number }) => void): void }
type Kit = {
  loadPty(): Promise<{ spawn(file: string, args: string[], o: Record<string, unknown>): IPty }>
  ptyLink(p: IPty, extra?: { write?: (b: Buffer) => void; exit?: (code: number, signal: number) => Promise<Exit> }): Link
  mirrored(link: Link, scrollback?: number): Promise<Link>
  runScript(file: string, id: string, run: AgentRun): string
}
const kit = () => plugin.peer("terminal")?.exports.backendKit as Kit | undefined

type Settings = { newTerminals?: boolean; session?: string }
const settings = () => plugin.settings() as Settings
/** A named session's (herdr --session <name>), else HERDR_SOCKET_PATH or the default one. */
function socketPath() {
  const name = String(settings().session ?? "").trim()
  if (/^[\w.-]{1,64}$/.test(name)) return path.join(os.homedir(), ".config", "herdr", "sessions", name, "herdr.sock")
  return process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config", "herdr", "herdr.sock")
}
/** The herdr binary, for attaching: where installers put it, else PATH's. */
const BIN = [path.join(os.homedir(), ".local", "bin", "herdr"), "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr", path.join(os.homedir(), ".cargo", "bin", "herdr")]
  .find((p) => fs.existsSync(p)) ?? "herdr"

/** One request to herdr's socket: its result (throws its error, or when nothing answers in time). */
function call(method: string, params: Record<string, unknown> = {}, ms = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath())
    let buf = "", done = false
    const finish = (err: Error | null, v?: Record<string, unknown>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err); else resolve(v ?? {})
    }
    const timer = setTimeout(() => finish(new Error(`herdr didn't answer ${method}`)), ms)
    sock.on("connect", () => sock.write(JSON.stringify({ id: "vaultite", method, params }) + "\n"))
    sock.setEncoding("utf8")
    sock.on("data", (d: string) => {
      buf += d
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      try {
        const m = JSON.parse(buf.slice(0, nl))
        if (m.error) finish(new Error(m.error.message ?? JSON.stringify(m.error))); else finish(null, m.result ?? {})
      } catch (e) { finish(e as Error) }
    })
    sock.on("error", (e) => finish(e))
  })
}

type Pane = { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; label?: string | null; cwd?: string | null; focused?: boolean }
type Agent = { pane_id: string; agent?: string | null; display_agent?: string | null; agent_status: string; title?: string | null; terminal_title_stripped?: string | null; name?: string | null }
type Snapshot = { version?: string; workspaces: { workspace_id: string; label?: string | null; number?: number }[]
  tabs: { tab_id: string; workspace_id: string; label?: string | null; number?: number }[]; panes: Pane[]; agents: Agent[] }

/** herdr's whole session (workspaces, tabs, panes, agents), a second ago at most; null when it isn't running. */
const snapshot = () => plugin.memo(1, async function herdrSnapshot(): Promise<Snapshot | null> {
  try { return ((await call("session.snapshot")).snapshot as Snapshot) ?? null } catch { return null }
})

const ID = /^[\w-]{1,64}$/
const VAULTITE = "Vaultite" // the workspace Vaultite's terminals go in
/** A pane's terminal id here: its label when Vaultite started it, else herdr-<its terminal id>. */
const idOf = (p: Pane) => (p.label && ID.test(p.label) && !p.label.startsWith("herdr-") ? p.label : `herdr-${p.terminal_id.replace(/^term_/, "")}`)
const ours = (p: Pane) => idOf(p) === p.label
/** herdr's agent states, as Terminal's: working, waiting (for an answer), idle. */
const STATES: Record<string, string> = { working: "working", blocked: "waiting", idle: "idle", done: "idle" }

const made = new Map<string, Pane>() // panes just made here (the snapshot may be a second old)
async function paneOf(id: string): Promise<Pane> {
  const p = (await snapshot())?.panes.find((x) => idOf(x) === id) ?? made.get(id)
  if (!p) throw new Error(`herdr has no pane '${id}'`)
  return p
}

const firstSeen = new Map<string, number>() // herdr says nothing of when a pane started: when it was first seen here
const attached = new Set<string>() // the panes a tab here shows: what runs in them is asked (busy or not, when closing)
/** What runs in a pane in front (its shell, a program) and the shell's process, asked of herdr. */
async function processOf(pane: string): Promise<{ name: string; pid?: number }> {
  try {
    const info = (await call("pane.process_info", { pane_id: pane })).process_info as { shell_pid?: number; foreground_processes?: { name?: string }[] }
    return { name: info.foreground_processes?.[0]?.name ?? "", pid: info.shell_pid }
  } catch { return { name: "" } }
}

const memoList = () => plugin.memo(1, async function herdrList(): Promise<Listed[]> {
  const snap = await snapshot()
  if (!snap) return []
  const agents = new Map(snap.agents.map((a) => [a.pane_id, a]))
  const out: Listed[] = []
  for (const p of snap.panes) {
    const id = idOf(p), a = agents.get(p.pane_id)
    if (!firstSeen.has(id)) firstSeen.set(id, Date.now())
    const proc = ours(p) || attached.has(id) ? await processOf(p.pane_id) : { name: "" }
    // An agent herdr recognized runs in it: its kind is the program (Terminal's app matches it to the agent's plugin).
    const kind = a?.agent ?? ""
    out.push({ id, pid: proc.pid, process: kind || proc.name, created: firstSeen.get(id)!, attached: 0,
      title: a?.terminal_title_stripped || a?.title || undefined, state: a ? STATES[a.agent_status] : undefined, ...(ours(p) ? {} : { external: true }) })
  }
  return out
})

/** The workspace Vaultite's terminals go in: herdr's "Vaultite", made when there's none (then with this pane in it). */
async function newPane(spec: Spec): Promise<Pane> {
  const snap = await snapshot()
  const env = spec.ctx
  const ws = snap?.workspaces.find((w) => w.label === VAULTITE)
  const made = ws
    ? await call("tab.create", { workspace_id: ws.workspace_id, cwd: spec.run?.cwd || spec.cwd, env, focus: false })
    : await call("workspace.create", { label: VAULTITE, cwd: spec.run?.cwd || spec.cwd, env, focus: false })
  return made.root_pane as Pane
}

/** Typing ⌃B (herdr's attach prefix, ⌃B q detaches) twice sends it once: the program gets it, the attach never stops. */
const escapePrefix = (b: Buffer) => (b.includes(2) ? Buffer.from([...b].flatMap((c) => (c === 2 ? [2, 2] : [c]))) : b)

const backend = {
  name: "herdr", label: "herdr", redraws: false, external: true,
  get preferred() { return !!settings().newTerminals },
  ready: async () => !!(await snapshot()),
  has: async (id: string) => !!(await snapshot())?.panes.some((p) => idOf(p) === id),
  list: memoList,
  async create(id: string, spec: Spec) {
    const k = kit()
    if (!k) throw new Error("the Terminal plugin is off")
    const p = await newPane(spec)
    await call("pane.rename", { pane_id: p.pane_id, label: id })
    made.set(id, { ...p, label: id })
    setTimeout(() => made.delete(id), 5000).unref?.()
    if (spec.run) {
      // herdr starts the pane's shell itself: the agent's command is typed into it (a short line: `source <script>`).
      const dir = path.join(os.tmpdir(), "vaultite-terminal")
      fs.mkdirSync(dir, { recursive: true })
      await call("pane.send_input", { pane_id: p.pane_id, text: k.runScript(path.join(dir, `run-${id}.sh`), id, spec.run).trimStart(), keys: ["enter"] })
    }
  },
  async attach(id: string, cols: number, rows: number): Promise<Link> {
    const k = kit()
    if (!k) throw new Error("the Terminal plugin is off")
    const pane = await paneOf(id)
    const lib = await k.loadPty()
    const name = String(settings().session ?? "").trim()
    const p = lib.spawn(BIN, [...(/^[\w.-]{1,64}$/.test(name) ? ["--session", name] : []), "terminal", "attach", pane.terminal_id, "--takeover"],
      { name: "xterm-256color", cols, rows, cwd: os.homedir(), env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } })
    attached.add(id)
    const link = k.ptyLink(p, {
      write: (b) => { try { p.write(escapePrefix(b) as unknown as string) } catch { /* ended */ } },
      // The attach ended: its pane is gone (ended), or something else took it over or herdr stopped (null: reattach).
      exit: async () => { attached.delete(id); return (await backend.has(id).catch(() => false)) ? null : { code: 0, signal: 0 } },
    })
    return k.mirrored(link)
  },
  kill: async (id: string) => { await call("pane.close", { pane_id: (await paneOf(id)).pane_id }) },
  async screen(id: string, lines: number) {
    const r = await call("pane.read", { pane_id: (await paneOf(id)).pane_id, source: "recent_unwrapped", lines, format: "text", strip_ansi: true })
    return String((r.read as { text?: string } | undefined)?.text ?? r.text ?? "")
  },
  async send(id: string, text: string, enter: boolean) {
    const pane = (await paneOf(id)).pane_id
    if (text) await call("pane.send_text", { pane_id: pane, text })
    if (enter) { if (text) await new Promise((r) => setTimeout(r, 150)); await call("pane.send_keys", { pane_id: pane, keys: ["enter"] }) }
  },
}

plugin.provide("terminal:backend", () => backend)

// --- the panel's data: workspaces > tabs > panes, each pane with its terminal id here and its agent

plugin.route("GET", "herdr", async (req) => {
  const why = req.http ? await plugin.refusal(req.http, "herdr") : ""
  if (why) throw new HTTPError(403, why)
  const snap = await snapshot()
  if (!snap) return { running: false, workspaces: [] }
  const agents = new Map(snap.agents.map((a) => [a.pane_id, a]))
  return {
    running: true, version: snap.version ?? null, preferred: !!settings().newTerminals,
    workspaces: snap.workspaces.map((w) => ({
      id: w.workspace_id, label: w.label || `Workspace ${w.number ?? ""}`.trim(),
      panes: snap.panes.filter((p) => p.workspace_id === w.workspace_id).map((p) => {
        const a = agents.get(p.pane_id)
        return { id: idOf(p), pane: p.pane_id, tab: snap.tabs.find((t) => t.tab_id === p.tab_id)?.label ?? "", label: p.label ?? null,
          cwd: p.cwd ?? null, agent: a?.agent ?? null, agentLabel: a?.display_agent ?? null, name: a?.name ?? null,
          title: a?.terminal_title_stripped || a?.title || null, state: a ? STATES[a.agent_status] ?? null : null, ours: ours(p) }
      }),
    })),
  }
})
