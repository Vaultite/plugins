#!/usr/bin/env node
// A stand-in for `codex app-server` in tests and QA: the JSON-RPC lines Codex 0.160 writes (recorded from real runs),
// replayed by what the prompt asks for. FAKE_CODEX_STATE (a folder): `codex.jsonl` gets each request; a file
// `codex-logged-out` there makes it signed out; `threads.json` keeps the threads it made, so a new process resumes them.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const STATE = process.env.FAKE_CODEX_STATE || ""
const argv = process.argv.slice(2)
if (argv[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0) }
if (argv[0] !== "app-server") { console.error("fake codex: only app-server"); process.exit(2) }

const log = (o) => { if (STATE) fs.appendFileSync(path.join(STATE, "codex.jsonl"), JSON.stringify({ pid: process.pid, ...o }) + "\n") }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const note = (method, params) => out({ method, params, emittedAtMs: Date.now() })
const loggedOut = () => !!STATE && fs.existsSync(path.join(STATE, "codex-logged-out"))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uuid = () => crypto.randomUUID()
const known = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE, "threads.json"), "utf8")) } catch { return {} } }
const remember = (id, cwd) => { if (STATE) fs.writeFileSync(path.join(STATE, "threads.json"), JSON.stringify({ ...known(), [id]: cwd })) }

const threads = new Map() // id -> { cwd, turn }
let nextReq = 0
const waiting = new Map()
const MODELS = [
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Latest frontier agentic coding model.", hidden: false, isDefault: true },
  { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", description: "Fast and efficient.", hidden: false, isDefault: false },
  { id: "old-model", model: "old-model", displayName: "Old", description: "", hidden: true, isDefault: false },
]
const threadOf = (id, cwd) => ({ id, sessionId: id, preview: "", ephemeral: false, modelProvider: "openai", model: "gpt-6.1-sol", createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000), status: { type: "idle" }, path: null, cwd, cliVersion: "0.160.0", source: "appServer", name: null, turns: [] })

/** Ask the client (a permission question) and wait for its answer. */
function ask(method, params, t) {
  const id = nextReq++
  out({ method, id, params })
  note("thread/status/changed", { threadId: params.threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } })
  return new Promise((resolve) => { waiting.set(id, resolve); t.cancel = () => resolve(null) })
}

async function message(t, text, phase = "final_answer") {
  const id = `msg_${crypto.randomBytes(8).toString("hex")}`
  const base = { threadId: t.thread, turnId: t.id }
  note("item/started", { item: { type: "agentMessage", id, text: "", phase, memoryCitation: null, delivery: null, questions: null }, ...base, startedAtMs: Date.now() })
  let said = ""
  for (const piece of text.match(/\S+\s*/g) ?? [text]) {
    if (t.stopped) return
    said += piece
    note("item/agentMessage/delta", { ...base, itemId: id, delta: piece })
    await sleep(t.slow ? 60 : 8)
  }
  note("item/completed", { item: { type: "agentMessage", id, text: said, phase, memoryCitation: null, delivery: null, questions: null }, ...base, completedAtMs: Date.now() })
}

async function respond(t, text) {
  const low = text.toLowerCase()
  const cwd = threads.get(t.thread).cwd
  const base = { threadId: t.thread, turnId: t.id }
  const asks = t.sandbox === "read-only" && t.approvalPolicy !== "never"
  if (low.includes("crash")) { console.error("the fake app-server fell over"); process.exit(1) }
  if (loggedOut()) return finish(t, "failed", { message: "You need to sign in: run codex login", codexErrorInfo: null, additionalDetails: null })
  if (low.includes("fail")) {
    note("error", { error: { message: "The fake model fell over", codexErrorInfo: null, additionalDetails: null }, willRetry: false, ...base })
    return finish(t, "failed", { message: "The fake model fell over", codexErrorInfo: null, additionalDetails: null })
  }
  if (low.includes("edit")) {
    const rel = /\bedit\s+(\S+?\.\w+)\b/i.exec(text)?.[1] ?? "hello.md"
    const file = path.join(cwd, rel)
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    await message(t, `I’ll edit ${rel}.\n`, "commentary")
    const read = `exec-${uuid()}`
    const item = { type: "commandExecution", id: read, pluginId: null, scriptPath: null, command: `/bin/zsh -lc 'cat ${rel}'`, cwd, processId: "1", source: "unifiedExecStartup",
      status: "inProgress", commandActions: [{ type: "read", command: `cat ${rel}`, name: rel, path: file }], aggregatedOutput: null, exitCode: null, durationMs: null }
    note("item/started", { item, ...base, startedAtMs: Date.now() })
    note("item/completed", { item: { ...item, status: "completed", aggregatedOutput: before, exitCode: 0, durationMs: 1 }, ...base, completedAtMs: Date.now() })
    const old = before.split("\n").find((l) => l.trim()) ?? ""
    const next = `${old} (edited)`
    const id = `call_${crypto.randomBytes(6).toString("hex")}`
    const change = { type: "fileChange", id, changes: [{ path: file, kind: { type: "update", move_path: null }, diff: `@@ -1 +1 @@\n-${old}\n+${next}\n` }], status: "inProgress" }
    note("item/started", { item: change, ...base, startedAtMs: Date.now() })
    let ok = true
    if (asks) {
      const answer = await ask("item/fileChange/requestApproval", { ...base, itemId: id, startedAtMs: Date.now(), reason: null, grantRoot: null }, t)
      if (t.stopped) return
      ok = answer?.decision === "accept"
      note("thread/status/changed", { threadId: t.thread, status: { type: "active", activeFlags: [] } })
    }
    if (ok) fs.writeFileSync(file, before.replace(old, next))
    note("item/completed", { item: { ...change, status: ok ? "completed" : "declined" }, ...base, completedAtMs: Date.now() })
    await message(t, ok ? `Done: I edited **${rel}**.` : "Okay, I left it as it was.")
    return finish(t)
  }
  if (low.includes("run")) {
    const id = `exec-${uuid()}`
    let ok = true
    if (asks) {
      const answer = await ask("item/commandExecution/requestApproval", { kind: "command", ...base, itemId: id, startedAtMs: Date.now(), environmentId: "local",
        reason: "Allow making out.txt?", command: "/bin/zsh -lc \"printf 'hi\\\\n' > out.txt\"", cwd, commandActions: [{ type: "unknown", command: "printf 'hi\\n' > out.txt" }] }, t)
      if (t.stopped) return
      ok = answer?.decision === "accept"
    }
    const item = { type: "commandExecution", id, pluginId: null, scriptPath: null, command: "/bin/zsh -lc \"printf 'hi\\\\n' > out.txt\"", cwd, processId: null, source: "agent",
      status: "inProgress", commandActions: [{ type: "unknown", command: "printf 'hi\\n' > out.txt" }], aggregatedOutput: null, exitCode: null, durationMs: null }
    note("item/started", { item, ...base, startedAtMs: Date.now() })
    if (ok) fs.writeFileSync(path.join(cwd, "out.txt"), "hi\n")
    note("item/completed", { item: { ...item, status: ok ? "completed" : "declined", exitCode: ok ? 0 : null, durationMs: 0 }, ...base, completedAtMs: Date.now() })
    await message(t, ok ? "Made out.txt." : "I didn't run it.")
    return finish(t)
  }
  if (low.includes("slow")) {
    t.slow = true
    await message(t, Array.from({ length: 200 }, (_, i) => `word${i + 1}`).join(" "))
    if (!t.stopped) finish(t)
    return
  }
  await message(t, `You said: ${text.split("\n")[0]}\n\n- one\n- two`)
  finish(t)
}

function finish(t, status = "completed", error = null) {
  if (t.done) return
  t.done = true
  const now = Math.floor(Date.now() / 1000)
  note("thread/status/changed", { threadId: t.thread, status: { type: "idle" } })
  note("turn/completed", { threadId: t.thread, turn: { id: t.id, items: [], itemsView: "summary", status, error, startedAt: now, completedAt: now, durationMs: 10 } })
  threads.get(t.thread).turn = null
}

function handle(j) {
  const p = j.params ?? {}
  const reply = (result) => out({ id: j.id, result })
  const fail = (message) => out({ id: j.id, error: { code: -32600, message } })
  switch (j.method) {
    case "initialize": return reply({ userAgent: "vaultite_agents/0.160.0 (fake)", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" })
    case "account/read": return reply(loggedOut() ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "alice@example.com", planType: "plus" }, requiresOpenaiAuth: true })
    case "model/list": return reply({ data: MODELS, nextCursor: null })
    case "thread/start": {
      const id = uuid()
      threads.set(id, { cwd: p.cwd, sandbox: p.sandbox, turn: null })
      remember(id, p.cwd)
      reply({ thread: threadOf(id, p.cwd), model: p.model ?? "gpt-6.1-sol", modelProvider: "openai", cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: "workspaceWrite" } })
      return note("thread/started", { thread: threadOf(id, p.cwd) })
    }
    case "thread/resume": {
      const cwd = known()[p.threadId]
      if (!cwd) return fail(`no rollout found for thread id ${p.threadId}`)
      threads.set(p.threadId, { cwd: p.cwd ?? cwd, sandbox: p.sandbox, turn: null })
      return reply({ thread: threadOf(p.threadId, cwd), model: "gpt-6.1-sol", modelProvider: "openai", cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: "workspaceWrite" } })
    }
    case "thread/unsubscribe": threads.delete(p.threadId); return reply({ status: "unsubscribed" })
    case "turn/start": {
      const th = threads.get(p.threadId)
      if (!th) return fail(`thread not loaded: ${p.threadId}`)
      if (p.sandboxPolicy) th.sandbox = p.sandboxPolicy.type === "readOnly" ? "read-only" : "workspace-write"
      const t = { id: uuid(), thread: p.threadId, approvalPolicy: p.approvalPolicy, sandbox: th.sandbox, stopped: false, done: false }
      th.turn = t
      reply({ turn: { id: t.id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } })
      note("thread/status/changed", { threadId: t.thread, status: { type: "active", activeFlags: [] } })
      note("turn/started", { threadId: t.thread, turn: { id: t.id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null } })
      const text = (p.input ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n")
      const user = { type: "userMessage", id: uuid(), clientId: null, content: p.input ?? [] }
      note("item/started", { item: user, threadId: t.thread, turnId: t.id, startedAtMs: Date.now() })
      note("item/completed", { item: user, threadId: t.thread, turnId: t.id, completedAtMs: Date.now() })
      void respond(t, text)
      return
    }
    case "turn/interrupt": {
      const t = threads.get(p.threadId)?.turn
      reply({})
      if (t && t.id === p.turnId) { t.stopped = true; t.cancel?.(); finish(t, "interrupted") }
      return
    }
    default: return fail(`fake codex: ${j.method} isn't faked`)
  }
}

let buf = ""
process.stdin.on("data", (d) => {
  buf += d
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    let j
    try { j = JSON.parse(line) } catch { continue }
    log(j.method ? { method: j.method, params: j.params } : { response: j })
    if (j.method && j.id !== undefined) handle(j)
    else if (j.id !== undefined && waiting.has(j.id)) { waiting.get(j.id)(j.result); waiting.delete(j.id) }
  }
})
process.stdin.on("end", () => process.exit(0))
