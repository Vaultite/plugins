// Agents against fake CLIs (Claude chat's fake-claude.mjs, fake-codex.mjs): threads of both harnesses, streamed answers,
// permission asks answered both ways, diffs and the changes summary, stop, resume after a restart, projects, the ops.
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
const claudeRuns = () => fs.readFileSync(path.join(state, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.argv?.includes("--include-partial-messages"))
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
    && l.params.developerInstructions?.includes("Agents") && l.params.approvalPolicy === "on-request" && l.params.sandbox === "read-only"), codexLog().filter((l) => l.method === "thread/start"))
  check("codex: titled from the message", t.title === "Hello codex", t.title)

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
  check("codex: the turn has the new model, policy and sandbox", turn?.params.model === "gpt-6-luna" && turn.params.approvalPolicy === "on-request" && turn.params.sandboxPolicy?.type === "workspaceWrite", turn?.params)

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
  const [, made2] = await s.api("POST", "agents/threads", { harness: "claude" })
  const cl = made2.id as string
  await s.api("POST", `agents/threads/${cl}/send`, { text: "Please edit Notes/Garden.md", file: "Notes/Garden.md" })
  t = await until(cl, (t) => t.entries.some((e) => e.kind === "ask" && !e.answer))
  const run = claudeRuns()[0]
  check("claude: runs in the vault, stream json, a new session", fs.realpathSync(run.cwd) === fs.realpathSync(s.vault) && flag(run.argv, "--session-id") === t.session && flag(run.argv, "--permission-mode") === "default", run)
  const ca = t.entries.find((e) => e.kind === "ask" && !e.answer)
  check("claude: asks before the edit, the note a link", ca?.tool === "Edit" && ca.file === "Notes/Garden.md", ca)
  await s.api("POST", `agents/threads/${cl}/answer`, { ask: ca!.id, allow: true })
  t = await until(cl, (t, running) => !running && t.entries.at(-1)?.kind === "assistant")
  check("claude: allowed, the note changed", s.read("Notes/Garden.md").includes("# Garden (edited)"))
  const cs = await summary(cl)
  check("claude: the summary's changes, in the vault project", cs?.changes.files[0]?.file === "Notes/Garden.md" && cs.project === "Vault" && cs.harness === "claude", cs)

  // A model change starts claude again, resuming the session.
  await s.api("PATCH", `agents/threads/${cl}`, { model: "haiku", mode: "edits" })
  await s.api("POST", `agents/threads/${cl}/send`, { text: "and now?" })
  t = await until(cl, (t, running) => !running && t.entries.at(-1)?.text === "You said: and now?\n\n- one\n- two")
  const again = claudeRuns().at(-1)
  check("claude: resumed with the new model and mode", flag(again.argv, "--resume") === t.session && flag(again.argv, "--model") === "haiku" && flag(again.argv, "--permission-mode") === "acceptEdits", again?.argv)

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
