// An Obsidian plugin and Vaultite's stand-in for it: installed together they're one row on the Plugins page (one
// switch, a line to swap them), and Browse offers Vaultite's first, the original under its … menu. Needs Vaultite's
// Excalidraw installed and on; writes a made-up Obsidian Excalidraw into the vault. WRITES.
//   node standins.mjs <base url> <vault path>
import fs from "node:fs"
import path from "node:path"
import { qa, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT], browser, check, watch, done } = await qa(import.meta.url)
const S = "/tmp/oc-lab/shots/standins-"
fs.mkdirSync("/tmp/oc-lab/shots", { recursive: true })
const ID = "obsidian-excalidraw-plugin", HID = `obsidian.${ID}`
const file = (rel) => path.join(VAULT, rel)
const json = (rel) => { try { return JSON.parse(fs.readFileSync(file(rel), "utf8")) } catch { return null } }
const api = async (p, body) => { const r = await fetch(`${B.replace(/\/+$/, "")}/api/${p}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}); return r.json().catch(() => null) }
const vaultitesOn = () => (json(".vaultite/plugins.json")?.enabled ?? []).includes("excalidraw")
// (obsidian-compat writes its own copy over Obsidian's: .vaultite/obsidian/)
const originalOn = () => (json(".vaultite/obsidian/community-plugins.json") ?? json(".obsidian/community-plugins.json") ?? []).includes(ID)

// A made-up original, on in Obsidian's list and allowed here.
const dir = file(`.obsidian/plugins/${ID}`)
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: ID, name: "Excalidraw", version: "2.0.0", minAppVersion: "1.0.0", description: "A made-up original.", author: "Alice Park" }))
fs.writeFileSync(path.join(dir, "main.js"), `const { Plugin } = require("obsidian"); module.exports = class extends Plugin { onload() {} }`)
fs.writeFileSync(file(".obsidian/community-plugins.json"), JSON.stringify([ID]))
fs.rmSync(file(".vaultite/obsidian/community-plugins.json"), { force: true })
await api("ops/obsidian-compat.allow", { id: ID })

for (const phone of [false, true]) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1300, height: 900 } })
  const page = watch(await ctx.newPage(), { label: phone ? "phone" : "desktop" })
  const tag = phone ? "phone-" : ""
  await page.goto(`${B}#plugins`)
  const row = page.locator('[data-plugin-row="excalidraw"]').locator("xpath=..")
  const pair = page.locator('[data-plugin-pair="excalidraw"]')
  await until(() => pair.count(), 15000)
  check(`${tag}one row for both: Vaultite's, with a line to swap`, (await pair.innerText()).includes("Vaultite's · use the Obsidian plugin instead"), await pair.innerText().catch(() => ""))
  check(`${tag}the original has no row of its own`, (await page.locator(`[data-plugin-row="${HID}"]`).count()) === 0)
  check(`${tag}its host's group says where it went`, (await page.locator('[data-plugin-group="hosted:obsidian-compat"] [data-plugin-group-empty]').innerText()).includes("Excalidraw shares its row with Vaultite's own"))
  check(`${tag}nothing overflows`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: `${S}${tag}row.png` })
  if (!phone) {
    await page.locator('[data-plugin-swap="excalidraw"]').click()
    check("swap: the original runs, Vaultite's off", await until(() => originalOn() && !vaultitesOn(), 8000), { o: originalOn(), v: vaultitesOn() })
    check("swap: the line says so", await until(async () => (await pair.innerText()).includes("The Obsidian plugin · use Vaultite's instead"), 8000), await pair.innerText().catch(() => ""))
    check("swap: the row's switch is on", await row.getByRole("switch").getAttribute("aria-checked") === "true")
    await page.screenshot({ path: `${S}original.png` })
    await page.locator('[data-plugin-swap="excalidraw"]').click()
    check("swap back: Vaultite's runs, the original off", await until(() => vaultitesOn() && !originalOn(), 8000), { o: originalOn(), v: vaultitesOn() })
    await row.getByRole("switch").click()
    check("off: both off", await until(() => !vaultitesOn() && !originalOn(), 8000), { o: originalOn(), v: vaultitesOn() })
    await row.getByRole("switch").click()
    check("on again: Vaultite's", await until(() => vaultitesOn() && !originalOn(), 8000), { o: originalOn(), v: vaultitesOn() })
  }

  // Browse, Obsidian: installed, it says so; badges for what isn't needed and what doesn't run
  await page.getByRole("radio", { name: "Browse" }).click()
  await page.getByRole("radio", { name: "Obsidian" }).click()
  const search = page.getByPlaceholder("Search the directory")
  const entry = (id) => page.locator(`[data-browse-row="${id}"]`)
  await search.fill("excalidraw")
  await until(() => entry(ID).count(), 20000)
  check(`${tag}browse: Vaultite's is on, said`, (await entry(ID).locator("[data-browse-stand-in]").innerText()) === "Vaultite's Excalidraw is on", await entry(ID).innerText())
  check(`${tag}browse: no Install for the installed original`, (await entry(ID).locator('[data-browse-action="install"]').count()) === 0)
  check(`${tag}browse: nothing overflows`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: `${S}${tag}browse-installed.png` })
  for (const [q, id, text] of [["hider", "obsidian-hider", "Not needed here"], ["pdf++", "pdf-plus", "Doesn't run here"]]) {
    await search.fill(q)
    await until(() => entry(id).count(), 8000)
    check(`${tag}browse: ${id} says ${text}`, (await entry(id).locator("[data-browse-badge]").allInnerTexts()).includes(text), await entry(id).innerText().catch(() => ""))
  }
  await ctx.close()
}

// The original gone and Vaultite's off: Browse offers Vaultite's first, the original under …
fs.rmSync(dir, { recursive: true, force: true })
await api("obsidian-compat/enable", { id: ID, on: false })
await api("ops/plugin.disable", { id: "excalidraw" })
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } })
const page = watch(await ctx.newPage())
await page.goto(`${B}#plugins`)
await page.getByRole("radio", { name: "Browse" }).click()
await page.getByRole("radio", { name: "Obsidian" }).click()
await page.getByPlaceholder("Search the directory").fill("excalidraw")
const entry = page.locator(`[data-browse-row="${ID}"]`)
await until(() => entry.locator('[data-browse-action="use-stand-in"]').count(), 20000)
check("browse: Use Vaultite's, not Install", (await entry.locator('[data-browse-action="install"]').count()) === 0)
await entry.locator("[data-browse-more]").click()
check("browse: the original under …", await until(() => page.getByRole("menuitem", { name: "Install the original anyway" }).count(), 3000)
  || await until(() => page.getByText("Install the original anyway").count(), 3000))
await page.screenshot({ path: `${S}browse-more.png` })
await page.keyboard.press("Escape")
await wait(300)
await entry.locator('[data-browse-action="use-stand-in"]').click()
check("use Vaultite's: it's on", await until(() => vaultitesOn(), 8000))
check("use Vaultite's: the row says so", await until(async () => (await entry.locator("[data-browse-stand-in]").innerText()) === "Vaultite's Excalidraw is on", 8000), await entry.innerText())
await page.screenshot({ path: `${S}browse-used.png` })
await done()
