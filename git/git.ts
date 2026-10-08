// Git for a vault: the user's git run by argv (never a shell) in the vault's folder, its answers parsed, and the
// commit-and-sync flow. No Vaultite imports, so the tests run it as it is against throwaway repositories.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Commit, FileStatus } from "./types.ts"

export { letter } from "./types.ts"
export type { FileStatus }

export type Run = { code: number; out: string; err: string }
export type GitOpts = { input?: string; timeout?: number; env?: Record<string, string> }
export type Git = (args: string[], opts?: GitOpts) => Promise<Run>

/** The git on this machine: the first on PATH, else where Homebrew and the system put it. */
export function gitBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
  for (const d of dirs) {
    const p = path.join(d, process.platform === "win32" ? "git.exe" : "git")
    try { if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}

const MAX_OUT = 32 << 20

/** Runs git in `cwd`. Its own session (detached), so ssh can't ask on a terminal, and prompts are off: a remote that
 *  needs a password fails instead of hanging. `env` adds to the environment (GIT_ASKPASS for a token). */
export function runner(cwd: string, bin: string, env: Record<string, string> = {}): Git {
  return (args, o = {}) => new Promise((resolve) => {
    let out = "", err = "", done = false
    const child = spawn(bin, ["-c", "core.quotepath=off", "-c", "color.ui=never", ...args], {
      cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env, ...o.env },
    })
    const finish = (r: Run) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGTERM") } catch { /* gone */ }
      finish({ code: 124, out, err: `${err}\ngit ${args[0]} took too long (over ${Math.round((o.timeout ?? 30_000) / 1000)} s) and was stopped` })
    }, o.timeout ?? 30_000)
    child.stdout.setEncoding("utf8").on("data", (d: string) => { if (out.length < MAX_OUT) out += d })
    child.stderr.setEncoding("utf8").on("data", (d: string) => { if (err.length < 1 << 20) err += d })
    child.on("error", (e) => finish({ code: 127, out: "", err: e.message }))
    child.on("close", (code) => finish({ code: code ?? 1, out, err }))
    child.stdin.on("error", () => {})
    child.stdin.end(o.input ?? "")
  })
}

/** A remote's address or git's words with any password or token in them hidden. */
export const redact = (s: string) => s.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@").replace(/\b(gh[pousr]_|github_pat_|glpat-)[\w-]+/g, "$1***")

/** git's last lines on stderr (or stdout), as one message without its hints. */
export function said(r: Run) {
  const lines = redact(`${r.err}\n${r.out}`).split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("hint:") && !l.startsWith('(use "git'))
  return lines.slice(-4).join(" ").slice(0, 400) || `git exited with ${r.code}`
}

export class GitError extends Error {}

/** Runs git and answers its stdout; a non-zero exit throws GitError with what it said. */
export async function must(git: Git, args: string[], opts?: GitOpts) {
  const r = await git(args, opts)
  if (r.code !== 0) throw new GitError(friendly(r))
  return r.out
}

/** git's answer as something to do. */
export function friendly(r: Run) {
  const text = `${r.err}\n${r.out}`
  if (/Author identity unknown|Please tell me who you are|unable to auto-detect email/i.test(text)) {
    return "Git doesn't know who you are yet: set your name and email in a terminal (git config --global user.name \"Your Name\", then user.email), or in the plugin's settings"
  }
  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey/i.test(text)) {
    return `The remote refused the credentials: ${said(r)}. Set up an SSH key or a credential helper for this machine's user, or an access token in the plugin's settings`
  }
  if (/Could not resolve host|unable to access|Connection (refused|timed out)|Operation timed out/i.test(text)) return `Couldn't reach the remote: ${said(r)}`
  return said(r)
}

// ---------- status

export type Status = { branch: string | null; oid: string | null; upstream: string | null; ahead: number; behind: number; files: FileStatus[] }

/** `git status --porcelain=v2 --branch -z`; paths made the vault's (`prefix`: the vault's folder in the repository). */
export function parseStatus(z: string, prefix = ""): Status {
  const st: Status = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const rec = z.split("\0")
  const mine = (p: string) => (prefix ? (p.startsWith(prefix) ? p.slice(prefix.length) : null) : p)
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i]
    if (!r) continue
    if (r.startsWith("# ")) {
      const [, key, ...v] = r.split(" ")
      if (key === "branch.oid") st.oid = v[0] === "(initial)" ? null : v[0]
      else if (key === "branch.head") st.branch = v[0] === "(detached)" ? null : v[0]
      else if (key === "branch.upstream") st.upstream = v[0]
      else if (key === "branch.ab") { st.ahead = Math.abs(Number(v[0]) || 0); st.behind = Math.abs(Number(v[1]) || 0) }
      continue
    }
    const kind = r[0]
    let x = ".", y = ".", p = "", from: string | undefined
    if (kind === "1") { const f = r.split(" "); x = f[1][0]; y = f[1][1]; p = f.slice(8).join(" ") }
    else if (kind === "2") { const f = r.split(" "); x = f[1][0]; y = f[1][1]; p = f.slice(9).join(" "); from = rec[++i] }
    else if (kind === "u") { const f = r.split(" "); x = f[1][0]; y = f[1][1]; p = f.slice(10).join(" ") }
    else if (kind === "?") { x = "?"; y = "?"; p = r.slice(2) }
    else continue
    const rel = mine(p)
    if (rel === null || !rel) continue
    const conflict = kind === "u"
    const untracked = kind === "?"
    const f: FileStatus = { path: rel, x, y, staged: !conflict && !untracked && x !== ".", unstaged: conflict || untracked || y !== ".", untracked, conflict }
    const was = from !== undefined ? mine(from) : null
    if (was) f.from = was
    st.files.push(f)
  }
  return st
}

// ---------- messages

const pad = (n: number) => String(n).padStart(2, "0")
/** A date in a moment.js-like format: YYYY, MM, DD, HH, mm, ss (what Obsidian Git's {{date}} uses). */
export function formatDate(d: Date, fmt = "YYYY-MM-DD HH:mm:ss") {
  const parts: Record<string, string> = { YYYY: String(d.getFullYear()), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) }
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (k) => parts[k])
}

export const hostname = () => os.hostname().replace(/\.local$/, "")

/** A commit message from its template: {{date}}, {{numFiles}}, {{hostname}}, {{files}}. */
export function commitMessage(template: string, o: { date?: Date; dateFormat?: string; files: string[]; host?: string }) {
  const files = o.files.length > 10 ? `${o.files.slice(0, 10).join(", ")} and ${o.files.length - 10} more` : o.files.join(", ")
  const text = (template.trim() || "vault backup: {{date}}")
    .replace(/\{\{\s*date\s*\}\}/g, formatDate(o.date ?? new Date(), o.dateFormat || undefined))
    .replace(/\{\{\s*numFiles\s*\}\}/g, String(o.files.length))
    .replace(/\{\{\s*hostname\s*\}\}/g, o.host ?? hostname())
    .replace(/\{\{\s*files\s*\}\}/g, files)
  return text.trim() || "vault backup"
}

/** Whether an automatic commit-and-sync is due, and why: `interval` minutes since the last one (or the last commit),
 *  or `idle` minutes since the last edit with changes pending. Times in ms. */
export function autoDue(o: { now: number; interval: number; idle: number; lastAuto: number; lastCommit: number; lastEdit: number; pending: number }): "interval" | "idle" | null {
  if (o.interval > 0 && o.now - Math.max(o.lastAuto, o.lastCommit) >= o.interval * 60_000) return "interval"
  if (o.idle > 0 && o.pending > 0 && o.lastEdit > o.lastAuto && o.now - o.lastEdit >= o.idle * 60_000) return "idle"
  return null
}

// ---------- the vault's folder

/** The sync service a folder is in (its real path): iCloud Drive, or another client's folder (Dropbox...), or null. */
export function cloudOf(dir: string, home = os.homedir()): { name: string; sure: boolean } | null {
  let real = dir
  try { real = fs.realpathSync(dir) } catch { /* as given */ }
  if (real.includes("/Library/Mobile Documents/")) return { name: "iCloud Drive", sure: true }
  const cs = /\/Library\/CloudStorage\/([A-Za-z]+)/.exec(real)
  if (cs) return { name: ({ GoogleDrive: "Google Drive" } as Record<string, string>)[cs[1]] ?? cs[1], sure: true }
  if (/\/(Dropbox|Google Drive|OneDrive)(\/|$)/.test(real)) return { name: /\/(Dropbox|Google Drive|OneDrive)/.exec(real)![1], sure: true }
  // Desktop & Documents in iCloud: the folders stay where they are, so it can only be guessed.
  const synced = fs.existsSync(path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Documents"))
  if (synced && [path.join(home, "Documents"), path.join(home, "Desktop")].some((d) => real === d || real.startsWith(`${d}/`))) {
    return { name: "iCloud Drive", sure: false }
  }
  return null
}

/** What to tell the user about git in a synced folder. */
export function cloudWarning(c: { name: string; sure: boolean }) {
  const where = c.sure ? `This vault is in ${c.name}.` : `This vault may be in ${c.name} (Desktop & Documents).`
  return `${where} ${c.name} and git would both sync it, and they can fight: ${c.name} copies the repository's own files (.git) one at a time, which can leave it broken (files like "index 2", objects not downloaded yet). Use one: ${c.name} to keep your devices in step (File history keeps earlier versions), or git pushing to a server (GitHub, say) with the vault moved out of ${c.name} (to ~/Vault).`
}

/** A new repository's .gitignore: what Vaultite rebuilds or keeps per machine, the trash and the OS's files. */
export const GITIGNORE = `# Vaultite: rebuilt or kept per machine
.vaultite/cache/
.vaultite/generated/
.trash/

# The OS's files
.DS_Store
._*
.Spotlight-V100
.Trashes
*.icloud
Thumbs.db
desktop.ini
`

// ---------- the repository

export type Repo = { top: string; prefix: string; gitDir: string }

/** The repository the vault's folder is in, or null. */
export async function repoOf(git: Git): Promise<Repo | null> {
  const r = await git(["rev-parse", "--show-toplevel", "--show-prefix", "--absolute-git-dir"])
  if (r.code !== 0) return null
  const [top, prefix, gitDir] = r.out.split("\n")
  return { top, prefix: prefix ?? "", gitDir: gitDir ?? path.join(top, ".git") }
}

export const merging = (repo: Repo) => fs.existsSync(path.join(repo.gitDir, "MERGE_HEAD"))
export const rebasing = (repo: Repo) => fs.existsSync(path.join(repo.gitDir, "rebase-merge")) || fs.existsSync(path.join(repo.gitDir, "rebase-apply"))

export async function status(git: Git, repo: Repo) {
  return parseStatus(await must(git, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."]), repo.prefix)
}

/** The files still in conflict (vault paths). */
export async function conflicts(git: Git, repo: Repo) {
  return (await status(git, repo)).files.filter((f) => f.conflict).map((f) => f.path)
}

const MARKERS = /^(<{7}|>{7}) /m
/** Conflicted files that still have git's markers in them (vault paths). */
export function withMarkers(vaultDir: string, paths: string[]) {
  return paths.filter((p) => { try { return MARKERS.test(fs.readFileSync(path.join(vaultDir, p), "utf8")) } catch { return false } })
}

export type { Commit } from "./types.ts"

export async function lastCommit(git: Git): Promise<Commit | null> {
  const r = await git(["log", "-1", "--format=%H%x1f%ct%x1f%an%x1f%s"])
  if (r.code !== 0 || !r.out.trim()) return null
  const [sha, t, author, subject] = r.out.trim().split("\x1f")
  return { sha, t: Number(t) * 1000, author, subject }
}

export async function remotes(git: Git) {
  return (await git(["remote"])).out.split("\n").map((s) => s.trim()).filter(Boolean)
}

export type CommitOpts = {
  message: string
  /** Only these (vault paths), whatever else is staged or changed: an agent's own work. */
  files?: string[]
  /** Stage everything first when nothing is staged (Commit's default). */
  stageAll?: boolean
  /** Trailers, "Key: value" (who asked, for an agent). */
  trailers?: string[]
  /** -c user.name / user.email, when set in the plugin's settings. */
  identity?: { name?: string; email?: string }
  vaultDir: string
}
export type Committed = { sha: string; message: string; files: string[] } | null

const idArgs = (id?: { name?: string; email?: string }) => [
  ...(id?.name ? ["-c", `user.name=${id.name}`] : []), ...(id?.email ? ["-c", `user.email=${id.email}`] : []),
]

/** Commit: the files given, or what's staged, or everything when nothing is (stageAll). During a merge it finishes it,
 *  once no conflicted file has markers left. null when there was nothing to commit. */
export async function commit(git: Git, repo: Repo, o: CommitOpts): Promise<Committed> {
  const msg = [o.message.trim(), ...(o.trailers?.length ? ["", ...o.trailers] : [])].join("\n")
  if (merging(repo)) {
    // (a file marked resolved, staged, may still have them: every changed file is looked at)
    const marked = withMarkers(o.vaultDir, (await status(git, repo)).files.map((f) => f.path))
    if (marked.length) throw new GitError(`Resolve the conflicts first: ${marked.join(", ")} still ${marked.length === 1 ? "has" : "have"} conflict markers (<<<<<<< and >>>>>>>)`)
    await must(git, ["add", "-A", "--", "."])
    const files = (await status(git, repo)).files.filter((f) => f.staged).map((f) => f.path)
    await must(git, [...idArgs(o.identity), "commit", ...(o.message.trim() ? ["-F", "-"] : ["--no-edit"])], { input: msg })
    return { sha: (await must(git, ["rev-parse", "HEAD"])).trim(), message: o.message.trim() || "merge", files }
  }
  let files: string[]
  if (o.files?.length) {
    const want = [...new Set(o.files.map((f) => f.replace(/^\/+/, "")))]
    const st = await status(git, repo)
    const changed = new Set(st.files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))
    files = want.filter((f) => changed.has(f))
    if (!files.length) return null
    const renamedFrom = st.files.filter((f) => f.from && files.includes(f.path)).map((f) => f.from!)
    const paths = [...files, ...renamedFrom] // (pathspecs are the vault folder's, where git runs)
    await must(git, ["--literal-pathspecs", "add", "-A", "--", ...paths])
    await must(git, [...idArgs(o.identity), "--literal-pathspecs", "commit", "-F", "-", "--only", "--", ...paths], { input: msg })
  } else {
    let st = await status(git, repo)
    if (!st.files.some((f) => f.staged) && o.stageAll !== false) {
      if (!st.files.length) return null
      await must(git, ["add", "-A", "--", "."])
      st = await status(git, repo)
    }
    files = st.files.filter((f) => f.staged).map((f) => f.path)
    if (!files.length) return null
    await must(git, [...idArgs(o.identity), "commit", "-F", "-"], { input: msg })
  }
  return { sha: (await must(git, ["rev-parse", "HEAD"])).trim(), message: o.message.trim(), files }
}

export type SyncResult = {
  committed: Committed
  /** Commits merged in from the remote, and pushed to it. */
  pulled: number; pushed: number
  /** Files in conflict: the merge is left for the user to resolve (nothing is lost; Abort merge undoes it). */
  conflicts: string[]
  remote: string | null
  /** What else happened, one line each ("No remote: committed only"). */
  notes: string[]
}

/** Where the branch syncs: its upstream, else the branch of the same name on `origin` (or the only remote). */
async function target(git: Git) {
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"])).out.trim() || null
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  if (up.code === 0 && up.out.trim()) {
    const u = up.out.trim()
    const names = await remotes(git)
    const remote = names.find((n) => u.startsWith(`${n}/`)) ?? u.split("/")[0]
    return { branch, remote, upstream: u, set: true }
  }
  const names = await remotes(git)
  const remote = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : null
  return { branch, remote, upstream: remote && branch ? `${remote}/${branch}` : null, set: false }
}

const count = async (git: Git, range: string) => Number((await git(["rev-list", "--count", range])).out.trim()) || 0
const exists = async (git: Git, ref: string) => (await git(["rev-parse", "--verify", "--quiet", ref])).code === 0

export type SyncOpts = {
  /** Commit first (with this message) when anything changed; false: only pull and push. */
  commit?: Omit<CommitOpts, "files"> | false
  pull?: boolean
  push?: boolean
  /** Runs the steps that change the vault's files (the merge), with the vault to itself. */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>
  /** What's happening now ("Pulling"), for whoever is watching. */
  step?: (what: string) => void
}

/** Commit, pull (a merge; never a rebase), then push. Stops at a conflict, leaving the merge for the user. */
export async function sync(git: Git, repo: Repo, o: SyncOpts): Promise<SyncResult> {
  const lock = o.lock ?? ((fn) => fn())
  const res: SyncResult = { committed: null, pulled: 0, pushed: 0, conflicts: [], remote: null, notes: [] }
  if (rebasing(repo)) throw new GitError("A rebase is under way in this repository: finish or abort it in a terminal first")
  if (merging(repo)) {
    const left = await conflicts(git, repo)
    if (left.length) { res.conflicts = left; res.notes.push("A merge is waiting for its conflicts to be resolved"); return res }
  }
  if (o.commit) {
    o.step?.("Committing")
    res.committed = await commit(git, repo, { ...o.commit, files: undefined, stageAll: true })
  }
  const t = await target(git)
  res.remote = t.remote
  if (!t.remote) { res.notes.push("No remote to sync with: committed here only"); return res }
  if (!t.branch) throw new GitError("HEAD isn't on a branch (detached): check out a branch in a terminal first")
  if (o.pull !== false) {
    o.step?.("Pulling")
    await must(git, ["fetch", "--quiet", "--prune", t.remote], { timeout: 120_000 })
    let up = t.set ? t.upstream : null
    if (!up && t.upstream && await exists(git, `refs/remotes/${t.upstream}`)) {
      up = t.upstream
      await git(["branch", `--set-upstream-to=${up}`])
    }
    if (up) {
      const head = await exists(git, "HEAD")
      const behind = head ? await count(git, `HEAD..${up}`) : await count(git, up)
      if (behind) {
        const merged = await lock(async () => {
          if (!head) return git(["merge", "--ff-only", up])
          return git(["merge", "--no-edit", "--allow-unrelated-histories", up])
        })
        if (merged.code !== 0) {
          const left = merging(repo) ? await conflicts(git, repo) : []
          if (left.length) { res.conflicts = left; return res }
          throw new GitError(`Couldn't merge ${up}: ${friendly(merged)}`)
        }
        res.pulled = behind
      }
    }
  }
  if (o.push !== false) {
    const up = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).out.trim() || null
    if (!(await exists(git, "HEAD"))) { res.notes.push("Nothing to push yet: no commits"); return res }
    const ahead = up ? await count(git, `${up}..HEAD`) : await count(git, "HEAD")
    if (ahead) {
      o.step?.("Pushing")
      const r = await git(up ? ["push", "--quiet", t.remote, `HEAD:${up.slice(t.remote.length + 1)}`] : ["push", "--quiet", "-u", t.remote, t.branch], { timeout: 120_000 })
      if (r.code !== 0) {
        if (/\[rejected\]|non-fast-forward|fetch first/i.test(`${r.err}${r.out}`)) throw new GitError("The remote has commits this vault doesn't have yet: sync again to pull them first")
        throw new GitError(`Couldn't push: ${friendly(r)}`)
      }
      res.pushed = ahead
    }
  }
  return res
}

// ---------- a file's history

export type Version = { sha: string; t: number; author: string; subject: string; path: string; change: string }

/** A file's commits, newest first, following renames: each with the file's path then (vault paths). */
export async function fileLog(git: Git, repo: Repo, rel: string, limit = 100): Promise<Version[]> {
  const r = await git(["--literal-pathspecs", "log", "--follow", `-n${limit}`, "--format=%x1e%H%x1f%ct%x1f%an%x1f%s", "--name-status", "--", rel])
  if (r.code !== 0) return []
  const out: Version[] = []
  for (const block of r.out.split("\x1e").slice(1)) {
    const [head, ...rest] = block.split("\n")
    const [sha, t, author, subject] = head.split("\x1f")
    const line = rest.find((l) => /^[A-Z]\d*\t/.test(l)) ?? ""
    const f = line.split("\t")
    const p = (f[0]?.startsWith("R") || f[0]?.startsWith("C") ? f[2] : f[1]) ?? `${repo.prefix}${rel}`
    out.push({ sha, t: Number(t) * 1000, author, subject, path: p.startsWith(repo.prefix) ? p.slice(repo.prefix.length) : p, change: (f[0] ?? "M")[0] })
  }
  return out
}

/** The repository's last commits, newest first. */
export async function log(git: Git, limit = 30): Promise<(Commit & { files: number })[]> {
  const r = await git(["log", `-n${limit}`, "--format=%x1e%H%x1f%ct%x1f%an%x1f%s", "--shortstat"])
  if (r.code !== 0) return []
  return r.out.split("\x1e").slice(1).map((block) => {
    const [head, ...rest] = block.split("\n")
    const [sha, t, author, subject] = head.split("\x1f")
    const files = Number(/(\d+) files? changed/.exec(rest.join(" "))?.[1] ?? 0)
    return { sha, t: Number(t) * 1000, author, subject, files }
  })
}

/** A file's text at a commit (its path then), or null when it wasn't there. */
export async function show(git: Git, repo: Repo, rev: string, rel: string): Promise<string | null> {
  if (!/^[\w^~.-]+$/.test(rev) || rev.startsWith("-")) throw new GitError(`'${rev}' isn't a commit`)
  const r = await git(["show", `${rev}:${repo.prefix}${rel}`])
  return r.code === 0 ? r.out : null
}
