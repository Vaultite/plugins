// Runs an expression in the lab's page once the plugins are loaded and prints its value (for poking at the runtime).
//   node evalpage.mjs <base url> "<js expression, may await>"
import { qa, until } from "../../../qa.mjs"
const { args: [B0, expr], browser, done } = await qa(import.meta.url)
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e.stack ?? e).slice(0, 600)))
await page.goto(B0)
await until(() => page.evaluate(() => window.app?.workspace?.layoutReady), 90000, 500)
await new Promise((r) => setTimeout(r, 2000))
console.log(await page.evaluate(`(async () => { try { return JSON.stringify(await (async () => (${expr}))(), null, 1) } catch (e) { return "THROWN " + e.stack } })()`))
if (errs.length) console.log("page errors:", errs.slice(0, 5).join("\n---\n"))
await done()
