// Agents against the fake CLIs: both harnesses, permissions, modes, questions, queue and steer, Edit from here, forks,
// task lists, git with the model's text, settling and the list's states, a pull request into a thread, the ops.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const state = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"))
const claude = path.join(state, "claude"), codex = path.join(state, "codex")
fs.symlinkSync(path.join(import.meta.dirname, "..", "..", "claude-chat", ".test", "fake-claude.mjs"), claude)
fs.symlinkSync(path.join(import.meta.dirname, "fake-codex.mjs"), codex)
process.env.AGENTS_CLAUDE_CLI = claude
process.env.AGENTS_CODEX_CLI = codex
process.env.FAKE_CLAUDE_STATE = state
process.env.FAKE_CODEX_STATE = state
const gh = path.join(state, "gh")
fs.symlinkSync(path.join(import.meta.dirname, "fake-gh.mjs"), gh)
process.env.AGENTS_GH_CLI = gh
process.env.FAKE_GH_STATE = state
process.env.AGENTS_WORKTREES = path.join(state, "worktrees")
// Git with a made-up author, never the machine's config.
process.env.GIT_CONFIG_GLOBAL = path.join(state, "gitconfig")
process.env.GIT_CONFIG_NOSYSTEM = "1"
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Alice Park\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n")
// As under launchd: a bare PATH, where the fakes (node scripts, like Homebrew's codex) find node only if we add it.
process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

const { check, done, serve } = await import("../../testkit.ts")
const s = await serve(["agents"])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Thread = { id: string; title: string; harness: string; cwd: string; session: string; started: boolean; model: string; mode: string; entries: Record<string, any>[] } // eslint-disable-line @typescript-eslint/no-explicit-any
const get = async (id: string) => (await s.api("GET", `agents/threads/${id}`))[1] as { thread: Thread; live: { running: boolean; status: string } }
async function until(id: string, ok: (t: Thread, running: boolean) => boolean, ms = 8000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(60)) { const r = await get(id); if (ok(r.thread, r.live.running)) return r.thread }
  return (await get(id)).thread
}
const summary = async (id: string) => (await s.api("GET", "agents/threads"))[1].list.find((x: { id: string }) => x.id === id)
const codexLog = () => fs.readFileSync(path.join(state, "codex.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
const claudeLog = () => fs.readFileSync(path.join(state, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
const claudeRuns = () => claudeLog().filter((x) => x.argv?.includes("--include-partial-messages"))
const stdinOf = () => claudeLog().filter((x) => x.stdin)
const flag = (argv: string[], f: string) => argv[argv.indexOf(f) + 1]
const project = fs.mkdtempSync(path.join(os.tmpdir(), "agents-project-"))
fs.writeFileSync(path.join(project, "app.ts"), "export const answer = 41\n")

try {
  const [, st] = await s.api("GET", "agents/status?fresh=1")
  check("status: both installed and signed in", st.claude.installed && st.claude.loggedIn && st.codex.installed && st.codex.loggedIn, st)
  check("status: each one's models (Codex's hidden ones left out)", st.claude.models.some((m: { value: string }) => m.value === "haiku")
    && st.codex.models.map((m: { value: string }) => m.value).join() === "gpt-6.1-sol,gpt-6-luna", st)

  // Projects: the vault, and a project file whose checkout is here.
  s.write("Projects/Lighthouse.md", `---\ntype: project\nstatus: building\npath: ${project}\n---\n`)
  await sleep(400)
  const [, pr] = await s.api("GET", "agents/projects")
  check("projects: the vault first, then Lighthouse's checkout", pr.list[0].vault && pr.list.some((p: { label: string; path: string }) => p.label === "Lighthouse" && p.path === fs.realpathSync(project)), pr.list)
  const [bad] = await s.api("POST", "agents/threads", { harness: "codex", cwd: "/no/such/folder" })
  check("a folder that isn't there is refused", bad === 400, bad)

  // ---------- Codex in a project: stream, ask before an edit, allow, its diff
  const [, made] = await s.api("POST", "agents/threads", { harness: "codex", cwd: project, mode: "ask" })
  const cx = made.id as string
  await s.api("POST", `agents/threads/${cx}/send`, { text: "Hello codex" })
  let t = await until(cx, (t, running) => !running && t.entries.some((e) => e.kind === "assistant" && !e.open))
  check("codex: the answer streamed back", t.entries.find((e) => e.kind === "assistant")?.text?.startsWith("You said: Hello codex"), t.entries)
  check("codex: started a thread in the project, with Agents' instructions", t.started && !!t.session && codexLog().some((l) => l.method === "thread/start" && l.params.cwd === fs.realpathSync(project)
    && l.params.developerInstructions?.includes("Agents") && l.params.approvalPolicy === "untrusted" && l.params.sandbox === "read-only"), codexLog().filter((l) => l.method === "thread/start"))
  check("codex: initialized with the experimental API (plan mode, steering)", codexLog().some((l) => l.method === "initialize" && l.params.capabilities?.experimentalApi === true))
  t = await until(cx, (t) => t.title === "Hello Codex")
  check("codex: titled by the model from the message (codex exec, its small model)", t.title === "Hello Codex" && codexLog().some((l) => l.exec?.includes("gpt-6-luna") && l.exec.includes("--output-schema")), t.title)

  await s.api("POST", `agents/threads/${cx}/send`, { text: "please edit app.ts" })
  t = await until(cx, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  const ask = t.entries.find((e) => e.kind === "ask" && !e.answer)
  check("codex: asks before the edit, with its diff", ask?.tool === "Edit" && ask.path === path.join(fs.realpathSync(project), "app.ts") && ask.patch?.[0]?.lines?.includes("+export const answer = 41 (edited)"), ask)
  check("codex: its read is a Read of the file", t.entries.some((e) => e.kind === "tool" && e.name === "Read" && e.path?.endsWith("app.ts") && e.result?.includes("answer")), t.entries.filter((e) => e.kind === "tool"))
  check("codex: the list says it's waiting", (await summary(cx))?.waiting === true)
  await s.api("POST", `agents/threads/${cx}/answer`, { ask: ask!.id, allow: true })
  t = await until(cx, (t, running) => !running)
  check("codex: allowed, the file changed", fs.readFileSync(path.join(project, "app.ts"), "utf8").includes("41 (edited)"))
  check("codex: the edit is kept with its diff", t.entries.some((e) => e.kind === "tool" && e.name === "Edit" && !e.error && e.patch?.length), t.entries.filter((e) => e.kind === "tool"))
  const sum = await summary(cx)
  check("codex: the summary's changes and last answer", sum?.changes.files.length === 1 && sum.changes.added === 1 && sum.changes.removed === 1 && sum.last.includes("I edited") && sum.project === "Lighthouse", sum)

  // Deny a command.
  await s.api("POST", `agents/threads/${cx}/send`, { text: "run the thing" })
  t = await until(cx, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  const cmd = t.entries.find((e) => e.kind === "ask" && !e.answer)
  check("codex: asks before a command, unwrapped, with its reason", cmd?.tool === "Bash" && cmd.input.command === "printf 'hi\\n' > out.txt" && cmd.input.description === "Allow making out.txt?", cmd)
  await s.api("POST", `agents/threads/${cx}/answer`, { ask: cmd!.id, allow: false })
  t = await until(cx, (t, running) => !running)
  check("codex: denied, nothing ran", !fs.existsSync(path.join(project, "out.txt")) && t.entries.at(-1)?.text === "I didn't run it.", t.entries.slice(-2))

  // Accept edits: no question; a mode change goes with the next turn.
  await s.api("PATCH", `agents/threads/${cx}`, { mode: "edits", model: "gpt-6-luna" })
  await s.api("POST", `agents/threads/${cx}/send`, { text: "run it now" })
  t = await until(cx, (t, running) => !running)
  const turn = codexLog().filter((l) => l.method === "turn/start").at(-1)
  check("codex: accept edits runs without asking", fs.existsSync(path.join(project, "out.txt")) && !t.entries.slice(-3).some((e) => e.kind === "ask"), t.entries.slice(-3))
  check("codex: the turn has the new model, policy, reviewer and sandbox", turn?.params.model === "gpt-6-luna" && turn.params.approvalPolicy === "on-request" && turn.params.approvalsReviewer === "user" && turn.params.sandboxPolicy?.type === "workspaceWrite", turn?.params)

  // Stop, mid-answer.
  await s.api("POST", `agents/threads/${cx}/send`, { text: "be slow" })
  await until(cx, (t) => (t.entries.at(-1)?.text ?? "").includes("word5"))
  await s.api("POST", `agents/threads/${cx}/stop`, {})
  t = await until(cx, (t, running) => !running)
  check("codex: stop ends the turn part way", !t.entries.filter((e) => e.kind === "assistant").at(-1)?.text.includes("word200") && t.entries.at(-1)?.text === "Stopped.", t.entries.slice(-2))

  // A failed turn says why.
  await s.api("POST", `agents/threads/${cx}/send`, { text: "fail please" })
  t = await until(cx, (t, running) => !running && t.entries.at(-1)?.kind === "note")
  check("codex: a failed turn says why", t.entries.at(-1)?.error && t.entries.at(-1)?.text === "The fake model fell over", t.entries.at(-1))

  // The process dies under it: the turn fails, and the next one resumes the thread in a new process.
  await s.api("POST", `agents/threads/${cx}/send`, { text: "crash now" })
  t = await until(cx, (t, running) => !running && t.entries.at(-1)?.kind === "note")
  check("codex: its process dying fails the turn", t.entries.at(-1)?.error === true, t.entries.at(-1))
  await s.api("POST", `agents/threads/${cx}/send`, { text: "still there?" })
  t = await until(cx, (t, running) => !running && t.entries.at(-1)?.text?.startsWith("You said: still there?"))
  check("codex: a new process resumes the same thread", codexLog().some((l) => l.method === "thread/resume" && l.params.threadId === t.session) && t.entries.at(-1)?.text?.startsWith("You said"), codexLog().filter((l) => l.method?.startsWith("thread/")))
  await s.api("PATCH", `agents/threads/${cx}`, { mode: "ask" })
  await s.api("POST", `agents/threads/${cx}/send`, { text: "edit app.ts again" })
  t = await until(cx, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  const [allowed] = await s.api("POST", `agents/threads/${cx}/answer`, { ask: t.entries.find((e) => e.kind === "ask" && !e.answer)!.id, allow: true })
  t = await until(cx, (t, running) => !running)
  check("codex: in the new process, questions are answered (its request ids start again)", allowed === 200 && t.entries.at(-1)?.text?.includes("I edited"), t.entries.slice(-2))

  // ---------- Claude Code in the vault
  s.write("Notes/Garden.md", "# Garden\n\nTomatoes by the fence\n")
  const [, made2] = await s.api("POST", "agents/threads", { harness: "claude", mode: "ask" })
  const cl = made2.id as string
  await s.api("POST", `agents/threads/${cl}/send`, { text: "Please edit Notes/Garden.md", file: "Notes/Garden.md" })
  t = await until(cl, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  const run = claudeRuns()[0]
  check("claude: runs in the vault, stream json, a new session", fs.realpathSync(run.cwd) === fs.realpathSync(s.vault) && flag(run.argv, "--session-id") === t.session && flag(run.argv, "--permission-mode") === "default"
    && run.argv.includes("--allow-dangerously-skip-permissions") && !run.argv.includes("--disallowedTools"), run)
  const ca = t.entries.find((e) => e.kind === "ask" && !e.answer)
  check("claude: asks before the edit, the note a link", ca?.tool === "Edit" && ca.file === "Notes/Garden.md", ca)
  await s.api("POST", `agents/threads/${cl}/answer`, { ask: ca!.id, allow: true })
  t = await until(cl, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("claude: allowed, the note changed", s.read("Notes/Garden.md").includes("# Garden (edited)"))
  const cs = await summary(cl)
  check("claude: the summary's changes, in the vault project", cs?.changes.files[0]?.file === "Notes/Garden.md" && cs.project === "Vault" && cs.harness === "claude", cs)

  // A model or mode change goes to the running claude (set_model, set_permission_mode): no restart.
  const runsBefore = claudeRuns().length
  await s.api("PATCH", `agents/threads/${cl}`, { model: "haiku", mode: "edits" })
  await s.api("POST", `agents/threads/${cl}/send`, { text: "and now?" })
  t = await until(cl, (t, running) => !running && t.entries.at(-1)?.text === "You said: and now?\n\n- one\n- two")
  const told = stdinOf().map((x) => x.stdin.request).filter((r) => r?.subtype === "set_model" || r?.subtype === "set_permission_mode")
  check("claude: model and mode changed as it runs, no restart", claudeRuns().length === runsBefore && told.some((r) => r.subtype === "set_model" && r.model === "haiku")
    && told.some((r) => r.subtype === "set_permission_mode" && r.mode === "acceptEdits"), told)

  // ---------- git: a thread in its own worktree, its turns' diffs, revert, commit, push and a pull request
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agents-repo-")), remote = `${repo}-remote.git`
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" })
  sh(repo, "init", "-q"); fs.writeFileSync(path.join(repo, "app.ts"), "export const answer = 41\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "first")
  execFileSync("git", ["init", "-q", "--bare", remote]); sh(repo, "remote", "add", "origin", remote); sh(repo, "push", "-q", "-u", "origin", "main")
  const [, wt] = await s.api("POST", "agents/threads", { harness: "codex", cwd: repo, mode: "edits", worktree: true })
  await s.api("POST", `agents/threads/${wt.id}/send`, { text: "please edit app.ts" })
  t = await until(wt.id, (t, running) => !running && t.entries.at(-1)?.kind === "assistant" && !!(t.entries[0] as { after?: string }).after)
  const w = (t as Thread & { worktree?: { top: string; branch: string } }).worktree
  check("worktree: made at the first message, on a branch the model named", w?.branch === "agents/fix-edit-app-ts" && (t.cwd === fs.realpathSync(w.top) || t.cwd === w?.top), { w, cwd: t.cwd })
  check("worktree: the edit is there, not in the checkout", fs.readFileSync(path.join(w!.top, "app.ts"), "utf8").includes("(edited)") && !fs.readFileSync(path.join(repo, "app.ts"), "utf8").includes("(edited)"))
  const u0 = t.entries[0] as { before?: string; after?: string; end?: string }
  check("a turn keeps its end and checkpoints", !!u0.end && !!u0.before && !!u0.after && u0.before !== u0.after, u0)
  check("the list groups it under its checkout, with its branch", (await summary(wt.id))?.home === fs.realpathSync(repo) && (await summary(wt.id))?.branch === w?.branch, await summary(wt.id))
  let [, df] = await s.api("GET", `agents/threads/${wt.id}/diff?turn=0`)
  check("diff: a turn's, from git", df.source === "git" && df.files.length === 1 && df.files[0].path === "app.ts" && df.files[0].added === 1 && df.files[0].removed === 1, df)
  await s.api("POST", `agents/threads/${wt.id}/send`, { text: "run it now" })
  t = await until(wt.id, (t, running) => !running && !!(t.entries.at(-1)?.kind === "assistant" && (t.entries.findLast((e) => e.kind === "user") as { after?: string }).after))
  const second = t.entries.findLastIndex((e) => e.kind === "user")
  ;[, df] = await s.api("GET", `agents/threads/${wt.id}/diff?turn=${second}`)
  check("diff: what a command made counts too (untracked files)", df.files.length === 1 && df.files[0].path === "out.txt" && df.files[0].status === "added", df)
  ;[, df] = await s.api("GET", `agents/threads/${wt.id}/diff`)
  check("diff: the whole thread's", df.files.map((f: { path: string }) => f.path).sort().join() === "app.ts,out.txt", df)
  const [rv] = await s.api("POST", `agents/threads/${wt.id}/revert`, { turn: second })
  check("revert: the files as before that turn", rv === 200 && !fs.existsSync(path.join(w!.top, "out.txt")) && fs.readFileSync(path.join(w!.top, "app.ts"), "utf8").includes("(edited)"))
  let [, g] = await s.api("GET", `agents/threads/${wt.id}/git`)
  check("git: the branch and its changed files", g.git.branch === w?.branch && g.git.files === 1 && g.git.worktree && g.git.base === "main" && g.git.gh, g)
  const [code2, cp] = await s.api("POST", `agents/threads/${wt.id}/git`, { action: "commit-push-pr", message: "fix: the answer is right" })
  check("git: commit, push and a pull request", code2 === 200 && !!cp.commit && cp.pushed && cp.pr === "https://github.com/alice/lighthouse/pull/7", cp)
  check("git: the commit is on the remote's branch", sh(remote, "log", "--format=%s", w!.branch).startsWith("fix: the answer is right"))
  const ghArgs = fs.readFileSync(path.join(state, "gh.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((x) => x.argv[1] === "create")
  check("git: the pull request's title and body by the model, its base and head", ghArgs?.argv.includes("--base") && ghArgs.argv[ghArgs.argv.indexOf("--head") + 1] === w?.branch
    && ghArgs.argv[ghArgs.argv.indexOf("--title") + 1] === "Make the answer right" && ghArgs.argv[ghArgs.argv.indexOf("--body") + 1].includes("## Summary"), ghArgs)
  ;[, g] = await s.api("GET", `agents/threads/${wt.id}/git?pr=1`)
  check("git: clean, pushed, and its pull request", g.git.files === 0 && g.git.ahead === 0 && g.git.pr?.number === 7, g)
  const [nothing, why] = await s.api("POST", `agents/threads/${wt.id}/git`, { action: "commit", message: "x" })
  check("git: nothing to commit says so", nothing === 409 && /nothing to commit/.test(why.error ?? JSON.stringify(why)), why)
  const [, br] = await s.api("GET", `agents/branches?cwd=${encodeURIComponent(repo)}`)
  check("branches: the checkout's, the worktree's marked", br.git && br.list.some((b: { name: string; current: boolean }) => b.name === "main" && b.current) && br.list.some((b: { name: string; worktree: string }) => b.name === w?.branch && b.worktree), br)
  // The pull request merged after the last message: the thread settles by itself.
  check("unread: a turn that ended with no one looking is Done", (await summary(wt.id))?.unread === true, await summary(wt.id))
  check("not settled while its pull request is open", !(await summary(wt.id))?.settledAt)
  const prFile = path.join(state, "gh-pr.json")
  fs.writeFileSync(prFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(prFile, "utf8")), state: "MERGED", mergedAt: new Date(Date.now() + 1000).toISOString() }))
  await s.api("GET", `agents/threads/${wt.id}/git?pr=1`)
  await sleep(150)
  check("auto-settle: its pull request merged", !!(await summary(wt.id))?.settledAt && (await summary(wt.id))?.pr?.state === "MERGED", await summary(wt.id))

  // A commit with no message: the model writes it; when the model fails, the thread's title.
  fs.writeFileSync(path.join(w!.top, "app.ts"), "export const answer = 42\n")
  let [cm, cmr] = await s.api("POST", `agents/threads/${wt.id}/git`, { action: "commit" })
  check("commit message by the model (codex exec, its small model)", cm === 200 && sh(w!.top, "log", "-1", "--format=%B").startsWith("fix(app): make the answer right\n\n- app.ts now answers 42"), { cm, cmr, log: sh(w!.top, "log", "-1", "--format=%B") })
  fs.writeFileSync(path.join(state, "codex-exec-fails"), "")
  fs.writeFileSync(path.join(w!.top, "app.ts"), "export const answer = 43\n")
  ;[cm, cmr] = await s.api("POST", `agents/threads/${wt.id}/git`, { action: "commit" })
  check("the model failing: the thread's title instead", cm === 200 && sh(w!.top, "log", "-1", "--format=%s").trim() === t.title, sh(w!.top, "log", "-1", "--format=%s"))
  fs.rmSync(path.join(state, "codex-exec-fails"))

  // New thread on its branch: the same worktree, the same project.
  const [, onb] = await s.api("POST", "agents/threads", { harness: "claude", cwd: w!.top, share: wt.id })
  const onbT = (await get(onb.id)).thread as Thread & { worktree?: { top: string; branch: string } }
  check("New thread on a branch: shares its worktree", onbT.worktree?.branch === w!.branch && onbT.cwd === t.cwd && (await summary(onb.id))?.home === fs.realpathSync(repo), onbT.worktree)
  await s.api("DELETE", `agents/threads/${onb.id}`)
  check("deleting a thread that shares a worktree leaves it", fs.existsSync(w!.top))

  // A pull request into a thread (#12, at the remote's refs/pull/12/head), in a worktree and in the checkout.
  const tmpClone = fs.mkdtempSync(path.join(os.tmpdir(), "agents-pr-"))
  sh(tmpClone, "clone", "-q", remote, "c")
  fs.writeFileSync(path.join(tmpClone, "c", "header.ts"), "export const glow = true\n")
  sh(path.join(tmpClone, "c"), "add", "-A"); sh(path.join(tmpClone, "c"), "commit", "-qm", "glow"); sh(path.join(tmpClone, "c"), "push", "-q", "origin", "HEAD:refs/pull/12/head")
  const [prc, prw] = await s.api("POST", "agents/pr", { cwd: repo, ref: "https://github.com/alice/lighthouse/pull/12", mode: "worktree", harness: "codex" })
  const prT = (await get(prw.id)).thread as Thread & { worktree?: { top: string; branch: string; pr?: number } }
  check("Checkout Pull Request (worktree): its branch in a worktree of its own, a thread on it", prc === 200 && prw.number === 12 && prT.worktree?.branch === "glow-header" && prT.worktree.pr === 12
    && fs.existsSync(path.join(prT.cwd, "header.ts")) && prT.title === "#12 Make the header glow" && (await summary(prw.id))?.pr?.number === 12, { prc, prw, prT: prT.worktree })
  await s.api("DELETE", `agents/threads/${prw.id}`)
  const [badPr] = await s.api("POST", "agents/pr", { cwd: repo, ref: "#99", mode: "local" })
  check("a pull request gh can't find is refused", badPr === 409, badPr)
  const [lc, lpr] = await s.api("POST", "agents/pr", { cwd: repo, ref: "gh pr checkout 12", mode: "local" })
  check("Checkout Pull Request (local): gh pr checkout in the project", lc === 200 && sh(repo, "branch", "--show-current").trim() === "glow-header" && (await get(lpr.id)).thread.cwd === fs.realpathSync(repo), { lc, lpr })
  const [sw] = await s.api("POST", `agents/threads/${lpr.id}/git`, { action: "switch", branch: "main" })
  check("switch branch (⌘⇧G) in a local thread", sw === 200 && sh(repo, "branch", "--show-current").trim() === "main")
  const [mkb] = await s.api("POST", `agents/threads/${lpr.id}/git`, { action: "switch", branch: "try-this", create: true })
  check("create a branch from the picker", mkb === 200 && sh(repo, "branch", "--show-current").trim() === "try-this")
  sh(repo, "switch", "-q", "main")
  await s.api("DELETE", `agents/threads/${lpr.id}`)
  fs.rmSync(tmpClone, { recursive: true, force: true })

  const [, gone] = await s.api("DELETE", `agents/threads/${wt.id}`)
  check("delete: a clean worktree goes, its branch stays", !gone.kept && !fs.existsSync(w!.top) && sh(repo, "branch", "--list", w!.branch).includes(w!.branch) && !sh(repo, "for-each-ref", "refs/vaultite-agents/").trim(), gone)
  const [, cl2] = await s.api("GET", `agents/threads/${cl}/diff`)
  check("diff: a folder that isn't a checkout has its edits' patches", cl2.source === "edits" && cl2.files[0]?.file === "Notes/Garden.md" && cl2.files[0].added >= 1, cl2)

  // ---------- the list, the ops, handoff, delete
  const [, all] = await s.api("GET", "agents/threads")
  check("list: both threads, newest first", all.list.length === 2 && all.list[0].id === cl, all.list.map((x: { id: string }) => x.id))
  const out = s.vau("agents", "ask", "What is in the garden", "--thread", cl)
  check("op: agents ask waits for the answer", out.includes("You said: What is in the garden") && out.includes(`thread ${cl}`), out)
  const fresh = JSON.parse(s.vau("agents.ask", "Hi from a script", "--harness", "codex", "--cwd", project, "--json"))
  check("op: a new Codex thread in the project", fresh.harness === "codex" && fresh.answer.startsWith("You said: Hi from a script"), fresh)
  check("op: agents list", s.vau("agents", "list").includes("Lighthouse"))
  const [, hand] = await s.api("POST", `agents/threads/${cx}/handoff`, {})
  check("handoff: the harness and session to resume", hand.harness === "codex" && hand.session.length > 10, hand)
  await s.api("DELETE", `agents/threads/${fresh.thread}`)
  check("delete", (await s.api("GET", `agents/threads/${fresh.thread}`))[0] === 404)

  // ---------- access modes and plan mode, as T3 Code maps them
  const mk = async (b: Record<string, unknown>) => (await s.api("POST", "agents/threads", b))[1].id as string
  const turnStarts = () => codexLog().filter((l) => l.method === "turn/start")
  const full = await mk({ harness: "claude", mode: "full" })
  await s.api("POST", `agents/threads/${full}/send`, { text: "Please edit Notes/Garden.md" })
  t = await until(full, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("full access is the default setting, and claude bypasses permissions", flag(claudeRuns().at(-1).argv, "--permission-mode") === "bypassPermissions" && !t.entries.some((e) => e.kind === "ask"), t.entries.map((e) => e.kind))
  check("a new thread's default mode is full access", (await get(await mk({ harness: "codex", cwd: project }))).thread.mode === "full")
  await s.api("PATCH", `agents/threads/${full}`, { mode: "auto" })
  await s.api("POST", `agents/threads/${full}/send`, { text: "hi again" })
  await until(full, (t, running) => !running && t.entries.at(-1)?.text?.startsWith("You said: hi again"))
  check("claude: auto mode mid-thread (set_permission_mode auto)", stdinOf().some((x) => x.stdin.request?.subtype === "set_permission_mode" && x.stdin.request.mode === "auto"))
  const cfull = await mk({ harness: "codex", cwd: project, mode: "full" })
  await s.api("POST", `agents/threads/${cfull}/send`, { text: "run the thing" })
  t = await until(cfull, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("codex full access: never asks, no sandbox", turnStarts().at(-1)?.params.approvalPolicy === "never" && turnStarts().at(-1)?.params.sandboxPolicy?.type === "dangerFullAccess" && !t.entries.some((e) => e.kind === "ask"), turnStarts().at(-1)?.params)
  await s.api("PATCH", `agents/threads/${cfull}`, { mode: "auto" })
  await s.api("POST", `agents/threads/${cfull}/send`, { text: "hello" })
  await until(cfull, (t, running) => !running && t.entries.at(-1)?.text?.startsWith("You said: hello"))
  check("codex auto: its own reviewer (approvalsReviewer auto_review)", turnStarts().at(-1)?.params.approvalsReviewer === "auto_review" && turnStarts().at(-1)?.params.approvalPolicy === "on-request", turnStarts().at(-1)?.params)
  const [badMode] = await s.api("PATCH", `agents/threads/${cfull}`, { mode: "read" })
  check("an unknown mode is refused", badMode === 400, badMode)

  // Plan mode: Claude's ExitPlanMode becomes a plan card (it's told to wait); Implement here leaves plan mode.
  const pl = await mk({ harness: "claude", mode: "full", plan: true })
  await s.api("POST", `agents/threads/${pl}/send`, { text: "plan the fix" })
  t = await until(pl, (t, running) => !running && t.entries.some((e) => e.kind === "plan"))
  const planAt = t.entries.findIndex((e) => e.kind === "plan")
  check("claude plan mode: --permission-mode plan, the plan a card of its own", flag(claudeRuns().at(-1).argv, "--permission-mode") === "plan" && t.entries[planAt]?.text.includes("Make the answer 42") && !t.entries.some((e) => e.kind === "ask"), t.entries.map((e) => e.kind))
  check("claude plan mode: told the plan was captured, to wait", stdinOf().some((x) => x.stdin.type === "control_response" && x.stdin.response?.response?.behavior === "deny" && /captured your proposed plan/.test(x.stdin.response.response.message)))
  const [, impl] = await s.api("POST", `agents/threads/${pl}/implement`, { at: planAt, where: "here" })
  t = await until(pl, (t, running) => !running && t.entries.filter((e) => e.kind === "user").length === 2)
  check("Implement: out of plan mode, the plan sent back", impl.id === pl && !(t as Thread & { plan?: boolean }).plan && t.entries[planAt]?.done === "here" && t.entries.findLast((e) => e.kind === "user")?.text.startsWith("PLEASE IMPLEMENT THIS PLAN:\n# Fix the wrong answer")
    && stdinOf().some((x) => x.stdin.request?.subtype === "set_permission_mode" && x.stdin.request.mode === "bypassPermissions"), t.entries.slice(-3))
  const cpl = await mk({ harness: "codex", cwd: project, mode: "full", plan: true })
  await s.api("POST", `agents/threads/${cpl}/send`, { text: "plan the fix" })
  t = await until(cpl, (t, running) => !running && t.entries.some((e) => e.kind === "plan" && !e.open))
  check("codex plan mode: collaborationMode plan, its plan item a card", turnStarts().at(-1)?.params.collaborationMode?.mode === "plan" && t.entries.find((e) => e.kind === "plan")?.text.includes("Run the tests"), turnStarts().at(-1)?.params)
  const [, implNew] = await s.api("POST", `agents/threads/${cpl}/implement`, { at: t.entries.findIndex((e) => e.kind === "plan"), where: "thread" })
  t = await until(implNew.id, (t, running) => !running && t.entries.some((e) => e.kind === "assistant"))
  check("Implement in a new thread: titled after the plan, sent the plan", implNew.id !== cpl && t.title === "Implement Fix the wrong answer" && t.entries[0]?.text.startsWith("PLEASE IMPLEMENT THIS PLAN:"), { title: t.title, first: t.entries[0] })

  // ---------- the agents' own questions (Claude's AskUserQuestion, Codex's request for input)
  const qa = await mk({ harness: "claude", mode: "full" })
  await s.api("POST", `agents/threads/${qa}/send`, { text: "ask me a question first" })
  t = await until(qa, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  const qask = t.entries.find((e) => e.kind === "ask" && !e.answer)!
  check("claude: AskUserQuestion reaches us, even in full access", qask.tool === "AskUserQuestion" && qask.input.questions.length === 2 && qask.input.questions[1].multiSelect === true, qask)
  check("the list says it waits on the user's input", (await summary(qa))?.input === true && (await summary(qa))?.waiting === true, await summary(qa))
  await s.api("POST", `agents/threads/${qa}/answer`, { ask: qask.id, allow: true, answers: { "Which colour should the button be?": "Blue", "Which pages need it?": "Home, Settings" } })
  t = await until(qa, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("claude: the answers go back in its input, by question", t.entries.at(-1)?.text === "You picked: Blue; Home, Settings." && t.entries.find((e) => e.kind === "ask")?.answers?.["Which pages need it?"] === "Home, Settings", t.entries.slice(-2))
  await s.api("POST", `agents/threads/${qa}/send`, { text: "another question please" })
  t = await until(qa, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  await s.api("POST", `agents/threads/${qa}/answer`, { ask: t.entries.find((e) => e.kind === "ask" && !e.answer)!.id, allow: false })
  t = await until(qa, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("claude: a question dismissed is a no", t.entries.at(-1)?.text === "Okay, I won't ask.", t.entries.at(-1))
  const cq = await mk({ harness: "codex", cwd: project, mode: "full" })
  await s.api("POST", `agents/threads/${cq}/send`, { text: "a question for me" })
  t = await until(cq, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  const cqa = t.entries.find((e) => e.kind === "ask" && !e.answer)!
  check("codex: its request for input is a question too", cqa.tool === "AskUserQuestion" && cqa.input.questions[0].id === "colour" && cqa.input.questions[0].options.length === 2, cqa)
  await s.api("POST", `agents/threads/${cq}/answer`, { ask: cqa.id, allow: true, answers: { "Which colour should the button be?": "Teal" } })
  t = await until(cq, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("codex: answered by question id (an answer of its own too)", t.entries.at(-1)?.text === "You picked: Teal." && codexLog().some((l) => l.response?.result?.answers?.colour?.answers?.[0] === "Teal"), t.entries.at(-1))

  // ---------- queue and steer while it works
  const qu = await mk({ harness: "claude", mode: "full" })
  await s.api("POST", `agents/threads/${qu}/send`, { text: "please wait a moment" })
  await until(qu, (_t, running) => running)
  const [, q1] = await s.api("POST", `agents/threads/${qu}/send`, { text: "then say this" })
  const [, q2] = await s.api("POST", `agents/threads/${qu}/send`, { text: "and drop this one" })
  t = await until(qu, (t) => (t as Thread & { queue?: unknown[] }).queue?.length === 2)
  check("queue: messages while it works wait their turn", !!q1.queued && !!q2.queued && (t as Thread & { queue?: { text: string }[] }).queue?.map((x) => x.text).join() === "then say this,and drop this one", (t as Thread & { queue?: unknown }).queue)
  await s.api("POST", `agents/threads/${qu}/queue/${q2.queued}`, { action: "move", to: 0 })
  t = await get(qu).then((r) => r.thread)
  check("queue: moved to the front", (t as Thread & { queue?: { id: string }[] }).queue?.[0]?.id === q2.queued)
  const [, gone2] = await s.api("POST", `agents/threads/${qu}/queue/${q2.queued}`, { action: "remove" })
  check("queue: removed, its text back (to edit)", gone2.text === "and drop this one")
  t = await until(qu, (t, running) => !running && t.entries.at(-1)?.text?.startsWith("You said: then say this"), 10_000)
  check("queue: sent by itself once the turn ended", t.entries.filter((e) => e.kind === "user").map((e) => e.text).join("|") === "please wait a moment|then say this" && !(t as Thread & { queue?: unknown[] }).queue?.length, t.entries.filter((e) => e.kind === "user"))
  await s.api("POST", `agents/threads/${qu}/send`, { text: "please wait again" })
  await until(qu, (t, running) => running && t.entries.at(-1)?.kind === "tool")
  const [, st1] = await s.api("POST", `agents/threads/${qu}/send`, { text: "also say hi", steer: true })
  t = await until(qu, (t, running) => !running && t.entries.at(-1)?.kind === "assistant", 10_000)
  check("claude steer: taken into the turn under way, one turn", st1.steered && t.entries.at(-1)?.text === "Waited. And: also say hi" && t.entries.some((e) => e.kind === "user" && e.steer && e.text === "also say hi")
    && t.entries.filter((e) => e.kind === "user" && !e.steer).length === 3, t.entries.slice(-4))
  const cs2 = await mk({ harness: "codex", cwd: project, mode: "full" })
  await s.api("POST", `agents/threads/${cs2}/send`, { text: "please wait" })
  await until(cs2, (_t, running) => running)
  await sleep(200)
  const [, q3] = await s.api("POST", `agents/threads/${cs2}/send`, { text: "mention bananas" })
  await s.api("POST", `agents/threads/${cs2}/queue/${q3.queued}`, { action: "steer" })
  t = await until(cs2, (t, running) => !running && t.entries.at(-1)?.kind === "assistant", 10_000)
  check("codex steer: a queued message promoted (turn/steer with the turn's id)", t.entries.at(-1)?.text === "Waited. And: mention bananas" && codexLog().some((l) => l.method === "turn/steer" && l.params.expectedTurnId && l.params.input[0].text === "mention bananas"), t.entries.slice(-3))

  // ---------- Edit from here (the conversation and the files) and forks
  s.write("Notes/Pond.md", "# Pond\n\nFrogs at dusk\n")
  const rw = await mk({ harness: "claude", mode: "full" })
  for (const text of ["the first message", "please edit Notes/Pond.md", "the third message"]) {
    await s.api("POST", `agents/threads/${rw}/send`, { text })
    await until(rw, (t, running) => !running && t.entries.at(-1)?.kind === "assistant" && t.entries.some((e) => e.kind === "user" && e.text === text))
  }
  check("rewind: the note was edited", s.read("Notes/Pond.md").includes("# Pond (edited)"))
  t = (await get(rw)).thread
  const pondAt = t.entries.findIndex((e) => e.kind === "user" && e.text === "please edit Notes/Pond.md")
  const [rwCode, rwr] = await s.api("POST", `agents/threads/${rw}/rewind`, { turn: pondAt, files: true })
  t = (await get(rw)).thread
  check("rewind: back to before the message, its text answered for the box", rwCode === 200 && rwr.text === "please edit Notes/Pond.md" && t.entries.length === pondAt && !!(t as Thread & { resumeAt?: string }).resumeAt, { rwr, n: t.entries.length })
  check("rewind: the files too (Claude Code's own checkpoints, outside git)", rwr.files === 1 && s.read("Notes/Pond.md") === "# Pond\n\nFrogs at dusk\n", rwr)
  await s.api("POST", `agents/threads/${rw}/send`, { text: "what did i say" })
  t = await until(rw, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  const resumed = claudeRuns().at(-1)
  check("rewind: claude resumes at the message before (--resume-session-at)", flag(resumed.argv, "--resume-session-at") === (t.entries[pondAt] as { prev?: string }).prev && t.entries.at(-1)?.text === "Before this you said: the first message", { argv: resumed.argv, said: t.entries.at(-1)?.text })
  const firstAnswer = t.entries.findIndex((e) => e.kind === "assistant")
  const [, fk] = await s.api("POST", `agents/threads/${rw}/fork`, { at: firstAnswer })
  let f = (await get(fk.id)).thread
  check("fork: a new thread with the conversation up to that answer", f.title.endsWith("(fork)") && f.entries.length === firstAnswer + 1 && !f.started, f.entries.map((e) => e.kind))
  await s.api("POST", `agents/threads/${fk.id}/send`, { text: "what did i say" })
  f = await until(fk.id, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  const forked = claudeRuns().at(-1)
  check("fork: claude forks the session there (--fork-session --resume-session-at)", forked.argv.includes("--fork-session") && flag(forked.argv, "--resume") === t.session && f.session !== t.session && f.started
    && f.entries.at(-1)?.text === "Before this you said: the first message", { argv: forked.argv, said: f.entries.at(-1)?.text })
  const crw = await mk({ harness: "codex", cwd: project, mode: "full" })
  for (const text of ["alpha message", "beta message"]) {
    await s.api("POST", `agents/threads/${crw}/send`, { text })
    await until(crw, (t, running) => !running && t.entries.some((e) => e.kind === "user" && e.text === text) && t.entries.at(-1)?.kind === "assistant")
  }
  t = (await get(crw)).thread
  const beta = t.entries.findIndex((e) => e.kind === "user" && e.text === "beta message")
  await s.api("POST", `agents/threads/${crw}/rewind`, { turn: beta, files: false })
  await s.api("POST", `agents/threads/${crw}/send`, { text: "what did i say" })
  t = await until(crw, (t, running) => !running && t.entries.at(-1)?.kind === "assistant" && t.entries.at(-2)?.text === "what did i say")
  check("codex rewind: thread/revert before that turn", codexLog().some((l) => l.method === "thread/revert") && t.entries.at(-1)?.text === "Before this you said: alpha message", t.entries.at(-1))
  const [, cfk] = await s.api("POST", `agents/threads/${crw}/fork`, { at: t.entries.findIndex((e) => e.kind === "assistant") })
  f = (await get(cfk.id)).thread
  check("codex fork: thread/fork through that turn", f.started && f.session !== t.session && codexLog().some((l) => l.method === "thread/fork" && l.params.lastTurnId), { f: f.session, t: t.session })

  // ---------- task lists: Claude's TodoWrite, Codex's plan
  const td = await mk({ harness: "claude", mode: "full" })
  await s.api("POST", `agents/threads/${td}/send`, { text: "make a todo list" })
  t = await until(td, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  const todos = t.entries.filter((e) => e.kind === "tool" && e.name === "TodoWrite").at(-1)?.input.todos
  check("claude: its to-do list as it goes", todos?.length === 3 && todos.every((x: { status: string }) => x.status === "completed"), todos)
  const ctd = await mk({ harness: "codex", cwd: project, mode: "full" })
  await s.api("POST", `agents/threads/${ctd}/send`, { text: "make a todo list" })
  t = await until(ctd, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  const ctodos = t.entries.filter((e) => e.kind === "tool" && e.name === "TodoWrite")
  check("codex: its plan's steps as one to-do list, kept up to date", ctodos.length === 1 && ctodos[0].input.todos.map((x: { status: string }) => x.status).join() === "completed,completed,completed" && ctodos[0].input.todos[0].content === "Read app.ts", ctodos)

  // ---------- effort, the context meter, and the approval's other answers
  const ef = await mk({ harness: "claude", mode: "full", effort: "high" })
  await s.api("POST", `agents/threads/${ef}/send`, { text: "hello effort" })
  t = await until(ef, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("claude effort: --effort as it starts", flag(claudeRuns().at(-1).argv, "--effort") === "high", claudeRuns().at(-1).argv)
  check("context: how full it is, from the CLI's usage", (t as Thread & { context?: { used: number; max: number } }).context?.max === 200000 && ((t as Thread & { context?: { used: number } }).context?.used ?? 0) > 20000, (t as Thread & { context?: unknown }).context)
  await s.api("PATCH", `agents/threads/${ef}`, { effort: "low" })
  await s.api("POST", `agents/threads/${ef}/send`, { text: "and now low" })
  await until(ef, (t, running) => !running && t.entries.at(-1)?.text?.startsWith("You said: and now low"))
  check("claude effort changed: started again, resuming", flag(claudeRuns().at(-1).argv, "--effort") === "low" && !!flag(claudeRuns().at(-1).argv, "--resume"), claudeRuns().at(-1).argv)
  const cef = await mk({ harness: "codex", cwd: project, mode: "full", effort: "xhigh" })
  await s.api("POST", `agents/threads/${cef}/send`, { text: "think hard" })
  t = await until(cef, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("codex effort per turn, and its context", turnStarts().at(-1)?.params.effort === "xhigh" && (t as Thread & { context?: { max: number } }).context?.max === 272000, turnStarts().at(-1)?.params)
  s.write("Notes/Shed.md", "# Shed\n\nRakes and hoes\n")
  const al = await mk({ harness: "claude", mode: "ask" })
  await s.api("POST", `agents/threads/${al}/send`, { text: "Please edit Notes/Shed.md" })
  t = await until(al, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  await s.api("POST", `agents/threads/${al}/answer`, { ask: t.entries.find((e) => e.kind === "ask" && !e.answer)!.id, allow: true, scope: "session" })
  t = await until(al, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("Always allow this session: claude gets its suggestions back as session permissions", stdinOf().some((x) => x.stdin.response?.response?.updatedPermissions?.[0]?.mode === "acceptEdits"))
  await s.api("POST", `agents/threads/${al}/send`, { text: "Please edit Notes/Shed.md again" })
  t = await until(al, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("…and it doesn't ask again in that session", t.entries.filter((e) => e.kind === "ask").length === 1 && s.read("Notes/Shed.md").includes("(edited) (edited)"), t.entries.filter((e) => e.kind === "ask").length)
  await s.api("PATCH", `agents/threads/${al}`, { mode: "ask" })
  s.write("Notes/Barn.md", "# Barn\n\nHay\n")
  const al2 = await mk({ harness: "claude", mode: "ask" })
  await s.api("POST", `agents/threads/${al2}/send`, { text: "Please edit Notes/Barn.md" })
  t = await until(al2, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  await s.api("POST", `agents/threads/${al2}/answer`, { ask: t.entries.find((e) => e.kind === "ask" && !e.answer)!.id, allow: false, scope: "cancel" })
  t = await until(al2, (t, running) => !running)
  check("Cancel: declined and the turn stopped", t.entries.some((e) => e.kind === "note" && e.text === "Stopped.") && !s.read("Notes/Barn.md").includes("edited"), t.entries.slice(-3))
  const cal = await mk({ harness: "codex", cwd: project, mode: "ask" })
  await s.api("POST", `agents/threads/${cal}/send`, { text: "run the thing" })
  t = await until(cal, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  await s.api("POST", `agents/threads/${cal}/answer`, { ask: t.entries.find((e) => e.kind === "ask" && !e.answer)!.id, allow: true, scope: "session" })
  await until(cal, (_t, running) => !running)
  check("codex: Always allow this session is acceptForSession", codexLog().some((l) => l.response?.result?.decision === "acceptForSession"))

  // ---------- settle, pin, snooze, archive, unread, auto-settle, titles
  await s.api("POST", `agents/threads/${td}/settle`, { settled: true })
  let sm = await summary(td)
  check("settle: settled by hand, when", sm?.settledAt && sm.settledOverride === "settled", sm)
  await s.api("POST", `agents/threads/${td}/settle`, { settled: false })
  sm = await summary(td)
  check("un-settle: back, kept out of settling by itself", !sm?.settledAt && sm?.settledOverride === "active", sm)
  await s.api("POST", `agents/threads/${td}/settle`, { settled: true })
  await s.api("POST", `agents/threads/${td}/send`, { text: "hello again" })
  sm = await summary(td)
  check("a new message brings a settled thread back", !sm?.settledAt && !sm?.settledOverride, sm)
  await until(td, (_t, running) => !running)
  await s.api("POST", `agents/threads/${td}/state`, { pinned: true, unread: true })
  sm = await summary(td)
  check("pin and mark unread", !!sm?.pinnedAt && sm.unread === true, sm)
  await s.api("POST", `agents/threads/${td}/settle`, { settled: true })
  sm = await summary(td)
  check("settling unpins (T3 Code's: done beats on top)", !!sm?.settledAt && !sm.pinnedAt, sm)
  const soon = new Date(Date.now() + 3_600_000).toISOString()
  await s.api("POST", `agents/threads/${qa}/state`, { snoozedUntil: soon })
  check("snooze: until a time", (await summary(qa))?.snoozedUntil === soon)
  await s.api("POST", `agents/threads/${qa}/state`, { snoozedUntil: null, autoSettle: false, archived: true })
  sm = await summary(qa)
  check("wake, auto-settle off, archive", !sm?.snoozedUntil && sm?.autoSettleOff === true && sm.archived === true, sm)
  const [, ttl] = await s.api("POST", `agents/threads/${qa}/title`, {})
  check("Regenerate title: the model's, from the thread", ttl.title === "Another Question" || ttl.title?.length > 0, ttl)

  // Signed out, then not installed.
  fs.writeFileSync(path.join(state, "codex-logged-out"), "")
  const [, st2] = await s.api("GET", "agents/status?fresh=1")
  check("codex signed out: status says so", st2.codex.installed && !st2.codex.loggedIn, st2.codex)
  await s.api("POST", `agents/threads/${cx}/send`, { text: "hi" })
  t = await until(cx, (t, running) => !running && t.entries.at(-1)?.kind === "note")
  check("codex signed out: the thread says to sign in", t.entries.at(-1)?.signIn === true, t.entries.at(-1))
  fs.rmSync(codex)
  const [, st3] = await s.api("GET", "agents/status?fresh=1")
  check("codex not installed: status says so", !st3.codex.installed && st3.claude.installed, st3)
  const [code] = await s.api("POST", `agents/threads/${cx}/send`, { text: "hi" })
  check("codex not installed: sending is refused", code === 424, code)

  // Through Tailscale Serve, someone else than the owner is refused.
  const r = await fetch(`${s.base}api/agents/threads`, { headers: { "Tailscale-User-Login": "someone@example.com" } })
  check("owner only", r.status === 403, r.status)
} finally {
  s.stop()
  fs.rmSync(state, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
}
done()
