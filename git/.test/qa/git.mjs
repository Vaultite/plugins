// Git in a browser: the Source control panel making the vault a repository, staging and committing, Commit and sync
// to a remote (a bare repository in a temp folder), a file's diff, its git history and a restore, a merge conflict
// (another clone pushes first: the panel, the Inbox and the file tree say so; resolved and committed), the status bar;
// desktop and 390px, light and dark, with screenshots. WRITES the vault (makes it a git repository) and its look (put
// back): throwaway server only.
//   node git/.test/qa/git.mjs <base url> <vault path> [out dir]   (VAULTITE_APP: the app's checkout)
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { install, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, VAULT, OUT0], browser, check, watch, noErrors, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const OUT = (OUT0 ?? "/tmp/git-shots").replace(/\/?$/, "/")
mkdirSync(OUT, { recursive: true })
const enc = encodeURIComponent
const api = async (method, p, body) => {
  const r = await fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text()
}
const file = (rel) => path.join(VAULT, rel)
const read = (rel) => readFileSync(file(rel), "utf8")
/** Whether any file of the vault (not .git) has `text` in it. */
const inVault = (text) => readdirSync(VAULT, { recursive: true }).some((rel) => {
  if (String(rel).split("/").includes(".git")) return false
  try { const st = statSync(file(rel)); return st.isFile() && st.size < 1 << 20 && readFileSync(file(rel), "utf8").includes(text) } catch { return false }
})
const write = (rel, text) => { mkdirSync(path.dirname(file(rel)), { recursive: true }); writeFileSync(file(rel), text) }

// Git for this script's own clone: a made-up author, none of this machine's config.
const TMP = mkdtempSync(path.join(realpathSync(os.tmpdir()), "vaultite-git-qa-"))
writeFileSync(path.join(TMP, "gitconfig"), "[user]\n\tname = Sam Lee\n\temail = sam@example.com\n[init]\n\tdefaultBranch = main\n")
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] })
const REMOTE = path.join(TMP, "remote.git"), OTHER = path.join(TMP, "other")
git(TMP, "init", "-q", "--bare", REMOTE)

if (existsSync(file(".git"))) { console.error("The vault is a git repository already: use a fresh sandbox"); process.exit(2) }
install(B, "git")
const look = await api("GET", "config/appearance").catch(() => ({}))
const NOTE = "QA/Git/Lighthouse.md", OTHER_NOTE = "QA/Git/Keeper.md"
write(NOTE, "# Lighthouse\n\nThe lamp is lit at dusk.\n\n## Keeper\n\nAlice Park keeps the log.\n")
write(OTHER_NOTE, "# Keeper\n\nShifts at six.\n")
await wait(1200)

async function open(w, h, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { deviceScaleFactor: 2 }) })
  return { ctx, page: watch(await ctx.newPage(), { label: `${w}px`, console: true }) }
}
const shot = async (page, name, el) => { await wait(500); await (el ?? page).screenshot({ path: `${OUT}${name}.png` }); console.log(`     ${OUT}${name}.png`) }
async function go(page, hash) {
  await page.goto("about:blank")
  await page.goto(`${B}#${hash}`)
  await until(() => page.locator("main").count(), 8000)
  await wait(1500)
}
const panel = (page) => page.locator("aside [data-git-panel], [data-git-panel]").first()
const row = (page, p, side = "unstaged") => panel(page).locator(`[data-git-file="${p}"][data-side="${side}"]`)

try {
  // ---------- desktop, light: a vault that isn't a repository yet
  await api("PATCH", "config/appearance", { theme: "light" })
  {
    const { ctx, page } = await open(1440, 900)
    await go(page, `file/${enc(NOTE)}`)
    const p = panel(page)
    check("the panel is in the sidebar", await until(() => p.count(), 6000))
    check("it offers to make a repository", await until(() => p.locator("[data-git-init]").count(), 6000))
    await shot(page, "desktop-light-not-a-repo")
    await p.locator("[data-git-init]").click()
    check("Make a repository: git init and a .gitignore", await until(() => existsSync(file(".git")) && existsSync(file(".gitignore")), 8000))
    check("the panel lists the vault's files as new", await until(() => row(page, NOTE).count(), 8000))
    check("a new file says U", (await row(page, NOTE).innerText()).trim().endsWith("U"), await row(page, NOTE).innerText())
    check("no remote yet: an address to add", await p.locator("input[aria-label='Remote address']").count() === 1)
    await p.locator("input[aria-label='Remote address']").fill(REMOTE)
    await p.locator("input[aria-label='Remote address']").press("Enter")
    check("the remote is set", await until(() => git(VAULT, "remote", "get-url", "origin").trim() === REMOTE, 6000))

    // Commit and sync: the first commit, pushed.
    await p.locator("[data-git-message]").fill("Start the vault's history")
    await p.locator("[data-git-sync]").click()
    check("Commit and sync commits and pushes", await until(() => { try { return git(REMOTE, "log", "-1", "--format=%s").trim() === "Start the vault's history" } catch { return false } }, 15000))
    check("then nothing is pending", await until(() => p.locator("[data-git-clean]").count(), 8000))
    check("the message box is emptied", await until(async () => (await p.locator("[data-git-message]").inputValue()) === "", 4000))

    // Changes: one staged with its +, committed alone with a message.
    write(NOTE, read(NOTE).replace("lit at dusk", "lit at dusk and put out at dawn"))
    write(OTHER_NOTE, read(OTHER_NOTE) + "\nNights only in winter.\n")
    write("QA/Git/New idea.md", "A new note.\n")
    check("changes show with their letters", await until(async () => (await row(page, NOTE).count()) && (await row(page, OTHER_NOTE).count()), 8000))
    check("a modified file says M", (await row(page, NOTE).innerText()).trim().endsWith("M"))
    await row(page, NOTE).hover()
    await shot(page, "desktop-light-changes")
    await row(page, NOTE).getByRole("button", { name: "Stage" }).click()
    check("+ stages it", await until(() => row(page, NOTE, "staged").count(), 6000))
    check("the staged one is in Staged changes", await p.locator("[data-git-section='Staged changes']").count() === 1)
    await p.locator("[data-git-message]").fill("Say when the lamp goes out")
    await p.locator("[data-git-commit]").click()
    check("Commit commits only what's staged", await until(() => git(VAULT, "log", "-1", "--format=%s").trim() === "Say when the lamp goes out", 8000) &&
      git(VAULT, "show", "--name-only", "--format=", "HEAD").trim() === NOTE)
    check("the others stay pending", await until(async () => (await row(page, NOTE).count()) === 0 && (await row(page, OTHER_NOTE).count()) === 1, 6000))
    check("the branch line says one to push", await until(async () => /↑?1/.test(await p.locator("[data-git-branch]").innerText()), 4000), await p.locator("[data-git-branch]").innerText())
    const status = page.locator("footer, [data-statusbar], body").locator("button[aria-label^='Git:']").first()
    check("the status bar says changes, ahead and the last commit", await until(() => status.count(), 4000) && /2.*↑1/.test(await status.innerText()), await status.innerText().catch(() => null))
    await shot(page, "desktop-light-committed")

    // A file's diff: click its row.
    await row(page, OTHER_NOTE).click()
    check("a row opens its diff", await until(() => page.locator("[data-git-diff-view]").count(), 6000))
    check("the diff shows the added line in green", await until(() => page.locator("[data-git-diff-view] [data-diff=add]", { hasText: "Nights only in winter." }).count(), 4000))
    await shot(page, "desktop-light-diff")
    await ctx.close()
  }

  // A version to go back to: commit and sync what's pending, then change the note again.
  await api("POST", "ops/git.sync", { message: "Winter nights, a new idea" })
  write(NOTE, "# Lighthouse\n\nThe lamp was replaced.\n")
  await api("POST", "ops/git.commit", { message: "Replace the lamp", files: [NOTE] })

  // ---------- desktop, dark: a file's history and a restore
  await api("PATCH", "config/appearance", { theme: "dark" })
  {
    const { ctx, page } = await open(1440, 900)
    await go(page, `view/${enc(`git-history/${NOTE}`)}`)
    const h = page.locator("[data-git-history]")
    check("the history lists the file's commits", await until(async () => (await h.locator("[role=option]").count()) === 3, 8000), await h.locator("[role=option]").allInnerTexts().catch(() => []))
    check("newest first, with the message", (await h.locator("[role=option]").first().innerText()).includes("Replace the lamp"))
    await h.locator("[role=option]", { hasText: "Start the vault's history" }).click()
    await until(() => h.locator("[data-git-diff] [data-diff=add]").count(), 4000)
    await shot(page, "desktop-dark-history")
    await h.getByRole("radio", { name: "Text" }).click()
    check("a version reads as its text, read-only", await until(() => h.locator("[data-git-version-text]", { hasText: "The lamp is lit at dusk." }).count(), 4000))
    await shot(page, "desktop-dark-history-text")
    await h.getByRole("button", { name: "Restore" }).click()
    check("Restore writes that version back", await until(() => read(NOTE).includes("The lamp is lit at dusk.") && !read(NOTE).includes("put out at dawn"), 6000), read(NOTE))
    check("it offers Undo", await until(() => page.getByRole("button", { name: "Undo" }).count(), 3000))
    await page.getByRole("button", { name: "Undo" }).click()
    check("Undo puts it back", await until(() => read(NOTE).includes("The lamp was replaced."), 6000), read(NOTE))

    // File history lists the commits beside its own versions.
    await go(page, `view/${enc(`history/${NOTE}`)}`)
    const fh = page.locator("[data-history]")
    check("File history lists the file's commits", await until(async () => (await fh.locator("[role=option][data-source=git]").count()) === 3, 8000), await fh.locator("[role=option]").allInnerTexts().catch(() => []))
    await fh.locator("[role=option][data-source=git]", { hasText: "Start the vault's history" }).click()
    check("and compares one with the file now", await until(() => fh.locator("[data-diff=add]", { hasText: "The lamp is lit at dusk." }).count(), 4000))
    await shot(page, "desktop-dark-file-history")

    // The settings sheet: a token kept on the server's machine, never shown again.
    await go(page, "view/git/plugin-settings/git")
    const st = page.locator("[data-git-settings]")
    check("the settings sheet has the repository and the token", await until(() => st.count(), 6000) && (await st.innerText()).includes(VAULT.split("/").pop()))
    await st.locator("input[aria-label=Token]").fill("ghp_madeupqa123456")
    await st.getByRole("button", { name: "Save" }).click()
    check("a token saved is kept", await until(async () => (await api("GET", "git/token")).set === true, 4000))
    check("and only said to be there", await until(async () => (await st.locator("input[aria-label=Token]").inputValue()) === "" && !(await page.content()).includes("ghp_madeupqa"), 4000) &&
      !JSON.stringify(await api("GET", "git/token")).includes("ghp_") && !inVault("ghp_madeupqa"))
    await shot(page, "desktop-dark-settings")
    await st.getByRole("button", { name: "Remove" }).click()
    check("and removed", await until(async () => (await api("GET", "git/token")).set === false, 4000))
    await ctx.close()
  }

  // ---------- a merge conflict: another clone pushes a change to the same line first
  await api("POST", "ops/git.sync", {})
  git(TMP, "clone", "-q", REMOTE, OTHER)
  writeFileSync(path.join(OTHER, NOTE), "# Lighthouse\n\nThe lamp was replaced by Sam.\n")
  git(OTHER, "commit", "-qam", "Sam's lamp"); git(OTHER, "push", "-q")
  write(NOTE, "# Lighthouse\n\nThe lamp was replaced by Alice.\n")
  await wait(800)
  {
    const { ctx, page } = await open(1440, 900)
    await go(page, `file/${enc(NOTE)}`)
    const p = panel(page)
    await until(() => row(page, NOTE).count(), 8000)
    await p.locator("[data-git-sync]").click()
    check("the sync stops at the conflict", await until(() => p.locator("[data-git-merge]").count(), 15000))
    check("the conflicted file is listed", await until(() => p.locator("[data-git-section='Merge conflicts']").locator(`[data-git-file="${NOTE}"]`).count(), 4000))
    check("nothing lost: both sides in the file", read(NOTE).includes("by Alice") && read(NOTE).includes("by Sam") && read(NOTE).includes("<<<<<<<"))
    const events = await api("GET", "inbox/events")
    const ev = events.events?.find((e) => e.source === "git")
    check("the Inbox says so, with the file and a way to Source control", ev?.title.includes("merge conflicts") && ev.body.includes(NOTE) && ev.link === "view:git", ev)
    check("the state lists it for the file tree", await until(async () => (await api("GET", "state")).git?.conflicts?.includes(NOTE), 6000))
    for (const folder of ["QA", "QA/Git"]) {
      if (!(await page.locator(`[data-tree-path="${NOTE}"]`).count())) await page.locator(`[data-tree-path="${folder}"] button[data-keyrow]`).first().click().catch(() => {})
      await wait(300)
    }
    check("the file tree marks it", await until(() => page.locator(`[data-tree-path="${NOTE}"] [data-file-mark]`, { hasText: "C" }).count(), 6000))
    check("Commit and sync waits for the conflict", await p.locator("[data-git-sync]").isDisabled())
    await shot(page, "desktop-dark-conflict")
    // Commit with the markers still there is refused.
    await p.locator("[data-git-commit]").click()
    check("Commit refuses while markers are left", await until(() => page.getByText("conflict markers").count(), 4000))
    write(NOTE, "# Lighthouse\n\nThe lamp was replaced by Alice and Sam.\n")
    await wait(800)
    await p.locator("[data-git-commit]").click()
    check("resolved, Commit finishes the merge", await until(async () => (await p.locator("[data-git-merge]").count()) === 0, 8000) && git(VAULT, "log", "-1", "--format=%p").trim().split(" ").length === 2)
    await p.locator("[data-git-sync]").click()
    check("then it syncs", await until(() => git(REMOTE, "log", "-1", "--format=%s").trim() === git(VAULT, "log", "-1", "--format=%s").trim(), 15000))
    await ctx.close()
  }

  // ---------- phone, 390px: the panel's tab and a diff, dark then light
  write(OTHER_NOTE, read(OTHER_NOTE) + "\nA phone edit.\n")
  await wait(800)
  for (const theme of ["dark", "light"]) {
    await api("PATCH", "config/appearance", { theme })
    const { ctx, page } = await open(390, 844, true)
    await go(page, "view/git")
    const p = page.locator("[data-git-page] [data-git-panel]")
    check(`phone ${theme}: the Source control tab`, await until(() => p.locator(`[data-git-file="${OTHER_NOTE}"]`).count(), 8000))
    const box = await p.locator(`[data-git-file="${OTHER_NOTE}"]`).boundingBox()
    check(`phone ${theme}: rows are a finger's height`, box && box.height >= 30, box)
    check(`phone ${theme}: nothing wider than the screen`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await shot(page, `phone-${theme}-panel`)
    await p.locator(`[data-git-file="${OTHER_NOTE}"]`).click()
    check(`phone ${theme}: the diff`, await until(() => page.locator("[data-git-diff-view] [data-diff=add]").count(), 6000))
    await shot(page, `phone-${theme}-diff`)
    await ctx.close()
  }
  noErrors()
} finally {
  await api("PATCH", "config/appearance", { theme: look.theme ?? null }).catch(() => {})
  rmSync(TMP, { recursive: true, force: true })
}
await done()
