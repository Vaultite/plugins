#!/usr/bin/env node
// A stand-in for claude (stream-json lines recorded from Claude Code 2.1), replayed by what the prompt asks for; `-p`
// alone answers once by its --json-schema. FAKE_CLAUDE_STATE: log.jsonl, sessions/, rewind.json, logged-out, oneshot-fails.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const STATE = process.env.FAKE_CLAUDE_STATE || ""
const argv = process.argv.slice(2)
const log = (o) => { if (STATE) fs.appendFileSync(path.join(STATE, "log.jsonl"), JSON.stringify({ pid: process.pid, ...o }) + "\n") }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const loggedOut = () => !!STATE && fs.existsSync(path.join(STATE, "logged-out"))
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (argv[0] === "--version") { console.log("2.1.291 (Claude Code)"); process.exit(0) }
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(JSON.stringify(loggedOut() ? { loggedIn: false, authMethod: "none", apiProvider: "firstParty" } : { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }, null, 2))
  process.exit(loggedOut() ? 1 : 0)
}
if (!argv.includes("-p")) { console.error("fake claude: only -p"); process.exit(2) }

log({ argv, cwd: process.cwd() })

// One answer, no stream: what the schema asks for (a branch name, a commit message, a pull request's title and body).
if (flag("--input-format") !== "stream-json") {
  let prompt = ""
  process.stdin.on("data", (d) => { prompt += d })
  process.stdin.on("end", () => {
    log({ prompt })
    if (STATE && fs.existsSync(path.join(STATE, "oneshot-fails"))) { console.error("API Error: 529 overloaded"); process.exit(1) }
    const props = Object.keys(JSON.parse(flag("--json-schema") || "{}").properties ?? {})
    // (a title: the message's first words, as a model might sum it up)
    const message = (/(?:User message|Thread contents):\n([^\n]*)/.exec(prompt)?.[1] ?? "").replace(/^USER: /, "")
    const words = message.replace(/[^\w\s./-]/g, "").split(/\s+/).filter((w) => w.length > 2 && !/^(please|the|and|now)$/i.test(w)).slice(0, 4)
    const answer = props.includes("branch") ? { branch: `fix-${words.slice(0, 3).join("-").toLowerCase() || "the-answer"}` }
      : props.includes("subject") ? { subject: "fix(app): make the answer right", body: "- app.ts now answers 42" }
      : props.includes("body") ? { title: "Make the answer right", body: "## Summary\n- app.ts now answers 42\n\n## Testing\n- Not run" }
      : props.includes("title") ? { title: words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "Untitled work" }
      : { text: "Hello" }
    const result = { type: "result", subtype: "success", is_error: false, duration_ms: 40, num_turns: 1, result: JSON.stringify(answer), structured_output: answer,
      session_id: crypto.randomUUID(), total_cost_usd: 0.001, uuid: crypto.randomUUID() }
    process.stdout.write(flag("--output-format") === "json" ? JSON.stringify(result) + "\n" : `${result.result}\n`)
  })
  process.stdin.resume()
} else stream()

function stream() {
const fork = argv.includes("--fork-session")
const session = (fork ? "" : flag("--resume") || flag("--session-id")) || crypto.randomUUID()
let mode = flag("--permission-mode") || "default"
let model = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5-5" }[flag("--model")] || "claude-opus-5-5"
const MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
]
let inited = false, turn = null, cost = 0, lastText = ""
const waiting = new Map()
/** Messages waiting for the turn under way: taken in at its next tool result (as Claude Code does), else run after it. */
const queue = []

// The session's messages, so a resume can stop at one (--resume-session-at) and a fork copies them.
const sessionFile = (id) => STATE && path.join(STATE, "sessions", `${id}.json`)
const readSession = (id) => { try { return JSON.parse(fs.readFileSync(sessionFile(id), "utf8")) } catch { return [] } }
let history = flag("--resume") ? readSession(flag("--resume")) : []
const at = flag("--resume-session-at")
if (at) { const i = history.findIndex((m) => m.uuid === at); history = i >= 0 ? history.slice(0, i + 1) : history }
const keep = (m) => { history.push(m); if (STATE) { fs.mkdirSync(path.join(STATE, "sessions"), { recursive: true }); fs.writeFileSync(sessionFile(session), JSON.stringify(history)) } }
const base = () => ({ session_id: session, uuid: crypto.randomUUID() })
const chain = (o) => { const b = base(); keep({ uuid: b.uuid, role: o.type, text: o.message?.content?.find?.((c) => c.type === "text")?.text ?? "" }); out({ ...o, ...b }) }

// What each message's edits replaced, for rewind_files (only with SDK file checkpointing on, as the real one).
const rewindFile = () => STATE && path.join(STATE, "rewind.json")
const rewinds = () => { try { return JSON.parse(fs.readFileSync(rewindFile(), "utf8")) } catch { return { msgs: [], edits: [] } } }
const saveRewinds = (r) => { if (STATE) fs.writeFileSync(rewindFile(), JSON.stringify(r)) }

function init() {
  if (inited) return
  inited = true
  out({ type: "system", subtype: "init", cwd: process.cwd(), tools: ["Bash", "Edit", "Read", "Write", "Glob", "Grep", "AskUserQuestion", "TodoWrite", "ExitPlanMode"], model, permissionMode: mode, ...base() })
}

/** One assistant message, streamed as Claude Code does with --include-partial-messages: its text in pieces. */
async function say(text, t) {
  const id = `msg_${crypto.randomBytes(8).toString("hex")}`
  out({ type: "stream_event", event: { type: "message_start", message: { model, id, type: "message", role: "assistant", content: [] } }, parent_tool_use_id: null, ...base() })
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null, ...base() })
  for (const piece of text.match(/\S+\s*/g) ?? [text]) {
    if (t.stopped) break
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, parent_tool_use_id: null, ...base() })
    await sleep(t.slow ? 60 : 8)
  }
  out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null, ...base() })
  if (t.stopped) return
  lastText = text
  chain({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [{ type: "text", text }],
    usage: { input_tokens: 2, cache_read_input_tokens: 17029, cache_creation_input_tokens: 7226, output_tokens: 40 } }, parent_tool_use_id: null, user_message_uuids: t.msgs })
}

const asks = () => mode === "default" || mode === "manual" || mode === "plan"
/** Answered on stdin: can_use_tool's control request, then its control_response. */
function canUse(t, name, input, id, extra = {}) {
  const rid = crypto.randomUUID()
  out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: name, display_name: name, input, tool_use_id: id, ...extra } })
  return new Promise((resolve) => { waiting.set(rid, resolve); t.cancel = () => resolve(null) })
}

/** Messages sent while it worked: taken in now, as the next tool result comes back. */
function absorb(t) {
  for (const m of queue.splice(0)) {
    out({ type: "command_lifecycle", command_uuid: m.uuid, state: "started", ...base() })
    t.msgs.push(m.uuid)
    t.also.push(m.text)
    keep({ uuid: m.uuid, role: "user", text: m.text })
  }
}

/** A tool call: asked first when the mode wants it (can_use_tool, answered on stdin), then run and its result sent. */
async function tool(t, name, input, run, ask, denied = () => {}) {
  const id = `toolu_${crypto.randomBytes(8).toString("hex")}`
  const msg = `msg_${crypto.randomBytes(8).toString("hex")}`
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }, parent_tool_use_id: null, ...base() })
  chain({ type: "assistant", message: { model, id: msg, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null })
  let used = input
  if (ask === "always" || (ask && asks())) {
    const answer = await canUse(t, name, input, id, ask === "always" ? { requires_user_interaction: true } : { description: path.basename(input.file_path ?? "") || input.command,
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] })
    if (!answer) return false
    for (const p of answer.updatedPermissions ?? []) if (p.type === "setMode" && p.destination === "session") mode = p.mode
    if (answer.behavior !== "allow") {
      denied(answer.message ?? "")
      if (answer.interrupt) { t.stopped = true; out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null, ...base() }); finish(t, { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" }); return false }
      chain({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: answer.message || "The user doesn't want to proceed with this tool use.", is_error: true, tool_use_id: id }] }, parent_tool_use_id: null })
      absorb(t)
      return false
    }
    used = answer.updatedInput ?? input
  }
  const { content, result } = await run(used)
  chain({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content }] }, parent_tool_use_id: null, tool_use_result: result })
  absorb(t)
  return true
}

const TODOS = [["Read app.ts", "Reading app.ts"], ["Fix the answer", "Fixing the answer"], ["Run the tests", "Running the tests"]]
const todos = (done) => TODOS.map(([content, activeForm], i) => ({ content, activeForm, status: i < done ? "completed" : i === done ? "in_progress" : "pending" }))

async function respond(text, t) {
  const low = text.toLowerCase()
  const vault = process.cwd()
  if (loggedOut()) return finish(t, { is_error: true, result: "Not logged in · Please run /login" })
  if (low.includes("crash")) { console.error("API Error: 500 the fake server fell over"); process.exit(1) }
  if (low.includes("question")) {
    const questions = [{ question: "Which colour should the button be?", header: "Colour", options: [{ label: "Red", description: "Warm and loud" }, { label: "Blue", description: "Calm" }], multiSelect: false },
      { question: "Which pages need it?", header: "Pages", options: [{ label: "Home", description: "The landing page" }, { label: "Settings", description: "The settings page" }], multiSelect: true }]
    let picked = null
    await tool(t, "AskUserQuestion", { questions }, (input) => {
      picked = input.answers ?? {}
      const said = Object.entries(picked).map(([q, a]) => `"${q}"="${a}"`).join(", ")
      return { content: `Your questions have been answered: ${said}. You can now continue with these answers in mind.`, result: { questions, answers: picked } }
    }, "always")
    if (t.stopped) return
    await say(picked ? `You picked: ${Object.values(picked).join("; ")}.` : "Okay, I won't ask.", t)
    return finish(t)
  }
  if (low.includes("todo")) {
    for (let done = 0; done <= TODOS.length; done++) {
      await tool(t, "TodoWrite", { todos: todos(done) }, () => ({ content: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.", result: { oldTodos: [], newTodos: todos(done) } }))
      if (t.stopped) return
      if (low.includes("slow") && done === 1) { t.slow = true; await sleep(6000) }
    }
    await say("All three are done.", t)
    return finish(t)
  }
  if (low.includes("plan") && mode === "plan") {
    const plan = "# Fix the wrong answer\n\n1. Read `app.ts`\n2. Make the answer 42\n3. Run the tests"
    let told = ""
    const ok = await tool(t, "ExitPlanMode", { plan }, () => ({ content: "User has approved your plan. You can now start coding.", result: { plan, isAgent: false } }), true, (m) => { told = m })
    if (t.stopped) return
    if (ok) mode = "default"
    await say(ok ? "Implementing the plan now." : /captured your proposed plan/.test(told) ? "The plan is above: tell me what to change, or implement it." : "Okay, I'll keep planning.", t)
    return finish(t)
  }
  if (low.includes("what did i say")) {
    const said = history.filter((m) => m.role === "user" && m.text).map((m) => m.text)
    await say(`Before this you said: ${said.slice(0, -1).join(" | ") || "nothing"}`, t)
    return finish(t)
  }
  if (low.includes("wait")) {
    await tool(t, "Bash", { command: "sleep 1", description: "Wait a second" }, async () => { await sleep(1200); return { content: "", result: { stdout: "", stderr: "", interrupted: false } } })
    if (t.stopped) return
    await say(`Waited.${t.also.length ? ` And: ${t.also.join(" / ")}` : ""}`, t)
    return finish(t)
  }
  if (low.includes("edit")) {
    const rel = /\bedit\s+(.+?\.(?:md|ts))\b/i.exec(text)?.[1] ?? "hello.md"
    const file = path.join(vault, rel)
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    await tool(t, "Read", { file_path: file, limit: 5 }, () => ({ content: before.split("\n").slice(0, 5).map((l, i) => `${i + 1}\t${l}`).join("\n"), result: { type: "text" } }))
    if (t.stopped) return
    const old = before.split("\n").find((l) => l.trim()) ?? ""
    const next = `${old} (edited)`
    const ok = await tool(t, "Edit", { file_path: file, old_string: old, new_string: next, replace_all: false }, () => {
      const r = rewinds()
      r.edits.push({ msg: t.msgs[0], file, before })
      saveRewinds(r)
      fs.writeFileSync(file, before.replace(old, next))
      return { content: `The file ${file} has been updated successfully.`, result: { filePath: file, oldString: old, newString: next, originalFile: before,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${old}`, `+${next}`] }], userModified: false, replaceAll: false } }
    }, true)
    if (t.stopped) return
    await say(ok ? `Done: I edited **${rel}**.` : "Okay, I left it as it was.", t)
    return finish(t)
  }
  if (low.includes("slow")) {
    await say(Array.from({ length: 200 }, (_, i) => `word${i + 1}`).join(" "), { ...t, slow: true, get stopped() { return t.stopped } })
    return finish(t)
  }
  await say(`You said: ${text.split("\n")[0]}\n\n- one\n- two`, t)
  finish(t)
}

function finish(t, extra = {}) {
  if (t.done) return
  t.done = true
  cost += 0.01
  out({ type: "result", subtype: extra.is_error ? "error_during_execution" : "success", is_error: false, duration_ms: 50, num_turns: 1, result: lastText, stop_reason: "end_turn",
    total_cost_usd: cost, terminal_reason: "completed", permission_denials: [], user_message_uuids: t.msgs,
    modelUsage: { [model]: { inputTokens: 4, outputTokens: 40, cacheReadInputTokens: 17029, cacheCreationInputTokens: 7226, contextWindow: 200000, maxOutputTokens: 64000 } }, ...extra, ...base() })
  for (const u of t.msgs) out({ type: "command_lifecycle", command_uuid: u, state: "completed", ...base() })
  turn = null
  const next = queue.shift()
  if (next) start(next)
}

function start(m) {
  init()
  out({ type: "command_lifecycle", command_uuid: m.uuid, state: "started", ...base() })
  keep({ uuid: m.uuid, role: "user", text: m.text })
  const r = rewinds()
  r.msgs.push(m.uuid)
  saveRewinds(r)
  turn = { stopped: false, done: false, msgs: [m.uuid], also: [] }
  lastText = ""
  void respond(m.text, turn)
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
    log({ stdin: j })
    const reply = (response) => out({ type: "control_response", response: { subtype: "success", request_id: j.request_id, response } })
    if (j.type === "control_request" && j.request?.subtype === "initialize") {
      reply({ commands: [], models: MODELS, current_permission_mode: mode, account: {} })
    } else if (j.type === "control_request" && j.request?.subtype === "set_permission_mode") {
      if (j.request.mode === "bypassPermissions" && !argv.includes("--allow-dangerously-skip-permissions") && !argv.includes("--dangerously-skip-permissions")) {
        out({ type: "control_response", response: { subtype: "error", request_id: j.request_id, error: "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions" } })
        continue
      }
      mode = j.request.mode === "manual" ? "default" : j.request.mode
      reply({ mode })
      out({ type: "system", subtype: "status", status: null, permissionMode: mode, ...base() })
    } else if (j.type === "control_request" && j.request?.subtype === "set_model") {
      model = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5-5" }[j.request.model] || "claude-opus-5-5"
      reply(null)
    } else if (j.type === "control_request" && j.request?.subtype === "rewind_files") {
      const r = rewinds()
      const from = r.msgs.indexOf(j.request.user_message_id)
      if (process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING !== "true") reply({ canRewind: false, error: "File checkpointing is not enabled" })
      else if (from < 0) reply({ canRewind: false, error: "No file checkpoint found for this message." })
      else {
        const later = new Set(r.msgs.slice(from))
        const undo = r.edits.filter((e) => later.has(e.msg))
        for (const e of [...undo].reverse()) fs.writeFileSync(e.file, e.before)
        if (!j.request.dry_run) saveRewinds({ msgs: r.msgs.slice(0, from), edits: r.edits.filter((e) => !later.has(e.msg)) })
        reply({ canRewind: true, filesChanged: [...new Set(undo.map((e) => e.file))], insertions: 0, deletions: undo.length })
      }
    } else if (j.type === "control_request" && j.request?.subtype === "interrupt") {
      reply({ still_queued: [] })
      if (turn) {
        const t = turn
        t.stopped = true
        t.cancel?.()
        out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null, ...base() })
        finish(t, { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" })
      }
    } else if (j.type === "control_response") {
      const r = j.response
      waiting.get(r?.request_id)?.(r?.response)
      waiting.delete(r?.request_id)
    } else if (j.type === "user") {
      const parts = Array.isArray(j.message?.content) ? j.message.content : [{ type: "text", text: String(j.message?.content ?? "") }]
      const m = { uuid: typeof j.uuid === "string" ? j.uuid : crypto.randomUUID(), text: parts.filter((p) => p.type === "text").map((p) => p.text).join("\n") }
      out({ type: "command_lifecycle", command_uuid: m.uuid, state: "queued", ...base() })
      if (turn) queue.push(m)
      else start(m)
    }
  }
})
process.stdin.on("end", () => { const wait = () => (turn || queue.length ? setTimeout(wait, 20) : process.exit(0)); wait() })
}
