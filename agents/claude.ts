// Claude Code: the user's `claude` with stream JSON both ways, one process per thread while it's in use; permission
// asks reach us only with `--permission-prompt-tool stdio`.
import { type ChildProcess, execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import os from "node:os"
import { type Any, changed, cliPath, context, cut, env, Run, type Image, now, plugin, push, save, setLive, str, where } from "./core.ts"
import type { Entry, HarnessStatus, Model, Thread } from "./types.ts"

export const claudeCli = () => cliPath("claude", "AGENTS_CLAUDE_CLI")
export const FLAGS = { full: "bypassPermissions", auto: "auto", edits: "acceptEdits", ask: "default" } as const
const permissionMode = (t: { mode: Thread["mode"]; plan?: boolean }) => (t.plan ? "plan" : FLAGS[t.mode] ?? "default")

/** Claude Code's hooks for a thread's runs: Activity hears each edit and command, as it does a terminal's. */
function hooks(): string | null {
  const report = plugin.service("activity:report") as ((agent: string, terminal: string) => string) | null
  if (!report) return null
  return JSON.stringify({ hooks: { PostToolUse: [{ matcher: "^(Edit|Write|MultiEdit|NotebookEdit|Bash)$", hooks: [{ type: "command", command: report("claude", "") }] }] } })
}

export class ClaudeRun extends Run {
  proc: ChildProcess
  buf = ""
  err = ""
  /** Index of each streamed text block of the message being written, by its index in that message. */
  blocks = new Map<number, number>()
  /** Streamed text entries the full message hasn't confirmed yet, in order. */
  open: number[] = []
  /** Messages written that no result has answered yet (one written while it works is taken into that turn). */
  unanswered = new Set<string>()
  /** Control requests of ours waiting for their answer. */
  replies = new Map<string, (r: Any) => void>()

  /** A process only for a control request (rewind_files): the thread's state is left alone. */
  probe: boolean
  /** Its effort, given as it started (a change starts it again); the last message's tokens (how full its context is). */
  effort: string
  tokens = 0
  plan: boolean

  constructor(t: Thread, cli: string, probe = false) {
    super(t)
    this.probe = probe
    this.plan = !!t.plan
    this.effort = t.effort ?? ""
    // (bypass can only be switched to later when the session started allowing it)
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-prompt-tool", "stdio", "--permission-mode", permissionMode(t), "--allow-dangerously-skip-permissions",
      ...(t.model ? ["--model", t.model] : []), ...(t.effort ? ["--effort", t.effort] : []),
      ...(t.fork ? ["--resume", t.fork.from, "--fork-session", "--resume-session-at", t.fork.at] : t.started ? ["--resume", t.session, ...(t.resumeAt ? ["--resume-session-at", t.resumeAt] : [])] : ["--session-id", t.session]),
      "--append-system-prompt", context(t)]
    const h = hooks()
    if (h) args.push("--settings", h)
    // (its own checkpoints of the files it edits: what "Edit from here" puts back outside a git checkout)
    this.proc = spawn(cli, args, { cwd: t.cwd, env: { ...env(), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" }, stdio: ["pipe", "pipe", "pipe"] })
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

  send(text: string, images: Image[], u?: Extract<Entry, { kind: "user" }>) {
    if (!this.busy) this.begin()
    const uuid = crypto.randomUUID()
    if (u) { u.uuid = uuid; u.prev = this.t.chain }
    this.unanswered.add(uuid)
    const content = [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })), { type: "text", text }]
    return this.write({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null, session_id: "" })
  }

  /** A control request of ours, and its answer (null when it fails or the process goes). */
  ask(subtype: string, body: Record<string, unknown> = {}, ms = 15_000): Promise<Any> {
    const id = `agents-${crypto.randomBytes(4).toString("hex")}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.replies.delete(id); resolve(null) }, ms)
      this.replies.set(id, (r) => { clearTimeout(timer); resolve(r) })
      if (!this.write({ type: "control_request", request_id: id, request: { subtype, ...body } })) { this.replies.delete(id); clearTimeout(timer); resolve(null) }
    })
  }
  /** Mode and model change in the session as it runs. */
  configure(t: Thread) {
    if (t.mode !== this.mode || !!t.plan !== this.plan) { this.mode = t.mode; this.plan = !!t.plan; void this.ask("set_permission_mode", { mode: permissionMode(t) }) }
    if (t.model !== this.model) { this.model = t.model; void this.ask("set_model", { model: t.model || "default" }) }
  }

  read(d: string) {
    this.buf += d
    let i
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      let j: Any
      try { j = JSON.parse(line) } catch { continue }
      try { this.line(j) } catch (e) { console.error("agents (claude):", e) }
    }
  }

  line(j: Any) {
    const t = this.t
    if (j.parent_tool_use_id) return // a subagent's own work: its Task line says what it was asked
    if (this.probe && j.type !== "control_response") return
    // (the conversation's messages: where a rewind or a fork resumes)
    if ((j.type === "assistant" || j.type === "user") && !j.isReplay && typeof j.uuid === "string") t.chain = j.uuid
    if (j.type === "system" && j.subtype === "init") {
      let keep = false
      if (t.fork && str(j.session_id)) { t.session = str(j.session_id); delete t.fork; keep = true }
      if (t.resumeAt) { delete t.resumeAt; keep = true }
      if (!t.started) { t.started = true; keep = true }
      if (keep) save(t)
    } else if (j.type === "stream_event") this.stream(j.event)
    else if (j.type === "assistant") {
      const u = j.message?.usage
      if (u) this.tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
      for (const b of j.message?.content ?? []) {
        if (b.type === "text" && b.text) {
          const at = this.open.shift()
          const e = at === undefined ? undefined : t.entries[at]
          if (e?.kind === "assistant") { e.text = b.text; e.uuid = str(j.uuid); delete e.open; changed(t, at!) }
          else push(t, { kind: "assistant", text: b.text, at: now(), uuid: str(j.uuid) })
        } else if (b.type === "tool_use") {
          const input = b.input && typeof b.input === "object" ? b.input : {}
          push(t, { kind: "tool", id: str(b.id), name: str(b.name), input, at: now(), uuid: str(j.uuid), ...where(str(input.file_path) || str(input.notebook_path) || str(input.path), t.cwd) })
          setLive(t, { status: b.name === "Task" || b.name === "Agent" ? "delegating" : "working" })
        }
      }
    } else if (j.type === "control_response") {
      const r = j.response ?? {}
      const done = this.replies.get(str(r.request_id))
      if (done) { this.replies.delete(str(r.request_id)); done(r.subtype === "success" ? r.response ?? {} : null) }
    } else if (j.type === "user") {
      const content = Array.isArray(j.message?.content) ? j.message.content : []
      for (const b of content) {
        if (b.type === "text" && /^\[Request interrupted by user/.test(b.text ?? "")) push(t, { kind: "note", text: "Stopped.", at: now() })
        if (b.type !== "tool_result") continue
        const at = t.entries.findIndex((e) => e.kind === "tool" && e.id === b.tool_use_id)
        const e = t.entries[at]
        if (e?.kind !== "tool") continue
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x: Any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n") : ""
        e.result = cut(text)
        e.uuid = str(j.uuid) || e.uuid
        if (b.is_error) e.error = true
        const patch = j.tool_use_result?.structuredPatch
        if (Array.isArray(patch) && patch.length) e.patch = patch.slice(0, 20).map((h: Any) => ({ oldStart: h.oldStart, newStart: h.newStart, lines: (h.lines ?? []).slice(0, 400) }))
        changed(t, at)
      }
      setLive(t, { status: "thinking" })
    } else if (j.type === "control_request") this.control(j)
    else if (j.type === "control_cancel_request") this.settle(str(j.request_id), "gone")
    else if (j.type === "result") this.result(j)
  }

  stream(ev: Any) {
    const t = this.t
    if (ev?.type === "message_start") this.blocks.clear()
    else if (ev?.type === "content_block_start") {
      const b = ev.content_block ?? {}
      if (b.type === "text") {
        const at = push(t, { kind: "assistant", text: b.text ?? "", at: now(), open: true })
        this.blocks.set(ev.index, at)
        this.open.push(at)
        setLive(t, { status: "writing" })
      } else if (b.type === "thinking") setLive(t, { status: "thinking" })
      else if (b.type === "tool_use") setLive(t, { status: "working" })
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const at = this.blocks.get(ev.index)
      const e = at === undefined ? undefined : t.entries[at]
      if (e?.kind === "assistant") { e.text += ev.delta.text ?? ""; changed(t, at!, true) }
    }
  }

  control(j: Any) {
    const r = j.request ?? {}
    if (r.subtype !== "can_use_tool") return this.write({ type: "control_response", response: { subtype: "error", request_id: j.request_id, error: `${r.subtype} isn't supported here` } })
    const input = r.input && typeof r.input === "object" ? r.input : {}
    // A plan, as T3 Code takes it: a card of its own, and Claude told to wait (Implement sends it back).
    if (r.tool_name === "ExitPlanMode") {
      push(this.t, { kind: "plan", id: str(r.tool_use_id) || str(j.request_id), text: str(input.plan), at: now() })
      return this.write({ type: "control_response", response: { subtype: "success", request_id: j.request_id, response: { behavior: "deny",
        message: "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn." } } })
    }
    push(this.t, { kind: "ask", id: str(j.request_id), tool: str(r.tool_name), input, text: str(r.description), at: now(), ...where(str(input.file_path) || str(input.notebook_path), this.t.cwd),
      ...(Array.isArray(r.permission_suggestions) && r.permission_suggestions.length ? { suggestions: r.permission_suggestions } : {}) })
    setLive(this.t, { status: "waiting" })
  }

  /** Its answer: AskUserQuestion's answers go back in its input (by question, a multi-select's labels joined by ", "). */
  protected answer(e: Extract<Entry, { kind: "ask" }>, allow: boolean) {
    const input = e.tool === "AskUserQuestion" && e.answers ? { ...e.input, answers: e.answers } : e.input
    // (Always allow this session: its own suggestions, applied for the session; Cancel: no, and the turn stops)
    if (e.scope === "cancel") this.stopping = true
    this.write({ type: "control_response", response: { subtype: "success", request_id: e.id, response: allow
      ? { behavior: "allow", updatedInput: input, ...(e.scope === "session" && e.suggestions ? { updatedPermissions: e.suggestions } : {}) }
      : { behavior: "deny", message: e.tool === "AskUserQuestion" ? "The user didn't answer: go on without it, or ask in the chat." : "The user said no. Ask them what they'd like instead.", ...(e.scope === "cancel" ? { interrupt: true } : {}) } } })
  }

  result(j: Any) {
    const t = this.t
    // (a message written while it worked and not taken in yet gets a turn of its own: this one isn't over)
    const answered: string[] = Array.isArray(j.user_message_uuids) ? j.user_message_uuids : [...this.unanswered]
    for (const u of answered) this.unanswered.delete(u)
    if (this.unanswered.size && !this.stopping && !j.is_error) return
    this.unanswered.clear()
    const max = Math.max(0, ...Object.values((j.modelUsage ?? {}) as Record<string, Any>).map((m) => Number(m?.contextWindow) || 0))
    if (max && this.tokens) t.context = { used: this.tokens, max }
    const aborted = j.terminal_reason === "aborted_streaming" || this.stopping
    const text = str(j.result) || this.said()
    const failed = (j.is_error || /^error/.test(str(j.subtype))) && !aborted
    if (failed) this.failed([text, ...(Array.isArray(j.errors) ? j.errors.filter((x: unknown) => typeof x === "string" && !x.startsWith("[ede_diagnostic]")) : [])].filter(Boolean).join("\n") || "Claude Code stopped with an error.")
    for (const at of this.open) { const e = t.entries[at]; if (e?.kind === "assistant") { delete e.open; changed(t, at) } }
    this.open = []
    this.endTurn(aborted ? "" : text, failed ? "failed" : null)
  }

  protected interrupt() { this.write({ type: "control_request", request_id: `stop-${Date.now()}`, request: { subtype: "interrupt" } }) }
  protected kill() { if (!this.ended) try { this.proc.kill("SIGTERM") } catch { /* gone */ } }

  /** Ended here: stdin closed (it saves and exits), or killed when it won't. */
  end() {
    if (this.ended) return
    try { this.proc.stdin?.end() } catch { /* gone */ }
    setTimeout(() => this.kill(), 3000).unref()
  }

  exit(code: number | null, why: string | null) {
    if (this.ended) return
    this.ended = true
    for (const done of this.replies.values()) done(null)
    this.replies.clear()
    if (this.idle) clearTimeout(this.idle)
    if (!this.busy) return
    if (this.stopping) { push(this.t, { kind: "note", text: "Stopped.", at: now() }); return this.endTurn("", null) }
    const tail = this.err.trim().split("\n").slice(-6).join("\n")
    this.failed(why ?? (tail || `Claude Code stopped (exit ${code ?? "signal"}).`))
    this.endTurn("", "failed")
  }
}

/** Claude Code puts back the files its edits changed since message `uuid` (its own checkpoints: a folder outside git). */
export async function claudeRewindFiles(t: Thread, cli: string, uuid: string): Promise<{ files: number; error?: string }> {
  const r = new ClaudeRun(t, cli, true)
  try {
    const got = await r.ask("rewind_files", { user_message_id: uuid }, 30_000)
    if (!got) return { files: 0, error: "Claude Code didn't answer" }
    if (got.canRewind === false) return { files: 0, error: str(got.error) || "Claude Code has no checkpoint for that message" }
    // (it doesn't always say which: -1, put back but not counted)
    return { files: Array.isArray(got.filesChanged) ? got.filesChanged.length : -1 }
  } finally { r.end() }
}

// ---------- is it here, signed in, and which models it takes

const run = (cli: string, args: string[], ms = 15_000) => new Promise<{ code: number | null; out: string }>((resolve) =>
  execFile(cli, args, { env: env(), timeout: ms, cwd: os.tmpdir() }, (e, out) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out) })))

async function authStatus(cli: string) {
  const r = await run(cli, ["auth", "status", "--json"])
  try { return { loggedIn: JSON.parse(r.out).loggedIn === true } } catch { return { loggedIn: r.code === 0 } }
}
async function versionOf(cli: string) { return (await run(cli, ["--version"])).out.trim().split(" ")[0] ?? "" }

/** The models and slash commands this claude offers: its stream-json handshake's lists (no prompt, nothing spent). */
function modelsOf(cli: string): Promise<{ models: Model[]; commands: { name: string; description: string }[] }> {
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
        const commands = Array.isArray(j.response?.response?.commands) ? j.response.response.commands : []
        resolve({ models: list.filter((m: Any) => typeof m?.value === "string" && m.value !== "default").map((m: Any) => ({ value: m.value, label: str(m.displayName) || m.value, description: str(m.description) })),
          commands: commands.filter((c: Any) => typeof c?.name === "string").map((c: Any) => ({ name: str(c.name), description: str(c.description) })) })
        return
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1)
    })
    p.stdin.write(JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } }) + "\n")
  })
}

export async function claudeStatus(): Promise<HarnessStatus> {
  const cli = claudeCli()
  if (!cli) return { installed: false, loggedIn: false, version: "", models: [] }
  const [auth, version] = await Promise.all([plugin.memo(60, authStatus, cli), plugin.memo(3600, versionOf, cli)])
  const got = auth.loggedIn ? await plugin.memo(3600, modelsOf, cli).catch(() => ({ models: [] as Model[], commands: [] })) : { models: [], commands: [] }
  return { installed: true, loggedIn: auth.loggedIn, version, models: got.models, commands: got.commands }
}
