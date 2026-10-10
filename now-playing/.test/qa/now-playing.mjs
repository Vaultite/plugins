// Now playing in a browser: the sidebar panel (the main player as a card, the others as rows; a row picked becomes the
// card; its menu's Open in a tab), its tab (a wide pane and a narrow one) and the block on a page, with screenshots. Shows whatever this Mac
// plays; WRITES a note to the vault: throwaway server only.
//   node now-playing/.test/qa/now-playing.mjs <base url> <vault path> [out dir]   (VAULTITE_APP: the app's checkout)
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { install, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, VAULT, OUT0], browser, check, watch, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const OUT = (OUT0 ?? "/tmp/now-playing-shots").replace(/\/?$/, "/")
mkdirSync(OUT, { recursive: true })
install(B, "now-playing")
const NOTE = "QA/Lighthouse radio.md"
mkdirSync(path.join(VAULT, "QA"), { recursive: true })
writeFileSync(path.join(VAULT, NOTE), "# Lighthouse radio\n\n```block-now-playing\n```\n")
const n = await (await fetch(`${B}api/now-playing`)).json()
console.log(`     players: ${n.players.map((p) => `${p.app.name} (${p.playing ? "playing" : "paused"}${p.control ? "" : ", no control"})`).join(", ") || "none"}`)

const shot = async (page, name, el) => { await wait(600); await (el ?? page).screenshot({ path: `${OUT}${name}.png` }); console.log(`     ${OUT}${name}.png`) }
async function go(page, hash) {
  await page.goto("about:blank")
  await page.goto(`${B}#${hash}`)
  await until(() => page.locator("main").count(), 8000)
  await wait(2000)
}
/** A scroller around the player (the pane, the sidebar) scrolls sideways. */
const overflow = (page) => page.evaluate(() => [...document.querySelectorAll("[data-now-playing-tab], [data-now-playing]")].some((el) => {
  for (let s = el.parentElement; s; s = s.parentElement) if (/(auto|scroll)/.test(getComputedStyle(s).overflowX)) return s.scrollWidth > s.clientWidth + 1
  return false
}))

for (const [w, h] of [[1440, 900], [900, 800]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
  const page = watch(await ctx.newPage(), { label: `${w}px` })
  await go(page, `view/now-playing`)
  const tab = page.locator("[data-now-playing-tab]").first()
  check(`${w}px tab: drawn`, await until(() => tab.isVisible(), 6000))
  if (n.players.length) {
    const cover = await tab.locator("img, svg").first().boundingBox()
    const box = await tab.boundingBox()
    check(`${w}px tab: a big cover, centered`, cover && box && cover.width >= Math.min(300, box.width - 2) && Math.abs(cover.x + cover.width / 2 - (box.x + box.width / 2)) < 4, [cover, box])
  }
  check(`${w}px tab: nothing overflows`, !(await overflow(page)))
  await shot(page, `tab-${w}`)
  const panel = page.locator("[data-now-playing]").first()
  if (await panel.isVisible().catch(() => false)) {
    check(`${w}px panel: a row per other player`, (await panel.locator("[data-player]").count()) === Math.max(0, n.players.length - 1))
    await shot(page, `panel-${w}`, panel)
    if (n.players.length > 1) {
      const other = n.players[1]
      await panel.locator(`[data-player="${other.app.bundle}"] button`).first().click()
      check(`${w}px panel: a picked row becomes the card`, await until(async () => (await panel.locator("[data-heading]").getAttribute("data-heading"))?.includes(other.app.name), 3000))
      await shot(page, `panel-picked-${w}`, panel)
    }
  }
  await go(page, `file/${encodeURIComponent(NOTE)}`)
  if (await panel.isVisible().catch(() => false)) {
    await panel.locator("[data-panel-handle]").first().click({ button: "right" })
    const item = page.getByText("Open Now playing in a tab", { exact: true }).first()
    check(`${w}px panel: its menu has Open in a tab`, await until(() => item.isVisible(), 3000))
    await item.click()
    check(`${w}px panel: Open in a tab shows the player`, await until(() => page.locator("[data-now-playing-tab]").first().isVisible(), 5000))
    await go(page, `file/${encodeURIComponent(NOTE)}`)
  }
  check(`${w}px block: drawn`, await until(() => page.locator("main [role=slider], main :text('Nothing playing'), main :text('isn\\'t available')").first().isVisible(), 6000))
  await shot(page, `block-${w}`)
  await ctx.close()
}
done()
