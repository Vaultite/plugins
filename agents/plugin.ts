// Agents: Claude Code and Codex threads, by project, each a chat; the CLIs run on this machine (claude.ts, codex.ts),
// threads are kept in plugin.localDir() (core.ts), never the vault.
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import path from "node:path"
import type { WebSocket } from "ws"
import { HTTPError, OpError, type Request, Text } from "@vaultite/core/plugins.ts"
import { ClaudeRun, claudeCli, claudeStatus } from "./claude.ts"
import { branches, checkout, checkpoint, commit, createPr, diffOf, dropCheckpoints, dropWorktree, newWorktree, prOf, push as gitPush, restore, stateOf, topOf } from "./git.ts"
import { codexCli, CodexRun, codexStatus } from "./codex.ts"
import {
  type Any, changed, create, dir, filesOfDiff, forget, home, ID, type Image, listChanged, liveOf, load, MODES, NEW_TITLE, now, patchFiles, plugin, projects, push, realOf, runs, save, send,
  setLive, sockets, str, summaries, thread, tilde, vaultReal,
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
  const at = push(t, { kind: "user", text, at: now(), ...(file ? { file } : {}), ...(images.length ? { images: images.map((im) => path.basename(im.path)) } : {}) })
  if (t.title === NEW_TITLE) {
    const words = text.replace(/[@#*_`[\]]/g, "").trim().split(/\s+/).filter(Boolean)
    t.title = words.slice(0, 7).join(" ").slice(0, 60) + (words.length > 7 ? "…" : "") || NEW_TITLE
  }
  setLive(t, { running: true, status: t.worktree?.pending ? "preparing" : "thinking" })
  return new Promise((resolve) => {
    const turn = async () => {
      // A thread that asked for its own worktree gets it now, named after what it was asked.
      if (t.worktree?.pending) {
        try {
          const w = await newWorktree(t.worktree.from, t.title, t.worktree.base)
          t.worktree = { top: w.top, branch: w.branch, from: t.worktree.from }
          t.cwd = w.path
          save(t)
          listChanged()
        } catch (e) {
          push(t, { kind: "note", text: `Couldn't make a worktree (${(e as Error).message}): it works in ${tilde(t.worktree.from)} instead.`, at: now(), error: true })
          t.cwd = t.worktree.from
          delete t.worktree
          save(t)
        }
      }
      await mark(t, at, "before")
      let r = runs.get(t.id)
      // Claude takes its model and mode as it starts: a change starts it again (the session goes on). Codex takes them per turn.
      if (r && (r.ended || r.cwd !== t.cwd || (t.harness === "claude" && (r.model !== t.model || r.mode !== t.mode)))) { r.end(); r = undefined }
      if (!r) { r = t.harness === "claude" ? new ClaudeRun(t, cli) : new CodexRun(t); runs.set(t.id, r) }
      const said = file ? `${text}\n\n(The note open beside this chat: ${file}. Read it if it helps.)` : text
      setLive(t, { status: "thinking" })
      r.turns.push({ done: (x, error) => { void mark(t, at, "after").finally(() => resolve({ text: x, error })) } })
      if (!r.send(said, images)) { r.failed(`${NAMES[t.harness]} couldn't take the message.`); r.endTurn("", "failed") }
    }
    turn().catch((e) => {
      push(t, { kind: "note", text: (e as Error).message, at: now(), error: true })
      const u = t.entries[at]
      if (u?.kind === "user" && !u.end) { u.end = now(); changed(t, at) }
      setLive(t, { running: false, status: "" })
      resolve({ text: "", error: "failed" })
    })
  })
}

/** The folder's checkpoint before or after the turn that entry `at` began (git checkouts only). */
async function mark(t: Thread, at: number, which: "before" | "after") {
  const e = t.entries[at]
  if (e?.kind !== "user") return
  const tree = await checkpoint(t.cwd, `${t.id}/${at}-${which === "before" ? "a" : "b"}`).catch(() => "")
  if (tree) e[which] = tree
  // What the turn changed, kept for its card: git's between the checkpoints, else its edits'.
  if (which === "after") {
    const next = t.entries.findIndex((x, i) => i > at && x.kind === "user")
    const files = e.before && e.after ? filesOfDiff(await diffOf(t.cwd, e.before, e.after).catch(() => ""), (await topOf(t.cwd)) ?? t.cwd) : patchFiles(t, at, next < 0 ? t.entries.length : next)
    e.changes = files.map(({ path: p, file, added, removed, status }) => ({ path: p, ...(file ? { file } : {}), added, removed, status }))
  }
  changed(t, at)
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
  const cwd = folder(b.cwd)
  const t = create(harness, cwd, typeof b.model === "string" ? b.model.trim() : s.model[harness], mode)
  if (b.worktree === true) {
    if (!(await topOf(cwd))) { forget(t); throw new HTTPError(400, "a worktree needs a git checkout") }
    t.worktree = { top: "", branch: "", from: cwd, base: str(b.base), pending: true }
    save(t, false)
  } else if (str(b.branch)) {
    try { await checkout(cwd, str(b.branch)) } catch (e) { forget(t); throw new HTTPError(409, `couldn't switch to ${str(b.branch)}: ${(e as Error).message}`) }
  }
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
  await dropCheckpoints(t.cwd, t.id).catch(() => {})
  // Its worktree goes too when nothing in it is left uncommitted (its branch stays).
  const kept = t.worktree?.top ? !(await dropWorktree(t.worktree.top).catch(() => false)) : false
  return { ok: true, ...(kept ? { kept: t.worktree!.top } : {}) }
})

// ---------- git: the thread's branch, its turns' diffs, commit, push and a pull request

/** The checkout's state for a thread, its pull request with it when asked (`pr=1`: gh is slow). */
plugin.route("GET", "agents/threads/*/git", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  if (t.worktree?.pending) return { git: null, pending: true }
  const st = await stateOf(t.cwd, !!t.worktree)
  if (st && req.query.pr && st.gh && st.remote && st.branch) st.pr = await prOf(t.cwd)
  return { git: st }
})

plugin.route("GET", "agents/branches", async (req) => {
  await owner(req)
  const cwd = folder(req.query.cwd)
  const top = await topOf(cwd)
  if (!top) return { git: false, list: [] }
  return { git: true, list: await branches(cwd) }
})

/** A turn's diff (`turn`: its user entry's index), or the whole thread's (none): git's between checkpoints, else what
 *  its edits' patches say (a folder that isn't a checkout). */
plugin.route("GET", "agents/threads/*/diff", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const turns = t.entries.map((e, i) => ({ e, i })).filter((x) => x.e.kind === "user") as { e: Extract<Entry, { kind: "user" }>; i: number }[]
  if (req.query.scope === "uncommitted") {
    const top = await topOf(t.cwd)
    if (!top) throw new HTTPError(409, "not a git checkout")
    return { source: "git", files: filesOfDiff(await diffOf(t.cwd, "HEAD", ""), top) }
  }
  const n = req.query.turn === undefined || req.query.turn === "" ? -1 : Number(req.query.turn)
  const pick = n >= 0 ? turns.filter((x) => x.i === n) : turns
  if (n >= 0 && !pick.length) throw new HTTPError(404, "no such turn")
  const first = pick.find((x) => x.e.before)
  const top = await topOf(t.cwd)
  if (top && first) {
    const last = pick.at(-1)!
    const live = liveOf(t.id).running && last === turns.at(-1)
    const diff = await diffOf(t.cwd, first.e.before!, live ? "" : last.e.after ?? "")
    return { source: "git", files: filesOfDiff(diff, top) }
  }
  const from = pick[0]?.i ?? 0, to = n >= 0 ? (turns.find((x) => x.i > n)?.i ?? t.entries.length) : t.entries.length
  return { source: "edits", files: patchFiles(t, from, to) }
})

/** Put the folder's files back as they were before turn `turn`. */
plugin.route("POST", "agents/threads/*/revert", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  if (liveOf(t.id).running) throw new HTTPError(409, "stop it first")
  const n = Number((req.body as Any)?.turn)
  const e = t.entries[n]
  if (e?.kind !== "user" || !e.before) throw new HTTPError(409, "that turn has no checkpoint to go back to")
  const count = await restore(t.cwd, e.before)
  const turn = t.entries.slice(0, n + 1).filter((x) => x.kind === "user").length
  push(t, { kind: "note", text: `Files put back as they were before turn ${turn} (${count === 1 ? "1 file" : `${count} files`}). ${NAMES[t.harness]} wasn't told: say so if it should know.`, at: now() })
  return { ok: true, files: count }
}, { lock: false })

plugin.route("POST", "agents/threads/*/git", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const action = str(b.action)
  if (liveOf(t.id).running && action !== "pr") throw new HTTPError(409, `${NAMES[t.harness]} is still working: wait, or stop it first`)
  const out: { commit?: string; pushed?: boolean; pr?: string } = {}
  try {
    if (action === "commit" || action === "commit-push" || action === "commit-push-pr") {
      const st = await stateOf(t.cwd)
      if (st?.files) out.commit = await commit(t.cwd, str(b.message) || t.title)
      else if (action === "commit") throw new Error("nothing to commit")
    }
    if (action === "push" || action === "commit-push" || action === "commit-push-pr") { await gitPush(t.cwd); out.pushed = true }
    if (action === "pr" || action === "commit-push-pr") out.pr = await createPr(t.cwd, str(b.title) || t.title, str(b.body))
    if (!Object.keys(out).length) throw new Error(`no action '${action}'`)
  } catch (e) { throw new HTTPError(409, (e as Error).message) }
  const what = [out.commit && `committed ${out.commit}`, out.pushed && "pushed", out.pr && `opened ${out.pr}`].filter(Boolean).join(", ")
  push(t, { kind: "note", text: `Git: ${what}.`, at: now() })
  return out
}, { lock: false })

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
