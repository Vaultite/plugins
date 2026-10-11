// Codex: the user's `codex app-server` (JSON-RPC over stdio), one process shared by every Codex thread while any is in
// use. Its items become the same entries Claude's do: commands as Bash/Read/Grep, file changes as Edit/Write with diffs.
import { type ChildProcess, execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import os from "node:os"
import {
  type Any, changed, cliPath, context, cut, env, hunksOf, IDLE_MS, type Image, listChanged, now, plugin, push, Run, runs, save, setLive, str, where,
} from "./core.ts"
import type { Entry, HarnessStatus, Model, Thread } from "./types.ts"

export const codexCli = () => cliPath("codex", "AGENTS_CODEX_CLI")
// Ask: reads run, anything that writes asks (out of its read-only sandbox). Read: never asks, so writes just fail.
const APPROVAL = { ask: "on-request", edits: "on-request", read: "never" } as const
const SANDBOX = { ask: "read-only", edits: "workspace-write", read: "read-only" } as const
const sandboxPolicy = (mode: Thread["mode"]) => SANDBOX[mode] === "read-only" ? { type: "readOnly", networkAccess: false }
  : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }

type Pending = { resolve: (v: Any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

class AppServer {
  proc: ChildProcess
  buf = ""
  err = ""
  next = 1
  ended = false
  pending = new Map<number, Pending>()
  /** Each loaded thread's run, by Codex's thread id. */
  threads = new Map<string, CodexRun>()
  ready: Promise<void>
  idle: ReturnType<typeof setTimeout> | null = null

  constructor(cli: string) {
    this.proc = spawn(cli, ["app-server"], { cwd: os.tmpdir(), env: env(), stdio: ["pipe", "pipe", "pipe"] })
    this.proc.stdout!.setEncoding("utf8")
    this.proc.stdout!.on("data", (d: string) => this.read(d))
    this.proc.stderr!.on("data", (d) => { this.err = (this.err + String(d)).slice(-4000) })
    this.proc.stdin!.on("error", () => { /* it exited: said below */ })
    this.proc.on("error", (e: NodeJS.ErrnoException) => this.exit(e.code === "ENOENT" ? "Codex isn't installed on this machine." : e.message))
    this.proc.on("exit", (code) => this.exit(this.err.trim().split("\n").slice(-4).join("\n") || `Codex stopped (exit ${code ?? "signal"}).`))
    this.ready = this.request("initialize", { clientInfo: { name: "vaultite_agents", title: "Vaultite Agents", version: plugin.manifest.version ?? "1" }, capabilities: null })
      .then(() => { this.write({ method: "initialized" }) })
    this.ready.catch(() => { /* each caller hears it */ })
    this.touch()
  }

  write(o: unknown) {
    if (this.ended || !this.proc.stdin?.writable) return false
    this.proc.stdin.write(JSON.stringify(o) + "\n")
    return true
  }

  request<T = Any>(method: string, params: unknown, ms = 60_000): Promise<T> {
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      if (this.ended) return reject(new Error("Codex isn't running"))
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex didn't answer ${method}`)) }, ms)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  respond(id: number | string, result: unknown) { this.write({ id, result }) }
  refuse(id: number | string, message: string) { this.write({ id, error: { code: -32601, message } }) }

  read(d: string) {
    this.buf += d
    let i
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      let j: Any
      try { j = JSON.parse(line) } catch { continue }
      try { this.line(j) } catch (e) { console.error("agents (codex):", e) }
    }
  }

  line(j: Any) {
    const threadId = str(j.params?.threadId)
    const run = threadId ? this.threads.get(threadId) : undefined
    if (j.method && j.id !== undefined) {
      if (run) run.request(j.id, j.method, j.params ?? {})
      else this.refuse(j.id, `${j.method} isn't supported here`)
    } else if (j.id !== undefined) {
      const p = this.pending.get(j.id)
      if (!p) return
      this.pending.delete(j.id)
      clearTimeout(p.timer)
      if (j.error) p.reject(new Error(str(j.error.message) || "Codex refused it"))
      else p.resolve(j.result)
    } else if (j.method && run) run.notice(j.method, j.params ?? {})
  }

  /** Ended after a while with no turn under way. */
  touch() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => { if ([...this.threads.values()].some((r) => r.busy)) this.touch(); else this.end() }, IDLE_MS)
    this.idle.unref?.()
  }

  end() {
    if (this.ended) return
    try { this.proc.stdin?.end() } catch { /* gone */ }
    setTimeout(() => { if (!this.ended) try { this.proc.kill("SIGTERM") } catch { /* gone */ } }, 3000).unref()
  }

  exit(why: string) {
    if (this.ended) return
    this.ended = true
    if (this.idle) clearTimeout(this.idle)
    if (server === this) server = null
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)) }
    this.pending.clear()
    for (const r of this.threads.values()) r.lost(why)
    this.threads.clear()
  }
}

let server: AppServer | null = null
function appServer(): AppServer {
  const cli = codexCli()
  if (!cli) throw new Error("Codex isn't installed on this machine.")
  if (!server || server.ended) server = new AppServer(cli)
  return server
}
plugin.onUnload(() => server?.end())

/** `/bin/zsh -lc 'cat a.txt'` as the user would write it: cat a.txt. */
function unwrap(cmd: string) {
  const m = /^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(cmd)
  return m ? m[2].replace(m[1] === "'" ? /'\\''/g : /\\(["\\$`])/g, m[1] === "'" ? "'" : "$1") : cmd
}

/** A command item as a tool: a lone read is Read, a search Grep, anything else Bash. */
function commandTool(item: Any): { name: string; input: Record<string, unknown>; at?: string } {
  const acts: Any[] = Array.isArray(item.commandActions) ? item.commandActions : []
  const command = acts.length === 1 ? str(acts[0].command) || unwrap(str(item.command)) : unwrap(str(item.command))
  if (acts.length === 1 && acts[0].type === "read" && acts[0].path) return { name: "Read", input: { file_path: acts[0].path, command }, at: acts[0].path }
  if (acts.length === 1 && acts[0].type === "search" && acts[0].query) return { name: "Grep", input: { pattern: acts[0].query, command } }
  return { name: "Bash", input: { command } }
}

const mcpText = (r: Any) => (Array.isArray(r?.content) ? r.content.map((x: Any) => (x?.type === "text" ? str(x.text) : `[${str(x?.type) || "content"}]`)).join("\n") : "")

export class CodexRun extends Run {
  srv: AppServer | null = null
  /** The mode its thread was loaded with: a turn in another one says so. */
  loadedMode: Thread["mode"] | null = null
  turnId = ""
  lastError = ""
  /** Each item's entry, by Codex's item id (a file change's files: `<id>#<n>`). */
  items = new Map<string, number>()
  /** Questions waiting: the ask's id -> the request's id and the item it's about. */
  asks = new Map<string, { rpc: number | string; item: string }>()

  send(text: string, images: Image[]) {
    this.begin()
    void this.go(text, images).catch((e: Error) => {
      if (!this.busy) return
      this.failed(e.message)
      this.endTurn("", "failed")
    })
    return true
  }

  async load(srv: AppServer) {
    const t = this.t
    const params = { cwd: t.cwd, model: t.model || null, approvalPolicy: APPROVAL[t.mode], sandbox: SANDBOX[t.mode], developerInstructions: context(t) }
    let r: Any
    if (t.started) {
      try { r = await srv.request("thread/resume", { threadId: t.session, ...params, excludeTurns: true }) } catch (e) {
        push(t, { kind: "note", text: `Couldn't pick up Codex's thread (${(e as Error).message}): this goes on in a new one.`, at: now() })
      }
    }
    if (!r) r = await srv.request("thread/start", params)
    const id = str(r?.thread?.id)
    if (!id) throw new Error("Codex didn't start a thread")
    if (t.session !== id || !t.started) { t.session = id; t.started = true; save(t) }
    srv.threads.set(id, this)
    this.srv = srv
    this.loadedMode = t.mode
  }

  async go(text: string, images: Image[]) {
    const srv = appServer()
    await srv.ready
    if (this.srv !== srv || !srv.threads.has(this.t.session)) await this.load(srv)
    if (!this.busy) return // stopped meanwhile
    const t = this.t
    const input = [{ type: "text", text, text_elements: [] }, ...images.map((im) => ({ type: "localImage", path: im.path }))]
    const r = await srv.request("turn/start", { threadId: t.session, input, model: t.model || null, approvalPolicy: APPROVAL[t.mode],
      ...(this.loadedMode !== t.mode ? { sandboxPolicy: sandboxPolicy(t.mode) } : {}) })
    this.turnId = str(r?.turn?.id)
    srv.touch()
  }

  /** A notification about this thread. */
  notice(method: string, p: Any) {
    const t = this.t
    if (method === "turn/started") { this.turnId = str(p.turn?.id) || this.turnId; setLive(t, { status: "thinking" }) }
    else if (method === "item/started") this.item(p.item, false)
    else if (method === "item/completed") this.item(p.item, true)
    else if (method === "item/agentMessage/delta") {
      const at = this.items.get(str(p.itemId))
      const e = at === undefined ? undefined : t.entries[at]
      if (e?.kind === "assistant") { e.text += str(p.delta); changed(t, at!, true); setLive(t, { status: "writing" }) }
    } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") setLive(t, { status: "thinking" })
    else if (method === "thread/status/changed") {
      const flags: string[] = p.status?.activeFlags ?? []
      if (this.busy) setLive(t, { status: flags.includes("waitingOnApproval") ? "waiting" : "working" })
    } else if (method === "serverRequest/resolved") {
      for (const [id, a] of this.asks) if (a.rpc === p.requestId) { this.asks.delete(id); this.settle(id, "gone") }
    } else if (method === "error") {
      if (!p.willRetry) this.lastError = str(p.error?.message)
    } else if (method === "thread/compacted") push(t, { kind: "note", text: "Codex compacted the thread's context.", at: now() })
    else if (method === "turn/completed") this.completed(p.turn ?? {})
  }

  item(item: Any, done: boolean) {
    if (!item?.id) return
    const t = this.t
    const id = str(item.id)
    const at = this.items.get(id)
    const entry = at === undefined ? undefined : t.entries[at]
    switch (item.type) {
      case "agentMessage": {
        if (entry?.kind === "assistant") { entry.text = str(item.text) || entry.text; if (done) delete entry.open; changed(t, at!); break }
        this.items.set(id, push(t, { kind: "assistant", text: str(item.text), at: now(), ...(done ? {} : { open: true }) }))
        if (!done) setLive(t, { status: "writing" })
        break
      }
      case "reasoning": if (!done) setLive(t, { status: "thinking" }); break
      case "commandExecution": {
        if (!entry) {
          const c = commandTool(item)
          this.items.set(id, push(t, { kind: "tool", id, name: c.name, input: c.input, at: now(), ...where(c.at ?? "", t.cwd) }))
          setLive(t, { status: "working" })
        }
        if (!done) break
        const e = t.entries[this.items.get(id)!] as Extract<Entry, { kind: "tool" }>
        e.result = cut(str(item.aggregatedOutput))
        if (item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0)) e.error = true
        if (item.status === "declined" && !e.result) e.result = "Not allowed."
        changed(t, this.items.get(id)!)
        break
      }
      case "fileChange": {
        const changes: Any[] = Array.isArray(item.changes) ? item.changes : []
        changes.forEach((c, n) => {
          const key = `${id}#${n}`
          const kind = str(c.kind?.type)
          let patch = hunksOf(str(c.diff))
          if (!patch.length && kind === "add" && c.diff) patch = [{ oldStart: 0, newStart: 1, lines: str(c.diff).split("\n").slice(0, 400).map((l) => `+${l}`) }]
          const name = kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit"
          const i = this.items.get(key)
          if (i === undefined) {
            this.items.set(key, push(t, { kind: "tool", id: key, name, input: { file_path: str(c.path) }, at: now(), ...where(str(c.path), t.cwd), patch }))
            setLive(t, { status: "working" })
          } else if (done) {
            const e = t.entries[i] as Extract<Entry, { kind: "tool" }>
            if (patch.length) e.patch = patch
          }
          // A question about these changes that came before them: now it can show them.
          const ask = t.entries.findIndex((e) => e.kind === "ask" && !e.answer && this.asks.get(e.id)?.item === id)
          const a = t.entries[ask]
          if (a?.kind === "ask" && n === 0) { a.input = { file_path: str(c.path) }; Object.assign(a, where(str(c.path), t.cwd)); a.patch = patch; changed(t, ask) }
        })
        if (done) for (let n = 0; n < changes.length; n++) {
          const i = this.items.get(`${id}#${n}`)!
          const e = t.entries[i] as Extract<Entry, { kind: "tool" }>
          if (item.status === "failed" || item.status === "declined") { e.error = true; e.result = item.status === "declined" ? "Not allowed." : "Couldn't apply it." }
          else e.result = ""
          changed(t, i)
        }
        break
      }
      case "mcpToolCall": case "dynamicToolCall": {
        if (!entry) {
          const name = item.type === "mcpToolCall" ? `mcp__${str(item.server)}__${str(item.tool)}` : str(item.tool)
          const input = item.arguments && typeof item.arguments === "object" ? item.arguments : {}
          this.items.set(id, push(t, { kind: "tool", id, name, input, at: now() }))
          setLive(t, { status: "working" })
        }
        if (!done) break
        const e = t.entries[this.items.get(id)!] as Extract<Entry, { kind: "tool" }>
        e.result = cut(item.error ? str(item.error.message) : mcpText(item.result) || (Array.isArray(item.contentItems) ? item.contentItems.map((x: Any) => str(x?.text)).join("\n") : ""))
        if (item.error || item.status === "failed" || item.success === false) e.error = true
        changed(t, this.items.get(id)!)
        break
      }
      case "webSearch": {
        if (!entry) this.items.set(id, push(t, { kind: "tool", id, name: "WebSearch", input: { query: str(item.query) }, at: now() }))
        else if (done) { (entry as Extract<Entry, { kind: "tool" }>).input = { query: str(item.query) }; (entry as Extract<Entry, { kind: "tool" }>).result = ""; changed(t, at!) }
        break
      }
      case "collabAgentToolCall": {
        if (!entry) { this.items.set(id, push(t, { kind: "tool", id, name: "Agent", input: { description: str(item.prompt).split("\n")[0].slice(0, 120) }, at: now() })); setLive(t, { status: "delegating" }) }
        else if (done) { (entry as Extract<Entry, { kind: "tool" }>).result = ""; changed(t, at!) }
        break
      }
    }
  }

  /** A request from Codex about this thread: its permission questions; anything else it asks is declined. */
  request(rpc: number | string, method: string, p: Any) {
    const t = this.t
    const id = `codex-${crypto.randomBytes(5).toString("hex")}` // (its request ids start again with each process)
    if (method === "item/commandExecution/requestApproval") {
      const c = commandTool({ command: str(p.command), commandActions: p.commandActions })
      this.asks.set(id, { rpc, item: str(p.itemId) })
      push(t, { kind: "ask", id, tool: "Bash", input: { command: c.input.command, ...(p.reason ? { description: str(p.reason) } : {}) }, text: str(p.reason), at: now() })
    } else if (method === "item/fileChange/requestApproval") {
      this.asks.set(id, { rpc, item: str(p.itemId) })
      const tools = t.entries.filter((e) => e.kind === "tool" && e.id.startsWith(`${str(p.itemId)}#`)) as Extract<Entry, { kind: "tool" }>[]
      const first = tools[0]
      push(t, { kind: "ask", id, tool: first?.name === "Write" ? "Write" : "Edit", input: { file_path: first ? str(first.input.file_path) : "" }, text: str(p.reason), at: now(),
        ...(first ? { file: first.file, path: first.path, patch: tools.flatMap((x) => x.patch ?? []) } : {}) })
    } else if (method === "mcpServer/elicitation/request") return this.srv?.respond(rpc, { action: "decline", content: null, _meta: null })
    else if (method === "item/tool/requestUserInput") return this.srv?.respond(rpc, { answers: {} })
    else return this.srv?.refuse(rpc, `${method} isn't supported here`)
    setLive(t, { status: "waiting" })
  }

  protected answer(e: { id: string }, allow: boolean) {
    const a = this.asks.get(e.id)
    if (!a) return
    this.asks.delete(e.id)
    this.srv?.respond(a.rpc, { decision: allow ? "accept" : "decline" })
  }

  completed(turn: Any) {
    if (!this.busy || (this.turnId && turn.id && turn.id !== this.turnId)) return
    const t = this.t
    this.asks.clear()
    if (turn.status === "interrupted" || this.stopping) { push(t, { kind: "note", text: "Stopped.", at: now() }); return this.endTurn("", null) }
    if (turn.status === "failed") {
      this.failed(str(turn.error?.message) || this.lastError || "Codex stopped with an error.")
      return this.endTurn("", "failed")
    }
    this.endTurn(this.said(), null)
  }

  protected interrupt() {
    if (this.srv && this.turnId) void this.srv.request("turn/interrupt", { threadId: this.t.session, turnId: this.turnId }).catch(() => this.endTurn("", null))
    else this.endTurn("", null)
  }

  end() {
    if (this.ended) return
    this.ended = true
    if (this.idle) clearTimeout(this.idle)
    const srv = this.srv
    if (srv && srv.threads.get(this.t.session) === this) {
      srv.threads.delete(this.t.session)
      void srv.request("thread/unsubscribe", { threadId: this.t.session }, 10_000).catch(() => { /* gone */ })
    }
    if (runs.get(this.t.id) === this) runs.delete(this.t.id)
  }

  /** Codex's process went away under this thread. */
  lost(why: string) {
    this.srv = null
    this.ended = true
    if (runs.get(this.t.id) === this) runs.delete(this.t.id)
    if (!this.busy) return
    if (this.stopping) { push(this.t, { kind: "note", text: "Stopped.", at: now() }); return this.endTurn("", null) }
    this.failed(why)
    this.endTurn("", "failed")
    listChanged()
  }
}

// ---------- is it here, signed in, and which models it takes

const version = (cli: string) => new Promise<string>((resolve) =>
  execFile(cli, ["--version"], { env: env(), timeout: 15_000 }, (_e, out) => resolve(String(out).trim().split(" ").pop() ?? "")))

async function account() {
  const srv = appServer()
  await srv.ready
  const r = await srv.request("account/read", {}, 20_000)
  return { loggedIn: !!r?.account || r?.requiresOpenaiAuth === false }
}
async function models(): Promise<Model[]> {
  const srv = appServer()
  await srv.ready
  const r = await srv.request("model/list", {}, 20_000)
  const list: Any[] = Array.isArray(r?.data) ? r.data : []
  return list.filter((m) => !m.hidden).map((m) => ({ value: str(m.model) || str(m.id), label: str(m.displayName) || str(m.model), description: str(m.description) }))
}

export async function codexStatus(): Promise<HarnessStatus> {
  const cli = codexCli()
  if (!cli) return { installed: false, loggedIn: false, version: "", models: [] }
  const [auth, v] = await Promise.all([plugin.memo(60, account).catch(() => ({ loggedIn: false })), plugin.memo(3600, version, cli)])
  const list = auth.loggedIn ? await plugin.memo(3600, models).catch(() => [] as Model[]) : []
  return { installed: true, loggedIn: auth.loggedIn, version: v, models: list }
}
