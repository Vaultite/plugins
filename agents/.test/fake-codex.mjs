#!/usr/bin/env node
// A stand-in for `codex app-server` (lines recorded from Codex 0.160), replayed by what the prompt asks for; `exec`
// answers once by its schema. FAKE_CODEX_STATE: codex.jsonl, threads.json, codex-logged-out, codex-exec-fails.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const STATE = process.env.FAKE_CODEX_STATE || ""
const argv = process.argv.slice(2)
if (argv[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0) }
if (argv[0] === "exec") {
  if (STATE && fs.existsSync(path.join(STATE, "codex-exec-fails"))) { console.error("stream error: 503"); process.exit(1) }
  const schema = JSON.parse(fs.readFileSync(argv[argv.indexOf("--output-schema") + 1], "utf8"))
  const props = Object.keys(schema.properties ?? {})
  const prompt = fs.readFileSync(0, "utf8")
  const message = /(?:User message|Thread contents):\n([^\n]*)/.exec(prompt)?.[1]?.replace(/^USER: /, "") ?? ""
  const words = message.replace(/[^\w\s./-]/g, "").split(/\s+/).filter((w) => w.length > 2 && !/^(please|the|and|now)$/i.test(w)).slice(0, 4)
  const answer = props.includes("branch") ? { branch: `fix-${words.slice(0, 3).join("-").toLowerCase() || "the-answer"}` }
    : props.includes("subject") ? { subject: "fix(app): make the answer right", body: "- app.ts now answers 42" }
    : props.includes("body") ? { title: "Make the answer right", body: "## Summary\n- app.ts now answers 42" }
    : { title: words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "Untitled work" }
  if (STATE) fs.appendFileSync(path.join(STATE, "codex.jsonl"), JSON.stringify({ pid: process.pid, exec: argv }) + "\n")
  const last = argv.indexOf("--output-last-message")
  if (last >= 0) fs.writeFileSync(argv[last + 1], JSON.stringify(answer))
  else console.log(JSON.stringify(answer))
  process.exit(0)
}
if (argv[0] !== "app-server") { console.error("fake codex: only app-server"); process.exit(2) }

const log = (o) => { if (STATE) fs.appendFileSync(path.join(STATE, "codex.jsonl"), JSON.stringify({ pid: process.pid, ...o }) + "\n") }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const note = (method, params) => out({ method, params, emittedAtMs: Date.now() })
const loggedOut = () => !!STATE && fs.existsSync(path.join(STATE, "codex-logged-out"))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uuid = () => crypto.randomUUID()
const known = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE, "threads.json"), "utf8")) } catch { return {} } }
// Each thread: its folder and its turns' ids and messages ({ cwd, turns: [{ id, text }] }).
const remember = (id, th) => { if (STATE) fs.writeFileSync(path.join(STATE, "threads.json"), JSON.stringify({ ...known(), [id]: th })) }
const turnsOf = (id) => known()[id]?.turns ?? []

const threads = new Map() // id -> { cwd, turn, sandbox }
let nextReq = 0, experimental = false
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
  if (low.includes("question")) {
    const questions = [{ id: "colour", header: "Colour", question: "Which colour should the button be?", isOther: true, isSecret: false,
      options: [{ label: "Red", description: "Warm and loud" }, { label: "Blue", description: "Calm" }] }]
    const answer = await ask("item/tool/requestUserInput", { ...base, itemId: `call_${crypto.randomBytes(6).toString("hex")}`, questions, isBlocking: true, autoResolutionMs: null }, t)
    if (t.stopped) return
    note("thread/status/changed", { threadId: t.thread, status: { type: "active", activeFlags: [] } })
    const picked = Object.values(answer?.answers ?? {}).flatMap((a) => a?.answers ?? [])
    await message(t, picked.length ? `You picked: ${picked.join("; ")}.` : "Okay, I won't ask.")
    return finish(t)
  }
  if (low.includes("todo")) {
    const steps = ["Read app.ts", "Fix the answer", "Run the tests"]
    for (let done = 0; done <= steps.length; done++) {
      note("turn/plan/updated", { ...base, explanation: done ? null : "Three steps", plan: steps.map((step, i) => ({ step, status: i < done ? "completed" : i === done ? "inProgress" : "pending" })) })
      await sleep(low.includes("slow") && done === 1 ? 6000 : 20)
      if (t.stopped) return
    }
    await message(t, "All three are done.")
    return finish(t)
  }
  if (low.includes("plan") && t.collaboration === "plan") {
    const id = `plan_${crypto.randomBytes(6).toString("hex")}`
    const text = "# Fix the wrong answer\n\n1. Read `app.ts`\n2. Make the answer 42\n3. Run the tests"
    note("item/started", { item: { type: "plan", id, text: "" }, ...base, startedAtMs: Date.now() })
    for (const piece of text.match(/\S+\s*/g)) { note("item/plan/delta", { ...base, itemId: id, delta: piece }); await sleep(5) }
    note("item/completed", { item: { type: "plan", id, text }, ...base, completedAtMs: Date.now() })
    return finish(t)
  }
  if (low.includes("what did i say")) {
    const said = turnsOf(t.thread).map((x) => x.text).slice(0, -1)
    await message(t, `Before this you said: ${said.join(" | ") || "nothing"}`)
    return finish(t)
  }
  if (low.includes("wait")) {
    const id = `exec-${uuid()}`
    const item = { type: "commandExecution", id, pluginId: null, scriptPath: null, command: "/bin/zsh -lc 'sleep 1'", cwd, processId: null, source: "agent",
      status: "inProgress", commandActions: [{ type: "unknown", command: "sleep 1" }], aggregatedOutput: null, exitCode: null, durationMs: null }
    note("item/started", { item, ...base, startedAtMs: Date.now() })
    await sleep(1200)
    note("item/completed", { item: { ...item, status: "completed", aggregatedOutput: "", exitCode: 0, durationMs: 1200 }, ...base, completedAtMs: Date.now() })
    if (t.stopped) return
    await message(t, `Waited.${t.also.length ? ` And: ${t.also.join(" / ")}` : ""}`)
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
  const usage = { totalTokens: 24310, inputTokens: 21000, cachedInputTokens: 18000, cacheWriteInputTokens: 0, outputTokens: 3310, reasoningOutputTokens: 900 }
  note("thread/tokenUsage/updated", { threadId: t.thread, turnId: t.id, tokenUsage: { total: usage, last: usage, modelContextWindow: 272000 } })
  note("thread/status/changed", { threadId: t.thread, status: { type: "idle" } })
  note("turn/completed", { threadId: t.thread, turn: { id: t.id, items: [], itemsView: "summary", status, error, startedAt: now, completedAt: now, durationMs: 10 } })
  threads.get(t.thread).turn = null
}

function handle(j) {
  const p = j.params ?? {}
  const reply = (result) => out({ id: j.id, result })
  const fail = (message) => out({ id: j.id, error: { code: -32600, message } })
  switch (j.method) {
    case "initialize": experimental = !!p.capabilities?.experimentalApi; return reply({ userAgent: "vaultite_agents/0.160.0 (fake)", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" })
    case "account/read": return reply(loggedOut() ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "alice@example.com", planType: "plus" }, requiresOpenaiAuth: true })
    case "model/list": return reply({ data: MODELS, nextCursor: null })
    case "thread/start": {
      const id = uuid()
      threads.set(id, { cwd: p.cwd, sandbox: p.sandbox, turn: null })
      remember(id, { cwd: p.cwd, turns: [] })
      reply({ thread: threadOf(id, p.cwd), model: p.model ?? "gpt-6.1-sol", modelProvider: "openai", cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: "workspaceWrite" } })
      return note("thread/started", { thread: threadOf(id, p.cwd) })
    }
    case "thread/resume": {
      const cwd = known()[p.threadId]?.cwd
      if (!cwd) return fail(`no rollout found for thread id ${p.threadId}`)
      threads.set(p.threadId, { cwd: p.cwd ?? cwd, sandbox: p.sandbox, turn: null })
      return reply({ thread: threadOf(p.threadId, cwd), model: "gpt-6.1-sol", modelProvider: "openai", cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: "workspaceWrite" } })
    }
    case "thread/revert": {
      const th = known()[p.threadId]
      const at = th?.turns.findIndex((x) => x.id === p.beforeTurnId) ?? -1
      if (at < 0) return fail(`turn ${p.beforeTurnId} not found in thread ${p.threadId}`)
      remember(p.threadId, { ...th, turns: th.turns.slice(0, at) })
      reply({ thread: threadOf(p.threadId, th.cwd), turnsBackwardsCursor: null, itemsBackwardsCursor: null })
      return note("thread/reverted", { threadId: p.threadId })
    }
    case "thread/fork": {
      const th = known()[p.threadId]
      if (!th) return fail(`no rollout found for thread id ${p.threadId}`)
      const at = p.lastTurnId ? th.turns.findIndex((x) => x.id === p.lastTurnId) : th.turns.length - 1
      if (p.lastTurnId && at < 0) return fail(`turn ${p.lastTurnId} not found`)
      const id = uuid()
      const cwd = p.cwd ?? th.cwd
      remember(id, { cwd, turns: th.turns.slice(0, at + 1) })
      threads.set(id, { cwd, sandbox: p.sandbox, turn: null })
      reply({ thread: threadOf(id, cwd), model: p.model ?? "gpt-6.1-sol", modelProvider: "openai", serviceTier: null, disabledPluginIds: [], cwd, instructionSources: [],
        approvalPolicy: p.approvalPolicy ?? "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" }, reasoningEffort: null })
      return note("thread/started", { thread: threadOf(id, cwd) })
    }
    case "turn/steer": {
      const t = threads.get(p.threadId)?.turn
      if (!t || t.id !== p.expectedTurnId) return fail("no active turn to steer")
      const text = (p.input ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n")
      t.also.push(text)
      const th = known()[p.threadId]
      if (th) remember(p.threadId, { ...th, turns: th.turns.map((x) => (x.id === t.id ? { ...x, text: `${x.text}\n${text}` } : x)) })
      const user = { type: "userMessage", id: uuid(), clientId: p.clientUserMessageId ?? null, content: p.input ?? [] }
      note("item/started", { item: user, threadId: t.thread, turnId: t.id, startedAtMs: Date.now() })
      note("item/completed", { item: user, threadId: t.thread, turnId: t.id, completedAtMs: Date.now() })
      return reply({ turnId: t.id })
    }
    case "thread/unsubscribe": threads.delete(p.threadId); return reply({ status: "unsubscribed" })
    case "turn/start": {
      const th = threads.get(p.threadId)
      if (!th) return fail(`thread not loaded: ${p.threadId}`)
      if (p.sandboxPolicy) th.sandbox = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" }[p.sandboxPolicy.type]
      if (p.collaborationMode && !experimental) return fail("turn/start.collaborationMode requires experimentalApi capability")
      const t = { id: uuid(), thread: p.threadId, approvalPolicy: p.approvalPolicy, sandbox: th.sandbox, collaboration: p.collaborationMode?.mode ?? "default", stopped: false, done: false, also: [] }
      th.turn = t
      reply({ turn: { id: t.id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } })
      note("thread/status/changed", { threadId: t.thread, status: { type: "active", activeFlags: [] } })
      note("turn/started", { threadId: t.thread, turn: { id: t.id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null } })
      const text = (p.input ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n")
      const was = known()[p.threadId]
      if (was) remember(p.threadId, { ...was, turns: [...was.turns, { id: t.id, text }] })
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
