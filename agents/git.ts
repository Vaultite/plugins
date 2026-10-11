// Git for a thread: its checkout's branch and state, a worktree of its own, a checkpoint of the files at each turn's
// start and end (a tree under refs/vaultite-agents/, so a turn's diff is git's), and commit, push and a pull request.
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cliPath, env, str } from "./core.ts"
import type { GitState } from "./types.ts"

type Out = { code: number; out: string; err: string }

/** A program by argv (never a shell) in its own session, prompts off: a remote wanting a password fails, never hangs. */
function exec(bin: string, args: string[], cwd: string, o: { env?: Record<string, string>; timeout?: number } = {}) {
  return new Promise<Out>((resolve) => {
    let out = "", err = "", done = false
    const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...env(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1", LC_ALL: "C", ...o.env } })
    const finish = (r: Out) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGTERM") } catch { /* gone */ }
      finish({ code: 124, out, err: `${err}\n${path.basename(bin)} took too long and was stopped` })
    }, o.timeout ?? 30_000)
    child.stdout.setEncoding("utf8").on("data", (d: string) => { if (out.length < 8 << 20) out += d })
    child.stderr.setEncoding("utf8").on("data", (d: string) => { if (err.length < 1 << 20) err += d })
    child.on("error", (e) => finish({ code: 127, out: "", err: e.message }))
    child.on("close", (code) => finish({ code: code ?? 1, out, err }))
  })
}

const gitBin = () => cliPath("git", "AGENTS_GIT_CLI")
export const ghBin = () => cliPath("gh", "AGENTS_GH_CLI")
export const git = (cwd: string, args: string[], o: { env?: Record<string, string>; timeout?: number } = {}) => {
  const bin = gitBin()
  return bin ? exec(bin, ["-c", "core.quotepath=off", "-c", "color.ui=never", ...args], cwd, o) : Promise.resolve({ code: 127, out: "", err: "git isn't installed" })
}
const redact = (s: string) => s.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@").replace(/\b(gh[pousr]_|github_pat_|glpat-)[\w-]+/g, "$1***")
/** A failed command's last lines, without git's hints. */
export function said(r: Out, what = "git") {
  const lines = redact(`${r.err}\n${r.out}`).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:") && !l.startsWith('(use "git'))
  return lines.slice(-4).join(" ").slice(0, 400) || `${what} exited with ${r.code}`
}
async function ok(cwd: string, args: string[], o?: { env?: Record<string, string>; timeout?: number }) {
  const r = await git(cwd, args, o)
  if (r.code) throw new Error(said(r))
  return r.out
}

/** The checkout `cwd` is in: its top folder, or null when it isn't one. */
export async function topOf(cwd: string) {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"])
  return r.code ? null : r.out.trim()
}

/** Where a thread's branch, its files and the remote stand. */
export async function stateOf(cwd: string, worktree = false): Promise<GitState | null> {
  const top = await topOf(cwd)
  if (!top) return null
  const [st, remote, gh] = await Promise.all([
    git(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    git(cwd, ["remote", "get-url", "origin"]),
    Promise.resolve(ghBin()),
  ])
  let branch = "", upstream = "", ahead = 0, behind = 0, files = 0
  for (const l of st.out.split("\n")) {
    if (l.startsWith("# branch.head ")) branch = l.slice(14).trim()
    else if (l.startsWith("# branch.upstream ")) upstream = l.slice(18).trim()
    else if (l.startsWith("# branch.ab ")) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { ahead = +m[1]; behind = +m[2] } }
    else if (l && !l.startsWith("#")) files++
  }
  if (branch === "(detached)") branch = ""
  const base = await defaultBranch(cwd)
  // (a branch with no upstream yet: what it has that the default branch doesn't)
  if (!upstream && branch && base && branch !== base) {
    const r = await git(cwd, ["rev-list", "--count", `${base}..HEAD`])
    if (!r.code) ahead = Number(r.out.trim()) || 0
  }
  return { top, branch, base, upstream, ahead, behind, files, remote: remote.code ? "" : redact(remote.out.trim()), gh: !!gh, worktree }
}

export async function defaultBranch(cwd: string) {
  const r = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
  if (!r.code && r.out.trim()) return r.out.trim().replace(/^origin\//, "")
  for (const b of ["main", "master", "trunk"]) if (!(await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code) return b
  return ""
}

export async function branches(cwd: string) {
  const out = await ok(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)%09%(worktreepath)", "refs/heads"])
  return out.split("\n").filter(Boolean).map((l) => { const [name, head, wt] = l.split("\t"); return { name, current: head === "*", worktree: wt || "" } })
}

/** Switch the checkout to `branch` (made from where it is when `create`). */
export async function checkout(cwd: string, branch: string, create = false) {
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) throw new Error(`'${branch}' isn't a branch name`)
  await ok(cwd, ["switch", ...(create ? ["-c"] : []), branch])
}

// ---------- a pull request into a thread (T3 Code's Checkout Pull Request)

export type PullRequest = { number: number; title: string; url: string; state: string; head: string }

/** A pull request by its number, URL or `gh pr checkout` command, as gh sees it from `cwd`'s checkout. */
export async function prView(cwd: string, ref: string): Promise<PullRequest> {
  const gh = ghBin()
  if (!gh) throw new Error("GitHub's gh isn't installed on this machine")
  const r = await exec(gh, ["pr", "view", ref, "--json", "number,title,url,state,headRefName"], cwd, { timeout: 30_000 })
  if (r.code) throw new Error(said(r, "gh"))
  const j = JSON.parse(r.out)
  return { number: Number(j.number), title: str(j.title), url: str(j.url), state: str(j.state), head: str(j.headRefName) }
}

/** The pull request's branch in the checkout itself (gh pr checkout), or in a new worktree of it. */
export async function prCheckout(cwd: string, pr: PullRequest, worktree: boolean) {
  const top = await topOf(cwd)
  if (!top) throw new Error(`${cwd} isn't a git checkout`)
  if (!worktree) {
    const r = await exec(ghBin()!, ["pr", "checkout", String(pr.number)], top, { timeout: 120_000 })
    if (r.code) throw new Error(said(r, "gh"))
    return { path: cwd, top, branch: (await git(top, ["branch", "--show-current"])).out.trim() || pr.head }
  }
  const taken = await branches(top)
  const held = taken.find((b) => b.name === pr.head && b.worktree)
  if (held) throw new Error(`${pr.head} is checked out in ${held.worktree}: use Local, or switch that checkout off it first`)
  await ok(top, ["fetch", "origin", `+refs/pull/${pr.number}/head:refs/heads/${pr.head}`], { timeout: 120_000 })
  const at = path.join(worktreesDir(), path.basename(top), `pr-${pr.number}`)
  fs.mkdirSync(path.dirname(at), { recursive: true })
  if (!fs.existsSync(at)) await ok(top, ["worktree", "add", at, pr.head], { timeout: 120_000 })
  return { path: fs.realpathSync(at), top: fs.realpathSync(at), branch: pr.head }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 5).join("-").slice(0, 40)
/** Where worktrees go: ~/.vaultite/worktrees/<repo>/<branch> (AGENTS_WORKTREES moves it, for tests). */
const worktreesDir = () => process.env.AGENTS_WORKTREES || path.join(os.homedir(), ".vaultite", "worktrees")

/** A new worktree of `cwd`'s checkout on a new branch `agents/<what it's for>`, from `base` (the current branch). */
export async function newWorktree(cwd: string, what: string, base = "") {
  const top = await topOf(cwd)
  if (!top) throw new Error(`${cwd} isn't a git checkout`)
  const name = slug(what) || crypto.randomBytes(3).toString("hex")
  const taken = new Set((await branches(top)).map((b) => b.name))
  const at = (b: string) => path.join(worktreesDir(), path.basename(top), b.slice("agents/".length))
  let branch = `agents/${name}`
  // (a folder left by a worktree of another checkout with the same name counts as taken too)
  for (let n = 2; taken.has(branch) || fs.existsSync(at(branch)); n++) branch = `agents/${name}-${n}`
  fs.mkdirSync(path.dirname(at(branch)), { recursive: true })
  await ok(top, ["worktree", "add", "-b", branch, at(branch), ...(base ? [base] : [])], { timeout: 120_000 })
  // (a worktree sits at the same place inside the checkout as the thread's folder did)
  const real = fs.realpathSync(at(branch))
  const inside = path.relative(top, fs.realpathSync(cwd))
  return { path: inside && !inside.startsWith("..") ? path.join(real, inside) : real, top: real, branch }
}

/** Removes a worktree the thread made, unless it has changes not committed. */
export async function dropWorktree(top: string) {
  const st = await git(top, ["status", "--porcelain"])
  if (st.code || st.out.trim()) return false
  const main = (await git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).out.trim()
  const r = await git(path.dirname(main), ["worktree", "remove", top])
  if (r.code) console.error("agents: couldn't remove worktree", top, said(r))
  return !r.code
}

// ---------- checkpoints: the whole folder as a tree, kept by a ref so gc leaves it

/** The files as they are now, untracked ones too (not ignored ones), without touching the index: a tree's id. */
export async function checkpoint(cwd: string, ref: string) {
  const top = await topOf(cwd)
  if (!top) return ""
  const index = (await git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).out.trim()
  const tmp = path.join(os.tmpdir(), `agents-index-${crypto.randomBytes(4).toString("hex")}`)
  try {
    // (a copy of the real index, so only files changed since are read again)
    try { fs.copyFileSync(index, tmp) } catch { /* a new repo: none yet */ }
    const e = { GIT_INDEX_FILE: tmp }
    if ((await git(top, ["add", "-A", "--", "."], { env: e, timeout: 120_000 })).code) return ""
    const tree = (await git(top, ["write-tree"], { env: e })).out.trim()
    if (!tree) return ""
    const commit = await git(top, ["commit-tree", tree, "-m", "agents checkpoint"], { env: { GIT_AUTHOR_NAME: "Agents", GIT_AUTHOR_EMAIL: "agents@vaultite", GIT_COMMITTER_NAME: "Agents", GIT_COMMITTER_EMAIL: "agents@vaultite" } })
    if (!commit.code && ref) await git(top, ["update-ref", `refs/vaultite-agents/${ref}`, commit.out.trim()])
    return tree
  } finally { fs.rmSync(tmp, { force: true }) }
}

/** Keeps checkpoint `tree` under another thread's ref too (a fork's turns), so gc leaves it when the first goes. */
export async function keepCheckpoint(cwd: string, ref: string, tree: string) {
  const top = await topOf(cwd)
  if (!top || !tree) return
  const who = { GIT_AUTHOR_NAME: "Agents", GIT_AUTHOR_EMAIL: "agents@vaultite", GIT_COMMITTER_NAME: "Agents", GIT_COMMITTER_EMAIL: "agents@vaultite" }
  const commit = await git(top, ["commit-tree", tree, "-m", "agents checkpoint"], { env: who })
  if (!commit.code) await git(top, ["update-ref", `refs/vaultite-agents/${ref}`, commit.out.trim()])
}

export async function dropCheckpoints(cwd: string, thread: string) {
  const out = (await git(cwd, ["for-each-ref", "--format=%(refname)", `refs/vaultite-agents/${thread}/`])).out
  for (const r of out.split("\n").filter(Boolean)) await git(cwd, ["update-ref", "-d", r])
}

/** The unified diff between two checkpoints (or one and the files now), whole files' names relative to the checkout. */
export async function diffOf(cwd: string, from: string, to: string) {
  const top = await topOf(cwd)
  if (!top || !from) return ""
  const r = await git(top, ["diff", "--no-ext-diff", "--no-renames", "-U3", from, to || (await checkpoint(cwd, "")), "--"], { timeout: 60_000 })
  return r.code ? "" : r.out
}

/** Puts the files back as checkpoint `tree` had them: changed and deleted ones restored, ones made since removed. */
export async function restore(cwd: string, tree: string) {
  const top = await topOf(cwd)
  if (!top) throw new Error("not a git checkout")
  const now = await checkpoint(cwd, "")
  const made = (await ok(top, ["diff", "--name-only", "--diff-filter=A", "--no-renames", tree, now])).split("\n").filter(Boolean)
  for (const f of made) fs.rmSync(path.join(top, f), { force: true })
  const back = (await ok(top, ["diff", "--name-only", "--no-renames", "--diff-filter=MDT", tree, now])).split("\n").filter(Boolean)
  if (back.length) await ok(top, ["restore", `--source=${tree}`, "--worktree", "--", ...back])
  return made.length + back.length
}

// ---------- commit, push, pull request

/** What a branch has that `base` doesn't: its commits (one line each), the diff's stat and patch (a PR's text). */
export async function branchChanges(cwd: string, base: string) {
  const range = base ? [`${base}...HEAD`] : ["HEAD~1", "HEAD"]
  const [log, stat, patch] = await Promise.all([
    git(cwd, ["log", "--format=%h %s", base ? `${base}..HEAD` : "-1"]),
    git(cwd, ["diff", "--stat", ...range]),
    git(cwd, ["diff", "--no-ext-diff", ...range]),
  ])
  return { commits: log.out.trim(), stat: stat.out.trim(), patch: patch.out }
}

export async function commit(cwd: string, message: string) {
  const msg = message.trim()
  if (!msg) throw new Error("write a commit message")
  await ok(cwd, ["add", "-A"])
  const st = await git(cwd, ["diff", "--cached", "--quiet"])
  if (!st.code) throw new Error("nothing to commit")
  await ok(cwd, ["commit", "-q", "-m", msg], { timeout: 120_000 })
  return (await ok(cwd, ["rev-parse", "--short", "HEAD"])).trim()
}

export async function push(cwd: string) {
  const s = await stateOf(cwd)
  if (!s?.branch) throw new Error("not on a branch")
  if (!s.remote) throw new Error("this checkout has no remote called origin")
  await ok(cwd, s.upstream ? ["push"] : ["push", "-u", "origin", s.branch], { timeout: 120_000 })
}

/** The branch's open pull request, by gh: its number, link and state, or null. */
export async function prOf(cwd: string) {
  const gh = ghBin()
  if (!gh) return null
  const r = await exec(gh, ["pr", "view", "--json", "number,url,state,title,mergedAt,closedAt"], cwd, { timeout: 20_000 })
  if (r.code) return null
  try {
    const j = JSON.parse(r.out)
    const at = str(j.mergedAt) || str(j.closedAt)
    return { number: Number(j.number), url: str(j.url), state: str(j.state), title: str(j.title), ...(at ? { at } : {}) }
  } catch { return null }
}

export async function createPr(cwd: string, title: string, body: string) {
  const gh = ghBin()
  if (!gh) throw new Error("GitHub's gh isn't installed on this machine")
  const s = await stateOf(cwd)
  const r = await exec(gh, ["pr", "create", "--title", title, "--body", body || " ", ...(s?.base ? ["--base", s.base] : []), ...(s?.branch ? ["--head", s.branch] : [])], cwd, { timeout: 60_000 })
  if (r.code) throw new Error(said(r, "gh"))
  return r.out.trim().split("\n").filter((l) => /^https?:\/\//.test(l)).pop() ?? r.out.trim()
}
