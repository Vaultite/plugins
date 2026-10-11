// Agents with the fake CLIs: a Codex thread in its own worktree of a git project (turns folded behind "Worked for",
// each turn's changed files, the diff panel stacked and side by side, commit, push and a PR from the header), a Claude
// Code thread in the vault waiting on an approval, a new thread's workspace and branch; desktop light and dark, and a
// 390px phone. Screenshots in the out dir. The server must run with AGENTS_CLAUDE_CLI, AGENTS_CODEX_CLI, AGENTS_GH_CLI
// (the fakes), FAKE_CLAUDE_STATE = FAKE_CODEX_STATE = FAKE_GH_STATE = <state dir>, AGENTS_WORKTREES and a made-up
// GIT_CONFIG_GLOBAL, and it WRITES (threads, a project folder): throwaway server only.
//   node agents/.test/qa/shots.mjs <base url> <state dir> [out dir]
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { install, qa, SHOTS, until, wait } from "../../../qa.mjs"
const { args: [B, STATE, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
fs.mkdirSync(OUT, { recursive: true })
const api = async (method, p, body) => {
  const r = await fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) })
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text()
}
const get = async (id) => (await api("GET", `agents/threads/${id}`))
const idle = (id) => until(async () => { const r = await get(id); return !r.live.running && r.thread.entries.length ? r : null }, 10000, 80)

install(B, "agents")
fs.rmSync(path.join(STATE, "gh-pr.json"), { force: true })
for (const t of (await api("GET", "agents/threads")).list ?? []) await api("DELETE", `agents/threads/${t.id}`)

// A project: a git checkout of Lighthouse with a bare remote.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-qa-"))
const repo = path.join(tmp, "lighthouse"), remote = path.join(tmp, "remote.git")
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig") } })
fs.writeFileSync(path.join(tmp, "gitconfig"), "[user]\n\tname = Alice Park\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n")
fs.mkdirSync(repo)
git("init", "-q")
fs.writeFileSync(path.join(repo, "app.ts"), "export const answer = 41\nexport const name = \"Lighthouse\"\n")
fs.writeFileSync(path.join(repo, "README.md"), "# Lighthouse\n\nA small app.\n")
git("add", "-A"); git("commit", "-qm", "first")
execFileSync("git", ["init", "-q", "--bare", remote]); git("remote", "add", "origin", remote); git("push", "-q", "-u", "origin", "main")

const cx = (await api("POST", "agents/threads", { harness: "codex", cwd: repo, mode: "edits", worktree: true })).id
await api("POST", `agents/threads/${cx}/send`, { text: "Please edit app.ts so the answer is right" })
await idle(cx)
await api("POST", `agents/threads/${cx}/send`, { text: "Now edit README.md and run the build" })
await idle(cx)
await until(async () => (await get(cx)).thread.entries.filter((e) => e.kind === "user").every((e) => e.changes), 8000)
await api("PUT", "file", { path: "Notes/Garden.md", text: "# Garden\n\nTomatoes by the fence\n" })
const cl = (await api("POST", "agents/threads", { harness: "claude", mode: "ask" })).id
await api("POST", `agents/threads/${cl}/send`, { text: "Please edit Notes/Garden.md" })
await until(async () => (await get(cl)).thread.entries.some((e) => e.kind === "ask" && !e.answer), 8000)

const hashOf = (id) => `view/${encodeURIComponent(`agents/${id}`)}`
async function open(opts, label, id) {
  const ctx = await browser.newContext(opts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank")
  await page.goto(`${B}#${hashOf(id)}`)
  await page.waitForSelector("[data-agents-thread]", { timeout: 15000 })
  await wait(1500)
  return { ctx, page }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `agents-${name}.png`) })

const T = "[data-agents-thread]"
for (const scheme of ["light", "dark"]) {
  const { ctx, page } = await open({ viewport: { width: 1360, height: 860 }, colorScheme: scheme }, scheme, cx)
  check(`${scheme}: each done turn folded behind how long it took`, (await page.locator(`${T} [data-turn-fold]`).count()) >= 2, await page.locator(`${T} [data-turn-fold]`).allTextContents())
  check(`${scheme}: the header has the worktree's branch`, (await page.locator(`${T} [data-branch]`).getAttribute("data-branch"))?.startsWith("agents/"))
  check(`${scheme}: each turn's changed files`, (await page.locator(`${T} [data-changed-files]`).count()) === 2)
  if (scheme === "light") check("the git button offers commit, push and a PR", (await page.locator(`${T} [data-git-actions]`).getAttribute("data-git-actions")) === "commit-push-pr")
  await shot(page, `codex-${scheme}`)
  if (scheme === "light") {
    await page.locator(`${T} [data-turn-fold]`).first().click(); await wait(300)
    check("a fold opens to the turn's work", (await page.locator(`${T} [data-turn]`).first().locator("[data-work] [data-work-group], [data-work] [data-tool]").count()) >= 1)
    await page.locator(`${T} [data-turn]`).first().locator("[data-work-group] [aria-expanded]").first().click(); await wait(200)
    check("its tool calls' group opens to a line each", (await page.locator(`${T} [data-turn]`).first().locator("[data-tool]").count()) === 2)
    await shot(page, "codex-unfolded")
    await page.locator(`${T} [data-turn-fold]`).first().click()
    await page.locator(`${T} [data-changed-file="app.ts"]`).first().click(); await wait(800)
    check("a changed file opens the diff panel on its turn", await page.locator("[data-diff-panel]").count() === 1 && (await page.locator("[data-diff-path='app.ts'] [data-diff=add]").count()) === 1)
    await shot(page, "diff-turn")
    await page.locator("[data-diff-scope-button]").click(); await wait(200)
    await page.locator("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]", { hasText: "All turns" }).first().click(); await wait(800)
    check("the whole thread's diff: both files", (await page.locator("[data-diff-path]").count()) === 2, await page.locator("[data-diff-path]").evaluateAll((els) => els.map((e) => e.getAttribute("data-diff-path"))))
    await page.locator("[data-diff-split-toggle]").click(); await wait(400)
    await shot(page, "diff-split")
    await page.locator("[data-diff-split-toggle]").click()
    await page.locator(`${T} [data-agents-input]`).focus()
    await page.keyboard.press("ControlOrMeta+d"); await wait(300)
    check("⌘D closes the panel", await page.locator("[data-diff-panel]").count() === 0)
    await page.keyboard.press("ControlOrMeta+d"); await wait(500)
    check("⌘D opens it again", await page.locator("[data-diff-panel]").count() === 1)
    await page.keyboard.press("ControlOrMeta+d"); await wait(300)
    // Commit, push and a PR.
    await page.locator(`${T} [data-git-primary]`).click(); await wait(600)
    check("the commit box lists the changed files", (await page.locator("[data-commit-files] > div").count()) === 2)
    await page.locator("[data-commit-message]").fill("feat: the answer is right")
    await shot(page, "commit")
    await page.locator("[data-commit-go]").click()
    const after = await until(async () => (await page.locator(`${T} [data-git-actions]`).getAttribute("data-git-actions")) === "view" || null, 8000)
    check("committed, pushed and the PR opened: the button views it", after)
    const remoteLog = execFileSync("git", ["log", "--format=%s", "--all"], { cwd: remote, encoding: "utf8" })
    check("the commit reached the remote", remoteLog.includes("feat: the answer is right"), remoteLog)
    await wait(500)
    await shot(page, "after-pr")
    // A turn under way: "Working for", the answer streaming in; Esc interrupts it.
    await page.locator(`${T} [data-agents-input]`).fill("be slow please")
    await page.locator(`${T} [data-agents-input]`).press("Enter")
    check("a turn under way says how long it's been working", !!(await until(async () => /Working for|Writing for|Thinking for/.test(await page.locator(`${T} [data-working]`).textContent()) || null, 5000)))
    await wait(700)
    await shot(page, "running")
    await page.locator(`${T} [data-agents-input]`).press("Escape")
    check("interrupted: 'You stopped after'", !!(await until(async () => (await page.locator(`${T} [data-turn-fold]`).last().textContent())?.startsWith("You stopped after") || null, 6000)))
  }
  await page.goto(`${B}#${hashOf(cl)}`); await wait(1500)
  check(`${scheme}: the approval waits above the box to write in`, await page.locator(`${T} [data-approval] [data-answer=allow]`).count() === 1)
  await shot(page, `claude-ask-${scheme}`)
  await ctx.close()
}
// A new thread in the project: its workspace and branch.
{
  const { ctx, page } = await open({ viewport: { width: 1360, height: 860 }, colorScheme: "light" }, "new", cx)
  await page.locator('[data-thread-group="lighthouse"] > div').first().hover()
  await page.locator('[data-thread-group="lighthouse"] [aria-label="New thread in lighthouse"]').click(); await wait(1500)
  check("a new thread: the hero names the project", (await page.locator("[data-agents-hero]").textContent())?.includes("lighthouse"))
  check("a new thread: workspace and branch below the box", await page.locator("[data-branch-toolbar] [data-workspace=local]").count() === 1)
  await page.locator("[data-branch-toolbar] [data-workspace]").click(); await wait(200)
  await page.locator("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]", { hasText: "New worktree" }).first().click(); await wait(200)
  await shot(page, "new-thread")
  await ctx.close()
}
{
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, "phone", cx)
  await shot(page, "codex-phone")
  await page.locator(`${T} [data-open-diff]`).first().click(); await wait(800)
  await shot(page, "diff-phone")
  await ctx.close()
}
fs.rmSync(tmp, { recursive: true, force: true })
await done()
