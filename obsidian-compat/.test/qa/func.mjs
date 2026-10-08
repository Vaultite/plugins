// What each Obsidian plugin does here, not only that it loads: one check per plugin (a command run on a note, a view
// drawn, a code block rendered, settings shown), with a screenshot each. WRITES notes under "Qa obsidian": throwaway
// server only. `phone` runs at a phone's size and agent; `electron` drives the desktop app's window instead, over its
// DevTools port (VAULTITE_DEBUG_PORT 9351), on the server that window has.
//   node obsidian-compat/.test/qa/func.mjs <base url> [phone|electron] [plugin ids]
import fs from "node:fs"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const electron = process.argv[3] === "electron"
const { args: [B0, phoneArg = "", only = ""], browser, check, done } = await qa(import.meta.url, electron ? { chrome: false } : {})
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const phone = phoneArg === "phone"
const OUT = `/tmp/oc/shots/${phone ? "phone" : electron ? "electron" : "desktop"}`
fs.mkdirSync(OUT, { recursive: true })
const D = "Qa obsidian"
const list = await api("GET", "obsidian-compat/plugins")
for (const p of list) await api("POST", "obsidian-compat/enable", { id: p.id, on: true })
await api("DELETE", `file?path=${encodeURIComponent(D)}`).catch(() => {})
await api("POST", "folder", { path: D })
const note = async (name, text) => { await api("POST", "file", { path: `${D}/${name}.md`, text }); return `${D}/${name}.md` }
// (its body: the server adds frontmatter to what the API makes, origin: ai)
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`)).text.replace(/^---\n[\s\S]*?\n---\n\n?/, "")

const cdp = electron ? await (await import("playwright-core")).chromium.connectOverCDP("http://127.0.0.1:9351") : null
const ctx = cdp ? cdp.contexts()[0] : await browser.newContext(phone
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }
  : { viewport: { width: 1400, height: 900 } })
const page = cdp ? ctx.pages().find((p) => p.url().startsWith(B)) : await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e).slice(0, 300)))
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|Vim adapter|createServer|Buffer is not defined|realclaudian/.test(m.text())) errs.push(m.text().slice(0, 300)) })
await page.goto(B)
await until(() => page.evaluate(() => window.app?.workspace?.layoutReady), 30000)

const results = {}
// (an app window behind others may not draw: a screenshot is a bonus, never the check)
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 5000 }).catch(() => {})
// (the address's hash: the page stays, as when a note is opened in the app)
const open = async (path) => {
  await page.evaluate((h) => { location.hash = h }, `#file/${encodeURIComponent(path)}`)
  await wait(1500)
  await until(() => page.evaluate(() => window.app?.workspace?.layoutReady), 20000)
  // (a phone opens a note to read: editor commands need it editing)
  if (phone && await page.evaluate(() => document.querySelector("[data-view-toggle]")?.getAttribute("data-view-toggle") === "read")) {
    await page.evaluate(() => document.querySelector("[data-view-toggle]")?.click())
    await wait(800)
  }
  // (the note's editor, for commands that need one)
  await until(() => page.evaluate((p) => window.app.workspace.activeEditor?.file?.path === p, path), 8000)
}
/** Put the cursor at the end of the first line holding `text` (the editor's own selection), and focus it. */
const cursorAt = (text, offset = text.length) => page.evaluate(([t, o]) => {
  const ed = window.app.workspace.activeEditor?.editor
  if (!ed) return false
  const val = ed.cm.state.doc.toString(), i = val.indexOf(t)
  if (i < 0) return false
  ed.cm.focus()
  ed.cm.dispatch({ selection: { anchor: i + o } })
  return true
}, [text, offset])
const run = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id)
const cmds = (prefix) => page.evaluate((p) => Object.keys(window.app.commands.commands).filter((k) => k.startsWith(p)), prefix)
const test = async (id, fn) => {
  if (only && !only.split(",").includes(id)) return
  const before = errs.length
  let r
  try { r = await fn() } catch (e) { r = { state: "fails", why: String(e).slice(0, 200) } }
  r.errors = errs.slice(before).slice(0, 3)
  results[id] = r
  check(`${id}: ${r.state}${r.why ? ` (${r.why})` : ""}`, r.state !== "fails" || true)
  await page.keyboard.press("Escape").catch(() => {})
  await page.evaluate(() => document.querySelectorAll(".modal-container, .menu, .suggestion-container").forEach((e) => e.remove()))
}

await test("table-editor-obsidian", async () => {
  const p = await note("Table", "# Table\n\n| a | bb |\n|--|--|\n| ccc | d |\n")
  await open(p)
  const ids = await cmds("table-editor-obsidian:")
  await cursorAt("| ccc", 3)
  await run("table-editor-obsidian:format-all-tables")
  await wait(1500)
  await shot("table-editor")
  const t = await read(p)
  const ok = t.includes("| a   | bb  |\n| --- | --- |")
  return { state: ok ? "works" : ids.length ? "partly" : "fails", commands: ids.length, why: ok ? "" : `table not formatted: ${JSON.stringify(t.slice(9, 60))}` }
})

await test("obsidian-outliner", async () => {
  const p = await note("Outline", "- one\n- two\n- three\n")
  await open(p)
  await cursorAt("- one", 3)
  await run("obsidian-outliner:move-list-item-down")
  await wait(1500)
  await shot("outliner")
  const t = await read(p)
  return { state: t.startsWith("- two\n- one") ? "works" : "fails", why: t.startsWith("- two") ? "" : `order unchanged: ${JSON.stringify(t)}` }
})

await test("nldates-obsidian", async () => {
  const p = await note("Dates", "Meet tomorrow\n")
  await open(p)
  await page.evaluate(() => { const ed = window.app.workspace.activeEditor.editor; const i = ed.getValue().indexOf("tomorrow"); ed.setSelection(ed.offsetToPos(i), ed.offsetToPos(i + 8)); ed.focus() })
  await run("nldates-obsidian:nlp-dates")
  await wait(1500)
  // and the @ suggester as you type
  await cursorAt("Meet", 0)
  await page.keyboard.type("@tod")
  await wait(800)
  const suggest = await page.locator(".suggestion-container .suggestion-item").count()
  await shot("nldates")
  const t = await read(p)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const ok = t.includes(`[[${tomorrow}]]`)
  return { state: ok && suggest ? "works" : ok || suggest ? "partly" : "fails", why: `${ok ? "" : `no date link: ${JSON.stringify(t)}; `}${suggest ? "" : "no @ suggestions"}` }
})

await test("quickadd", async () => {
  await run("quickadd:runQuickAdd")
  await wait(1000)
  const modal = await page.locator(".modal-container, .notice").count()
  await shot("quickadd")
  await page.keyboard.press("Escape")
  const opened = await page.evaluate(() => { window.app.setting.openTabById("quickadd"); return !!document.querySelector(".modal.mod-settings .setting-item") })
  await wait(800)
  await shot("quickadd-settings")
  return { state: opened ? "works" : modal ? "partly" : "fails", why: opened ? "" : "settings empty" }
})

await test("omnisearch", async () => {
  await run("omnisearch:show-modal")
  await wait(800)
  await page.keyboard.type("Alice")
  await wait(2000)
  const n = await page.locator(".modal-container .suggestion-item, .modal-container .omnisearch-result").count()
  await shot("omnisearch")
  return { state: n ? "works" : "fails", results: n, why: n ? "" : "no results in its modal" }
})

await test("calendar", async () => {
  await run("calendar:show-calendar-view")
  await wait(1500)
  const days = await page.locator(".obsidian-compat-side .calendar td, .obsidian-compat-side .day, .obsidian-compat-leaf .calendar td").count()
  await shot("calendar")
  return { state: days >= 28 ? "works" : "fails", days, why: days >= 28 ? "" : "no month drawn (the sidebar panel may be hidden)" }
})

await test("recent-files-obsidian", async () => {
  await run("recent-files-obsidian:recent-files-open")
  await wait(500)
  // (it lists the files opened from now on)
  await open(await note("Recent one", "one\n"))
  await open(await note("Recent two", "two\n"))
  await wait(1000)
  const rows = await page.evaluate(() => window.app.workspace.getLeavesOfType("recent-files")[0]?.view.containerEl.querySelectorAll(".nav-file-title").length ?? 0)
  await shot("recent-files")
  return { state: rows ? "works" : "fails", rows, why: rows ? "" : "no rows" }
})

await test("dataview", async () => {
  const p = await note("Dataview", "# People\n\n```dataview\nLIST FROM \"People\"\n```\n\nInline: `= this.file.name`\n")
  await open(p)
  await wait(2500)
  const items = await page.locator('[data-fence="dataview"] li').count()
  await shot("dataview")
  return { state: items ? "works" : "fails", items, why: items ? "" : "the fence drew nothing" }
})

await test("obsidian-tasks-plugin", async () => {
  await note("Todo", "- [ ] Water plants 📅 2026-10-08\n- [x] Call Alice\n")
  const p = await note("Tasks", "```tasks\nnot done\n```\n")
  await open(p)
  await wait(3000)
  const items = await page.locator('[data-fence="tasks"] li').count()
  await shot("tasks")
  return { state: items ? "works" : "fails", items, why: items ? "" : "the fence drew nothing" }
})

await test("templater-obsidian", async () => {
  await note("Templates/Daily", "Created <% tp.date.now(\"YYYY-MM-DD\") %>\n")
  await page.evaluate(async () => { const p = window.app.plugins.plugins["templater-obsidian"]; p.settings.templates_folder = "Qa obsidian/Templates"; await p.save_settings?.() })
  const p = await note("Templated", "x\n")
  await open(p)
  await cursorAt("x", 1)
  await run("templater-obsidian:insert-templater")
  await wait(1000)
  const modal = await page.locator(".modal-container .suggestion-item").count()
  if (modal) { await page.keyboard.type("Daily"); await wait(300); await page.keyboard.press("Enter") }
  await wait(2000)
  await shot("templater")
  const t = await read(p)
  const today = new Date().toISOString().slice(0, 10)
  return { state: t.includes(`Created ${today}`) ? "works" : modal ? "partly" : "fails", why: t.includes("Created") ? "" : `nothing inserted: ${JSON.stringify(t)}` }
})

await test("obsidian-linter", async () => {
  // (written without frontmatter: Linter edits the editor's text as if it held the whole file, below)
  const p = `${D}/Lint.md`
  fs.writeFileSync(`${(await api("GET", "vault")).path}/${p}`, "#Heading\nSome text   \n\n\n\nMore\n")
  await wait(1500)
  await open(p)
  // (every rule is off until chosen: two of them on)
  await page.evaluate(async () => { const l = window.app.plugins.plugins["obsidian-linter"]; for (const r of ["trailing-spaces", "consecutive-blank-lines", "space-after-list-markers"]) if (l.settings.ruleConfigs[r]) l.settings.ruleConfigs[r].enabled = true; await l.saveSettings?.() })
  await cursorAt("More", 0)
  await run("obsidian-linter:lint-file")
  await wait(2000)
  await shot("linter")
  const t = await read(p)
  return { state: t === "#Heading\nSome text\n\nMore\n" ? "works" : t !== "#Heading\nSome text   \n\n\n\nMore\n" ? "partly" : "fails", why: `after: ${JSON.stringify(t.slice(0, 120))}` }
})

await test("obsidian-git", async () => {
  await run("obsidian-git:open-git-view")
  await wait(1500)
  const text = await page.evaluate(() => [...document.querySelectorAll(".workspace-leaf-content")].map((e) => e.textContent).join(" | ").slice(0, 200))
  await shot("git")
  return { state: "fails", why: `no git here: ${text}` }
})

await test("realclaudian", async () => ({ state: phone ? "skipped" : "fails", why: phone ? "isDesktopOnly" : "needs Node (child_process, fs, Buffer)" }))

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 1))
if (cdp) await cdp.close(); else await ctx.close()
await done()
