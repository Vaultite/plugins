// Opens the app and prints its console for a while: debugging the runtime.
//   node obsidian-compat/.test/qa/peek.mjs <base url> [seconds]
import { qa, wait } from "../../../qa.mjs"
const { args: [B, secs = "15"], browser, done } = await qa(import.meta.url)
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on("console", (m) => console.log(`[${m.type()}] ${m.text().slice(0, 400)}`))
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e.stack ?? e).slice(0, 600)}`))
await page.goto(B)
await wait(Number(secs) * 1000)
await page.screenshot({ path: "/tmp/oc/shots/peek.png" })
await done()
