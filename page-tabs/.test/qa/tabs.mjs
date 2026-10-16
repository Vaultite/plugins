// Page tabs in a real browser: two pages joined by `tabs:` show the strip under their titles, and picking a tab shows
// that page; desktop and a 390px phone. Installs the plugin; WRITES a folder (Qa tabs/): a throwaway server only.
//   node page-tabs/.test/qa/tabs.mjs <base url> <vault path> [out dir]
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { install, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
mkdirSync(`${VAULT}/Qa tabs`, { recursive: true })
writeFileSync(`${VAULT}/Qa tabs/Harbor.md`, "---\ntab: List\ntabs: [Harbor map]\n---\n\nThe boats in a list.\n")
writeFileSync(`${VAULT}/Qa tabs/Harbor map.md`, "---\ntab: Map\n---\n\nThe boats on a map.\n")
const putBackWs = setAsideWorkspaces(VAULT)
install(B, "page-tabs")

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 860 } }], ["phone", phone]]) {
  const ctx = await browser.newContext(opts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent("Qa tabs/Harbor.md")}`); await wait(2000)
  const strip = page.locator(".page-tabs").last()
  check(`${label}: the strip, its tabs by their labels`, await until(async () => (await strip.count()) > 0 && (await strip.innerText()).replace(/\s+/g, " ").trim() === "List Map", 8000),
    await strip.count() && await strip.innerText())
  await page.screenshot({ path: `${OUT}page-tabs-${label}.png` })
  await strip.getByText("Map", { exact: true }).click()
  check(`${label}: picking a tab shows its page`, await until(async () => (await page.getByText("The boats on a map.").count()) > 0, 6000))
  await ctx.close()
}
rmSync(`${VAULT}/Qa tabs`, { recursive: true, force: true })
putBackWs()
await done()
