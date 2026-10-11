// Claude Code: the user's `claude` with stream JSON both ways, one process per thread while it's in use; permission
// asks reach us only with `--permission-prompt-tool stdio`.
import { type ChildProcess, execFile, spawn } from "node:child_process"
import os from "node:os"
import { type Any, changed, cliPath, context, cut, env, Run, type Image, now, plugin, push, save, setLive, str, where } from "./core.ts"
import type { HarnessStatus, Model, Thread } from "./types.ts"

export const claudeCli = () => cliPath("claude", "AGENTS_CLAUDE_CLI")
const FLAGS = { ask: "default", edits: "acceptEdits", read: "plan" } as const

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

  constructor(t: Thread, cli: string) {
    super(t)
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-prompt-tool", "stdio", "--permission-mode", FLAGS[t.mode], "--disallowedTools", "AskUserQuestion",
      ...(t.model ? ["--model", t.model] : []), ...(t.started ? ["--resume", t.session] : ["--session-id", t.session]),
      "--append-system-prompt", context(t)]
    const h = hooks()
    if (h) args.push("--settings", h)
    this.proc = spawn(cli, args, { cwd: t.cwd, env: env(), stdio: ["pipe", "pipe", "pipe"] })
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

  send(text: string, images: Image[]) {
    this.begin()
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
      try { this.line(j) } catch (e) { console.error("agents (claude):", e) }
    }
  }

  line(j: Any) {
    const t = this.t
    if (j.parent_tool_use_id) return // a subagent's own work: its Task line says what it was asked
    if (j.type === "system" && j.subtype === "init") {
      if (!t.started) { t.started = true; save(t) }
    } else if (j.type === "stream_event") this.stream(j.event)
    else if (j.type === "assistant") {
      for (const b of j.message?.content ?? []) {
        if (b.type === "text" && b.text) {
          const at = this.open.shift()
          const e = at === undefined ? undefined : t.entries[at]
          if (e?.kind === "assistant") { e.text = b.text; delete e.open; changed(t, at!) }
          else push(t, { kind: "assistant", text: b.text, at: now() })
        } else if (b.type === "tool_use") {
          const input = b.input && typeof b.input === "object" ? b.input : {}
          push(t, { kind: "tool", id: str(b.id), name: str(b.name), input, at: now(), ...where(str(input.file_path) || str(input.notebook_path) || str(input.path), t.cwd) })
          setLive(t, { status: b.name === "Task" || b.name === "Agent" ? "delegating" : "working" })
        }
      }
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
    push(this.t, { kind: "ask", id: str(j.request_id), tool: str(r.tool_name), input, text: str(r.description), at: now(), ...where(str(input.file_path) || str(input.notebook_path), this.t.cwd) })
    setLive(this.t, { status: "waiting" })
  }

  protected answer(e: { id: string; input: Record<string, unknown> }, allow: boolean) {
    this.write({ type: "control_response", response: { subtype: "success", request_id: e.id, response: allow
      ? { behavior: "allow", updatedInput: e.input }
      : { behavior: "deny", message: "The user said no. Ask them what they'd like instead." } } })
  }

  result(j: Any) {
    const t = this.t
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
    if (this.idle) clearTimeout(this.idle)
    if (!this.busy) return
    if (this.stopping) { push(this.t, { kind: "note", text: "Stopped.", at: now() }); return this.endTurn("", null) }
    const tail = this.err.trim().split("\n").slice(-6).join("\n")
    this.failed(why ?? (tail || `Claude Code stopped (exit ${code ?? "signal"}).`))
    this.endTurn("", "failed")
  }
}

// ---------- is it here, signed in, and which models it takes

const run = (cli: string, args: string[], ms = 15_000) => new Promise<{ code: number | null; out: string }>((resolve) =>
  execFile(cli, args, { env: env(), timeout: ms, cwd: os.tmpdir() }, (e, out) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out) })))

async function authStatus(cli: string) {
  const r = await run(cli, ["auth", "status", "--json"])
  try { return { loggedIn: JSON.parse(r.out).loggedIn === true } } catch { return { loggedIn: r.code === 0 } }
}
async function versionOf(cli: string) { return (await run(cli, ["--version"])).out.trim().split(" ")[0] ?? "" }

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
        resolve(list.filter((m: Any) => typeof m?.value === "string" && m.value !== "default").map((m: Any) => ({ value: m.value, label: str(m.displayName) || m.value, description: str(m.description) })))
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
  const models = auth.loggedIn ? await plugin.memo(3600, modelsOf, cli).catch(() => [] as Model[]) : []
  return { installed: true, loggedIn: auth.loggedIn, version, models }
}
