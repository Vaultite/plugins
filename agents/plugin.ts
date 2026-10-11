// Agents: Claude Code and Codex threads, by project, each a chat; the CLIs run on this machine (claude.ts, codex.ts),
// threads are kept in plugin.localDir() (core.ts), never the vault.
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import path from "node:path"
import type { WebSocket } from "ws"
import { HTTPError, OpError, type Request, Text } from "@vaultite/core/plugins.ts"
import { ClaudeRun, claudeCli, claudeStatus } from "./claude.ts"
import { codexCli, CodexRun, codexStatus } from "./codex.ts"
import {
  type Any, create, dir, forget, home, ID, type Image, listChanged, liveOf, load, MODES, NEW_TITLE, now, plugin, projects, push, realOf, runs, save, send,
  setLive, sockets, str, summaries, thread, vaultReal,
} from "./core.ts"
import type { Entry, Harness, Mode, Summary, Thread } from "./types.ts"

export { plugin }

const HARNESSES: Harness[] = ["claude", "codex"]
const NAMES: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" }

plugin.onUnload(() => { for (const r of runs.values()) r.end(); for (const ws of sockets.keys()) ws.close() })

const settings = () => {
  const s = plugin.settings()
  return {
    harness: (HARNESSES.includes(s.harness as Harness) ? s.harness : "claude") as Harness,
    mode: (MODES.includes(s.mode as Mode) ? s.mode : "ask") as Mode,
    model: { claude: str(s.claudeModel).trim(), codex: str(s.codexModel).trim() } as Record<Harness, string>,
  }
}

/** A folder to work in: an existing directory (~ allowed); the vault when none is given. */
function folder(p: unknown): string {
  const raw = str(p).trim()
  if (!raw) return vaultReal()
  const abs = realOf(path.resolve(home(raw)))
  try { if (fs.statSync(abs).isDirectory()) return abs } catch { /* below */ }
  throw new HTTPError(400, `no folder '${raw}' on this machine`)
}

// ---------- who may: only this machine's owner (it runs agents here), or the logins its settings let in

async function allowed(ws: WebSocket, req: IncomingMessage) {
  const why = await plugin.refusal(req, "Agents")
  if (why) { send(ws, { t: "refused", reason: why }); ws.close(4403, "refused"); return false }
  return ws.readyState === ws.OPEN
}
async function owner(req: Request) {
  const why = req.http ? await plugin.refusal(req.http, "Agents") : ""
  if (why) throw new HTTPError(403, why)
}

plugin.socket("agents/live", async (ws, req) => {
  if (!(await allowed(ws, req))) return
  const ids = new Set<string>()
  sockets.set(ws, ids)
  send(ws, { t: "list", list: summaries() })
  ws.on("message", (data) => {
    let m: Any
    try { m = JSON.parse(String(data)) } catch { return }
    if (m?.t === "watch" && typeof m.id === "string") {
      ids.add(m.id)
      try { const t = thread(m.id); send(ws, { t: "thread", thread: t, live: liveOf(t.id) }) } catch { send(ws, { t: "gone", id: m.id }) }
    } else if (m?.t === "unwatch" && typeof m.id === "string") ids.delete(m.id)
  })
  ws.on("close", () => sockets.delete(ws))
})

// ---------- a message: its entry, then the harness's run for the thread takes it

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }
type Sent = { file?: string; images?: { type: string; data: string }[] }

function ask(t: Thread, text: string, opts: Sent = {}): Promise<{ text: string; error: string | null }> {
  if (liveOf(t.id).running) throw new HTTPError(409, `${NAMES[t.harness]} is still answering: stop it first, or wait`)
  const cli = t.harness === "claude" ? claudeCli() : codexCli()
  if (!cli) throw new HTTPError(424, `${NAMES[t.harness]} isn't installed on this machine`)
  const images: Image[] = (opts.images ?? []).filter((im) => IMAGE_TYPES[im.type] && typeof im.data === "string").slice(0, 6).map((im, n) => {
    const name = `${Date.now().toString(36)}-${n}.${IMAGE_TYPES[im.type]}`
    const file = path.join(dir("images", t.id), name)
    fs.writeFileSync(file, Buffer.from(im.data, "base64"))
    return { path: file, type: im.type, data: im.data }
  })
  const file = opts.file && !opts.file.includes("..") ? opts.file : undefined
  push(t, { kind: "user", text, at: now(), ...(file ? { file } : {}), ...(images.length ? { images: images.map((im) => path.basename(im.path)) } : {}) })
  if (t.title === NEW_TITLE) {
    const words = text.replace(/[@#*_`[\]]/g, "").trim().split(/\s+/).filter(Boolean)
    t.title = words.slice(0, 7).join(" ").slice(0, 60) + (words.length > 7 ? "…" : "") || NEW_TITLE
  }
  let r = runs.get(t.id)
  // Claude takes its model and mode as it starts: a change starts it again (the session goes on). Codex takes them per turn.
  if (r && (r.ended || (t.harness === "claude" && (r.model !== t.model || r.mode !== t.mode)))) { r.end(); r = undefined }
  if (!r) { r = t.harness === "claude" ? new ClaudeRun(t, cli) : new CodexRun(t); runs.set(t.id, r) }
  const said = file ? `${text}\n\n(The note open beside this chat: ${file}. Read it if it helps.)` : text
  setLive(t, { running: true, status: "thinking" })
  const answer = new Promise<{ text: string; error: string | null }>((resolve) => r!.turns.push({ done: (x, error) => resolve({ text: x, error }) }))
  if (!r.send(said, images)) { r.failed(`${NAMES[t.harness]} couldn't take the message.`); r.endTurn("", "failed") }
  return answer
}

// ---------- what the app asks for

plugin.route("GET", "agents/status", async (req) => {
  await owner(req)
  if (req.query.fresh) plugin.forget()
  const [claude, codex] = await Promise.all([claudeStatus(), codexStatus()])
  return { claude, codex }
})

plugin.route("GET", "agents/projects", async (req) => { await owner(req); load(); return { list: projects() } })

plugin.route("GET", "agents/threads", async (req) => { await owner(req); return { list: summaries() } })

plugin.route("POST", "agents/threads", async (req) => {
  await owner(req)
  const b = (req.body ?? {}) as Any
  const s = settings()
  const harness: Harness = HARNESSES.includes(b.harness) ? b.harness : s.harness
  const mode: Mode = MODES.includes(b.mode) ? b.mode : s.mode
  const t = create(harness, folder(b.cwd), typeof b.model === "string" ? b.model.trim() : s.model[harness], mode)
  return { id: t.id }
})

plugin.route("GET", "agents/threads/*", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  return { thread: t, live: liveOf(t.id) }
})

/** Rename a thread, or change the model or mode its next turns use. */
plugin.route("PATCH", "agents/threads/*", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  if (b.title !== undefined) {
    const title = str(b.title).trim().slice(0, 120)
    if (!title) throw new HTTPError(400, "give it a title")
    t.title = title
  }
  if (b.model !== undefined) t.model = str(b.model).trim()
  if (b.mode !== undefined) {
    if (!MODES.includes(b.mode)) throw new HTTPError(400, `mode is one of ${MODES.join(", ")}`)
    t.mode = b.mode
  }
  save(t)
  listChanged()
  for (const [ws, ids] of sockets) if (ids.has(t.id)) send(ws, { t: "thread", thread: t, live: liveOf(t.id) })
  return { id: t.id, title: t.title, model: t.model, mode: t.mode }
})

plugin.route("DELETE", "agents/threads/*", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  runs.get(t.id)?.end()
  runs.delete(t.id)
  forget(t)
  return { ok: true }
})

plugin.route("POST", "agents/threads/*/send", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const text = str(b.text).trim()
  if (!text && !b.images?.length) throw new HTTPError(400, "write a message first")
  void ask(t, text, { file: str(b.file) || undefined, images: Array.isArray(b.images) ? b.images : [] })
  return { ok: true }
}, { lock: false })

plugin.route("POST", "agents/threads/*/stop", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  runs.get(t.id)?.stop()
  return { ok: true }
}, { lock: false })

plugin.route("POST", "agents/threads/*/answer", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const r = runs.get(t.id)
  if (!r || !r.settle(str(b.ask), b.allow === true ? "allow" : "deny")) throw new HTTPError(409, "that question isn't waiting any more")
  return { ok: true }
}, { lock: false })

/** Hand the session to a terminal: this thread's run ends first, so the two never write one session at once. */
plugin.route("POST", "agents/threads/*/handoff", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  if (!t.started) throw new HTTPError(409, "nothing to resume yet: send a message first")
  const r = runs.get(t.id)
  if (r) { r.stop(); r.end() }
  runs.delete(t.id)
  return { harness: t.harness, session: t.session }
}, { lock: false })

plugin.route("GET", "agents/image/*/*", async (req) => {
  await owner(req)
  const [id, name] = [req.arg(0), req.arg(1)]
  if (!ID.test(id) || !/^[\w.-]+$/.test(name)) throw new HTTPError(404, "no such image")
  const file = path.join(plugin.localDir(), "images", id, name)
  if (!fs.existsSync(file)) throw new HTTPError(404, "no such image")
  return new Text(fs.readFileSync(file), `image/${name.endsWith("jpg") ? "jpeg" : name.split(".").pop()}`, { "Cache-Control": "private, max-age=86400" })
})

// ---------- for agents and scripts

/** A turn's tool calls, as an agent reads them: "Edit Notes/Idea.md". */
function toolLines(t: Thread, from: number) {
  return t.entries.slice(from).filter((e) => e.kind === "tool").map((e) => {
    const x = e as Extract<Entry, { kind: "tool" }>
    const on = x.file ?? x.path ?? (str(x.input.command) ? `: ${str(x.input.command).split("\n")[0].slice(0, 80)}` : str(x.input.pattern))
    return `${x.name}${on ? (on.startsWith(":") ? on : ` ${on}`) : ""}${x.error ? " (failed)" : ""}`
  })
}

plugin.op({
  id: "agents.ask",
  cli: "agents ask",
  summary: "Send a message to a Claude Code or Codex thread in Agents and wait for its answer; a new thread unless you name one.",
  help: `Runs the user's own claude or codex CLI on the server's machine, in the thread's folder (the vault, or a project's
checkout), with its permission mode: when it asks to edit or run something, the user answers in Agents, so this waits.

  vau agents ask "Which notes mention Lighthouse?"
  vau agents ask "Fix the failing test" --harness codex --cwd ~/Projects/lighthouse
  vau agents ask "Now commit it" --thread k3j2h1g0a1`,
  kind: "write",
  owner: "Agents",
  lock: false,
  params: {
    message: { type: "string", required: true, description: "what to ask or tell the agent" },
    thread: { type: "string", description: "a thread's id to follow up in (agents list); a new one when left out" },
    harness: { type: "string", enum: HARNESSES, description: "a new thread's agent; the plugin's setting when left out" },
    cwd: { type: "string", description: "a new thread's folder (a project's checkout); the vault when left out" },
    model: { type: "string", description: "a new thread's model; the plugin's setting when left out" },
    mode: { type: "string", enum: MODES, description: "a new thread's permissions: ask, edits or read" },
    timeout: { type: "integer", minimum: 10, maximum: 3600, default: 600, description: "seconds to wait for the answer" },
  },
  args: ["message"],
  run: async (p) => {
    let t: Thread
    const s = settings()
    try {
      if (p.thread) t = thread(p.thread)
      else { const h: Harness = p.harness ?? s.harness; t = create(h, folder(p.cwd), p.model ?? s.model[h], p.mode ?? s.mode) }
    } catch (e) { throw new OpError(p.thread ? `no thread '${p.thread}': agents list lists them` : (e as Error).message, (e as HTTPError).status ?? 400) }
    const from = t.entries.length
    let pending: Promise<{ text: string; error: string | null }>
    try { pending = ask(t, p.message) } catch (e) { throw new OpError((e as Error).message, (e as HTTPError).status ?? 400) }
    const timer = new Promise<null>((r) => setTimeout(() => r(null), (p.timeout ?? 600) * 1000).unref())
    const got = await Promise.race([pending, timer])
    if (!got) throw new OpError(`no answer within ${p.timeout ?? 600} s: it's still going in Agents (thread ${t.id})`, 504)
    const notes = t.entries.slice(from).filter((e) => e.kind === "note" && e.error).map((e) => (e as { text: string }).text)
    if (got.error) throw new OpError(notes.join("\n") || `${NAMES[t.harness]} failed`, 502)
    return { thread: t.id, harness: t.harness, answer: got.text, tools: toolLines(t, from) }
  },
  text: (r) => `${r.answer || "(no answer)"}${r.tools.length ? `\n\nWhat it did: ${r.tools.join("; ")}.` : ""}\n\n(thread ${r.thread})`,
})

plugin.op({
  id: "agents.list",
  cli: "agents list",
  summary: "Agents' threads on the server's machine, newest first: id, agent, project, title, and whether one is working or waiting.",
  kind: "read",
  owner: "Agents",
  run: () => ({ threads: summaries() }),
  text: (r) => (r.threads.length ? r.threads.map((t: Summary) => `${t.id}  ${NAMES[t.harness]}  ${t.project}  ${t.title}  ${t.updated.slice(0, 16).replace("T", " ")}${t.waiting ? " (waiting for the user)" : t.running ? " (working)" : ""}`).join("\n") : "No threads yet."),
})
