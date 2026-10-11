// Agents: Claude Code and Codex threads, by project, each a chat; the CLIs run on this machine (claude.ts, codex.ts),
// threads are kept in plugin.localDir() (core.ts), never the vault.
import { execFile, execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import type { IncomingMessage } from "node:http"
import path from "node:path"
import type { WebSocket } from "ws"
import { HTTPError, OpError, type Request, Text } from "@vaultite/core/plugins.ts"
import { ClaudeRun, claudeCli, claudeRewindFiles, claudeStatus } from "./claude.ts"
import { branchChanges, branches, checkout, checkpoint, commit, filesOf, prCheckout, prView, createPr, diffOf, dropCheckpoints, dropWorktree, keepCheckpoint, newWorktree, prOf, push as gitPush, restore, stateOf, topOf } from "./git.ts"
import { codexCli, codexFork, CodexRun, codexRevert, codexStatus } from "./codex.ts"
import { branchFor, commitFor, prFor, titleFor } from "./gentext.ts"
import {
  type Any, changed, create, threads, dir, filesOfDiff, forget, home, ID, type Image, listChanged, liveOf, load, MODES, NEW_TITLE, now, onInterrupted, patchFiles, plugin, projects, push, realOf, reset, runs, save, send,
  setLive, snoozed, sockets, waitingIn, str, summaries, thread, tilde, vaultReal,
} from "./core.ts"
import type { Entry, Harness, Mode, Summary, Thread } from "./types.ts"

export { plugin }

const HARNESSES: Harness[] = ["claude", "codex"]
const NAMES: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" }

// (a turn under way is left for the next start: restarting goes on with it)
plugin.onUnload(() => { for (const r of runs.values()) if (r.busy) r.abandon(); else r.end(); reset(); for (const ws of sockets.keys()) ws.close() })

const settings = () => {
  const s = plugin.settings()
  return {
    harness: (HARNESSES.includes(s.harness as Harness) ? s.harness : "claude") as Harness,
    mode: (MODES.includes(s.mode as Mode) ? s.mode : "full") as Mode,
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
      try {
        const t = thread(m.id)
        // (opened: what it finished is read, and a woken snooze is seen)
        if (t.unread || (t.snoozedUntil && !snoozed(t))) { delete t.unread; if (!snoozed(t)) delete t.snoozedUntil; save(t); listChanged() }
        send(ws, { t: "thread", thread: t, live: liveOf(t.id) })
      } catch { send(ws, { t: "gone", id: m.id }) }
    } else if (m?.t === "unwatch" && typeof m.id === "string") ids.delete(m.id)
  })
  ws.on("close", () => sockets.delete(ws))
})

/** The whole thread again to those watching it (after a change that isn't one entry). */
function tellThread(t: Thread) {
  for (const [ws, ids] of sockets) if (ids.has(t.id)) send(ws, { t: "thread", thread: t, live: liveOf(t.id) })
}

// ---------- a message: its entry, then the harness's run for the thread takes it

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }
type Sent = { file?: string; images?: { type: string; data: string }[] }

/** A message's pasted images, saved with the thread: their names (what a queued message keeps). */
function saveImages(t: Thread, list: Sent["images"]) {
  return (list ?? []).filter((im) => IMAGE_TYPES[im.type] && typeof im.data === "string").slice(0, 6).map((im, n) => {
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}-${n}.${IMAGE_TYPES[im.type]}`
    fs.writeFileSync(path.join(dir("images", t.id), name), Buffer.from(im.data, "base64"))
    return name
  })
}
const imagesOf = (t: Thread, names: string[]): Image[] => names.map((name) => {
  const file = path.join(dir("images", t.id), name)
  const ext = name.split(".").pop()!
  return { path: file, type: Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === ext) ?? "image/png", data: fs.readFileSync(file).toString("base64") }
})
const noteOf = (f?: string) => (f && !f.includes("..") ? f : undefined)
const said = (text: string, file?: string) => (file ? `${text}\n\n(The note open beside this chat: ${file}. Read it if it helps.)` : text)

/** A message while it works: into that turn (Claude Code takes it at its next step, Codex by turn/steer). */
function steer(t: Thread, text: string, file: string | undefined, names: string[]) {
  const r = runs.get(t.id)
  if (!r || r.ended || !r.busy) return false
  const at = push(t, { kind: "user", text, at: now(), steer: true, ...(file ? { file } : {}), ...(names.length ? { images: names } : {}) })
  const u = t.entries[at] as Extract<Entry, { kind: "user" }>
  if (!r.send(said(text, file), imagesOf(t, names), u)) { t.entries.splice(at, 1); return false }
  changed(t, at)
  return true
}

/** The next queued message, once a turn has ended. */
function nextQueued(t: Thread) {
  const q = t.queue?.shift()
  if (!q) return
  save(t)
  tellThread(t)
  try { void ask(t, q.text, { file: q.file }, q.images ?? []) } catch (e) { push(t, { kind: "note", text: (e as Error).message, at: now(), error: true }) }
}

/** Whether its session still runs in a terminal it was handed to (`claude --resume <session>`). */
function inTerminal(t: Thread) {
  try { return execFileSync("pgrep", ["-f", t.session], { encoding: "utf8" }).split("\n").some((p) => p && +p !== process.pid) } catch { return false }
}

function ask(t: Thread, text: string, opts: Sent = {}, saved?: string[]): Promise<{ text: string; error: string | null }> {
  if (liveOf(t.id).running) throw new HTTPError(409, `${NAMES[t.harness]} is still answering: stop it first, or wait`)
  if (t.terminal) {
    if (inTerminal(t)) throw new HTTPError(409, `It's open in a terminal: go on there, or quit ${NAMES[t.harness]} there (/exit) to come back here`)
    delete t.terminal
  }
  const cli = t.harness === "claude" ? claudeCli() : codexCli()
  if (!cli) throw new HTTPError(424, `${NAMES[t.harness]} isn't installed on this machine`)
  const names = saved ?? saveImages(t, opts.images)
  const images = imagesOf(t, names)
  const file = noteOf(opts.file)
  const at = push(t, { kind: "user", text, at: now(), ...(file ? { file } : {}), ...(names.length ? { images: names } : {}) })
  // (a new turn brings a settled thread back, ends a manual Un-settle, and wakes a snoozed one)
  for (const k of ["settledOverride", "settledAt", "snoozedUntil", "unread"] as const) delete t[k]
  if (t.title === NEW_TITLE) {
    // Its first words for now; the model's title once it's written (unless it was renamed meanwhile).
    const words = text.replace(/[@#*_`[\]]/g, "").trim().split(/\s+/).filter(Boolean)
    const first = t.title = words.slice(0, 7).join(" ").slice(0, 60) + (words.length > 7 ? "…" : "") || NEW_TITLE
    if (text.trim()) void titleFor(t.harness, text).then((title) => {
      if (!title || t.title !== first || !threads.has(t.id)) return
      t.title = title
      save(t)
      listChanged()
      tellThread(t)
    })
  }
  setLive(t, { running: true, status: t.worktree?.pending ? "preparing" : "thinking" })
  return new Promise((resolve) => {
    const turn = async () => {
      // A thread that asked for its own worktree gets it now, named after what it was asked.
      if (t.worktree?.pending) {
        try {
          // (its branch named by the model from the message, as T3 Code does; the title when that fails or is slow)
          const name = await Promise.race([branchFor(t.harness, t.worktree.from, text), new Promise<null>((r) => setTimeout(() => r(null), 20_000).unref())])
          const w = await newWorktree(t.worktree.from, name ?? t.title, t.worktree.base)
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
      // (Claude Code takes its effort as it starts: a change starts it again, the session going on)
      if (r && (r.ended || r.cwd !== t.cwd || (r instanceof ClaudeRun && r.effort !== (t.effort ?? "")))) { r.end(); r = undefined }
      if (r instanceof ClaudeRun) r.configure(t)
      if (!r) { r = t.harness === "claude" ? new ClaudeRun(t, cli) : new CodexRun(t); runs.set(t.id, r) }
      setLive(t, { status: "thinking" })
      r.turns.push({ done: (x, error) => { void mark(t, at, "after").finally(() => { resolve({ text: x, error })
        // (a turn that failed or was stopped leaves the queue for the user to look at)
        if (!error && !t.entries.slice(at).some((e) => e.kind === "note" && e.text === "Stopped.")) nextQueued(t)
      }) } })
      if (!r.send(said(text, file), images, t.entries[at] as Extract<Entry, { kind: "user" }>)) { r.failed(`${NAMES[t.harness]} couldn't take the message.`); r.endTurn("", "failed") }
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
  if (b.plan === true) t.plan = true
  if (str(b.effort)) t.effort = str(b.effort)
  // (New thread on a branch: in the same worktree as the thread it came from, under the same project)
  const like = str(b.share) ? threads.get(str(b.share)) : undefined
  if (like?.worktree && !like.worktree.pending) { t.worktree = { ...like.worktree }; t.cwd = like.cwd; save(t, false) }
  else if (b.worktree === true) {
    if (!(await topOf(cwd))) { forget(t); throw new HTTPError(400, "a worktree needs a git checkout") }
    t.worktree = { top: "", branch: "", from: cwd, base: str(b.base), pending: true }
    save(t, false)
  } else if (str(b.branch)) {
    try { await checkout(cwd, str(b.branch), b.create === true) } catch (e) { forget(t); throw new HTTPError(409, `couldn't switch to ${str(b.branch)}: ${(e as Error).message}`) }
  }
  save(t, false)
  return { id: t.id }
})

/** Checkout Pull Request: a pull request (its number, URL or `gh pr checkout` command) into a new thread, on the
 *  project's checkout (`mode` local) or in a worktree of its own. */
plugin.route("POST", "agents/pr", async (req) => {
  await owner(req)
  const b = (req.body ?? {}) as Any
  const cwd = folder(b.cwd)
  const ref = str(b.ref).trim().replace(/^gh\s+pr\s+checkout\s+/, "").replace(/^#/, "")
  if (!ref) throw new HTTPError(400, "give a pull request: its number, URL or checkout command")
  const s = settings()
  let w: Awaited<ReturnType<typeof prCheckout>>, pr: Awaited<ReturnType<typeof prView>>
  try {
    pr = await prView(cwd, ref)
    w = await prCheckout(cwd, pr, b.mode === "worktree")
  } catch (e) { throw new HTTPError(409, (e as Error).message) }
  const harness: Harness = HARNESSES.includes(b.harness) ? b.harness : s.harness
  const t = create(harness, w.path, s.model[harness], s.mode)
  t.title = `#${pr.number} ${pr.title}`.slice(0, 120)
  t.pr = { number: pr.number, url: pr.url, state: pr.state }
  if (b.mode === "worktree") t.worktree = { top: w.top, branch: w.branch, from: (await topOf(cwd)) ?? cwd, pr: pr.number }
  save(t, false)
  listChanged()
  return { id: t.id, number: pr.number, branch: w.branch }
}, { lock: false })

plugin.route("GET", "agents/threads/*", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  return { thread: t, live: liveOf(t.id) }
})

/** A thread's place in the list, T3 Code's way: pinned on top, snoozed until a time, archived out of the list, read
 *  or marked unread, settling by itself or not. Each key given is set (null or false clears it). */
plugin.route("POST", "agents/threads/*/state", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const at = now()
  if (b.pinned !== undefined) {
    if (b.pinned) { t.pinnedAt = t.pinnedAt ?? at; if (t.settledOverride === "settled") { t.settledOverride = "active"; delete t.settledAt } }
    else delete t.pinnedAt
  }
  if (b.snoozedUntil !== undefined) {
    if (b.snoozedUntil && Number.isFinite(Date.parse(str(b.snoozedUntil)))) t.snoozedUntil = new Date(str(b.snoozedUntil)).toISOString()
    else delete t.snoozedUntil
  }
  if (b.archived !== undefined) {
    if (b.archived && liveOf(t.id).running) throw new HTTPError(409, "stop it first")
    if (b.archived) t.archivedAt = at
    else delete t.archivedAt
  }
  if (b.unread !== undefined) { if (b.unread) t.unread = true; else delete t.unread }
  if (b.autoSettle !== undefined) { if (b.autoSettle === false) t.autoSettleOff = true; else delete t.autoSettleOff }
  save(t)
  listChanged()
  tellThread(t)
  return { ok: true }
}, { lock: false })

/** Its title again, written by the model from the whole thread (Regenerate title). */
plugin.route("POST", "agents/threads/*/title", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const said = t.entries.filter((e) => e.kind === "user" || e.kind === "assistant").map((e) => `${e.kind === "user" ? "USER" : "ASSISTANT"}: ${(e as { text: string }).text}`).join("\n\n")
  if (!said) throw new HTTPError(409, "nothing to title yet")
  const title = await titleFor(t.harness, said, t.title)
  if (!title) throw new HTTPError(502, `${NAMES[t.harness]} couldn't write a title`)
  t.title = title
  save(t)
  listChanged()
  tellThread(t)
  return { title }
}, { lock: false })

/** Settle a thread (done with it: it goes to Settled), or unsettle it (back, and kept out of settling by itself). */
plugin.route("POST", "agents/threads/*/settle", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  // (T3 Code's: nothing may be waiting on it when it's settled)
  if ((req.body as Any)?.settled !== false) {
    if (waitingIn(t)) throw new HTTPError(409, `Thread ${t.id} is waiting on an approval or question. Answer it before settling.`)
    if (liveOf(t.id).running) throw new HTTPError(409, `Thread ${t.id} is still running. Stop it before settling.`)
    if (t.queue?.length) throw new HTTPError(409, `Thread ${t.id} has a queued message. Send it or remove it from the queue before settling.`)
  }
  if ((req.body as Any)?.settled === false) { t.settledOverride = "active"; delete t.settledAt }
  // (settling is "done with it": it unpins too)
  else { if (t.settledOverride !== "settled") t.settledAt = now(); t.settledOverride = "settled"; delete t.pinnedAt }
  save(t)
  listChanged()
  tellThread(t)
  return { ok: true, settledOverride: t.settledOverride }
}, { lock: false })

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
  if (b.plan !== undefined) t.plan = b.plan === true
  if (b.effort !== undefined) { if (str(b.effort)) t.effort = str(b.effort); else delete t.effort }
  // (Claude Code switches its mode and model as it runs; Codex takes them with its next turn)
  const r = runs.get(t.id)
  if (r instanceof ClaudeRun && !r.ended) r.configure(t)
  save(t)
  listChanged()
  tellThread(t)
  return { id: t.id, title: t.title, model: t.model, mode: t.mode, plan: !!t.plan }
})

plugin.route("DELETE", "agents/threads/*", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  runs.get(t.id)?.end()
  runs.delete(t.id)
  forget(t)
  await dropCheckpoints(t.cwd, t.id).catch(() => {})
  // Its worktree goes too when nothing in it is left uncommitted (its branch stays), and no fork of it works there.
  const shared = !!t.worktree?.top && [...threads.values()].some((x) => x.worktree?.top === t.worktree!.top)
  const kept = t.worktree?.top && !shared ? !(await dropWorktree(t.worktree.top).catch(() => false)) : false
  return { ok: true, ...(kept ? { kept: t.worktree!.top } : {}) }
})

// ---------- git: the thread's branch, its turns' diffs, commit, push and a pull request

/** The checkout's state for a thread, its pull request with it when asked (`pr=1`: gh is slow). */
plugin.route("GET", "agents/threads/*/git", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  if (t.worktree?.pending) return { git: null, pending: true }
  const st = await stateOf(t.cwd, !!t.worktree)
  if (st && req.query.pr && st.gh && st.remote && st.branch) {
    st.pr = await prOf(t.cwd)
    // (kept: a merged or closed pull request settles the thread)
    const pr = st.pr ? { number: st.pr.number, url: st.pr.url, state: st.pr.state, ...(st.pr.at ? { at: st.pr.at } : {}) } : undefined
    if (JSON.stringify(pr) !== JSON.stringify(t.pr)) { if (pr) t.pr = pr; else delete t.pr; save(t); listChanged() }
  }
  return { git: st }
})

/** A project's files (a git checkout's), for @ to point the agent at one. */
plugin.route("GET", "agents/files", async (req) => {
  await owner(req)
  return { list: await filesOf(folder(req.query.cwd)) }
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

/** "Edit from here": back to before message `turn`, the conversation (the agent forgets it and what came after) and the
 *  files (git's checkpoint, else Claude Code's own). Answers the message, to be edited and sent again. */
plugin.route("POST", "agents/threads/*/rewind", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  if (liveOf(t.id).running) throw new HTTPError(409, "stop it first")
  let n = Number((req.body as Any)?.turn)
  let u = t.entries[n]
  if (u?.kind !== "user") throw new HTTPError(404, "no such message")
  // (Codex forgets whole turns: a message sent into one goes back to that turn's start)
  if (t.harness === "codex" && u.steer) { n = t.entries.findLastIndex((e, i) => i < n && e.kind === "user" && !e.steer); u = t.entries[n] as typeof u }
  const first = !t.entries.slice(0, n).some((e) => e.kind === "user")
  if (t.started && !first && (t.harness === "claude" ? !u.prev : !u.turn)) throw new HTTPError(409, "this message is from before Agents could go back to one: fork the thread instead")
  runs.get(t.id)?.end()
  runs.delete(t.id)
  let files = 0, fileNote = ""
  try {
    if ((req.body as Any)?.files === false) { /* (Revert and keep changes) */ }
    else if (u.before && (await topOf(t.cwd))) files = await restore(t.cwd, u.before)
    else if (t.harness === "claude" && u.uuid) {
      const r = await claudeRewindFiles(t, claudeCli() ?? "", u.uuid)
      files = r.files
      if (r.error) fileNote = r.error
    }
  } catch (e) { fileNote = (e as Error).message }
  if (t.started) {
    if (first) {
      // (back to the start: a new conversation)
      t.started = false
      t.session = t.harness === "claude" ? crypto.randomUUID() : ""
      delete t.resumeAt
      delete t.chain
    } else if (t.harness === "claude") { t.resumeAt = u.prev; t.chain = u.prev }
    else await codexRevert(t, u.turn!).catch((e) => { throw new HTTPError(502, `Codex couldn't go back: ${(e as Error).message}`) })
  }
  t.entries = t.entries.slice(0, n)
  save(t)
  tellThread(t)
  listChanged()
  return { text: u.text, ...(u.file ? { file: u.file } : {}), files, ...(fileNote ? { fileNote } : {}) }
}, { lock: false })

/** Implement a plan (entry `at`): here, out of plan mode, or in a new thread on the same project (T3 Code's
 *  "PLEASE IMPLEMENT THIS PLAN"). */
plugin.route("POST", "agents/threads/*/implement", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const e = t.entries[Number(b.at)]
  if (e?.kind !== "plan") throw new HTTPError(404, "no such plan")
  const prompt = `PLEASE IMPLEMENT THIS PLAN:\n${e.text.trim()}`
  const title = /^#{1,3}\s+(.+)$/m.exec(e.text)?.[1]?.replace(/[*_`]/g, "").trim()
  let to = t
  if (b.where === "thread") {
    to = create(t.harness, t.worktree?.from ?? t.cwd, t.model, t.mode)
    to.title = title ? `Implement ${title}` : "Implement plan"
    save(to, false)
  } else { t.plan = false; runs.get(t.id) instanceof ClaudeRun && (runs.get(t.id) as ClaudeRun).configure(t) }
  e.done = b.where === "thread" ? "thread" : "here"
  changed(t, Number(b.at))
  save(t)
  tellThread(t)
  void ask(to, prompt)
  return { id: to.id }
}, { lock: false })

/** A plan saved as a file in the thread's folder (Save to workspace). */
plugin.route("POST", "agents/threads/*/plan", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const e = t.entries[Number(b.at)]
  if (e?.kind !== "plan") throw new HTTPError(404, "no such plan")
  const rel = str(b.path).trim()
  const abs = path.resolve(t.cwd, rel)
  if (!rel || !abs.startsWith(t.cwd + "/")) throw new HTTPError(400, "a path inside the thread's folder")
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${e.text.trimEnd()}\n`)
  return { path: rel }
}, { lock: false })

/** A new thread with this one's conversation up to the end of the turn entry `at` is in (forked from an answer). */
plugin.route("POST", "agents/threads/*/fork", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const at = Number((req.body as Any)?.at)
  if (!(at >= 0 && at < t.entries.length)) throw new HTTPError(404, "no such message")
  const next = t.entries.findIndex((e, i) => i > at && e.kind === "user" && !e.steer)
  const end = next < 0 ? t.entries.length : next
  if (end === t.entries.length && liveOf(t.id).running) throw new HTTPError(409, "wait for this turn to end, or stop it")
  const kept = structuredClone(t.entries.slice(0, end))
  const f = create(t.harness, t.cwd, t.model, t.mode)
  f.title = `${t.title} fork`.slice(0, 120)
  if (t.worktree && !t.worktree.pending) f.worktree = { ...t.worktree }
  try {
    if (t.harness === "claude") {
      const last = kept.findLast((e) => (e as { uuid?: string }).uuid && e.kind !== "user") as { uuid?: string } | undefined
      if (!t.started || !last?.uuid) throw new HTTPError(409, "this answer is from before Agents could fork from one")
      f.fork = { from: t.session, at: last.uuid }
      f.chain = last.uuid
    } else {
      const turn = (kept.findLast((e) => e.kind === "user" && e.turn) as { turn?: string } | undefined)?.turn
      if (!t.started || !turn) throw new HTTPError(409, "this answer is from before Agents could fork from one")
      f.session = await codexFork(t, turn, f)
      f.started = true
    }
  } catch (e) { forget(f); throw e instanceof HTTPError ? e : new HTTPError(502, (e as Error).message) }
  for (const e of kept) if (e.kind === "ask" && !e.answer) e.answer = "gone"
  f.entries = kept
  // (its turns' checkpoints kept under its own name, so its diffs outlive this thread)
  for (const [i, e] of kept.entries()) if (e.kind === "user") for (const w of ["before", "after"] as const) if (e[w]) await keepCheckpoint(f.cwd, `${f.id}/${i}-${w === "before" ? "a" : "b"}`, e[w]!).catch(() => {})
  save(f, false)
  listChanged()
  return { id: f.id }
}, { lock: false })

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
  const out: { commit?: string; pushed?: boolean; pr?: string; branch?: string } = {}
  try {
    if (action === "switch") {
      if (t.worktree) throw new Error("a worktree thread keeps its own branch")
      await checkout(t.cwd, str(b.branch), b.create === true)
      out.branch = str(b.branch)
    }
    if (action === "commit" || action === "commit-push" || action === "commit-push-pr") {
      const st = await stateOf(t.cwd)
      if (st?.files) {
        // (no message given: the model writes one from the changes, else the thread's title)
        let message = str(b.message).trim()
        if (!message) {
          const files = filesOfDiff(await diffOf(t.cwd, "HEAD", "").catch(() => ""))
          const patch = await diffOf(t.cwd, "HEAD", "").catch(() => "")
          message = (await commitFor(t.harness, t.cwd, st.branch, files.map((f) => `${f.status} ${f.path} (+${f.added} -${f.removed})`).join("\n"), patch)) ?? t.title
        }
        out.commit = await commit(t.cwd, message)
      } else if (action === "commit") throw new Error("nothing to commit")
    }
    if (action === "push" || action === "commit-push" || action === "commit-push-pr") { await gitPush(t.cwd); out.pushed = true }
    if (action === "pr" || action === "commit-push-pr") {
      let title = str(b.title).trim(), body = str(b.body)
      if (!title) {
        const st = await stateOf(t.cwd)
        const c = await branchChanges(t.cwd, st?.base ?? "")
        const got = await prFor(t.harness, t.cwd, st?.base ?? "", st?.branch ?? "", c.commits, c.stat, c.patch)
        title = got?.title ?? t.title
        body = body || got?.body || ""
      }
      out.pr = await createPr(t.cwd, title, body)
    }
    if (!Object.keys(out).length) throw new Error(`no action '${action}'`)
  } catch (e) { throw new HTTPError(409, (e as Error).message) }
  const what = [out.branch && `switched to ${out.branch}`, out.commit && `committed ${out.commit}`, out.pushed && "pushed", out.pr && `opened ${out.pr}`].filter(Boolean).join(", ")
  push(t, { kind: "note", text: `Git: ${what}.`, at: now() })
  return out
}, { lock: false })

plugin.route("POST", "agents/threads/*/send", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const text = str(b.text).trim()
  if (!text && !b.images?.length) throw new HTTPError(400, "write a message first")
  const images = Array.isArray(b.images) ? b.images : []
  // While it works: queued for when the turn ends, or straight into it (steer).
  if (liveOf(t.id).running) {
    const names = saveImages(t, images), file = noteOf(str(b.file))
    if (b.steer === true && steer(t, text, file, names)) return { ok: true, steered: true }
    const q = { id: crypto.randomBytes(4).toString("hex"), text, at: now(), ...(file ? { file } : {}), ...(names.length ? { images: names } : {}) }
    t.queue = [...t.queue ?? [], q]
    save(t)
    tellThread(t)
    return { ok: true, queued: q.id }
  }
  void ask(t, text, { file: str(b.file) || undefined, images })
  return { ok: true }
}, { lock: false })

/** A queued message: removed, moved (`to`: its new place), or sent into the turn under way (`steer`). */
plugin.route("POST", "agents/threads/*/queue/*", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  const b = (req.body ?? {}) as Any
  const i = (t.queue ?? []).findIndex((q) => q.id === req.arg(1))
  if (i < 0) throw new HTTPError(404, "that message isn't queued any more")
  const [q] = t.queue!.splice(i, 1)
  if (b.action === "move") t.queue!.splice(Math.max(0, Math.min(Number(b.to) || 0, t.queue!.length)), 0, q)
  else if (b.action === "steer" && !liveOf(t.id).running) {
    // (nothing under way, as after a stop: it's sent now, a turn of its own)
    if (!t.queue!.length) delete t.queue
    save(t)
    tellThread(t)
    void ask(t, q.text, { file: q.file }, q.images ?? [])
    return { ok: true, sent: true }
  } else if (b.action === "steer") {
    if (!steer(t, q.text, q.file, q.images ?? [])) { t.queue!.splice(i, 0, q); throw new HTTPError(409, "There is no active run to steer") }
  } else if (b.action !== "remove") { t.queue!.splice(i, 0, q); throw new HTTPError(400, "action is remove, move or steer") }
  if (!t.queue!.length) delete t.queue
  save(t)
  tellThread(t)
  // (removed with nothing running: its images go too, unless a message uses them)
  if (b.action === "remove") for (const im of q.images ?? []) fs.rmSync(path.join(dir("images", t.id), im), { force: true })
  return { ok: true, ...(b.action === "remove" ? { text: q.text, file: q.file } : {}) }
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
  const answers = b.answers && typeof b.answers === "object" ? Object.fromEntries(Object.entries(b.answers as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, (v as string).trim()])) : undefined
  const scope = b.scope === "session" || b.scope === "cancel" ? b.scope : undefined
  if (!r || !r.settle(str(b.ask), b.allow === true ? "allow" : "deny", answers, scope)) throw new HTTPError(409, "that question isn't waiting any more")
  return { ok: true }
}, { lock: false })

/** Hand the session to a terminal: this thread's run ends first, so the two never write one session at once; a turn
 *  under way stops here and goes on there (`prompt`). */
plugin.route("POST", "agents/threads/*/handoff", async (req) => {
  await owner(req)
  const t = thread(req.arg(0))
  if (!t.started) throw new HTTPError(409, "nothing to resume yet: send a message first")
  const r = runs.get(t.id)
  const busy = !!r?.busy
  if (r) { r.stop(); await r.closed() }
  runs.delete(t.id)
  t.terminal = now()
  push(t, { kind: "note", text: busy ? "Went on in a terminal." : "Opened in a terminal.", at: now() })
  return { harness: t.harness, session: t.session, prompt: busy ? "You were moved from the app's Agents panel to this terminal in the middle of your last turn: carry on where you left off." : "" }
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
    mode: { type: "string", enum: MODES, description: "a new thread's access: ask (supervised), edits, auto or full; the plugin's setting (full) when left out" },
    plan: { type: "boolean", description: "a new thread in plan mode: it reads and proposes a plan, changing nothing" },
    timeout: { type: "integer", minimum: 10, maximum: 3600, default: 600, description: "seconds to wait for the answer" },
  },
  args: ["message"],
  run: async (p) => {
    let t: Thread
    const s = settings()
    try {
      if (p.thread) t = thread(p.thread)
      else { const h: Harness = p.harness ?? s.harness; t = create(h, folder(p.cwd), p.model ?? s.model[h], p.mode ?? s.mode); if (p.plan) t.plan = true }
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

// ---------- a turn the server went down in (a restart, an update): its process ends if it outlived it, and it goes on

/** Process `pid`, while it's still that CLI, ends (at most 5 s). */
async function ended(pid: number, harness: Harness) {
  const cmd = await new Promise<string>((r) => execFile("ps", ["-p", String(pid), "-o", "command="], (e, out) => r(e ? "" : String(out))))
  if (!cmd.includes(harness)) return
  try { process.kill(pid, "SIGTERM") } catch { return }
  for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 100)); try { process.kill(pid, 0) } catch { return } }
  try { process.kill(pid, "SIGKILL") } catch { /* gone */ }
}

async function takeUp(list: Thread[]) {
  for (const t of list) {
    if (!t.running || threads.get(t.id) !== t) continue
    const { pid } = t.running
    delete t.running
    await ended(pid, t.harness)
    // (one from long ago isn't started again by surprise)
    const recent = Date.now() - Date.parse(t.updated) < 3_600_000
    push(t, { kind: "note", text: recent ? "The app restarted mid-turn: going on." : "The app restarted mid-turn.", at: now() })
    if (recent) try { void ask(t, "The app restarted in the middle of your last turn and stopped it: carry on where you left off.") } catch (e) { push(t, { kind: "note", text: (e as Error).message, at: now(), error: true }) }
  }
}
onInterrupted((list) => void takeUp(list))
setTimeout(load, 0)
