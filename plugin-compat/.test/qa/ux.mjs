// Coming from Obsidian: the offer when its vault opens, its sheet (run them all, Vaultite's or the original), the
// Obsidian plugins on the Plugins page, Browse's Obsidian source and an install, a changed plugin's trust sheet. Needs a
// lab up with OC_COMPAT=off, Calendar, Dataview and Recent Files in .obsidian, and the Dataview vault plugin installed
// off. WRITES (installs a plugin, edits one's main.js): throwaway lab only.
//   node ux.mjs <base url> <vault path> [phone]
import fs from "node:fs"
import path from "node:path"
import { qa } from "../../../qa.mjs"
const { args: [B, VAULT, mode = ""], browser, done } = await qa(import.meta.url)
const phone = mode === "phone", S = `/tmp/oc-lab/shots/ux-${phone ? "phone-" : ""}`
fs.mkdirSync("/tmp/oc-lab/shots", { recursive: true })
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)))
let fails = 0
const ok = (name, v) => { if (!v) fails++; console.log(`${v ? "ok  " : "FAIL"} ${name}`) }
const wait = (ms) => page.waitForTimeout(ms)
const shot = (n) => page.screenshot({ path: `${S}${n}.png` })
const api = (m, r, b) => page.evaluate(async ([m, r, b]) => (await fetch(`/api/${r}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json(), [m, r, b])
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(300) } return false }

await page.goto(B)
// 1. The offer, once
const toast = page.getByText(/This vault has \d+ plugins from another app: run them here\?/)
ok("offered to run the vault's Obsidian plugins", await until(() => toast.isVisible().catch(() => false)))
await shot("offer")
await page.getByRole("button", { name: "Review" }).click()
const sheet = page.locator("[data-obsidian-plugins]")
ok("its sheet lists them", await until(async () => (await sheet.locator("[data-obsidian-plugin]").count()) >= 3))
await shot("sheet")
// 2. Run them all
await sheet.locator("[data-obsidian-run-all]").click()
ok("run them all: the compat plugin on, the originals run", await until(async () => (await api("POST", "ops/other-apps.plugins", {})).every((r) => r.original === "on" || r.here.some((h) => h.on)), 40000))
await wait(1500)
await shot("sheet-running")
// 3. Vaultite's Dataview instead: the original goes off
await sheet.locator('[data-obsidian-plugin="dataview"]').getByRole("radio", { name: "Vaultite's" }).click()
ok("Vaultite's Dataview on, the original off", await until(async () => { const r = (await api("POST", "ops/other-apps.plugins", {})).find((x) => x.id === "dataview"); return r.here[0]?.on && r.original !== "on" }, 30000))
await wait(1000)
await shot("sheet-native")
await page.keyboard.press("Escape"); await wait(500)
ok("not offered again", !(await api("GET", "state")).obsidianOffer)
// 4. The Plugins page: Obsidian plugins, counted
await page.evaluate(() => { location.hash = "#plugins" })
const group = page.locator('[data-plugin-group="hosted:plugin-compat"]')
ok("Obsidian plugins on the Plugins page", await until(() => group.isVisible().catch(() => false)))
await group.scrollIntoViewIfNeeded().catch(() => {})
const sw = group.locator('[data-plugin-row="obsidian.dataview"]').locator("xpath=..").getByRole("switch")
ok("the original Dataview shows off there", await until(async () => (await sw.getAttribute("aria-checked")) === "false"))
await shot("plugins")
// Its switch turned on there: Vaultite's Dataview goes off, said in a notice
await sw.click()
ok("turning the original on turns Vaultite's off", await until(async () => { const r = (await api("POST", "ops/other-apps.plugins", {})).find((x) => x.id === "dataview"); return r.original === "on" && !r.here[0]?.on }, 30000))
ok("said in a notice", await page.getByText(/Turned off Dataview: Dataview \(plugin from another app\) does the same/).isVisible().catch(() => false))
// 5. Browse, Obsidian's source: search and install one
await page.getByRole("radio", { name: "Browse" }).click(); await wait(500)
await page.getByRole("radio", { name: "Other apps" }).click()
ok("Obsidian's community plugins listed", await until(async () => (await page.locator("[data-browse-row]").count()) > 20, 30000))
await shot("browse")
await page.locator('input[type="search"], input[placeholder*="earch"]').first().fill("natural language dates")
ok("search finds one", await until(() => page.locator('[data-browse-row="nldates-obsidian"]').isVisible().catch(() => false)))
await page.locator('[data-browse-row="nldates-obsidian"] [data-browse-action="install"]').click()
ok("installed and on", await until(async () => (await api("GET", "plugin-compat/plugins")).some((p) => p.id === "nldates-obsidian" && p.enabled && p.allowed), 60000))
await wait(1500)
await shot("browse-installed")
// 6. Its code changed: it waits again, and its sheet says what it can do
const main = path.join(VAULT, ".vaultite/obsidian/plugins/nldates-obsidian/main.js")
fs.appendFileSync(main, "\n// changed\n")
await page.reload(); await wait(4000)
await page.evaluate(() => window.__vaultite.modules["@vaultite"].openDetail("plugin/obsidian.nldates-obsidian"))
const approval = page.locator('[data-plugin-approval="obsidian.nldates-obsidian"]')
ok("a changed plugin waits, saying so", await until(async () => /changed since you allowed it/i.test(await approval.innerText().catch(() => ""))))
ok("its trust sheet says it runs with full access", /full access/.test(await approval.innerText().catch(() => "")))
await shot("trust")
await approval.locator("[data-plugin-allow]").click()
ok("allowed again", await until(async () => (await api("GET", "plugin-compat/plugins")).find((p) => p.id === "nldates-obsidian")?.allowed))
console.log("page errors:", errs.slice(0, 5))
await ctx.close()
await done()
process.exit(fails ? 1 : 0)
