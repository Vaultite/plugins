// Claude chat with a fake claude (../fake-claude.mjs): a message sent and its answer streamed, a tool use (the files as
// links, the edit's diff), a permission asked and answered both ways, Stop, a follow-up resuming the session after the
// mode changed, @ to point at a note, the open note's chip, the conversation list (new, rename, delete), Open in
// terminal, signed out; desktop (tab and sidebar) and a 390px phone, light and dark. Screenshots in the out dir.
// The server must run with CLAUDE_CHAT_CLI=<that fake> and FAKE_CLAUDE_STATE=<state dir>, and it WRITES (notes,
// conversations, a terminal): throwaway server only.
//   node claude-chat/.test/qa/chat.mjs <base url> <vault path> <state dir> [out dir]
import fs from "node:fs"
import path from "node:path"
import { install, palette, qa, SHOTS, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, STATE, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
fs.mkdirSync(OUT, { recursive: true })
const api = async (method, p, body) => {
  const r = await fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) })
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text()
}
const runs = () => fs.readFileSync(path.join(STATE, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.argv?.includes("--include-partial-messages"))
const flag = (argv, f) => argv[argv.indexOf(f) + 1]
const chatHash = (id) => `view/${encodeURIComponent(`claude-chat/${id}`)}`
const NOTE = "Notes/Qa chat.md", TEXT = "# Qa chat\n\nA note for Claude to edit.\n"

fs.rmSync(path.join(STATE, "logged-out"), { force: true })
fs.writeFileSync(path.join(STATE, "log.jsonl"), "")
await api("PUT", "file", { path: NOTE, text: TEXT })
await api("PATCH", "config/plugin/claude-chat", { mode: null, model: null }).catch(() => {})
install(B, "claude-chat")
for (const c of (await api("GET", "claude-chat/conversations")).list ?? []) await api("DELETE", `claude-chat/conversations/${c.id}`)

async function open(opts, label, hash = `file/${encodeURIComponent(NOTE)}`) {
  const ctx = await browser.newContext(opts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank")
  await page.goto(`${B}#${hash}`)
  await wait(2500)
  return { ctx, page }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `claude-chat-${name}.png`) })

// ---------- desktop, light: the tab
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 820 }, colorScheme: "light" }, "desktop")
  check("the sidebar has the chat", await page.locator("[data-chat-panel] [data-chat-input]").count() === 1)
  await palette(page, "New Claude chat", 1200)
  const T = "[data-chat-tab]"
  const input = page.locator(`${T} [data-chat-input]`)
  check("a new chat: the open note's chip", (await page.locator(`${T} [data-note-chip]`).getAttribute("data-note-chip")) === NOTE)
  check("the models are claude's own", await (async () => {
    await page.locator(`${T} [data-chat-model]`).click(); await wait(300)
    const rows = await page.locator("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]").allTextContents()
    await page.keyboard.press("Escape"); await wait(200)
    return rows.join("|").includes("Haiku 4.5")
  })())

  // Send, and the answer streams.
  await input.fill("be slow please")
  await input.press("Enter")
  const streamed = await until(async () => { const t = await page.locator(`${T} .note-prose`).last().textContent().catch(() => ""); return t.includes("word3") && !t.includes("word200") ? t : "" }, 6000, 40)
  check("the answer streams in", !!streamed, streamed)
  check("it says what it's doing", (await page.locator(`${T} [data-chat-status]`).getAttribute("data-chat-status")) === "writing")
  await shot(page, "desktop-streaming")
  await page.locator(`${T} [data-chat-stop]`).click()
  check("Stop stops it", await until(async () => !(await page.locator(`${T} [data-chat-stop]`).count()) && (await page.locator(`${T} [data-note]`).last().textContent()) === "Stopped.", 6000))
  const cut = await page.locator(`${T} .note-prose`).last().textContent()
  check("the answer stays where it stopped", cut.includes("word") && !cut.includes("word200"), cut.length)
  check("the conversation is named by its first message", (await page.locator(`${T} [data-chat-head]`).textContent()).includes("be slow please"))

  // A tool use: Read, then an Edit it asks for; the diff before Allow.
  await input.fill(`Please edit ${NOTE}`)
  await input.press("Enter")
  await page.locator(`${T} [data-ask=waiting]`).waitFor({ timeout: 8000 })
  const card = page.locator(`${T} [data-ask=waiting]`)
  check("it asks before editing, with the diff", (await card.textContent()).includes("Claude wants to edit") && await card.locator("[data-diff=add]").count() === 1)
  check("the status says it waits for you", (await page.locator(`${T} [data-chat-status]`).getAttribute("data-chat-status")) === "waiting")
  await shot(page, "desktop-ask")
  await card.locator("[data-answer=allow]").click()
  await until(async () => !(await page.locator(`${T} [data-chat-stop]`).count()), 8000)
  check("allowed: the note changed", fs.readFileSync(path.join(VAULT, NOTE), "utf8").includes("# Qa chat (edited)"))
  check("its tool lines link the note", await page.locator(`${T} [data-tool=Read] [data-file="${NOTE}"]`).count() === 1 && await page.locator(`${T} [data-tool=Edit] [data-file="${NOTE}"]`).count() === 1)
  await page.locator(`${T} [data-tool=Edit] [role=button]`).click()
  check("the edit opens to its diff", await page.locator(`${T} [data-tool=Edit] [data-diff=add]`).count() === 1)
  await shot(page, "desktop-edited")
  await page.locator(`${T} [data-tool=Read] [data-file="${NOTE}"]`).click()
  await wait(800)
  const chatTab = page.getByRole("tab", { name: /be slow please/ })
  check("a file link opens the note, the chat's tab kept", (await page.evaluate(() => location.hash)) === `#file/${encodeURIComponent(NOTE)}` && await chatTab.count() === 1)
  await chatTab.click(); await wait(600)

  // Deny: the note stays.
  const before = fs.readFileSync(path.join(VAULT, NOTE), "utf8")
  await input.fill(`edit ${NOTE} again`)
  await input.press("Enter")
  await page.locator(`${T} [data-ask=waiting] [data-answer=deny]`).click({ timeout: 8000 })
  await until(async () => !(await page.locator(`${T} [data-chat-stop]`).count()), 8000)
  check("denied: the note is as it was, and it says so", fs.readFileSync(path.join(VAULT, NOTE), "utf8") === before && await page.locator(`${T} [data-ask=deny]`).count() === 1)

  // The mode changed: the follow-up resumes the session in a new claude, which edits without asking.
  await page.locator(`${T} [data-chat-mode]`).click(); await wait(250)
  await page.getByText("Accept edits", { exact: true }).click(); await wait(500)
  await input.fill(`edit ${NOTE} once more`)
  await input.press("Enter")
  await until(async () => (await page.locator(`${T} .note-prose`).last().textContent()).includes("I edited"), 8000)
  const last = runs().at(-1)
  check("the follow-up resumes the session, in the new mode", runs().length === 2 && flag(last.argv, "--resume") && flag(last.argv, "--permission-mode") === "acceptEdits", last?.argv)
  check("accepting edits, it didn't ask", await page.locator(`${T} [data-ask=waiting]`).count() === 0)

  // @: a note picked, put in as its path.
  await input.fill("Look at ")
  await input.press("End")
  await input.pressSequentially("@")
  await page.locator("[role=option]").first().waitFor({ timeout: 3000 })
  await page.keyboard.type("Lisbon"); await wait(300)
  await page.keyboard.press("Enter"); await wait(300)
  check("@ puts a note's path in", (await input.inputValue()).includes("@Notes/Lisbon trip.md"), await input.inputValue())
  await input.fill("")
  await page.locator(`${T} [data-note-chip] button`).click()
  check("the note's chip goes when removed", await page.locator(`${T} [data-note-chip]`).count() === 0)

  // Open in terminal: the session goes to a Claude Code terminal (the fake keeps none, so it says it can't resume).
  const id = await page.locator(`${T} [data-claude-chat]`).getAttribute("data-claude-chat")
  await page.locator(`${T} [data-chat-more]`).click(); await wait(250)
  const term = page.getByText("Open in terminal", { exact: true })
  check("Open in terminal is offered", await term.count() === 1)
  await term.click(); await wait(2000)
  const session = (await api("GET", `claude-chat/conversations/${id}`)).conv.session
  check("it opens the session's terminal", (await page.evaluate(() => location.hash)).includes(`resume-claude-${session}`))
  await api("DELETE", `terminals/${encodeURIComponent(`resume-claude-${session}`)}`).catch(() => {})
  await wait(800)

  // The conversations: a second one, renamed, one deleted.
  await page.goto("about:blank"); await page.goto(`${B}#${chatHash(id)}`); await wait(2500)
  await page.locator(`${T} [data-chat-new]`).click(); await wait(300)
  await input.fill("A second chat")
  await input.press("Enter")
  await until(async () => (await page.locator(`${T} .note-prose`).count()) > 0, 6000)
  await page.locator(`${T} [data-chat-head] button`).first().dblclick()
  await page.locator(`${T} [data-chat-rename]`).fill("Renamed chat")
  await page.keyboard.press("Enter"); await wait(600)
  await page.locator(`${T} [data-chat-history]`).click(); await wait(300)
  const rows = await page.locator(`${T} [data-chat-row]`).allTextContents()
  check("the list has both, the renamed one", rows.length === 2 && rows.some((r) => r.includes("Renamed chat")), rows)
  await shot(page, "desktop-list")
  await page.locator(`${T} [data-chat-row]`).filter({ hasText: "Renamed chat" }).hover()
  await page.locator(`${T} [data-chat-row]`).filter({ hasText: "Renamed chat" }).getByLabel("Delete").click()
  await page.locator("[data-confirm] [data-confirm-ok]").click(); await wait(600)
  check("deleted after asking, a new chat in its place", await page.locator(`${T} [data-claude-chat=new]`).count() === 1)
  await page.locator(`${T} [data-chat-history]`).click(); await wait(300)
  check("the list has the other one", await page.locator(`${T} [data-chat-row]`).count() === 1)
  await page.locator(`${T} [data-chat-row]`).first().click(); await wait(500)

  // The sidebar's chat.
  const side = page.locator("[data-chat-panel] [data-chat-input]")
  await side.fill("Hello from the sidebar")
  await side.press("Enter")
  await until(async () => (await page.locator("[data-chat-panel] .note-prose").count()) > 0, 6000)
  await shot(page, "desktop-sidebar")
  check("the sidebar chats too", (await page.locator("[data-chat-panel] .note-prose").last().textContent()).includes("Hello from the sidebar"))
  await ctx.close()
}

// ---------- desktop, dark
{
  const id = (await api("GET", "claude-chat/conversations")).list.find((c) => c.title.startsWith("be slow")).id
  const { ctx, page } = await open({ viewport: { width: 1280, height: 820 }, colorScheme: "dark" }, "dark", chatHash(id))
  await page.locator("[data-chat-tab] [data-tool=Edit]").first().locator("[role=button]").click().catch(() => {})
  await wait(300)
  await shot(page, "desktop-dark")
  check("dark: the conversation is drawn", await page.locator("[data-chat-tab] [data-entry=user]").count() >= 3)
  await ctx.close()
}

// ---------- phone, 390 px, light and dark
await api("PATCH", "config/plugin/claude-chat", { mode: null })
for (const scheme of ["light", "dark"]) {
  const id = (await api("GET", "claude-chat/conversations")).list.find((c) => c.title.startsWith("be slow")).id
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme }, `phone ${scheme}`, chatHash(id))
  const T = "[data-chat-tab]"
  await page.locator(`${T} [data-chat-input]`).waitFor({ timeout: 8000 })
  const box = await page.locator(`${T} [data-composer]`).boundingBox()
  check(`phone ${scheme}: the box to write in is on screen`, box && box.y + box.height <= 844 && box.width <= 390, box)
  const wide = await page.evaluate(() => document.documentElement.scrollWidth)
  check(`phone ${scheme}: nothing wider than the screen`, wide <= 390, wide)
  const send = await page.locator(`${T} [data-chat-send]`).boundingBox()
  check(`phone ${scheme}: a 44px send button`, send && send.height >= 43, send)
  if (scheme === "light") {
    await page.locator(`${T} [data-chat-input]`).fill(`Please edit ${NOTE}`)
    await page.locator(`${T} [data-chat-send]`).tap()
    await page.locator(`${T} [data-ask=waiting]`).waitFor({ timeout: 8000 })
    await shot(page, "phone-ask")
    const allow = await page.locator(`${T} [data-ask=waiting] [data-answer=allow]`).boundingBox()
    check("phone: Allow is a 44px target", allow && allow.height >= 43, allow)
    await page.locator(`${T} [data-ask=waiting] [data-answer=allow]`).tap()
    await until(async () => !(await page.locator(`${T} [data-chat-stop]`).count()), 8000)
  }
  await shot(page, `phone-${scheme}`)
  await ctx.close()
}

// ---------- signed out
{
  fs.writeFileSync(path.join(STATE, "logged-out"), "")
  await api("GET", "claude-chat/status?fresh=1")
  const { ctx, page } = await open({ viewport: { width: 1280, height: 820 }, colorScheme: "light" }, "signed out", chatHash(""))
  check("signed out: it says so, with a way to sign in", await until(() => page.locator("[data-chat-tab] [data-chat-problem=signed-out]").count(), 5000))
  await shot(page, "signed-out")
  fs.rmSync(path.join(STATE, "logged-out"))
  await page.locator("[data-chat-tab] [data-chat-problem] button", { hasText: "Check again" }).click()
  check("checked again: ready", await until(async () => !(await page.locator("[data-chat-tab] [data-chat-problem]").count()), 5000))
  await ctx.close()
}

await done()
