// Opens a note and runs a script in the page (an async function body, from a file): debugging the runtime.
//   node plugin-compat/.test/qa/eval.mjs <base url> <note path> <script file>
import fs from "node:fs"
import { qa, until, wait } from "../../../qa.mjs"
const { args: [B, note, file], browser, done } = await qa(import.meta.url)
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/Failed to load|Vim adapter|createServer|Buffer/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 500)}`) })
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e.stack ?? e).slice(0, 500)}`))
await page.goto(`${B}#file/${encodeURIComponent(note)}`)
await until(() => page.evaluate(() => window.app?.workspace?.layoutReady), 30000)
await wait(1500)
console.log(JSON.stringify(await page.evaluate(`(async () => { ${fs.readFileSync(file, "utf8")} })()`), null, 1)?.slice(0, 4000))
await page.screenshot({ path: "/tmp/oc/shots/eval.png" })
await done()
