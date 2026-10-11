// Claude chat: the user's own `claude` CLI run on this machine in the vault's folder, as a chat. Each conversation is a
// Claude Code session driven with stream JSON both ways; conversations are kept in plugin.localDir(), never the vault.
import { type ChildProcess, execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import os from "node:os"
import path from "node:path"
import type { WebSocket } from "ws"
import { agentLines, HTTPError, OpError, Plugin, type Request, ROOT, Text } from "@vaultite/core/plugins.ts"

export const plugin = new Plugin(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
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

const MODES = ["default", "acceptEdits", "plan"]
const NEW_TITLE = "New chat"
const IDLE_MS = 10 * 60_000
const STOP_MS = 4000
const now = () => new Date().toISOString()
const str = (v: unknown) => (typeof v === "string" ? v : "")
const cut = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s)

// ---------- where things are

const dir = (...p: string[]) => { const d = path.join(plugin.localDir(), ...p); fs.mkdirSync(d, { recursive: true }); return d }
const convFile = (id: string) => path.join(dir("conversations"), `${id}.json`)
const ID = /^[a-z0-9]{6,16}$/
const vaultReal = () => { try { return fs.realpathSync(plugin.vault.path) } catch { return plugin.vault.path } }

/** A path Claude used, as the vault's (Notes/Idea.md), or undefined when it's outside the vault. */
function inVault(abs: string): string | undefined {
  if (!abs) return undefined
  for (const root of new Set([plugin.vault.path, vaultReal()])) if (abs.startsWith(root + "/")) return abs.slice(root.length + 1)
  return undefined
}

/** The claude CLI: CLAUDE_CHAT_CLI or this machine's data/config.json (`claude-chat.cli`), else found where installs put it. */
function cliPath(): string | null {
  const own = process.env.CLAUDE_CHAT_CLI || str((plugin.secrets()["claude-chat"] as Any)?.cli)
  if (own) return fs.existsSync(own) ? own : null
  const home = os.homedir()
  const dirs = [...(process.env.PATH ?? "").split(":"), path.join(home, ".local/bin"), path.join(home, ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin",
    path.join(home, ".npm-global/bin"), path.join(home, ".volta/bin"), path.join(home, ".bun/bin")]
  for (const d of dirs.filter(Boolean)) {
    const p = path.join(d, "claude")
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}

// A Claude Code that inherits these from a session that started the server takes itself for nested (terminal's list).
const AGENT_SESSION = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID", "CLAUDE_EFFORT"]

// (a launchd server's PATH is bare: an npm-installed claude is a node script, so it needs node's folder)
function env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || AGENT_SESSION.includes(k) || k.startsWith("npm_") || (k.startsWith("VAULTITE") && k !== "VAULTITE_LOCAL")
      || ["PORT", "HOST", "INIT_CWD", "TMUX", "TMUX_PANE", "ELECTRON_RUN_AS_NODE", "CLAUDE_CHAT_CLI"].includes(k)) continue
    out[k] = v
  }
  const host = !process.env.HOST || ["0.0.0.0", "::"].includes(process.env.HOST) ? "127.0.0.1" : process.env.HOST
  return { ...out, VAULTITE: "1", VAULTITE_URL: `http://${host.includes(":") ? `[${host}]` : host}:${Number(process.env.PORT || 8793)}`,
    VAULTITE_VAULT: plugin.vault.path, PATH: [...new Set([path.join(ROOT, "bin"), ...(out.PATH ?? "").split(":"), path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean))].join(":") }
}

/** What Claude is told about where it runs, then every plugin's line for agents (the vault's rules, the user's file). */
function context() {
  const lines = agentLines(plugin.vault).map((l) => `- ${l.text}`)
  return [
    "You're Claude Code in Claude chat, a chat panel inside Vaultite, the user's vault app: they read your replies beside their notes, drawn as Markdown, and this folder is their vault. They can't type into a terminal here: they answer your permission requests with Allow or Deny, and anything else in their next message.",
    "Name notes by their vault path (Notes/Idea.md) or as [[links]]. The `vau` CLI (`vau --help`; `vau context` first) reads and changes the vault and the app.",
    ...lines,
  ].join("\n")
}

/** Claude Code's hooks for a chat's runs: Activity hears each edit and command, as it does a terminal's. */
function hooks(): string | null {
  const report = plugin.service("activity:report") as ((agent: string, terminal: string) => string) | null
  if (!report) return null
  return JSON.stringify({ hooks: { PostToolUse: [{ matcher: "^(Edit|Write|MultiEdit|NotebookEdit|Bash)$", hooks: [{ type: "command", command: report("claude", "") }] }] } })
}

// ---------- conversations: in memory, saved to their files a moment after they change

const convs = new Map<string, Conv>()
const live = new Map<string, Live>()
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  for (const f of fs.readdirSync(dir("conversations"))) {
    if (!f.endsWith(".json")) continue
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir("conversations"), f), "utf8")) as Conv
      if (!c || !ID.test(c.id) || !Array.isArray(c.entries)) continue
      // A turn the server went down in: its questions can't be answered any more.
      for (const e of c.entries) if (e.kind === "ask" && !e.answer) e.answer = "gone"
      for (const e of c.entries) if (e.kind === "assistant") delete e.open
      convs.set(c.id, c)
    } catch { /* unreadable: left alone */ }
  }
}

const saving = new Map<string, ReturnType<typeof setTimeout>>()
function save(c: Conv, soon = true) {
  clearTimeout(saving.get(c.id))
  const write = () => { saving.delete(c.id); if (convs.get(c.id) === c) fs.writeFileSync(convFile(c.id), JSON.stringify(c)) }
  if (soon) saving.set(c.id, setTimeout(write, 400))
  else write()
}

function conv(id: string): Conv {
  load()
  const c = ID.test(id) ? convs.get(id) : undefined
  if (!c) throw new HTTPError(404, `no conversation '${id}'`)
  return c
}

const liveOf = (id: string): Live => live.get(id) ?? { running: false, status: "" }
const waitingIn = (c: Conv) => c.entries.some((e) => e.kind === "ask" && !e.answer)
function summaries(): Summary[] {
  load()
  return [...convs.values()].map((c) => ({ id: c.id, title: c.title, updated: c.updated, running: liveOf(c.id).running, waiting: waitingIn(c) }))
    .sort((a, b) => b.updated.localeCompare(a.updated))
}

function create(title = NEW_TITLE): Conv {
  load()
  const c: Conv = { id: crypto.randomBytes(5).toString("hex"), title, session: crypto.randomUUID(), started: false, created: now(), updated: now(), entries: [] }
  convs.set(c.id, c)
  save(c, false)
  listChanged()
  return c
}

// ---------- the sockets: each app gets the list, and the conversations it watches entry by entry

const sockets = new Map<WebSocket, Set<string>>()
const send = (ws: WebSocket, msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)) }
let listTimer: ReturnType<typeof setTimeout> | null = null
function listChanged() {
  if (listTimer) return
  listTimer = setTimeout(() => { listTimer = null; const list = summaries(); for (const ws of sockets.keys()) send(ws, { t: "list", list }) }, 50)
}
function tell(id: string, msg: unknown) {
  for (const [ws, ids] of sockets) if (ids.has(id)) send(ws, msg)
}

/** Entry `i` changed (or is new): watchers get it, and the file is saved soon. Streamed text goes at most every 60 ms. */
const dirty = new Map<string, Set<number>>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
function changed(c: Conv, i: number, stream = false) {
  c.updated = now()
  const d = dirty.get(c.id) ?? new Set<number>()
  d.add(i)
  dirty.set(c.id, d)
  if (!stream) return flush(c)
  if (!flushTimers.has(c.id)) flushTimers.set(c.id, setTimeout(() => flush(c), 60))
}
function flush(c: Conv) {
  clearTimeout(flushTimers.get(c.id))
  flushTimers.delete(c.id)
  for (const i of dirty.get(c.id) ?? []) tell(c.id, { t: "entry", id: c.id, i, entry: c.entries[i] })
  dirty.delete(c.id)
  save(c)
}
function push(c: Conv, e: Entry) {
  c.entries.push(e)
  changed(c, c.entries.length - 1)
  return c.entries.length - 1
}
function setLive(c: Conv, l: Partial<Live>) {
  const next = { ...liveOf(c.id), ...l }
  live.set(c.id, next)
  tell(c.id, { t: "live", id: c.id, live: next })
  listChanged()
}

plugin.socket("claude-chat/live", async (ws, req) => {
  if (!(await allowed(ws, req))) return
  const ids = new Set<string>()
  sockets.set(ws, ids)
  send(ws, { t: "list", list: summaries() })
  ws.on("message", (data) => {
    let m: Any
    try { m = JSON.parse(String(data)) } catch { return }
    if (m?.t === "watch" && typeof m.id === "string") {
      ids.add(m.id)
      try { const c = conv(m.id); send(ws, { t: "conv", conv: c, live: liveOf(c.id) }) } catch { send(ws, { t: "gone", id: m.id }) }
    } else if (m?.t === "unwatch" && typeof m.id === "string") ids.delete(m.id)
  })
  ws.on("close", () => sockets.delete(ws))
})

/** Only this machine's owner chats (it runs Claude Code here), or the logins its settings let in. */
async function allowed(ws: WebSocket, req: IncomingMessage) {
  const why = await plugin.refusal(req, "Claude chat")
  if (why) { send(ws, { t: "refused", reason: why }); ws.close(4403, "refused"); return false }
  return ws.readyState === ws.OPEN
}
async function owner(req: Request) {
  const why = req.http ? await plugin.refusal(req.http, "Claude chat") : ""
  if (why) throw new HTTPError(403, why)
}

// ---------- running claude: one process per conversation while it's in use, ended after a while idle

type Turn = { done: (text: string, error: string | null) => void }
class Run {
  proc: ChildProcess
  c: Conv
  model: string
  mode: string
  buf = ""
  err = ""
  ended = false
  /** Index of each streamed text block of the message being written, by its index in that message. */
  blocks = new Map<number, number>()
  /** Streamed text entries the full message hasn't confirmed yet, in order. */
  open: number[] = []
  turns: Turn[] = []
  idle: ReturnType<typeof setTimeout> | null = null
  stopTimer: ReturnType<typeof setTimeout> | null = null
  stopping = false
  /** A turn is under way in this process (the conversation's live state may be a newer process's). */
  busy = false
  /** Where the turn under way began in the conversation. */
  from = 0

  constructor(c: Conv, cli: string, model: string, mode: string) {
    this.c = c; this.model = model; this.mode = mode
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-prompt-tool", "stdio", "--permission-mode", mode, "--disallowedTools", "AskUserQuestion",
      ...(model ? ["--model", model] : []), ...(c.started ? ["--resume", c.session] : ["--session-id", c.session]),
      "--append-system-prompt", context()]
    const h = hooks()
    if (h) args.push("--settings", h)
    this.proc = spawn(cli, args, { cwd: vaultReal(), env: env(), stdio: ["pipe", "pipe", "pipe"] })
    this.proc.stdout!.setEncoding("utf8")
    this.proc.stdout!.on("data", (d: string) => this.read(d))
    this.proc.stderr!.on("data", (d) => { this.err = (this.err + String(d)).slice(-4000) })
    this.proc.stdin!.on("error", () => { /* it exited: said below */ })
    this.proc.on("error", (e: NodeJS.ErrnoException) => this.exit(null, e.code === "ENOENT" ? "Claude Code isn't installed on this machine." : e.message))
    this.proc.on("exit", (code) => this.exit(code, null))
  }

  write(o: unknown) {
    if (this.ended || !this.proc.stdin?.writable) return false
    this.proc.stdin.write(JSON.stringify(o) + "\n")
    return true
  }

  ask(text: string, images: { type: string; data: string }[]) {
    if (this.idle) { clearTimeout(this.idle); this.idle = null }
    this.from = this.c.entries.length
    this.busy = true
    const content = [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })), { type: "text", text }]
    return this.write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" })
  }

  read(d: string) {
    this.buf += d
    let i
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      let j: Any
      try { j = JSON.parse(line) } catch { continue }
      try { this.line(j) } catch (e) { console.error("claude-chat:", e) }
    }
  }

  line(j: Any) {
    const c = this.c
    if (j.parent_tool_use_id) return // a subagent's own work: its Task line says what it was asked
    if (j.type === "system" && j.subtype === "init") {
      if (!c.started) { c.started = true; save(c) }
    } else if (j.type === "stream_event") this.stream(j.event)
    else if (j.type === "assistant") {
      for (const b of j.message?.content ?? []) {
        if (b.type === "text" && b.text) {
          const at = this.open.shift()
          const e = at === undefined ? undefined : c.entries[at]
          if (e?.kind === "assistant") { e.text = b.text; delete e.open; changed(c, at!) }
          else push(c, { kind: "assistant", text: b.text, at: now() })
        } else if (b.type === "tool_use") {
          const input = b.input && typeof b.input === "object" ? b.input : {}
          push(c, { kind: "tool", id: str(b.id), name: str(b.name), input, at: now(), file: inVault(str(input.file_path) || str(input.notebook_path) || str(input.path)) })
          setLive(c, { status: b.name === "Task" || b.name === "Agent" ? "delegating" : "working" })
        }
      }
    } else if (j.type === "user") {
      const content = Array.isArray(j.message?.content) ? j.message.content : []
      for (const b of content) {
        if (b.type === "text" && /^\[Request interrupted by user/.test(b.text ?? "")) push(c, { kind: "note", text: "Stopped.", at: now() })
        if (b.type !== "tool_result") continue
        const at = c.entries.findIndex((e) => e.kind === "tool" && e.id === b.tool_use_id)
        const e = c.entries[at]
        if (e?.kind !== "tool") continue
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x: Any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n") : ""
        e.result = cut(text)
        if (b.is_error) e.error = true
        const patch = j.tool_use_result?.structuredPatch
        if (Array.isArray(patch) && patch.length) e.patch = patch.slice(0, 20).map((h: Any) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: (h.lines ?? []).slice(0, 400) }))
        changed(c, at)
      }
      setLive(c, { status: "thinking" })
    } else if (j.type === "control_request") this.control(j)
    else if (j.type === "control_cancel_request") this.settle(str(j.request_id), "gone")
    else if (j.type === "result") this.result(j)
  }

  stream(ev: Any) {
    const c = this.c
    if (ev?.type === "message_start") this.blocks.clear()
    else if (ev?.type === "content_block_start") {
      const b = ev.content_block ?? {}
      if (b.type === "text") {
        const at = push(c, { kind: "assistant", text: b.text ?? "", at: now(), open: true })
        this.blocks.set(ev.index, at)
        this.open.push(at)
        setLive(c, { status: "writing" })
      } else if (b.type === "thinking") setLive(c, { status: "thinking" })
      else if (b.type === "tool_use") setLive(c, { status: "working" })
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const at = this.blocks.get(ev.index)
      const e = at === undefined ? undefined : c.entries[at]
      if (e?.kind === "assistant") { e.text += ev.delta.text ?? ""; changed(c, at!, true) }
    }
  }

  control(j: Any) {
    const r = j.request ?? {}
    if (r.subtype !== "can_use_tool") return this.write({ type: "control_response", response: { subtype: "error", request_id: j.request_id, error: `${r.subtype} isn't supported here` } })
    const input = r.input && typeof r.input === "object" ? r.input : {}
    push(this.c, { kind: "ask", id: str(j.request_id), tool: str(r.tool_name), input, text: str(r.description), at: now(),
      file: inVault(str(input.file_path) || str(input.notebook_path)) })
    setLive(this.c, { status: "waiting" })
  }

  /** The user's answer to a permission request (allow or deny), or "gone" when it can't be answered any more. */
  settle(id: string, answer: "allow" | "deny" | "gone") {
    const c = this.c
    const at = c.entries.findIndex((e) => e.kind === "ask" && e.id === id)
    const e = c.entries[at]
    if (e?.kind !== "ask" || e.answer) return false
    e.answer = answer
    changed(c, at)
    if (answer === "allow") this.write({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "allow", updatedInput: e.input } } })
    if (answer === "deny") this.write({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "deny", message: "The user said no. Ask them what they'd like instead." } } })
    if (!waitingIn(c)) setLive(c, { status: "working" })
    else listChanged()
    return true
  }

  result(j: Any) {
    const c = this.c
    const aborted = j.terminal_reason === "aborted_streaming" || this.stopping
    const said = c.entries.slice(this.from).filter((e) => e.kind === "assistant").at(-1) as { text: string } | undefined
    const text = str(j.result) || said?.text || ""
    const failed = (j.is_error || /^error/.test(str(j.subtype))) && !aborted
    if (failed) this.failed([text, ...(Array.isArray(j.errors) ? j.errors.filter((x: unknown) => typeof x === "string" && !x.startsWith("[ede_diagnostic]")) : [])].filter(Boolean).join("\n") || "Claude Code stopped with an error.")
    this.endTurn(aborted ? "" : text, failed ? "failed" : null)
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.end(), IDLE_MS)
  }

  failed(text: string) {
    const signIn = /not logged in|\/login|invalid api key|authenticat|oauth token/i.test(text)
    push(this.c, { kind: "note", text: signIn ? "Claude Code isn't signed in on this machine." : text, at: now(), error: true, ...(signIn ? { signIn } : {}) })
  }

  endTurn(text: string, error: string | null) {
    const c = this.c
    for (const at of this.open) { const e = c.entries[at]; if (e?.kind === "assistant") { delete e.open; changed(c, at) } }
    this.open = []
    for (const [i, e] of c.entries.entries()) if (e.kind === "ask" && !e.answer) { e.answer = "gone"; changed(c, i) }
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null }
    this.stopping = false
    this.busy = false
    setLive(c, { running: false, status: "" })
    flush(c)
    for (const t of this.turns.splice(0)) t.done(text, error)
  }

  stop() {
    if (!this.busy) return
    this.stopping = true
    for (const e of this.c.entries) if (e.kind === "ask" && !e.answer) this.settle(e.id, "gone")
    this.write({ type: "control_request", request_id: `stop-${Date.now()}`, request: { subtype: "interrupt" } })
    this.stopTimer = setTimeout(() => { if (this.busy) this.kill() }, STOP_MS)
  }

  /** Ended here: stdin closed (it saves and exits), or killed when it won't. */
  end() {
    if (this.ended) return
    try { this.proc.stdin?.end() } catch { /* gone */ }
    setTimeout(() => this.kill(), 3000).unref()
  }
  kill() { if (!this.ended) try { this.proc.kill("SIGTERM") } catch { /* gone */ } }

  exit(code: number | null, why: string | null) {
    if (this.ended) return
    this.ended = true
    if (this.idle) clearTimeout(this.idle)
    if (runs.get(this.c.id) === this) runs.delete(this.c.id)
    if (!this.busy) return
    if (this.stopping) { push(this.c, { kind: "note", text: "Stopped.", at: now() }); return this.endTurn("", null) }
    const tail = this.err.trim().split("\n").slice(-6).join("\n")
    this.failed(why ?? (tail || `Claude Code stopped (exit ${code ?? "signal"}).`))
    this.endTurn("", "failed")
  }
}

const runs = new Map<string, Run>()
plugin.onUnload(() => { for (const r of runs.values()) r.end(); for (const ws of sockets.keys()) ws.close() })

const settings = () => {
  const s = plugin.settings()
  return { mode: MODES.includes(str(s.mode)) ? str(s.mode) : "default", model: str(s.model).trim(), currentNote: s.currentNote !== false }
}

type Image = { type: string; data: string; name?: string }
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }

/** Send a message to a conversation: its text, the note open beside it and pasted images; the turn's answer comes later. */
function ask(c: Conv, text: string, opts: { file?: string; images?: Image[]; model?: string; mode?: string } = {}): Promise<{ text: string; error: string | null }> {
  if (liveOf(c.id).running) throw new HTTPError(409, "Claude is still answering: stop it first, or wait")
  const cli = cliPath()
  if (!cli) throw new HTTPError(424, "Claude Code isn't installed on this machine")
  const s = settings()
  const model = opts.model ?? s.model, mode = opts.mode && MODES.includes(opts.mode) ? opts.mode : s.mode
  const images = (opts.images ?? []).filter((im) => IMAGE_TYPES[im.type] && typeof im.data === "string").slice(0, 6)
  const saved = images.map((im, n) => {
    const name = `${Date.now().toString(36)}-${n}.${IMAGE_TYPES[im.type]}`
    fs.writeFileSync(path.join(dir("images", c.id), name), Buffer.from(im.data, "base64"))
    return name
  })
  const file = opts.file && !opts.file.includes("..") ? opts.file : undefined
  push(c, { kind: "user", text, at: now(), ...(file ? { file } : {}), ...(saved.length ? { images: saved } : {}) })
  if (c.title === NEW_TITLE) {
    const words = text.replace(/[@#*_`[\]]/g, "").trim().split(/\s+/).filter(Boolean)
    c.title = words.slice(0, 7).join(" ").slice(0, 60) + (words.length > 7 ? "…" : "") || NEW_TITLE
  }
  let r = runs.get(c.id)
  if (r && (r.ended || r.model !== model || r.mode !== mode)) { r.end(); r = undefined }
  if (!r) { r = new Run(c, cli, model, mode); runs.set(c.id, r) }
  const said = file ? `${text}\n\n(The note open beside this chat: ${file}. Read it if it helps.)` : text
  setLive(c, { running: true, status: "thinking" })
  const answer = new Promise<{ text: string; error: string | null }>((resolve) => r!.turns.push({ done: (t, error) => resolve({ text: t, error }) }))
  r.ask(said, images)
  return answer
}

// ---------- what the app asks for (routes) and agents (ops)

/** Is claude here, signed in, and which models it takes (its own list, from its handshake: nothing is sent to Claude). */
async function status() {
  const cli = cliPath()
  if (!cli) return { installed: false, loggedIn: false, cli: null, version: "", models: [] as Model[] }
  const [auth, version] = await Promise.all([plugin.memo(60, authStatus, cli), plugin.memo(3600, versionOf, cli)])
  const models = auth.loggedIn ? await plugin.memo(3600, modelsOf, cli).catch(() => [] as Model[]) : []
  return { installed: true, loggedIn: auth.loggedIn, cli, version, models }
}

const run = (cli: string, args: string[], ms = 15_000) => new Promise<{ code: number | null; out: string }>((resolve) =>
  execFile(cli, args, { env: env(), timeout: ms, cwd: vaultReal() }, (e, out) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out) })))

async function authStatus(cli: string) {
  const r = await run(cli, ["auth", "status", "--json"])
  try { return { loggedIn: JSON.parse(r.out).loggedIn === true } } catch { return { loggedIn: r.code === 0 } }
}
async function versionOf(cli: string) { return (await run(cli, ["--version"])).out.trim().split(" ")[0] ?? "" }

type Model = { value: string; label: string; description: string }
/** The models this claude offers: its stream-json handshake's list (no prompt is sent, nothing is spent). */
function modelsOf(cli: string): Promise<Model[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(cli, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], { cwd: os.tmpdir(), env: env(), stdio: ["pipe", "pipe", "ignore"] })
    let buf = ""
    const timer = setTimeout(() => { p.kill(); reject(new Error("no answer")) }, 20_000)
    p.on("error", (e) => { clearTimeout(timer); reject(e) })
    p.stdout.setEncoding("utf8")
    p.stdout.on("data", (d: string) => {
      buf += d
      for (const line of buf.split("\n").slice(0, -1)) {
        let j: Any
        try { j = JSON.parse(line) } catch { continue }
        if (j.type !== "control_response") continue
        clearTimeout(timer)
        p.stdin.end()
        const list = Array.isArray(j.response?.response?.models) ? j.response.response.models : []
        resolve(list.filter((m: Any) => typeof m?.value === "string").map((m: Any) => ({ value: m.value, label: str(m.displayName) || m.value, description: str(m.description) })))
        return
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1)
    })
    p.stdin.write(JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }) + "\n")
  })
}

plugin.route("GET", "claude-chat/status", async (req) => {
  await owner(req)
  if (req.query.fresh) plugin.forget()
  return await status()
})

plugin.route("GET", "claude-chat/conversations", async (req) => { await owner(req); return { list: summaries() } })

plugin.route("POST", "claude-chat/conversations", async (req) => { await owner(req); const c = create(); return { id: c.id } })

plugin.route("GET", "claude-chat/conversations/*", async (req) => {
  await owner(req)
  const c = conv(req.arg(0))
  return { conv: c, live: liveOf(c.id) }
})

plugin.route("PATCH", "claude-chat/conversations/*", async (req) => {
  await owner(req)
  const c = conv(req.arg(0))
  const title = str((req.body as Any)?.title).trim().slice(0, 120)
  if (!title) throw new HTTPError(400, "give it a title")
  c.title = title
  save(c)
  listChanged()
  return { id: c.id, title }
})

plugin.route("DELETE", "claude-chat/conversations/*", async (req) => {
  await owner(req)
  const c = conv(req.arg(0))
  runs.get(c.id)?.end()
  runs.delete(c.id)
  convs.delete(c.id)
  live.delete(c.id)
  clearTimeout(saving.get(c.id))
  fs.rmSync(convFile(c.id), { force: true })
  fs.rmSync(path.join(plugin.localDir(), "images", c.id), { recursive: true, force: true })
  tell(c.id, { t: "gone", id: c.id })
  listChanged()
  return { ok: true }
})

plugin.route("POST", "claude-chat/conversations/*/send", async (req) => {
  await owner(req)
  const c = conv(req.arg(0))
  const b = (req.body ?? {}) as Any
  const text = str(b.text).trim()
  if (!text && !b.images?.length) throw new HTTPError(400, "write a message first")
  void ask(c, text, { file: str(b.file) || undefined, images: Array.isArray(b.images) ? b.images : [] })
  return { ok: true }
}, { lock: false })

plugin.route("POST", "claude-chat/conversations/*/stop", async (req) => {
  await owner(req)
  const c = conv(req.arg(0))
  runs.get(c.id)?.stop()
  return { ok: true }
}, { lock: false })

plugin.route("POST", "claude-chat/conversations/*/answer", async (req) => {
  await owner(req)
  const c = conv(req.arg(0))
  const b = (req.body ?? {}) as Any
  const r = runs.get(c.id)
  if (!r || !r.settle(str(b.ask), b.allow === true ? "allow" : "deny")) throw new HTTPError(409, "that question isn't waiting any more")
  return { ok: true }
}, { lock: false })

/** Hand the session to a terminal: this chat's claude ends first, so the two never write one session at once. */
plugin.route("POST", "claude-chat/conversations/*/handoff", async (req) => {
  await owner(req)
  const c = conv(req.arg(0))
  if (!c.started) throw new HTTPError(409, "nothing to resume yet: send a message first")
  const r = runs.get(c.id)
  if (r) { r.stop(); r.end() }
  runs.delete(c.id)
  return { session: c.session }
}, { lock: false })

plugin.route("GET", "claude-chat/image/*/*", async (req) => {
  await owner(req)
  const [id, name] = [req.arg(0), req.arg(1)]
  if (!ID.test(id) || !/^[\w.-]+$/.test(name)) throw new HTTPError(404, "no such image")
  const file = path.join(plugin.localDir(), "images", id, name)
  if (!fs.existsSync(file)) throw new HTTPError(404, "no such image")
  return new Text(fs.readFileSync(file), `image/${name.endsWith("jpg") ? "jpeg" : name.split(".").pop()}`, { "Cache-Control": "private, max-age=86400" })
})

/** A turn's tool calls, as an agent reads them: "Edited Notes/Idea.md". */
function toolLines(c: Conv, from: number) {
  return c.entries.slice(from).filter((e) => e.kind === "tool").map((e) => {
    const t = e as Extract<Entry, { kind: "tool" }>
    return `${t.name}${t.file ? ` ${t.file}` : str(t.input.command) ? `: ${str(t.input.command).split("\n")[0].slice(0, 80)}` : str(t.input.pattern) ? ` ${str(t.input.pattern)}` : ""}${t.error ? " (failed)" : ""}`
  })
}

plugin.op({
  id: "claude-chat.ask",
  cli: "claude-chat ask",
  summary: "Send a message to Claude Code in the vault (Claude chat) and wait for its answer; a new conversation unless you name one.",
  help: `Runs the user's own claude CLI on the server's machine, in the vault's folder, with the plugin's permission mode
(ask before edits by default): when it asks to edit or run something, the user answers in Claude chat, so this waits.
The conversation shows in Claude chat's list; pass its id back as conversation to follow up.

  vau claude-chat ask "Which notes mention Lighthouse?"
  vau claude-chat ask "Now tag them #lighthouse" --conversation k3j2h1g0a1`,
  kind: "write",
  owner: "Claude chat",
  lock: false,
  mcp: true,
  params: {
    message: { type: "string", required: true, description: "what to ask or tell Claude" },
    conversation: { type: "string", description: "a conversation's id to follow up in (claude-chat list); a new one when left out" },
    model: { type: "string", description: "the model (opus, sonnet, haiku...); the plugin's setting when left out" },
    mode: { type: "string", enum: MODES, description: "default (asks before edits), acceptEdits or plan; the plugin's setting when left out" },
    file: { type: "string", format: "path", description: "a note to point Claude at (it's told the path)" },
    timeout: { type: "integer", minimum: 10, maximum: 3600, default: 600, description: "seconds to wait for the answer" },
  },
  args: ["message"],
  run: async (p, _ctx) => {
    let c: Conv
    try { c = p.conversation ? conv(p.conversation) : create() } catch { throw new OpError(`no conversation '${p.conversation}': claude-chat list lists them`, 404) }
    if (!cliPath()) throw new OpError("Claude Code isn't installed on this machine (https://claude.com/claude-code)", 424)
    const from = c.entries.length
    let pending: Promise<{ text: string; error: string | null }>
    try { pending = ask(c, p.message, { model: p.model, mode: p.mode, file: p.file }) } catch (e) { throw new OpError((e as Error).message, (e as HTTPError).status ?? 400) }
    const timer = new Promise<null>((r) => setTimeout(() => r(null), (p.timeout ?? 600) * 1000).unref())
    const got = await Promise.race([pending, timer])
    if (!got) throw new OpError(`no answer within ${p.timeout ?? 600} s: it's still going in Claude chat (conversation ${c.id})`, 504)
    const notes = c.entries.slice(from).filter((e) => e.kind === "note" && e.error).map((e) => (e as { text: string }).text)
    if (got.error) throw new OpError(notes.join("\n") || "Claude Code failed", 502)
    return { conversation: c.id, session: c.session, answer: got.text, tools: toolLines(c, from) }
  },
  text: (r) => `${r.answer || "(no answer)"}${r.tools.length ? `\n\nWhat it did: ${r.tools.join("; ")}.` : ""}\n\n(conversation ${r.conversation})`,
})

plugin.op({
  id: "claude-chat.list",
  cli: "claude-chat list",
  summary: "Claude chat's conversations on the server's machine, newest first: id, title, when, and whether one is running.",
  kind: "read",
  owner: "Claude chat",
  run: () => ({ conversations: summaries() }),
  text: (r) => (r.conversations.length ? r.conversations.map((c: Summary) => `${c.id}  ${c.title}  ${c.updated.slice(0, 16).replace("T", " ")}${c.running ? " (running)" : ""}${c.waiting ? " (waiting for the user)" : ""}`).join("\n") : "No conversations yet."),
})
