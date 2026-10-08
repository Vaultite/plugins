// The data group's plugins doing their job (catalog.tsv): queries rendered, checkboxes ticked into the file, widgets
// drawn, views listing what notes hold. WRITES notes under "Qa data": throwaway server only (lab.mjs).
//   node data.mjs <base url> [phone] [ids,comma,separated]     (OC_CDP=<devtools url>: reuse a running Chrome)
import fs from "node:fs"
import path from "node:path"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const cdpUrl = process.env.OC_CDP
const { args: [B0, mode = "", only = ""], browser, done } = await qa(import.meta.url, cdpUrl ? { chrome: false } : {})
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const phone = mode === "phone"
const D = "Qa data"
const today = new Date().toLocaleDateString("en-CA")
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const cdp = cdpUrl ? await (await import("playwright-core")).chromium.connectOverCDP(cdpUrl) : null
const ctx = cdp ? cdp.contexts()[0] : await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA } : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e.stack ?? e).slice(0, 300)))

// (made, or replaced when it's there: the API answers an error rather than throwing)
// (and waits for plugins' picture of the vault to have it, as a note made by hand would be)
const write = async (p, text) => {
  const r = await api("POST", "file", { path: p, text })
  if (r?.error) await api("PUT", "file", { path: p, text })
  await until(() => page.evaluate(([p, t]) => { const f = window.app.vault.getFileByPath(p); return f && f.stat.size >= new TextEncoder().encode(t).length }, [p, text]), 8000).catch(() => {})
  await wait(400)
}
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`))?.text ?? null
const run = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id)
const settle = (ms = 1500) => wait(ms)
async function open(p) {
  await page.evaluate((h) => { location.hash = h }, `#file/${encodeURIComponent(p)}`)
  await until(() => page.evaluate((p) => window.app?.workspace?.getActiveFile()?.path === p, p), 15000).catch(() => {})
  await settle(2500)
}
/** Scroll the open note's editor to its end (CodeMirror draws only what's on screen). */
const toEnd = () => page.evaluate(async () => {
  const cm = window.app.workspace.activeEditor?.editor?.cm
  if (!cm) return
  // (on a phone the page scrolls, not the editor: its last line is brought into view, twice as lines draw)
  for (let i = 0; i < 2; i++) { cm.scrollDOM.scrollTop = cm.scrollDOM.scrollHeight; cm.contentDOM.lastElementChild?.scrollIntoView(); await new Promise((r) => setTimeout(r, 500)) }
}).then(() => settle(1000))
/** Its start, where a reopened note doesn't start (the app keeps the place it was left at). */
const toTop = () => page.evaluate(() => { const cm = window.app.workspace.activeEditor?.editor?.cm; if (cm) { cm.scrollDOM.scrollTop = 0; cm.contentDOM.firstElementChild?.scrollIntoView() } }).then(() => settle(1000))
const fenceText = (lang) => page.evaluate((l) => [...document.querySelectorAll(`[data-fence="${l}"]`)].filter((e) => e.checkVisibility()).map((e) => e.innerText).join("\n---\n"), lang)
const viewText = (type) => page.evaluate((t) => window.app.workspace.getLeavesOfType(t).map((l) => l.view.containerEl.innerText).join("\n"), type)
/** Something already on the page, clicked as a person would (scrolled to, real pointer events). */
const click = async (sel) => { const el = page.locator(`${sel} >> visible=true`).first(); await el.scrollIntoViewIfNeeded({ timeout: 5000 }); await el.click({ timeout: 5000 }) }
const closeAll = () => page.evaluate(() => { document.querySelectorAll(".modal-container").forEach((m) => m.querySelector(".modal-close-button")?.click()); document.querySelectorAll(".modal-container").forEach((e) => e.remove()) })

const results = {}
async function check(id, fn) {
  if (only && !only.split(",").includes(id)) return
  const before = errs.length
  let r
  try { r = await fn() } catch (e) { r = { state: "fails", why: String(e?.message ?? e).split("\n")[0].slice(0, 200) } }
  r.errors = errs.slice(before).filter((e) => e.includes(`obsidian-plugin:${id}/`)).slice(0, 2)
  results[id] = r
  console.log(`${r.state.padEnd(6)} ${id}${r.why ? `: ${r.why}` : ""}${r.errors.length ? `  [${r.errors.length} errors: ${r.errors[0].split("\n")[0]}]` : ""}`)
  await page.keyboard.press("Escape").catch(() => {})
  await closeAll().catch(() => {})
}
const ok = (cond, why) => (cond ? { state: "works" } : { state: "fails", why })

await page.goto(B)
await until(() => page.evaluate(() => window.app?.workspace?.layoutReady), 90000)
await settle(4000)
await api("DELETE", `file?path=${encodeURIComponent(D)}`).catch(() => {})

await check("dataview", async () => {
  await write(`${D}/Dataview.md`, "# Dataview\n\n```dataview\nTABLE status, due FROM #project\n```\n\n```dataview\nLIST FROM \"Daily\"\n```\n\n```dataviewjs\ndv.paragraph(\"Pages \" + dv.pages().length)\n```\n\nInline: `= this.file.name`\n")
  await page.evaluate(async () => { const p = window.app.plugins.plugins.dataview; p.settings.enableDataviewJs = true; p.settings.enableInlineDataviewJs = true; await p.saveSettings?.() })
  await open(`${D}/Dataview.md`)
  await toEnd()
  const t = await fenceText("dataview"), js = await fenceText("dataviewjs")
  const inline = await page.evaluate(() => document.querySelector(".cm-content .dataview-inline")?.textContent?.trim())
  if (!/Lighthouse/.test(t) || !/active/.test(t)) return { state: "fails", why: "TABLE without Lighthouse/active" }
  if (!/2026-10-05/.test(t)) return { state: "fails", why: "LIST without daily notes" }
  if (!/Pages \d+/.test(js)) return { state: "partly", why: `dataviewjs: ${js.slice(0, 80)}` }
  return ok(inline === "Dataview", `inline query: ${inline}`)
})

await check("datacore", async () => {
  await write(`${D}/Datacore.md`, "# Datacore\n\n```datacorejsx\nreturn function View() { const pages = dc.useQuery(\"@page\"); return <p id=\"dc-out\">Pages: {pages.length}</p>; }\n```\n")
  await open(`${D}/Datacore.md`)
  const t = await until(() => page.evaluate(() => document.querySelector("#dc-out")?.textContent), 8000).catch(() => null)
  return ok(/Pages: [1-9]/.test(t ?? ""), `no result: ${await fenceText("datacorejsx")}`)
})

await check("obsidian-tasks-plugin", async () => {
  await write(`${D}/Tasks src.md`, "# Tasks src\n\n- [ ] Water the plants 📅 2026-10-07\n- [ ] Call the plumber\n")
  await write(`${D}/Tasks.md`, "# Tasks\n\n```tasks\nnot done\npath includes Qa data/Tasks src\n```\n")
  await open(`${D}/Tasks.md`)
  const t = await until(async () => { const x = await fenceText("tasks"); return /Water the plants/.test(x) ? x : null }, 8000)
  await click('[data-fence="tasks"] li:has-text("Water the plants") input[type=checkbox]')
  const f = await until(async () => { const s = await read(`${D}/Tasks src.md`); return /- \[x\] Water the plants.*✅/.test(s) ? s : null }, 6000).catch(() => null)
  if (!f) return { state: "fails", why: `ticking didn't complete it (${t.split("\n")[0]})` }
  await open(`${D}/Tasks src.md`)
  await page.evaluate(() => { const e = window.app.workspace.activeEditor.editor; const l = e.getValue().split("\n").findIndex((x) => x.includes("Call the plumber")); e.setCursor({ line: l, ch: 8 }) })
  await run("obsidian-tasks-plugin:edit-task")
  const modal = await until(() => page.evaluate(() => document.querySelector(".modal-container")?.innerText), 4000).catch(() => null)
  return ok(/Description|description/.test(modal ?? ""), "edit task modal didn't open")
})

await check("tasknotes", async () => {
  await run("tasknotes:create-new-task")
  const m = await until(() => page.evaluate(() => !!document.querySelector(".modal-container input, .modal-container textarea, .modal-container [contenteditable]")), 6000).catch(() => false)
  if (!m) return { state: "fails", why: "create task modal didn't open" }
  // (typed once its field has the keyboard: a fresh page may still be placing it)
  await page.evaluate(() => document.querySelector(".modal-container input, .modal-container textarea, .modal-container [contenteditable]")?.focus())
  await settle(300)
  await page.keyboard.type("Buy rope for climbing")
  await settle(800)
  await click(".modal-container button.mod-cta")
  const f = await until(async () => {
    const l = await page.evaluate(() => window.app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => /Buy rope/.test(p)))
    return l.length ? l : null
  }, 8000).catch(() => null)
  if (!f) return { state: "fails", why: "no task note written" }
  await run("tasknotes:open-tasks-view")
  await settle(2500)
  const shown = await page.evaluate(() => document.body.innerText.includes("Buy rope for climbing"))
  return shown ? { state: "works" } : { state: "partly", why: `task note ${f[0]} written; tasks view doesn't list it` }
})

await check("obsidian-checklist-plugin", async () => {
  await write(`${D}/Checklist.md`, "# Checklist\n\n- [ ] Pack the tent #todo\n")
  await run("obsidian-checklist-plugin:show-checklist-view")
  await settle(2500)
  const t = await viewText("todo")
  if (!/Pack the tent/.test(t)) return { state: "fails", why: `view: ${t.slice(0, 100)}` }
  await page.evaluate(() => { const leaf = window.app.workspace.getLeavesOfType("todo")[0]; const li = [...leaf.view.containerEl.querySelectorAll("li, .todo-list-item, div")].find((e) => /Pack the tent/.test(e.textContent ?? "") && e.querySelector("input[type=checkbox], .checkbox")); (li?.querySelector("input[type=checkbox], .checkbox"))?.click() })
  const f = await until(async () => (/- \[x\] Pack the tent/.test(await read(`${D}/Checklist.md`)) ? true : null), 5000).catch(() => null)
  return f ? { state: "works" } : { state: "partly", why: "lists tasks; ticking one didn't write it" }
})

await check("obsidian-tracker", async () => {
  await open("Notes/Widgets.md")
  await toTop()
  const n = await page.evaluate(() => document.querySelector('[data-fence="tracker"] svg')?.querySelectorAll("path, circle, line").length ?? 0)
  return ok(n > 3, "no chart drawn")
})

await check("obsidian-charts", async () => {
  await open("Notes/Widgets.md")
  await toTop()
  // (Chart.js animates in: polled until something's painted)
  const painted = await until(() => page.evaluate(() => {
    const c = [...document.querySelectorAll('[data-fence="chart"] canvas')].find((x) => x.checkVisibility())
    if (!c || !c.width) return false
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data
    for (let i = 3; i < d.length; i += 16) if (d[i]) return true
    return false
  }), 8000).catch(() => false)
  return ok(painted, "canvas empty")
})

await check("obsidian-meta-bind-plugin", async () => {
  await write(`${D}/Bind.md`, "---\ndone: false\n---\n# Bind\n\nDone: `INPUT[toggle:done]`\n")
  await open(`${D}/Bind.md`)
  await until(() => page.evaluate(() => !!document.querySelector(".cm-content .mb-input-type-toggle .checkbox-container")), 6000)
  await click(".cm-content .mb-input-type-toggle .checkbox-container")
  const f = await until(async () => (/done: true/.test(await read(`${D}/Bind.md`)) ? true : null), 5000).catch(() => null)
  return ok(f, "toggle drawn; clicking it didn't write done: true")
})

await check("metadata-menu", async () => {
  // (it manages the fields its settings define: a preset "status" field saved (its saveSettings writes presetFields),
  // then the app opened again so it builds and indexes them from the start, as for someone who set one up)
  await page.evaluate(async () => {
    const p = window.app.plugins.plugins["metadata-menu"]
    p.presetFields = [{ name: "status", type: "Select", id: "qastatus", options: { sourceType: "ValuesList", valuesList: { 1: "active", 2: "done" } }, path: "" }]
    await p.saveSettings()
  })
  await page.reload()
  await until(() => page.evaluate(() => window.app?.workspace?.layoutReady && !!window.app.plugins.plugins["metadata-menu"]), 90000)
  await settle(3000)
  await open("Projects/Lighthouse.md")
  await run("metadata-menu:open_fields_modal")
  const t = await until(() => page.evaluate(() => { const x = document.querySelector(".modal-container")?.innerText ?? ""; return /status/.test(x) ? x : null }), 8000).catch(() => null)
  return ok(t, `fields modal: ${await page.evaluate(() => document.querySelector(".modal-container")?.innerText?.slice(0, 80))}`)
})

await check("buttons", async () => {
  await write(`${D}/Buttons.md`, "# Buttons\n\n```button\nname Add a line\ntype append text\naction Button clicked\n```\n")
  await open(`${D}/Buttons.md`)
  await until(() => page.evaluate(() => /Add a line/.test(document.querySelector('[data-fence="button"] button')?.textContent ?? "")), 6000)
  await click('[data-fence="button"] button')
  const f = await until(async () => (/Button clicked/.test(await read(`${D}/Buttons.md`)) ? true : null), 5000).catch(() => null)
  return ok(f, "button drawn; clicking it didn't append")
})

await check("obsidian-day-planner", async () => {
  const p = `Daily/${today}.md`
  const had = await read(p)
  // (Day planner reads the list under its heading, "Day planner" by default)
  const plan = "\n# Day planner\n\n- [ ] 10:00 - 11:00 Standup with Alice\n"
  if (had === null) await write(p, `# ${today}\n${plan}`)
  else if (!/Standup with Alice/.test(had)) await api("PUT", "file", { path: p, text: `${had.trimEnd()}\n${plan}` })
  await run("obsidian-day-planner:show-day-planner-timeline")
  const t = await until(async () => { const x = await viewText("planner-timeline"); return /Standup with Alice/.test(x) ? x : null }, 10000).catch(() => null)
  return ok(t, `timeline: ${(await viewText("planner-timeline")).slice(0, 100)}`)
})

await check("obsidian-reminder-plugin", async () => {
  await write(`${D}/Reminders.md`, "# Reminders\n\n- [ ] Call Alice about the brief (@2026-12-01 10:00)\n")
  await run("obsidian-reminder-plugin:scan-reminders")
  await run("obsidian-reminder-plugin:show-reminders")
  const t = await until(async () => { const x = await viewText("reminder-list"); return /Call Alice/.test(x) ? x : null }, 8000).catch(() => null)
  return ok(t, `reminder list: ${(await viewText("reminder-list")).slice(0, 100)}`)
})

await check("obsidian-spaced-repetition", async () => {
  await run("obsidian-spaced-repetition:srs-review-flashcards")
  const t = await until(() => page.evaluate(() => document.querySelector(".modal-container")?.innerText), 8000).catch(() => null)
  if (!/flashcards/i.test(t ?? "")) return { state: "fails", why: `review modal: ${String(t).slice(0, 80)}` }
  await page.evaluate(() => { const deck = [...document.querySelectorAll(".modal-container *")].find((e) => e.children.length === 0 && /^#?flashcards$/i.test(e.textContent?.trim() ?? "")); deck?.click() })
  const card = await until(() => page.evaluate(() => /lighthouse|France/i.test(document.querySelector(".modal-container")?.innerText ?? "")), 5000).catch(() => false)
  return card ? { state: "works" } : { state: "partly", why: "deck list shows; opening the deck shows no card" }
})

await check("obsidian-full-calendar", async () => {
  await write(`Events/${today} Climbing.md`, `---\ntitle: Climbing session\nallDay: false\ndate: ${today}\nstartTime: "18:00"\nendTime: "20:00"\ntype: single\n---\n`)
  await until(() => page.evaluate(() => !!window.app.vault.getFolderByPath("Events")), 8000)
  await page.evaluate(async () => { const p = window.app.plugins.plugins["obsidian-full-calendar"]; p.settings.calendarSources = [{ type: "local", directory: "Events", color: "#3b82f6" }]; await p.saveSettings() })
  await run("obsidian-full-calendar:full-calendar-open")
  const t = await until(async () => { const x = await viewText("full-calendar-view"); return /Climbing session/.test(x) ? x : null }, 10000).catch(() => null)
  return ok(t, `calendar view: ${(await viewText("full-calendar-view")).slice(0, 100)}`)
})

await check("breadcrumbs", async () => {
  await write(`${D}/Crumbs parent.md`, "# Crumbs parent\n\n```breadcrumbs\ntype: tree\n```\n")
  await write(`${D}/Crumbs child.md`, "---\nup: \"[[Crumbs parent]]\"\n---\n# Crumbs child\n")
  await run("breadcrumbs:rebuild-graph")
  await settle(1500)
  await open(`${D}/Crumbs parent.md`)
  const t = await until(async () => { const x = await fenceText("breadcrumbs"); return /Crumbs child/.test(x) ? x : null }, 8000).catch(() => null)
  return ok(t, `tree: ${(await fenceText("breadcrumbs")).slice(0, 100)}`)
})

await check("multi-column-markdown", async () => {
  await write(`${D}/Columns.md`, "# Columns\n\n--- start-multi-column: cols1\n```column-settings\nNumber of Columns: 2\n```\n\nLeft column text.\n\n--- column-break ---\n\nRight column text.\n\n--- end-multi-column\n")
  await open(`${D}/Columns.md`)
  const n = await page.evaluate(() => document.querySelectorAll(".cm-content .mcm-column-div, .cm-content .mcm-column-content").length)
  return ok(n >= 2, "no columns drawn in the editor")
})

await check("obsidian-dice-roller", async () => {
  await open("Notes/Widgets.md")
  const r = await until(() => page.evaluate(() => document.querySelector(".cm-content .dice-roller-result")?.textContent), 6000).catch(() => null)
  return ok(/^\d+$/.test(r ?? ""), "no roll drawn")
})

await check("obsidian-5e-statblocks", async () => {
  await write(`${D}/Statblock.md`, "# Statblock\n\n```statblock\nname: Lighthouse keeper\nsize: Medium\ntype: humanoid\nac: 12\nhp: 9\nstats: [10, 12, 10, 14, 13, 11]\n```\n")
  await open(`${D}/Statblock.md`)
  return ok(/Armor Class/.test(await fenceText("statblock")), "no statblock")
})

await check("obsidian-leaflet-plugin", async () => {
  await open("Notes/Widgets.md")
  await toEnd()
  const tiles = await until(() => page.evaluate(() => document.querySelectorAll('[data-fence="leaflet"] .leaflet-container').length), 6000).catch(() => 0)
  return ok(tiles, "no map")
})

const out = path.join(import.meta.dirname, "..", "results", `data${phone ? "-phone" : ""}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
if (!only) fs.writeFileSync(out, JSON.stringify(results, null, 2))
console.log(Object.values(results).reduce((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {}))
await page.close()
if (!cdp) await ctx.close()
await done()
