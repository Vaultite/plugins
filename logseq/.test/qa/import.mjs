// Logseq in a browser: "Import a Logseq graph…" from the palette, its folder picked (the made-up Lighthouse graph) and
// then a zip of the DB version's export, the toast following the job, the notes it made (tasks, block refs, callouts,
// queries drawn by the Tasks and Dataview plugins, a namespace's folders, a journal as a daily note), its settings, and
// "Export a folder as a Logseq graph…" downloading a zip; desktop and 390px, with screenshots. WRITES the vault:
// throwaway server only.
//   node logseq/.test/qa/import.mjs <base url> <vault path> [out dir]   (VAULTITE_APP: the app's checkout)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { command, install, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, VAULT, OUT0], browser, check, watch, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const OUT = (OUT0 ?? path.join(os.tmpdir(), "logseq-shots")).replace(/\/?$/, "/")
fs.mkdirSync(OUT, { recursive: true })
const enc = encodeURIComponent
const { fixtures } = await import("../fixtures.ts")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-qa-"))
const graphs = fixtures(TMP)
for (const id of ["logseq", "tasks", "dataview"]) install(B, id)
const read = (rel) => fs.readFileSync(path.join(VAULT, rel), "utf8")

async function open(w, h, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, acceptDownloads: true, ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  return { ctx, page: watch(await ctx.newPage(), { label: `${w}px`, console: true }) }
}
const shot = async (page, name, el) => { await wait(600); await (el ?? page).screenshot({ path: `${OUT}${name}.png` }); console.log(`     ${OUT}${name}.png`) }
async function go(page, hash) {
  await page.goto("about:blank")
  await page.goto(`${B}#${hash}`)
  await until(() => page.locator("main").count(), 8000)
  await wait(1500)
}
const toast = (page) => page.locator("[data-sonner-toast], [role=status]").filter({ hasText: /Logseq|Sending|Importing/ }).last()

try {
  const { ctx, page } = await open(1440, 900)
  await go(page, "")

  // the graph's folder, picked
  check("Import a Logseq graph… is a command", await command(page, "Import a Logseq graph"))
  await until(() => page.locator("[role=option]", { hasText: "The graph's folder" }).count(), 4000)
  await shot(page, "1-import-choose", page.locator("[role=dialog]").last())
  const chooser = page.waitForEvent("filechooser")
  await page.locator("[role=option]", { hasText: "The graph's folder" }).click()
  await (await chooser).setFiles(graphs.lighthouse)
  await until(() => toast(page).filter({ hasText: /^Logseq: / }).count(), 60000)
  const said = await toast(page).innerText().catch(() => "")
  check("the toast says what came in", /Logseq: 9 pages and 2 journals \(\d+ new, \d+ assets\)/.test(said), said)
  await shot(page, "2-import-done", toast(page))
  check("its notes are there", fs.existsSync(path.join(VAULT, "Logseq/Lighthouse.md")) && fs.existsSync(path.join(VAULT, "Daily/2025-03-02.md")))

  // the notes it made
  await go(page, `file/${enc("Logseq/Lighthouse.md")}`)
  await until(() => page.locator("main").getByText("The lamp is lit at dusk").count(), 8000)
  check("a page reads as its outline", await page.locator("main").getByText("The lamp is lit at dusk").count() > 0)
  await shot(page, "3-page")
  const scroll = async (dy) => { await page.mouse.move(1000, 500); await page.mouse.wheel(0, dy); await wait(800) }
  await scroll(800)
  await shot(page, "4-page-notes")
  await scroll(800)
  await shot(page, "5-page-queries")
  await scroll(900)
  await shot(page, "5b-page-cards")
  await go(page, `file/${enc("Daily/2025-03-02.md")}`)
  await shot(page, "6-journal")
  await go(page, `file/${enc("Logseq/Projects/Lighthouse/Lamp.md")}`)
  await shot(page, "7-namespace")
  // (its settings sheet by address: the app's main has it, v0.14.0 opens it from Plugins only)
  await go(page, "view/logseq/plugin-settings/logseq")
  const sheet = page.locator('[data-plugin-settings-sheet="logseq"]')
  if (await until(() => sheet.count(), 8000)) {
    check("its settings have the import and the export", await sheet.getByText("Export a folder as a Logseq graph…").count() > 0)
    await shot(page, "8-settings", sheet.first())
  } else console.log("     (no settings sheet by address in this version)")

  // a zip: the DB version's Markdown export
  check("…and again for a zip", await command(page, "Import a Logseq graph"))
  await until(() => page.locator("[role=option]", { hasText: "A zip of it" }).count(), 4000)
  const zipChooser = page.waitForEvent("filechooser")
  await page.locator("[role=option]", { hasText: "A zip of it" }).click()
  await (await zipChooser).setFiles(graphs.dbexport)
  await until(() => toast(page).filter({ hasText: /^Logseq: 3 pages/ }).count(), 60000)
  check("the zip came in too", read("Logseq/Projects/Lamp.md").includes("A namespaced page from the DB version"))

  // exported back, from the palette
  check("Export a folder as a Logseq graph… is a command", await command(page, "Export a folder as a Logseq graph"))
  await until(() => page.locator("[role=option]", { hasText: /^Logseq$/ }).count(), 4000)
  await shot(page, "9-export-choose", page.locator("[role=dialog]").last())
  const download = page.waitForEvent("download")
  await page.locator("[role=option]", { hasText: /^Logseq$/ }).first().click()
  const file = path.join(TMP, "export.zip")
  await (await download).saveAs(file)
  check("the export downloads as a zip", fs.statSync(file).size > 1000 && fs.readFileSync(file).subarray(0, 2).toString() === "PK")
  await ctx.close()

  // a phone
  const phone = await open(390, 844, true)
  await go(phone.page, `file/${enc("Logseq/Lighthouse.md")}`)
  await shot(phone.page, "10-phone-page")
  await phone.ctx.close()
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}
await done()
