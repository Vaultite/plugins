// App windows in the desktop app (a Mac): installed and on, the vault's window opens see-through; "Open app in a tab…"
// lists the Mac's apps; an app's tab asks the app's helper for its window (one not on this Mac says so, as does a
// missing Accessibility permission). Nothing of the user's: a throwaway vault and app data.
//   node app-windows/.test/qa/desktop.mjs
import { desktop, qa, until, wait } from "../../../qa.mjs"

const { check, watch, done, skip } = await qa(import.meta.url, { chrome: false })
if (process.platform !== "darwin") await skip("the desktop app's App windows are a Mac's")
const d = await desktop(["app-windows"])
try {
  watch(d.win, { console: true })
  const colors = await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBackgroundColor()))
  check("installed and on, the vault's window is see-through (electron/apps.ts appsOn)", colors.includes("#00000000"), colors)
  await d.win.keyboard.press("ControlOrMeta+P"); await d.win.waitForSelector("[role=option]"); await d.win.keyboard.type("Open app in a tab"); await wait(300)
  await d.win.keyboard.press("Enter")
  check("Open app in a tab… lists the Mac's apps", await until(async () => (await d.win.locator("[role=option]", { hasText: "Finder" }).count()) > 0, 60000))
  await d.win.keyboard.press("Escape"); await wait(300)
  d.vau("open", "view:app/com.example.nowhere")
  const said = await until(async () => /isn't on this Mac|Accessibility permission/.test(await d.win.locator("[data-pane]").innerText()), 60000)
  check("an app's tab asks the helper for its window: one not on this Mac says so (or the permission it needs)", said, (await d.win.locator("[data-pane]").innerText()).slice(0, 300))
} finally {
  await d.close()
}
await done()
