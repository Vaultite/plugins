// What every harness shares: the threads (in memory, saved to plugin.localDir()), the sockets that follow them, and the
// turn's bookkeeping (Run). claude.ts and codex.ts drive their CLIs; plugin.ts has the routes and ops.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { WebSocket } from "ws"
import { agentLines, HTTPError, Plugin, ROOT } from "@vaultite/core/plugins.ts"
import type { Changes, Entry, FileDiff, Harness, Hunk, Live, Mode, Project, Summary, Thread } from "./types.ts"

export const plugin = new Plugin(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any
export const MODES: Mode[] = ["ask", "edits", "auto", "full"]
export const NEW_TITLE = "New thread"
export const IDLE_MS = 10 * 60_000
const STOP_MS = 4000
export const now = () => new Date().toISOString()
export const str = (v: unknown) => (typeof v === "string" ? v : "")
export const cut = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s)

// ---------- where things are

export const dir = (...p: string[]) => { const d = path.join(plugin.localDir(), ...p); fs.mkdirSync(d, { recursive: true }); return d }
const threadFile = (id: string) => path.join(dir("threads"), `${id}.json`)
export const ID = /^[a-z0-9]{6,16}$/
export const realOf = (p: string) => { try { return fs.realpathSync(p) } catch { return p } }
export const vaultReal = () => realOf(plugin.vault.path)
export const home = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p === "~" ? os.homedir() : p)
export const tilde = (p: string) => (p.startsWith(os.homedir() + "/") ? `~${p.slice(os.homedir().length)}` : p)

/** A path an agent used, as the vault's (Notes/Idea.md), or undefined when it's outside the vault. */
export function inVault(abs: string): string | undefined {
  if (!abs || !path.isAbsolute(abs)) return undefined
  for (const root of new Set([plugin.vault.path, vaultReal()])) if (abs.startsWith(root + "/")) return abs.slice(root.length + 1)
  return undefined
}
/** Where a tool acted: the vault's path (a link) and the absolute one. */
export function where(p: string, cwd: string): { file?: string; path?: string } {
  if (!p) return {}
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p)
  return { file: inVault(abs), path: abs }
}

/** A CLI: `env` names it, or this machine's data/config.json (`agents.<name>`), else found where installs put it. */
export function cliPath(name: string, envName: string): string | null {
  const own = process.env[envName] || str((plugin.secrets().agents as Any)?.[name])
  if (own) return fs.existsSync(own) ? own : null
  const h = os.homedir()
  const dirs = [...(process.env.PATH ?? "").split(":"), path.join(h, ".local/bin"), path.join(h, ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin",
    path.join(h, ".npm-global/bin"), path.join(h, ".volta/bin"), path.join(h, ".bun/bin")]
  for (const d of dirs.filter(Boolean)) {
    const p = path.join(d, name)
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}

// An agent that inherits these from a session that started the server takes itself for nested.
const AGENT_SESSION = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID", "CLAUDE_EFFORT",
  "CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"]

// A launchd server's PATH is bare (/usr/bin:/bin): Homebrew's codex is a node script, so it needs node's folder.
const BIN_DIRS = () => [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")]

export function env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || AGENT_SESSION.includes(k) || k.startsWith("npm_") || (k.startsWith("VAULTITE") && k !== "VAULTITE_LOCAL") || k.startsWith("AGENTS_")
      || ["PORT", "HOST", "INIT_CWD", "TMUX", "TMUX_PANE", "ELECTRON_RUN_AS_NODE"].includes(k)) continue
    out[k] = v
  }
  const host = !process.env.HOST || ["0.0.0.0", "::"].includes(process.env.HOST) ? "127.0.0.1" : process.env.HOST
  return { ...out, VAULTITE: "1", VAULTITE_URL: `http://${host.includes(":") ? `[${host}]` : host}:${Number(process.env.PORT || 8793)}`,
    VAULTITE_VAULT: plugin.vault.path, PATH: [...new Set([path.join(ROOT, "bin"), ...(out.PATH ?? "").split(":"), ...BIN_DIRS()].filter(Boolean))].join(":") }
}

/** What an agent is told about where it runs, then every plugin's line for agents (the vault's rules, the user's file). */
export function context(t: Thread) {
  const inVaultNow = realOf(t.cwd) === vaultReal()
  return [
    `You're running in Agents, a panel inside Vaultite, the user's vault app: they read your replies as Markdown in a chat, not a terminal, and answer your permission requests with Allow or Deny. You work in ${inVaultNow ? "their vault" : tilde(t.cwd)}; their vault is ${tilde(plugin.vault.path)}.`,
    "Name vault notes by their vault path (Notes/Idea.md). The `vau` CLI (`vau --help`; `vau context` first) reads and changes the vault and the app.",
    ...agentLines(plugin.vault).map((l) => `- ${l.text}`),
  ].join("\n")
}

// ---------- diffs

/** A unified diff's hunks (Codex's file changes), at most 20 of 400 lines each. */
export function hunksOf(diff: string): Hunk[] {
  const out: Hunk[] = []
  let h: Hunk | null = null
  for (const line of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) { h = { oldStart: +m[1], newStart: +m[2], lines: [] }; out.push(h); continue }
    if (!h || line.startsWith("+++") || line.startsWith("---")) continue
    if (/^[+\- \\]/.test(line) && h.lines.length < 400) h.lines.push(line)
  }
  // (a new file's diff may be only + lines, with no hunk header)
  if (!out.length && diff.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++"))) out.push({ oldStart: 0, newStart: 1, lines: diff.split("\n").filter((l) => /^[+\- ]/.test(l) && !/^(\+\+\+|---)/.test(l)).slice(0, 400) })
  return out.slice(0, 20)
}

/** A unified diff of many files (git's) as each file's hunks and counts: the diff panel's, larger than a tool's. */
export function filesOfDiff(diff: string, cwd = ""): FileDiff[] {
  const out: FileDiff[] = []
  for (const part of diff.split(/^diff --git /m).slice(1)) {
    const head = part.split("\n", 1)[0]
    const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(part)?.[1], minus = /^--- (?:a\/)?(.+)$/m.exec(part)?.[1]
    const name = (plus && plus !== "/dev/null" ? plus : minus && minus !== "/dev/null" ? minus : / b\/(.+)$/.exec(head)?.[1] ?? head).trim()
    const hunks: Hunk[] = []
    let h: Hunk | null = null, added = 0, removed = 0, lines = 0
    for (const line of part.split("\n")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) { h = { oldStart: +m[1], newStart: +m[2], lines: [] }; hunks.push(h); continue }
      if (!h || /^(\+\+\+|---) /.test(line)) continue
      if (line[0] === "+") added++
      else if (line[0] === "-") removed++
      if (/^[+\- \\]/.test(line) && lines++ < 3000) h.lines.push(line)
    }
    const abs = cwd ? path.join(cwd, name) : name
    const file = cwd ? inVault(abs) : undefined
    out.push({ path: name, ...(file ? { file } : {}), added, removed, hunks, binary: /^Binary files/m.test(part), status: /^new file/m.test(part) ? "added" : /^deleted file/m.test(part) ? "deleted" : "modified" })
  }
  return out
}

const EDITS = /^(Edit|MultiEdit|Write|NotebookEdit)$/
/** What a thread changed: each file it edited, with lines added and removed. */
export function changesOf(t: Thread): Changes {
  const files = new Map<string, Changes["files"][number]>()
  for (const e of t.entries) {
    if (e.kind !== "tool" || !EDITS.test(e.name) || e.error || e.result === undefined) continue // (finished ones: not one still asked about)
    const key = e.path ?? e.file ?? str(e.input.file_path)
    if (!key) continue
    const f = files.get(key) ?? { path: e.file ?? tilde(key), ...(e.file ? { file: e.file } : {}), added: 0, removed: 0 }
    if (e.patch?.length) for (const h of e.patch) for (const l of h.lines) { if (l[0] === "+") f.added++; else if (l[0] === "-") f.removed++ }
    else if (e.name === "Write") f.added += str(e.input.content).split("\n").length
    files.set(key, f)
  }
  const list = [...files.values()]
  return { files: list, added: list.reduce((n, f) => n + f.added, 0), removed: list.reduce((n, f) => n + f.removed, 0) }
}

/** What a stretch of the thread's edits did, file by file, from their patches (a folder that isn't a git checkout). */
export function patchFiles(t: Thread, from: number, to: number): FileDiff[] {
  const files = new Map<string, FileDiff>()
  for (const e of t.entries.slice(from, to)) {
    if (e.kind !== "tool" || !EDITS.test(e.name) || e.error || e.result === undefined) continue
    const key = e.path ?? e.file ?? str(e.input.file_path)
    if (!key) continue
    const rel = e.file ?? (key.startsWith(t.cwd + "/") ? key.slice(t.cwd.length + 1) : tilde(key))
    const f = files.get(key) ?? { path: rel, ...(e.file ? { file: e.file } : {}), added: 0, removed: 0, hunks: [], status: "modified" as const }
    let hunks = e.patch ?? []
    if (!hunks.length && e.name === "Write") { hunks = [{ oldStart: 0, newStart: 1, lines: str(e.input.content).split("\n").slice(0, 3000).map((l) => `+${l}`) }]; if (!f.hunks.length) f.status = "added" }
    else if (!hunks.length && e.name === "Edit") hunks = [{ oldStart: 0, newStart: 0, lines: [...str(e.input.old_string).split("\n").map((l) => `-${l}`), ...str(e.input.new_string).split("\n").map((l) => `+${l}`)] }]
    for (const h of hunks) for (const l of h.lines) { if (l[0] === "+") f.added++; else if (l[0] === "-") f.removed++ }
    f.hunks.push(...hunks)
    files.set(key, f)
  }
  return [...files.values()]
}

// ---------- projects: the vault, project files with a checkout here, then folders threads ran in

export function projects(): Project[] {
  const out: Project[] = [{ label: "Vault", path: vaultReal(), vault: true }]
  const seen = new Set([vaultReal()])
  const add = (label: string, p: string) => {
    const real = realOf(home(p))
    if (seen.has(real)) return
    try { if (!fs.statSync(real).isDirectory()) return } catch { return }
    seen.add(real)
    out.push({ label, path: real })
  }
  try {
    for (const p of plugin.vault.items("projects")) if (typeof p.path === "string" && !p.archived) add(str(p.name) || str(p.title) || path.basename(p.path), p.path)
  } catch { /* Projects is off */ }
  for (const t of [...threads.values()].sort((a, b) => b.updated.localeCompare(a.updated))) add(path.basename(homeOf(t)), homeOf(t))
  return out
}
export function projectOf(cwd: string, list = projects()) {
  const real = realOf(cwd)
  return list.find((p) => p.path === real)?.label ?? path.basename(cwd)
}

// ---------- threads: in memory, saved to their files a moment after they change

export const threads = new Map<string, Thread>()
export const live = new Map<string, Live>()
let loaded = false

export function load() {
  if (loaded) return
  loaded = true
  for (const f of fs.readdirSync(dir("threads"))) {
    if (!f.endsWith(".json")) continue
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir("threads"), f), "utf8")) as Thread
      if (!t || !ID.test(t.id) || !Array.isArray(t.entries)) continue
      // A turn the server went down in: its questions can't be answered any more.
      for (const e of t.entries) if (e.kind === "ask" && !e.answer) e.answer = "gone"
      for (const e of t.entries) if (e.kind === "assistant") delete e.open
      t.entries.forEach((e, i) => {
        if (e.kind !== "user" || e.end) return
        const next = t.entries.findIndex((x, j) => j > i && x.kind === "user")
        e.end = t.entries.slice(i + 1, next < 0 ? undefined : next).at(-1)?.at ?? e.at
      })
      for (const e of t.entries) if (e.kind === "tool" && e.result === undefined) { e.result = ""; e.error = true }
      // (before 1.2 Plan was a mode of its own)
      if ((t.mode as string) === "read") { t.mode = "ask"; t.plan = true }
      threads.set(t.id, t)
    } catch { /* unreadable: left alone */ }
  }
  const cut = [...threads.values()].filter((t) => t.running)
  if (cut.length) setTimeout(() => interrupted(cut), 0)
}

/** What takes up the threads a turn was under way in when the server went (load() finds them). */
let interrupted: (list: Thread[]) => void = () => {}
export const onInterrupted = (fn: typeof interrupted) => { interrupted = fn }
/** Forget what's in memory: the same module loaded again (off and on) starts from the files. */
export function reset() { saveAll(); runs.clear(); live.clear(); threads.clear(); loaded = false }

const saving = new Map<string, ReturnType<typeof setTimeout>>()
/** Every thread's pending save, now (the server is going). */
export function saveAll() { for (const id of [...saving.keys()]) { const t = threads.get(id); if (t) save(t, false) } }

export function save(t: Thread, soon = true) {
  clearTimeout(saving.get(t.id))
  const write = () => { saving.delete(t.id); if (threads.get(t.id) === t) fs.writeFileSync(threadFile(t.id), JSON.stringify(t)) }
  if (soon) saving.set(t.id, setTimeout(write, 400))
  else write()
}

export function thread(id: string): Thread {
  load()
  const t = ID.test(id) ? threads.get(id) : undefined
  if (!t) throw new HTTPError(404, `no thread '${id}'`)
  return t
}

export function create(harness: Harness, cwd: string, model: string, mode: Mode): Thread {
  load()
  const t: Thread = { id: crypto.randomBytes(5).toString("hex"), title: NEW_TITLE, harness, cwd, model, mode,
    session: harness === "claude" ? crypto.randomUUID() : "", started: false, created: now(), updated: now(), entries: [] }
  threads.set(t.id, t)
  save(t, false)
  listChanged()
  return t
}

export function forget(t: Thread) {
  threads.delete(t.id)
  live.delete(t.id)
  clearTimeout(saving.get(t.id))
  fs.rmSync(threadFile(t.id), { force: true })
  fs.rmSync(path.join(plugin.localDir(), "images", t.id), { recursive: true, force: true })
  tell(t.id, { t: "gone", id: t.id })
  listChanged()
}

/** The project a thread belongs to: its folder, or the checkout its worktree came from. */
export const homeOf = (t: Thread) => t.worktree?.from ?? t.cwd
export const liveOf = (id: string): Live => live.get(id) ?? { running: false, status: "" }
export const waitingIn = (t: Thread) => t.entries.some((e) => e.kind === "ask" && !e.answer)
const excerpt = (s: string, n = 280) => { const one = s.replace(/\s+/g, " ").trim(); return one.length > n ? `${one.slice(0, n)}…` : one }

/** When a thread settled, if it has, by T3 Code's rules: by hand, else by itself once nothing waits on it and its pull
 *  request was merged (the setting) or closed after the last message, or nothing happened for days (the setting). */
export function settledAt(t: Thread, now = Date.now()): string | null {
  const s = plugin.settings()
  const days = typeof s.settleAfterDays === "number" ? s.settleAfterDays : 3
  if (t.settledOverride === "settled") return t.settledAt ?? t.updated
  if (t.settledOverride === "active" || t.pinnedAt || t.autoSettleOff || t.archivedAt || snoozed(t, now)) return null
  const l = liveOf(t.id)
  if (l.running || waitingIn(t) || t.queue?.length) return null
  const u = t.entries.findLast((e) => e.kind === "user") as Extract<Entry, { kind: "user" }> | undefined
  const active = u ? u.end ?? u.at : t.created
  if (t.pr && ((t.pr.state === "MERGED" && s.settleOnMerge !== false) || t.pr.state === "CLOSED") && (t.pr.at ?? "") >= (u?.at ?? t.created)) return active
  return days > 0 && Date.parse(active) < now - days * 86_400_000 ? active : null
}

export const snoozed = (t: Thread, now = Date.now()) => !!t.snoozedUntil && Date.parse(t.snoozedUntil) > now && !waitingIn(t)

export function summaries(): Summary[] {
  load()
  const list = projects()
  return [...threads.values()].map((t) => {
    const l = liveOf(t.id)
    const last = t.entries.findLast((e) => e.kind === "assistant") as { text: string } | undefined
    const asked = t.entries.findLast((e) => e.kind === "user") as { text: string; at: string } | undefined
    const settled = settledAt(t)
    const u = t.entries.findLast((e) => e.kind === "user" && !e.steer) as { at: string } | undefined
    const waits = t.entries.filter((e) => e.kind === "ask" && !e.answer) as { tool: string }[]
    return { id: t.id, title: t.title, harness: t.harness, cwd: t.cwd, home: homeOf(t), project: projectOf(homeOf(t), list), model: t.model, mode: t.mode, updated: t.updated,
      created: t.created, running: l.running, waiting: waitingIn(t), status: l.status, asked: excerpt(asked?.text ?? "", 160), askedAt: asked?.at ?? t.created,
      last: excerpt(last?.text ?? ""), changes: changesOf(t), ...(t.queue?.length ? { queued: t.queue.length } : {}), ...(settled ? { settledAt: settled } : {}),
      ...(t.settledOverride ? { settledOverride: t.settledOverride } : {}), ...(t.pr ? { pr: t.pr } : {}),
      ...(t.plan ? { plan: true } : {}), ...(t.pinnedAt ? { pinnedAt: t.pinnedAt } : {}), ...(snoozed(t) ? { snoozedUntil: t.snoozedUntil } : {}),
      ...(t.snoozedUntil && !snoozed(t) ? { woke: true } : {}), ...(t.archivedAt ? { archived: true } : {}), ...(t.unread && !l.running ? { unread: true } : {}),
      ...(t.autoSettleOff ? { autoSettleOff: true } : {}), ...(waits.length && waits.every((a) => a.tool === "AskUserQuestion") ? { input: true } : {}),
      ...(l.running && u ? { since: u.at } : {}), ...(t.worktree ? { worktree: true } : {}),
      ...(t.worktree?.branch ? { branch: t.worktree.branch } : {}), ...(!l.running && (t.entries.at(-1) as { error?: boolean } | undefined)?.error && t.entries.at(-1)?.kind === "note" ? { failed: true } : {}) }
  }).sort((a, b) => b.updated.localeCompare(a.updated))
}

// ---------- the sockets: each app gets the list, and the threads it watches entry by entry

export const sockets = new Map<WebSocket, Set<string>>()
export const send = (ws: WebSocket, msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)) }
let listTimer: ReturnType<typeof setTimeout> | null = null
export function listChanged() {
  if (listTimer) return
  listTimer = setTimeout(() => { listTimer = null; const list = summaries(); for (const ws of sockets.keys()) send(ws, { t: "list", list }) }, 80)
}
export function tell(id: string, msg: unknown) {
  for (const [ws, ids] of sockets) if (ids.has(id)) send(ws, msg)
}

/** Entry `i` changed (or is new): watchers get it, and the file is saved soon. Streamed text goes at most every 60 ms. */
const dirty = new Map<string, Set<number>>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
export function changed(t: Thread, i: number, stream = false) {
  t.updated = now()
  const d = dirty.get(t.id) ?? new Set<number>()
  d.add(i)
  dirty.set(t.id, d)
  if (!stream) return flush(t)
  if (!flushTimers.has(t.id)) flushTimers.set(t.id, setTimeout(() => flush(t), 60))
}
export function flush(t: Thread) {
  clearTimeout(flushTimers.get(t.id))
  flushTimers.delete(t.id)
  for (const i of dirty.get(t.id) ?? []) tell(t.id, { t: "entry", id: t.id, i, entry: t.entries[i] })
  dirty.delete(t.id)
  save(t)
}
export function push(t: Thread, e: Entry) {
  t.entries.push(e)
  changed(t, t.entries.length - 1)
  listChanged()
  return t.entries.length - 1
}
export function setLive(t: Thread, l: Partial<Live>) {
  const next = { ...liveOf(t.id), ...l }
  const was = liveOf(t.id)
  live.set(t.id, next)
  if (was.running === next.running && was.status === next.status) return
  tell(t.id, { t: "live", id: t.id, live: next })
  listChanged()
}

// ---------- a turn's bookkeeping, whatever runs it

export type Turn = { done: (text: string, error: string | null) => void }
export type Image = { path: string; type: string; data: string }

export abstract class Run {
  t: Thread
  model: string
  mode: Mode
  cwd: string
  turns: Turn[] = []
  busy = false
  ended = false
  stopping = false
  stopTimer: ReturnType<typeof setTimeout> | null = null
  idle: ReturnType<typeof setTimeout> | null = null
  /** Where the turn under way began in the thread. */
  from = 0

  constructor(t: Thread) { this.t = t; this.model = t.model; this.mode = t.mode; this.cwd = t.cwd }

  /** Send the user's message (its entry `u` is in already; while it works, into that turn); false when the CLI can't take it. */
  abstract send(text: string, images: Image[], u?: Extract<Entry, { kind: "user" }>): boolean
  /** Interrupt the turn under way. */
  protected abstract interrupt(): void
  /** Tell the CLI the user's answer to permission request `id` (or to its questions: `e.answers`). */
  protected abstract answer(e: Extract<Entry, { kind: "ask" }>, allow: boolean): void
  /** End this run's process (or its part of a shared one). */
  abstract end(): void
  /** The process its turns run in. */
  abstract pid(): number | undefined
  /** Ended, and its process gone (Codex's shared one stays). */
  async closed() { this.end() }
  /** The server is going: its process ends now, and the turn under way is left for the next start to take up. */
  abstract abandon(): void

  begin() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    this.from = this.t.entries.length
    this.busy = true
    this.hold()
  }
  /** The turn under way and its process, kept with the thread. */
  hold() {
    const pid = this.pid()
    if (this.busy && pid && this.t.running?.pid !== pid) { this.t.running = { pid, at: now() }; save(this.t, false) }
  }

  /** The user's answer to a permission request (allow or deny), or "gone" when it can't be answered any more. */
  /** `scope`: allowed for the rest of the session ("Always allow this session"), or declined and the turn stopped. */
  settle(id: string, answer: "allow" | "deny" | "gone", answers?: Record<string, string>, scope?: "session" | "cancel") {
    const t = this.t
    const at = t.entries.findLastIndex((e) => e.kind === "ask" && e.id === id)
    const e = t.entries[at]
    if (e?.kind !== "ask" || e.answer) return false
    e.answer = answer
    if (answers) e.answers = answers
    if (scope) e.scope = scope
    changed(t, at)
    if (answer !== "gone") this.answer(e, answer === "allow")
    if (!waitingIn(t)) setLive(t, { status: "working" })
    listChanged()
    return true
  }

  stop() {
    if (!this.busy) return
    this.stopping = true
    for (const e of this.t.entries) if (e.kind === "ask" && !e.answer) this.settle(e.id, "gone")
    this.interrupt()
    this.stopTimer = setTimeout(() => { if (this.busy) this.kill() }, STOP_MS)
  }
  /** When it won't stop: the process goes (Codex's shared one stays; its turn is ended here). */
  protected kill() { this.endTurn("", null) }

  failed(text: string, signIn = /not logged in|\/login|invalid api key|authenticat|oauth token|codex login/i.test(text)) {
    const who = this.t.harness === "claude" ? "Claude Code" : "Codex"
    push(this.t, { kind: "note", text: signIn ? `${who} isn't signed in on this machine.` : text, at: now(), error: true, ...(signIn ? { signIn } : {}) })
  }

  endTurn(text: string, error: string | null) {
    const t = this.t
    t.entries.forEach((e, i) => { if (e.kind === "assistant" && e.open) { delete e.open; changed(t, i) } })
    t.entries.forEach((e, i) => { if (e.kind === "ask" && !e.answer) { e.answer = "gone"; changed(t, i) } })
    t.entries.forEach((e, i) => { if (e.kind === "tool" && e.result === undefined && i >= this.from) { e.result = ""; e.error = true; changed(t, i) } })
    const u = t.entries.findLastIndex((e, i) => i < this.from && e.kind === "user")
    const began = t.entries[u]
    if (began?.kind === "user" && !began.end) { began.end = now(); changed(t, u) }
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null }
    this.stopping = false
    this.busy = false
    delete t.running
    // (finished with no one looking: "Done" in the list until it's opened)
    if (![...sockets.values()].some((ids) => ids.has(t.id))) t.unread = true
    setLive(t, { running: false, status: "" })
    flush(t)
    listChanged()
    for (const turn of this.turns.splice(0)) turn.done(text, error)
    if (this.idle) clearTimeout(this.idle)
    if (!this.ended) this.idle = setTimeout(() => this.end(), IDLE_MS)
  }

  /** The turn's last answer, as an agent reads it. */
  said() { return (this.t.entries.slice(this.from).findLast((e) => e.kind === "assistant") as { text: string } | undefined)?.text ?? "" }
}

export const runs = new Map<string, Run>()
