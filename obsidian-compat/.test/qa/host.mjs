// Obsidian plugins as the app's own: their panels, a view in a tab, options in their sheet, a fence arriving in an open
// note, a plugin turned off taking its UI with it. Needs Calendar, Recent Files and Tasks in the lab (lab.mjs). WRITES.
//   node host.mjs <base url> [phone]
import fs from "node:fs"
import { qa } from "../../../qa.mjs"
const { args: [B, mode = ""], browser, done } = await qa(import.meta.url)
const phone = mode === "phone", S = `/tmp/oc-lab/shots/host-${phone ? "phone-" : ""}`
fs.mkdirSync("/tmp/oc-lab/shots", { recursive: true })
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)))
const ok = (name, v) => console.log(`${v ? "ok  " : "FAIL"} ${name}`)
const wait = (ms) => page.waitForTimeout(ms)
const api = (m, r, b) => page.evaluate(async ([m, r, b]) => (await fetch(`/api/${r}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json(), [m, r, b])
await page.goto(B)
await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60000 })
await wait(3000)
// 1. Tasks off, its note open, Plugins in a split beside it: turned on there, its fence draws in the open note
await api("POST", "obsidian-compat/enable", { id: "obsidian-tasks-plugin", on: false })
await api("POST", "obsidian-compat/enable", { id: "calendar", on: true })
await page.reload(); await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60000 }); await wait(2000)
await page.evaluate(() => { location.hash = `#file/${encodeURIComponent("Dashboards/Queries.md")}` })
await wait(2500)
const count = () => page.evaluate(() => document.querySelectorAll('[data-fence="tasks"]').length)
const before = await count()
if (!phone) {
  await page.evaluate(() => window.__vaultite.modules["@vaultite"].openInSplit("plugins")); await wait(2000)
  await page.screenshot({ path: `${S}plugins.png` })
  await page.locator('[data-plugin-row="obsidian.obsidian-tasks-plugin"]').locator("xpath=..").getByRole("switch").click(); await wait(3000)
  const after = await count()
  ok(`tasks fence appears in the open note (${before} -> ${after})`, before === 0 && after > 0)
  await page.screenshot({ path: `${S}tasks-fence.png` })
} else {
  await page.evaluate(() => { location.hash = "#plugins" }); await wait(1500)
  await page.screenshot({ path: `${S}plugins.png` })
  await page.locator('[data-plugin-row="obsidian.obsidian-tasks-plugin"]').locator("xpath=..").getByRole("switch").click(); await wait(2500)
}
// 2. Calendar: its own panel
const cal = await page.evaluate(() => !!document.querySelector('[data-type="calendar"]'))
ok("calendar panel drawn", phone || cal)
// 3. A view in a tab
await page.evaluate(() => window.app.workspace.getLeaf(true).setViewState({ type: "calendar", active: true }))
await wait(2500)
ok("a plugin's view as a tab", await page.evaluate(() => location.hash.includes("obsidian-calendar") && !!document.querySelector('main [data-type="calendar"], [data-type="calendar"]')))
await page.screenshot({ path: `${S}view-tab.png` })
// 4. Recent files: its command opens its panel
await page.evaluate(() => window.__vaultite.modules["@vaultite"].runCommandById("obsidian.recent-files-obsidian:recent-files-open"))
await wait(2000)
ok("recent files panel", phone ? await page.evaluate(() => location.hash.includes("recent")) : await page.evaluate(() => !!document.querySelector('[data-type="recent-files"]')))
await page.screenshot({ path: `${S}recent.png` })
// 5. Calendar's options in its sheet
await page.evaluate(() => window.__vaultite.modules["@vaultite"].openPluginSettings("obsidian.calendar"))
await wait(1500)
ok("calendar settings in its sheet", await page.evaluate(() => !!document.querySelector('[data-obsidian-settings="calendar"] .setting-item')))
await page.screenshot({ path: `${S}calendar-settings.png` })
await page.keyboard.press("Escape"); await wait(500)
// 6. Calendar off: its panel and commands go
await page.evaluate(() => { location.hash = "#plugins" }); await wait(1500)
await page.locator('[data-plugin-row="obsidian.calendar"]').locator("xpath=..").getByRole("switch").click(); await wait(2500)
ok("calendar off: panel gone", await page.evaluate(() => !document.querySelector('[data-type="calendar"]')))
ok("calendar off: commands gone", await page.evaluate(() => !window.app.commands.findCommand("calendar:show-calendar-view")))
console.log("errors", errs.length, errs.slice(0, 6))
await done()
