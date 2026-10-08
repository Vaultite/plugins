// One check per kind of plugin in the desktop app (Electron), over its DevTools port: queries, editor commands, a side
// panel and the file tree, a board, templates, Git through the Node bridge. Throwaway app data and vault only.
//   node electron.mjs <devtools port> <vault folder>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { chromium } from "playwright-core"

const [port, vault] = process.argv.slice(2)
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = b.contexts()[0].pages().find((p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()))
const base = new URL(page.url()).origin
const errs = []
page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 200)))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await wait(250) } }
const ev = (fn, a) => page.evaluate(fn, a)
const read = (p) => fs.readFileSync(`${vault}/${p}`, "utf8")
const open = async (p) => { await ev((h) => { location.hash = h }, `#file/${encodeURIComponent(p)}`); await until(() => ev((p) => window.app.workspace.getActiveFile()?.path === p, p)); await wait(1200) }
const run = (id) => ev((id) => window.app.commands.executeCommandById(id), id)
const shot = (n) => page.screenshot({ path: `/tmp/oc-e/${n}.png` }).catch(() => {})
const out = {}
const check = async (name, fn) => { try { out[name] = await fn() } catch (e) { out[name] = `fails: ${String(e).slice(0, 150)}` } console.log(`${name}: ${out[name]}`) }

await until(() => ev(() => window.app?.workspace?.layoutReady), 60000)
await wait(4000)
await check("loaded", async () => {
  const r = await (await fetch(`${base}/api/obsidian-compat/report`)).json()
  const mine = Object.entries(r).filter(([k]) => k.startsWith("desktop")).map(([, v]) => v).pop()
  const res = mine?.results ?? []
  return `${res.filter((x) => x.state === "ok").length}/${res.length} ok${res.some((x) => x.state !== "ok") ? ` (${res.filter((x) => x.state !== "ok").map((x) => x.id)})` : ""}`
})
await check("dataview + tasks", async () => {
  await open("Dashboards/Queries.md")
  const rows = await until(() => ev(() => document.querySelectorAll(".dataview.table-view-table tbody tr").length), 10000)
  const tasks = await until(() => ev(() => document.querySelectorAll(".plugin-tasks-query-result .task-list-item, .tasks-list-text").length), 10000)
  await shot("e-queries")
  return rows && tasks ? `works (${rows} rows, ${tasks} tasks)` : `fails (rows ${rows}, tasks ${tasks})`
})
await check("advanced tables", async () => {
  fs.writeFileSync(`${vault}/Notes/Etable.md`, "# T\n\n| a | bb |\n|--|--|\n| ccc | d |\n")
  await wait(1500); await open("Notes/Etable.md")
  await run("table-editor-obsidian:format-all-tables")
  const t = await until(() => (/\| a {3}\| bb {2}\|/.test(read("Notes/Etable.md")) ? 1 : 0), 6000)
  return t ? "works" : `fails: ${JSON.stringify(read("Notes/Etable.md"))}`
})
await check("linter (frontmatter)", async () => {
  fs.writeFileSync(`${vault}/Notes/Elint.md`, "---\ntags: [x]\n---\n# Lint   \n\ntext   \n")
  await ev(async () => { const p = window.app.plugins.plugins["obsidian-linter"]; p.settings.ruleConfigs["trailing-spaces"].enabled = true; await p.saveSettings() })
  await wait(1500); await open("Notes/Elint.md")
  await run("obsidian-linter:lint-file")
  const t = await until(() => { const s = read("Notes/Elint.md"); return s.startsWith("---\ntags: [x]\n---") && !/ +\n/.test(s) ? 1 : 0 }, 6000)
  return t ? "works" : `fails: ${JSON.stringify(read("Notes/Elint.md"))}`
})
await check("calendar panel + iconize tree", async () => {
  await run("calendar:show-calendar-view")
  const cal = await until(() => ev(() => !!document.querySelector(".calendar .day")), 8000)
  await ev(async () => { const p = window.app.plugins.plugins["obsidian-icon-folder"]; p.addFolderIcon("Projects", "LiStar"); await p.saveIconFolderData() })
  await page.reload(); await until(() => ev(() => window.app?.workspace?.layoutReady), 60000)
  const icon = await until(() => ev(() => !!document.querySelector('[data-tree-path="Projects"] .iconize-icon svg')), 10000)
  await shot("e-calendar-iconize")
  return cal && icon ? "works" : `fails (calendar ${cal}, icon ${icon})`
})
await check("kanban", async () => {
  await open("Boards/Roadmap.md")
  const lanes = await until(() => ev(() => document.querySelectorAll(".kanban-plugin__lane").length), 10000)
  await shot("e-kanban")
  return lanes ? `works (${lanes} lanes)` : "fails"
})
await check("templater", async () => {
  fs.writeFileSync(`${vault}/Notes/Etpl.md`, "start\n")
  await wait(1500); await open("Notes/Etpl.md")
  await ev(async () => { const t = window.app.plugins.plugins["templater-obsidian"]; t.settings.templates_folder = "Templates"; await t.save_settings() })
  await run("templater-obsidian:insert-templater")
  await until(() => ev(() => !!document.querySelector(".prompt-input, .modal-container input")), 5000)
  await page.keyboard.type("Daily"); await wait(500); await page.keyboard.press("Enter")
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  const t = await until(() => (read("Notes/Etpl.md").includes(`# ${today}`) ? 1 : 0), 6000)
  return t ? "works" : `fails: ${JSON.stringify(read("Notes/Etpl.md"))}`
})
await check("git commit (Node bridge)", async () => {
  const count = () => Number(execFileSync("git", ["-C", vault, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim())
  const before = count()
  fs.writeFileSync(`${vault}/Notes/Egit.md`, `changed ${Date.now()}\n`)
  await wait(1500)
  await run("obsidian-git:commit")
  const after = await until(() => (count() > before ? count() : 0), 15000)
  return after ? `works (${before} -> ${after} commits, author ${execFileSync("git", ["-C", vault, "log", "-1", "--format=%an"], { encoding: "utf8" }).trim()})` : "fails"
})
await check("importer + electron", async () => {
  const api = await ev(() => typeof window.require?.("electron")?.remote?.dialog?.showOpenDialog)
  await run("obsidian-importer:open-modal")
  const modal = await until(() => ev(() => document.querySelector(".modal-container")?.innerText?.slice(0, 60)), 5000)
  await shot("e-importer")
  await page.keyboard.press("Escape")
  return modal && api === "function" ? `works (modal: ${modal.replace(/\n/g, " ")})` : `fails (modal ${modal}, dialog ${api})`
})
console.log(JSON.stringify({ errors: errs.slice(0, 8) }))
await b.close()
