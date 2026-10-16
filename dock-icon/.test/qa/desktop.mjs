// Dock icon in the desktop app (a Mac): installed and on, an image's menu has Use as Dock icon, which the main process
// keeps in the app's data; Reset Dock icon takes it away. Nothing of the user's: a throwaway vault and app data.
//   node dock-icon/.test/qa/desktop.mjs
import fs from "node:fs"
import path from "node:path"
import { desktop, qa, until, wait } from "../../../qa.mjs"

const { check, watch, done, skip } = await qa(import.meta.url, { chrome: false })
if (process.platform !== "darwin") await skip("the Dock is a Mac's")
const d = await desktop(["dock-icon"])
// (a 1x1 red PNG)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
const kept = path.join(d.userData, "dock-icon.png")
try {
  watch(d.win, { console: true })
  fs.writeFileSync(path.join(d.vault, "Dock qa.png"), Buffer.from(PNG, "base64"))
  d.vau("open", "Dock qa.png")
  const img = d.win.locator("[data-pane] article[data-kind=image] img").first()
  await img.waitFor({ timeout: 30000 })
  await img.click({ button: "right" })
  const item = d.win.getByRole("menuitem", { name: "Use as Dock icon" })
  if (!(await until(async () => (await item.count()) > 0, 2000))) await d.win.getByRole("menuitem", { name: /^More/ }).first().click()
  await item.click()
  check("an image's menu: Use as Dock icon keeps it in the app's data", await until(() => fs.existsSync(kept), 10000) &&
    await until(async () => (await d.win.getByText("Dock qa.png is the Dock icon").count()) > 0, 5000))
  await wait(300)
  await d.win.keyboard.press("ControlOrMeta+P"); await d.win.waitForSelector("[role=option]"); await d.win.keyboard.type("Reset Dock icon"); await wait(300)
  const offered = (await d.win.locator("[role=option]", { hasText: "Reset Dock icon" }).count()) > 0
  await d.win.keyboard.press(offered ? "Enter" : "Escape")
  check("Reset Dock icon is offered, and takes it away", offered && await until(() => !fs.existsSync(kept), 10000))
} finally {
  await d.close()
}
await done()
