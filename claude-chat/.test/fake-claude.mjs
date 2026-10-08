#!/usr/bin/env node
// A stand-in for the claude CLI in tests and QA: the stream-json lines Claude Code 2.1 writes (recorded from real runs),
// replayed by what the prompt asks for, so nothing spends tokens or needs the network. FAKE_CLAUDE_STATE (a folder):
// `log.jsonl` gets each run's argv and stdin; a file `logged-out` there makes it signed out.
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
const session = flag("--resume") || flag("--session-id") || crypto.randomUUID()
const mode = flag("--permission-mode") || "default"
const model = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5-5" }[flag("--model")] || "claude-opus-5-5"
const MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
]
const base = () => ({ session_id: session, uuid: crypto.randomUUID() })
let inited = false, turn = null, cost = 0, lastText = ""
const waiting = new Map()

function init() {
  if (inited) return
  inited = true
  out({ type: "system", subtype: "init", cwd: process.cwd(), tools: ["Bash", "Edit", "Read", "Write", "Glob", "Grep"], model, permissionMode: mode, ...base() })
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
  out({ type: "assistant", message: { model, id, type: "message", role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, ...base() })
}

/** A tool call: asked first when the mode wants it (can_use_tool, answered on stdin), then run and its result sent. */
async function tool(t, name, input, run, ask) {
  const id = `toolu_${crypto.randomBytes(8).toString("hex")}`
  const msg = `msg_${crypto.randomBytes(8).toString("hex")}`
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }, parent_tool_use_id: null, ...base() })
  out({ type: "assistant", message: { model, id: msg, type: "message", role: "assistant", content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null, ...base() })
  if (ask && mode !== "acceptEdits") {
    const rid = crypto.randomUUID()
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: name, display_name: name, input, description: path.basename(input.file_path ?? "") || input.command,
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }], tool_use_id: id } })
    const answer = await new Promise((resolve) => { waiting.set(rid, resolve); t.cancel = () => resolve(null) })
    if (!answer) return false
    if (answer.behavior !== "allow") {
      out({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: answer.message || "The user doesn't want to proceed with this tool use.", is_error: true, tool_use_id: id }] }, parent_tool_use_id: null, ...base() })
      return false
    }
  }
  const { content, result } = run()
  out({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content }] }, parent_tool_use_id: null, tool_use_result: result, ...base() })
  return true
}

async function respond(text, t) {
  const low = text.toLowerCase()
  const vault = process.cwd()
  if (loggedOut()) return finish(t, { is_error: true, result: "Not logged in · Please run /login" })
  if (low.includes("crash")) { console.error("API Error: 500 the fake server fell over"); process.exit(1) }
  if (low.includes("edit")) {
    const rel = /\bedit\s+(.+?\.md)\b/i.exec(text)?.[1] ?? "hello.md"
    const file = path.join(vault, rel)
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    await tool(t, "Read", { file_path: file, limit: 5 }, () => ({ content: before.split("\n").slice(0, 5).map((l, i) => `${i + 1}\t${l}`).join("\n"), result: { type: "text" } }))
    if (t.stopped) return
    const old = before.split("\n").find((l) => l.trim()) ?? ""
    const next = `${old} (edited)`
    const ok = await tool(t, "Edit", { file_path: file, old_string: old, new_string: next, replace_all: false }, () => {
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
    total_cost_usd: cost, terminal_reason: "completed", permission_denials: [], ...extra, ...base() })
  turn = null
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
    if (j.type === "control_request" && j.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: j.request_id, response: { commands: [], models: MODELS, current_permission_mode: mode, account: {} } } })
    } else if (j.type === "control_request" && j.request?.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: j.request_id, response: { still_queued: [] } } })
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
      init()
      const parts = Array.isArray(j.message?.content) ? j.message.content : [{ type: "text", text: String(j.message?.content ?? "") }]
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
      turn = { stopped: false, done: false }
      lastText = ""
      void respond(text, turn)
    }
  }
})
process.stdin.on("end", () => { const wait = () => (turn ? setTimeout(wait, 20) : process.exit(0)); wait() })
