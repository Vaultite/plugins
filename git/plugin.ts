// Git: the vault's folder as a git repository, run with the user's git on the server's machine (git.ts). Ops are the
// API (the app's panel uses them too); one machine commits and syncs on a timer or after editing stops.
import fs from "node:fs"
import path from "node:path"
import { HTTPError, OpError, Plugin, Text } from "@vaultite/core/plugins.ts"
import {
  autoDue, cloudOf, cloudWarning, commit, type Committed, fileLog, type Git, GITIGNORE, GitError, gitBinary, lastCommit, log, merging, must, redact,
  remotes, type Repo, repoOf, runner, show, status, sync, type SyncResult, commitMessage,
} from "./git.ts"

export const plugin = new Plugin(import.meta.url)

type Settings = { autoInterval: number; autoIdle: number; message: string; dateFormat: string; push: boolean; stageAll: boolean
  machine: string; authorName: string; authorEmail: string }
const DEFAULTS: Settings = { autoInterval: 0, autoIdle: 0, message: "vault backup: {{date}}", dateFormat: "YYYY-MM-DD HH:mm:ss", push: true,
  stageAll: true, machine: "", authorName: "", authorEmail: "" }
function settings(): Settings {
  const s = plugin.settings({})
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d)
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d)
  return { autoInterval: num(s.autoInterval, 0), autoIdle: num(s.autoIdle, 0), message: str(s.message, DEFAULTS.message) || DEFAULTS.message,
    dateFormat: str(s.dateFormat, DEFAULTS.dateFormat) || DEFAULTS.dateFormat, push: s.push !== false, stageAll: s.stageAll !== false,
    machine: str(s.machine, "").trim(), authorName: str(s.authorName, "").trim(), authorEmail: str(s.authorEmail, "").trim() }
}

// ---------- running git

let bin: string | null | undefined
const gitPath = () => (bin === undefined ? (bin = gitBinary()) : bin)

/** A token for HTTPS remotes, kept in this machine's config (plugin.secrets()), handed to git by an askpass helper. */
function tokenEnv(): Record<string, string> {
  const s = plugin.secrets()[plugin.id] ?? {}
  if (typeof s.token !== "string" || !s.token) return {}
  const helper = path.join(plugin.localDir(), "askpass.cjs")
  const code = `#!${process.execPath}\nconst q = process.argv[2] || ""\nprocess.stdout.write((/^username/i.test(q) ? process.env.VAULTITE_GIT_USER || "git" : process.env.VAULTITE_GIT_TOKEN || "") + "\\n")\n`
  try { if (fs.readFileSync(helper, "utf8") !== code) throw new Error("changed") } catch { fs.writeFileSync(helper, code, { mode: 0o700 }) }
  return { GIT_ASKPASS: helper, VAULTITE_GIT_TOKEN: s.token, VAULTITE_GIT_USER: typeof s.user === "string" && s.user ? s.user : "git" }
}

function gitHere(): Git {
  const b = gitPath()
  if (!b) throw new OpError("git isn't installed on the server's machine (on a Mac: xcode-select --install, or brew install git)")
  return runner(plugin.vault.path, b, tokenEnv())
}

async function repoHere(git: Git): Promise<Repo> {
  const repo = await repoOf(git)
  if (!repo) throw new OpError("The vault isn't a git repository yet: git.init makes it one (the Source control panel offers it)", 409)
  return repo
}

/** One change to the repository at a time (the timer's and the panel's), with what it's doing for the panel. */
let queue: Promise<unknown> = Promise.resolve()
let busy: string | null = null
function exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => { busy = what; try { return await fn() } finally { busy = null } })
  queue = run.catch(() => {})
  return run
}
const asOp = async <T>(fn: () => Promise<T>) => {
  try { return await fn() } catch (e) { throw e instanceof GitError ? new OpError(e.message) : e }
}

// ---------- what's kept on this machine: the last sync, for the panel and the timer

type Last = { t: number; ok: boolean; auto?: boolean; error?: string; summary?: string }
const stateFile = () => path.join(plugin.localDir(), "state.json")
function readState(): { lastSync?: Last; lastAuto?: number } {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) } catch { return {} }
}
function saveState(patch: { lastSync?: Last; lastAuto?: number }) {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch })) } catch { /* disposable */ }
}

// ---------- telling the user (the Inbox, else a toast in their window)

async function tell(key: string, title: string, body: string, error = true) {
  const ev = await plugin.ask<unknown>("inbox:event", null, { source: "git", kind: error ? "error" : "info", title, body, link: "view:git", key })
  if (ev === null) await plugin.runOp("notify", { text: `${title}: ${body}`, error, actionOpen: "view:git" }).catch(() => {})
}
const untell = (key: string) => plugin.ask("inbox:drop", null, "git", key)

// ---------- the repository's state, for the panel, the status bar and git.status

export type Snapshot = Awaited<ReturnType<typeof snapshot>>
/** The files in conflict, as last seen: in /api/state for the file tree's marks (asking git on every state is too
 *  much), and in the cache, whose change has the app ask for the state again. */
let conflicted: string[] | null = null
const conflictsNow = () => (conflicted ??= (plugin.readCache({})?.conflicts as string[] | undefined) ?? [])
function setConflicts(list: string[]) {
  if (JSON.stringify(list) === JSON.stringify(conflictsNow())) return
  conflicted = list
  plugin.writeCache({ conflicts: list })
}
plugin.state(() => ({ git: { conflicts: conflictsNow() } }))
const FILES_SHOWN = 1000

async function snapshot() {
  const cloud = cloudOf(plugin.vault.path)
  const s = settings()
  const st = readState()
  const base = {
    git: !!gitPath(), cloud: cloud ? { ...cloud, warning: cloudWarning(cloud) } : null, busy, lastSync: st.lastSync ?? null,
    auto: { interval: s.autoInterval, idle: s.autoIdle }, push: s.push,
  }
  if (!gitPath()) return { ...base, repo: null }
  const git = gitHere()
  const repo = await repoOf(git)
  if (!repo) return { ...base, repo: null }
  const [stat, last, names] = await Promise.all([status(git, repo), lastCommit(git), remotes(git)])
  setConflicts(stat.files.filter((f) => f.conflict).map((f) => f.path))
  return {
    ...base,
    repo: { top: repo.top, prefix: repo.prefix.replace(/\/$/, "") },
    branch: stat.branch, upstream: stat.upstream, ahead: stat.ahead, behind: stat.behind, remotes: names,
    merging: merging(repo),
    conflicts: stat.files.filter((f) => f.conflict).map((f) => f.path),
    total: stat.files.length,
    files: stat.files.slice(0, FILES_SHOWN),
    lastCommit: last,
  }
}

plugin.route("GET", "git/status", () => snapshot())

/** A vault path from a request, or a 400. */
function relOf(p: unknown) {
  const rel = String(p ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
  if (!rel || rel.split("/").includes("..")) throw new HTTPError(400, "which file? ?path=Notes/Idea.md")
  return rel
}
function readNow(rel: string): string | null {
  try { return fs.readFileSync(plugin.vault.abs(rel), "utf8") } catch { return null }
}
const binary = (t: string | null) => t !== null && (t.length > 2_000_000 || t.includes("\0"))

/** A file against HEAD: both texts (null where it isn't), for the diff view. */
plugin.route("GET", "git/diff", async (req) => {
  const rel = relOf(req.query.path)
  const git = gitHere()
  const repo = await repoHere(git)
  const f = (await status(git, repo)).files.find((x) => x.path === rel)
  const head = await show(git, repo, "HEAD", f?.from ?? rel)
  const now = readNow(rel)
  if (binary(head) || binary(now)) return { path: rel, from: f?.from ?? null, binary: true, head: null, now: null, file: f ?? null }
  return { path: rel, from: f?.from ?? null, binary: false, head, now, file: f ?? null }
})

plugin.route("GET", "git/log", async (req) => {
  const git = gitHere()
  const repo = await repoHere(git)
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500)
  return req.query.path ? { path: relOf(req.query.path), versions: await fileLog(git, repo, relOf(req.query.path), limit) } : { commits: await log(git, limit) }
})

plugin.route("GET", "git/show", async (req) => {
  const git = gitHere()
  const repo = await repoHere(git)
  const text = await asOp(() => show(git, repo, String(req.query.rev ?? ""), relOf(req.query.path)))
  if (text === null) throw new HTTPError(404, `no ${req.query.path} at ${req.query.rev}`)
  return new Text(text, "text/plain; charset=utf-8")
})

/** Whether a token for HTTPS remotes is kept on this machine (never the token itself). */
plugin.route("GET", "git/token", () => {
  const s = plugin.secrets()[plugin.id] ?? {}
  return { set: typeof s.token === "string" && !!s.token, user: typeof s.user === "string" ? s.user : "" }
})
plugin.route("POST", "git/token", async (req) => {
  const why = req.http ? await plugin.refusal(req.http, "Git's token") : ""
  if (why) throw new HTTPError(403, why)
  const token = String(req.body.token ?? "").trim(), user = String(req.body.user ?? "").trim()
  plugin.saveSecrets(token ? { token, ...(user ? { user } : {}) } : null)
  return { set: !!token, user }
})

// File history lists a file's commits beside its own versions (its service `versions:<source>`).
plugin.provide("versions:git", async (rel: string, id?: string) => {
  const b = gitPath()
  const git = b ? runner(plugin.vault.path, b) : null
  const repo = git ? await repoOf(git) : null
  if (!git || !repo) return null
  if (id) return show(git, repo, id, (await fileLog(git, repo, rel, 500)).find((v) => v.sha === id)?.path ?? rel)
  const versions = (await fileLog(git, repo, rel, 50)).filter((v) => v.change !== "D")
  return { label: "Git", versions: versions.map((v) => ({ id: v.sha, t: v.t, title: v.subject, by: v.author })) }
})

// ---------- the flows

const identity = (s: Settings) => ({ name: s.authorName || undefined, email: s.authorEmail || undefined })
const trailersFor = (who: { agent: string | null; label: string } | null) => (who?.agent ? [`Vaultite-Agent: ${who.label}`] : [])

async function doCommit(o: { message?: string; files?: string[]; who?: { agent: string | null; label: string } | null }): Promise<Committed> {
  const s = settings()
  const git = gitHere()
  const repo = await repoHere(git)
  return exclusive("Committing", async () => {
    const pending = (await status(git, repo)).files
    const files = o.files?.length ? o.files : pending.some((f) => f.staged) ? pending.filter((f) => f.staged).map((f) => f.path) : pending.map((f) => f.path)
    const message = o.message?.trim() || (merging(repo) ? "" : commitMessage(s.message, { files, dateFormat: s.dateFormat }))
    const done = await commit(git, repo, { message, files: o.files, stageAll: s.stageAll, trailers: trailersFor(o.who ?? null), identity: identity(s), vaultDir: plugin.vault.path })
    if (done) {
      if (!merging(repo)) setConflicts([])
      plugin.emit("git.committed", { sha: done.sha, message: done.message, files: done.files })
      if (!merging(repo)) void untell("conflict")
    }
    return done
  })
}

async function doSync(o: { message?: string; auto?: boolean; who?: { agent: string | null; label: string } | null; pull?: boolean; push?: boolean; commit?: boolean }) {
  const s = settings()
  const git = gitHere()
  const repo = await repoHere(git)
  return exclusive("Syncing", async () => {
    let res: SyncResult
    try {
      const pending = (await status(git, repo)).files.map((f) => f.path)
      const message = o.message?.trim() || commitMessage(s.message, { files: pending, dateFormat: s.dateFormat })
      res = await sync(git, repo, {
        commit: o.commit === false ? false : { message, trailers: trailersFor(o.who ?? null), identity: identity(s), vaultDir: plugin.vault.path },
        pull: o.pull !== false,
        push: o.push ?? s.push,
        lock: (fn) => plugin.vault.lock(fn),
        step: (what) => { busy = what },
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      saveState({ lastSync: { t: Date.now(), ok: false, auto: !!o.auto, error } })
      if (o.auto) void tell("sync", "Git couldn't commit and sync", error)
      throw e instanceof GitError ? new OpError(error) : e
    }
    const summary = summarize(res)
    saveState({ lastSync: { t: Date.now(), ok: !res.conflicts.length, auto: !!o.auto, summary } })
    if (res.committed) plugin.emit("git.committed", { sha: res.committed.sha, message: res.committed.message, files: res.committed.files })
    setConflicts(res.conflicts)
    if (res.conflicts.length) {
      plugin.emit("git.conflict", { files: res.conflicts })
      void tell("conflict", `Git: merge conflicts in ${res.conflicts.length} file${res.conflicts.length === 1 ? "" : "s"}`,
        `Nothing was lost: the pull stopped so you can choose. Fix ${res.conflicts.join(", ")} (keep what you want between <<<<<<< and >>>>>>>), then Commit; or Abort merge in Source control.`)
    } else {
      plugin.emit("git.synced", { pulled: res.pulled, pushed: res.pushed, sha: res.committed?.sha ?? null })
      void untell("sync")
      if (!merging(repo)) void untell("conflict")
    }
    return res
  })
}

function summarize(r: SyncResult) {
  if (r.conflicts.length) return `Stopped at merge conflicts in ${r.conflicts.join(", ")}`
  const parts = [
    r.committed ? `committed ${r.committed.files.length} file${r.committed.files.length === 1 ? "" : "s"}` : "",
    r.pulled ? `pulled ${r.pulled} commit${r.pulled === 1 ? "" : "s"}` : "",
    r.pushed ? `pushed ${r.pushed} commit${r.pushed === 1 ? "" : "s"}` : "",
  ].filter(Boolean)
  const text = parts.length ? parts.join(", ") : "nothing to commit, pull or push"
  return [text[0].toUpperCase() + text.slice(1), ...r.notes].join(". ")
}

// ---------- the timer: commit and sync every so often, or once editing has stopped (one machine runs it)

let lastEdit = 0
plugin.onChange((paths) => {
  if (paths && !paths.some((p) => !p.startsWith(".vaultite/") && !p.startsWith(".trash/") && p !== ".vaultite")) return
  lastEdit = Date.now()
})

async function tick() {
  const s = settings()
  if (!s.autoInterval && !s.autoIdle) return
  const b = gitPath()
  if (!b) return
  const git = runner(plugin.vault.path, b, tokenEnv())
  const repo = await repoOf(git)
  if (!repo || merging(repo) || busy) return
  const now = Date.now()
  const st = readState()
  const pending = (await status(git, repo)).files.length
  if (pending && s.autoIdle > 0 && !lastEdit) lastEdit = now // (after a restart: wait a full idle time)
  const why = autoDue({ now, interval: s.autoInterval, idle: s.autoIdle, lastAuto: st.lastAuto ?? 0, lastCommit: (await lastCommit(git))?.t ?? 0, lastEdit, pending })
  if (!why) return
  saveState({ lastAuto: now })
  await doSync({ auto: true }).catch(() => {}) // (said in the Inbox)
}

// (the machine it names is read once the vault is there, and again when the setting changes)
let jobMachine = ""
const schedule = (machine: string) => {
  jobMachine = machine
  plugin.every("auto", { every: "1m", ...(machine ? { machine } : {}) }, tick)
}
schedule("")
plugin.onSync(() => { if (settings().machine !== jobMachine) schedule(settings().machine) })

// ---------- operations

const pathsParam = { type: "array", items: { type: "string" }, description: "vault paths (Notes/Idea.md); none: every change" } as const
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

function statusText(s: Snapshot) {
  if (!s.git) return "git isn't installed on the server's machine."
  const warn = s.cloud ? `\n\nNote: ${s.cloud.warning}` : ""
  if (!s.repo) return `The vault isn't a git repository (git.init makes one).${warn}`
  const lines = [
    `On ${s.branch ?? "a detached HEAD"}${s.upstream ? `, syncing with ${s.upstream}` : s.remotes?.length ? `, remote ${s.remotes.join(", ")}` : ", no remote"}` +
      `${s.ahead || s.behind ? ` (${s.ahead} ahead, ${s.behind} behind)` : ""}.`,
    s.lastCommit ? `Last commit: ${new Date(s.lastCommit.t).toISOString().slice(0, 16).replace("T", " ")} UTC, "${s.lastCommit.subject}" (${s.lastCommit.sha.slice(0, 7)}).` : "No commits yet.",
  ]
  if (s.merging) lines.push(s.conflicts?.length ? `A merge is waiting: conflicts in ${s.conflicts.join(", ")}. Fix them (the text between <<<<<<< and >>>>>>>), then git.commit; or git.abort.` : "A merge is waiting: git.commit finishes it.")
  const files = s.files ?? []
  if (!files.length) lines.push("Nothing changed since the last commit.")
  else {
    lines.push(`${plural(s.total ?? files.length, "changed file")}:`)
    for (const f of files.slice(0, 200)) lines.push(`- ${f.conflict ? "conflict" : f.untracked ? "new" : f.x === "D" || f.y === "D" ? "deleted" : f.from ? `renamed from ${f.from}` : f.x === "A" ? "added" : "modified"}${f.staged ? " (staged)" : ""}: ${f.path}`)
    if (files.length > 200) lines.push(`- and ${files.length - 200} more`)
  }
  if (s.lastSync) lines.push(`Last sync: ${new Date(s.lastSync.t).toISOString().slice(0, 16).replace("T", " ")} UTC, ${s.lastSync.ok ? s.lastSync.summary ?? "done" : `failed: ${s.lastSync.error ?? s.lastSync.summary}`}.`)
  return lines.join("\n") + warn
}

plugin.op({
  id: "git.status",
  cli: "git status",
  mcp: true,
  summary: "The vault's git repository: branch, remote, ahead and behind, the files changed since the last commit, a merge waiting.",
  help: "  vau git status",
  kind: "read",
  lock: false,
  run: () => asOp(() => snapshot()),
  text: (s: Snapshot) => statusText(s),
})

plugin.op({
  id: "git.commit",
  cli: "git commit",
  mcp: true,
  summary: "Commit changes to the vault's git repository, with a message saying what was done; files: only those (your own work).",
  help: `An agent commits its own work: the files it changed, and a message saying what it did. Without files it commits
what's staged, or every change when nothing is (the plugin's setting); without a message, the plugin's template
("vault backup: {{date}}"). During a merge it finishes the merge once no conflicted file has markers left.

  vau git commit -m "Added the reading notes for Lighthouse" --files "Notes/Lighthouse.md"
  vau git commit`,
  kind: "write",
  lock: false,
  params: {
    message: { type: "string", description: "what was done, one line (a blank line, then more if needed)" },
    files: pathsParam,
  },
  args: ["message"],
  run: ({ message, files }, ctx) => asOp(async () => {
    // (`vau git commit -m "..."`: vau has no short flags, so -m arrives as the message's first word)
    const msg = typeof message === "string" ? message.replace(/^-m\s+/, "") : undefined
    const done = await doCommit({ message: msg, files, who: ctx.who })
    return { committed: done }
  }),
  text: (r: { committed: Committed }) => (r.committed ? `Committed ${plural(r.committed.files.length, "file")} (${r.committed.sha.slice(0, 7)}): ${r.committed.message.split("\n")[0]}` : "Nothing to commit."),
})

plugin.op({
  id: "git.sync",
  cli: "git sync",
  mcp: true,
  summary: "Commit every change, pull (a merge) and push: the vault's repository in step with its remote. A conflict stops it, nothing lost.",
  help: `Commits what changed (message: given, else the plugin's template), then pulls from the branch's remote and
pushes. A merge conflict stops it before anything is overwritten: the conflicted files are listed (and in the Inbox);
fix them, then git.commit, or git.abort.

  vau git sync
  vau git sync "Weekly review notes"`,
  kind: "write",
  lock: false,
  owner: "Git's sync",
  params: { message: { type: "string", description: "the commit's message (else the plugin's template)" } },
  args: ["message"],
  run: ({ message }, ctx) => asOp(() => doSync({ message, who: ctx.who })),
  text: (r: SyncResult) => (r.conflicts.length ? `Stopped: merge conflicts in ${r.conflicts.join(", ")}. Nothing was lost. Fix them (the text between <<<<<<< and >>>>>>>), then git.commit; or git.abort.` : `${summarize(r)}.`),
})

plugin.op({
  id: "git.pull",
  cli: "git pull",
  summary: "Pull the vault's branch from its remote (a merge), without committing first.",
  kind: "write",
  lock: false,
  owner: "Git's pull",
  run: (_p, ctx) => asOp(() => doSync({ commit: false, push: false, who: ctx.who })),
  text: (r: SyncResult) => (r.conflicts.length ? `Stopped: merge conflicts in ${r.conflicts.join(", ")}.` : `${summarize(r)}.`),
})

plugin.op({
  id: "git.push",
  cli: "git push",
  summary: "Push the vault's commits to its remote, without pulling first (it fails when the remote has new commits).",
  kind: "write",
  lock: false,
  owner: "Git's push",
  run: (_p, ctx) => asOp(() => doSync({ commit: false, pull: false, push: true, who: ctx.who })),
  text: (r: SyncResult) => `${summarize(r)}.`,
})

plugin.op({
  id: "git.log",
  cli: "git log",
  mcp: true,
  summary: "A file's commits (its versions in git, following renames), or the repository's last commits.",
  help: "  vau git log Notes/Idea.md\n  vau git log",
  kind: "read",
  lock: false,
  params: {
    path: { type: "string", format: "path", description: "the file; none: the repository's last commits" },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "at most this many (50)" },
  },
  args: ["path"],
  run: ({ path: p, limit }, ctx) => ctx.api("GET", `git/log?limit=${limit ?? 50}${p ? `&path=${encodeURIComponent(p)}` : ""}`),
  text: (r: { path?: string; versions?: { sha: string; t: number; author: string; subject: string; path: string; change: string }[]; commits?: { sha: string; t: number; author: string; subject: string; files: number }[] }) => {
    const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ")
    if (r.versions) return r.versions.length ? [`${r.path}, newest first (git.show with its commit):`, ...r.versions.map((v) => `- ${v.sha.slice(0, 7)} ${when(v.t)} ${v.author}: ${v.subject}${v.path !== r.path ? ` (then ${v.path})` : ""}${v.change === "D" ? " (deleted)" : ""}`)].join("\n") : `No commits of ${r.path}.`
    return r.commits?.length ? r.commits.map((c) => `- ${c.sha.slice(0, 7)} ${when(c.t)} ${c.author}: ${c.subject} (${plural(c.files, "file")})`).join("\n") : "No commits yet."
  },
})

plugin.op({
  id: "git.show",
  cli: "git show",
  summary: "A file's text at a commit (from git.log; its path then, when it was renamed since).",
  help: "  vau git show Notes/Idea.md 1a2b3c4",
  kind: "read",
  lock: false,
  params: {
    path: { type: "string", format: "path", required: true, description: "the file (its path at that commit)" },
    commit: { type: "string", required: true, description: "the commit (a hash from git.log, or HEAD)" },
  },
  args: ["path", "commit"],
  run: async ({ path: p, commit: rev }, ctx) => ({ path: p, commit: rev, text: String(await ctx.api("GET", `git/show?path=${encodeURIComponent(p)}&rev=${encodeURIComponent(rev)}`)) }),
  text: (r: { text: string }) => r.text,
})

plugin.op({
  id: "git.restore",
  cli: "git restore",
  summary: "Make a file what it was at a commit: written back as an ordinary edit (File history keeps what it replaces).",
  help: "  vau git restore Notes/Idea.md 1a2b3c4\n  vau git restore Notes/Idea.md 1a2b3c4 --from \"Notes/Old name.md\"",
  kind: "write",
  lock: false,
  params: {
    path: { type: "string", format: "path", required: true, description: "the file to write" },
    commit: { type: "string", required: true, description: "the commit (from git.log)" },
    from: { type: "string", description: "the file's path at that commit, when it was renamed since (git.log says)" },
  },
  args: ["path", "commit"],
  run: ({ path: p, commit: rev, from }, ctx) => asOp(async () => {
    const git = gitHere()
    const repo = await repoHere(git)
    const text = await show(git, repo, rev, from || p)
    if (text === null) throw new OpError(`${from || p} isn't in commit ${rev} (git.log ${p} lists its versions)`, 404)
    const before = readNow(p)
    if (before === text) return { path: p, commit: rev, changed: false }
    if (before === null) await ctx.api("POST", "file", { path: p, text })
    else await ctx.api("PUT", "file", { path: p, text, base: before })
    return { path: p, commit: rev, changed: true }
  }),
  text: (r: { path: string; commit: string; changed: boolean }) => (r.changed ? `Restored ${r.path} as it was at ${r.commit.slice(0, 7)}.` : `${r.path} is already as it was at ${r.commit.slice(0, 7)}.`),
})

async function stageOp(paths: string[] | undefined, how: "stage" | "unstage" | "discard") {
  const git = gitHere()
  const repo = await repoHere(git)
  return exclusive(how === "stage" ? "Staging" : how === "unstage" ? "Unstaging" : "Discarding", async () => {
    const st = (await status(git, repo)).files
    const want = paths?.length ? st.filter((f) => paths.includes(f.path)) : st
    const all = want.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])) // (pathspecs are the vault folder's)
    if (!all.length) return { files: [] as string[] }
    if (how === "stage") await must(git, ["--literal-pathspecs", "add", "-A", "--", ...all])
    else if (how === "unstage") {
      const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0
      await must(git, head ? ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...all] : ["--literal-pathspecs", "rm", "-q", "--cached", "-r", "--", ...all])
    } else {
      // Only what HEAD has (a file added or renamed since isn't discarded: it stays, changed)
      const tracked = want.filter((f) => !f.untracked && !f.conflict && !f.from && f.x !== "A")
      if (!tracked.length) return { files: [] }
      await plugin.vault.lock(() => must(git, ["--literal-pathspecs", "checkout", "HEAD", "--", ...tracked.map((f) => f.path)]))
      return { files: tracked.map((f) => f.path) }
    }
    return { files: want.map((f) => f.path) }
  })
}

for (const [how, summary] of [
  ["stage", "Stage files for the next commit (git add)."],
  ["unstage", "Take files out of the next commit (they stay changed)."],
] as const) {
  plugin.op({
    id: `git.${how}`,
    cli: `git ${how}`,
    summary,
    kind: "write",
    lock: false,
    params: { files: pathsParam },
    args: ["files"],
    run: ({ files }) => asOp(() => stageOp(files, how)),
    text: (r: { files: string[] }) => (r.files.length ? `${how === "stage" ? "Staged" : "Unstaged"} ${r.files.join(", ")}.` : "Nothing to do."),
  })
}

plugin.op({
  id: "git.discard",
  cli: "git discard",
  summary: "Throw away a tracked file's changes since the last commit (File history keeps the text it had). New files are left alone.",
  kind: "destructive",
  lock: false,
  params: { files: { ...pathsParam, description: "vault paths (Notes/Idea.md)" } },
  args: ["files"],
  run: ({ files }) => asOp(async () => {
    if (!files?.length) throw new OpError("which files? Discarding is never done to every change at once")
    return stageOp(files, "discard")
  }),
  text: (r: { files: string[] }) => (r.files.length ? `Discarded the changes to ${r.files.join(", ")}.` : "Nothing to discard (new files are left alone)."),
})

plugin.op({
  id: "git.abort",
  cli: "git abort",
  summary: "Abort the merge a pull stopped at: the vault goes back to how it was before the pull (your commits kept).",
  kind: "write",
  lock: false,
  run: () => asOp(async () => {
    const git = gitHere()
    const repo = await repoHere(git)
    if (!merging(repo)) throw new OpError("There's no merge to abort")
    await exclusive("Aborting the merge", () => plugin.vault.lock(() => must(git, ["merge", "--abort"])))
    setConflicts([])
    void untell("conflict")
    return { aborted: true }
  }),
  text: () => "Aborted the merge: the vault is as it was before the pull.",
})

plugin.op({
  id: "git.init",
  cli: "git init",
  summary: "Make the vault's folder a git repository, with a .gitignore for what Vaultite rebuilds, the trash and the OS's files.",
  help: `In iCloud Drive (or Dropbox...) it refuses unless force: the two syncs can fight over the repository's files.
remote: the address of a repository to sync with (made the branch's remote, origin).

  vau git init
  vau git init --remote git@github.com:alice/vault.git`,
  kind: "write",
  lock: false,
  owner: "Git's setup",
  params: {
    remote: { type: "string", description: "a remote's address to add as origin (git@host:you/vault.git, https://...)" },
    force: { type: "boolean", description: "make it even in iCloud Drive or another synced folder" },
  },
  run: ({ remote, force }) => asOp(async () => {
    const b = gitPath()
    if (!b) throw new OpError("git isn't installed on the server's machine (on a Mac: xcode-select --install, or brew install git)")
    const git = runner(plugin.vault.path, b)
    const cloud = cloudOf(plugin.vault.path)
    if (cloud && !force) throw new OpError(`${cloudWarning(cloud)} To make it anyway: force.`, 409)
    const was = await repoOf(git)
    if (was) throw new OpError(was.prefix ? `The vault is in a git repository already (${was.top})` : "The vault is a git repository already")
    await must(git, ["init", "-q", "-b", "main"])
    const ignore = plugin.vault.abs(".gitignore")
    const wrote = !fs.existsSync(ignore)
    if (wrote) fs.writeFileSync(ignore, GITIGNORE)
    if (remote?.trim()) await must(git, ["remote", "add", "origin", remote.trim()])
    return { initialized: true, gitignore: wrote, remote: remote?.trim() ? redact(remote.trim()) : null, cloud: cloud?.name ?? null }
  }),
  text: (r: { gitignore: boolean; remote: string | null }) => `Made the vault a git repository${r.gitignore ? ", with a .gitignore" : ""}${r.remote ? `, its remote origin ${r.remote}` : ""}. Nothing is committed yet: git.commit or git.sync.`,
})

plugin.op({
  id: "git.remote",
  cli: "git remote",
  summary: "Set the address of the vault's remote (origin, or the one named): where sync pulls from and pushes to.",
  kind: "write",
  lock: false,
  owner: "Git's setup",
  params: {
    url: { type: "string", required: true, description: "the remote's address (git@host:you/vault.git, https://...)" },
    name: { type: "string", description: "the remote's name (origin)" },
  },
  args: ["url"],
  run: ({ url, name }) => asOp(async () => {
    const git = gitHere()
    await repoHere(git)
    const n = (name || "origin").trim()
    if (!/^[\w.-]+$/.test(n)) throw new OpError("a remote's name is letters, digits, . _ and -")
    const has = (await remotes(git)).includes(n)
    await must(git, has ? ["remote", "set-url", n, url.trim()] : ["remote", "add", n, url.trim()])
    return { name: n, url: redact(url.trim()) }
  }),
  text: (r: { name: string; url: string }) => `Remote ${r.name} is ${r.url}.`,
})
