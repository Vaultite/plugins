// A note changed on disk while being typed in (the server's own frontmatter stamp, saved text a few keys behind): the
// cursor stays and nothing typed is lost. WRITES "Qa follow/": lab only.
//   node follow.mjs <base url>
import { qa, until, wait } from "../../../qa.mjs"

const { args: [B0], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
const api = (m, r, b) => page.evaluate(async ([m, r, b]) => { const x = await fetch(`/api/${r}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const t = await x.text(); try { return JSON.parse(t) } catch { return t } }, [m, r, b])
const P = "Qa follow/Note.md"
const fm = (status) => `---\ntags: [qa]\nstatus: ${status}\n---\n`
const BODY = "First line.\n\nSecond line\n"

await page.goto(B)
await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 90000 })
await api("POST", "file", { path: P, text: fm("draft") + BODY })
await page.evaluate((h) => { location.hash = h }, `#file/${encodeURIComponent(P)}`)
await until(() => page.evaluate((p) => window.app.workspace.activeEditor?.file?.path === p, P), 15000)
const ed = () => page.evaluate(() => { const e = window.app.workspace.activeEditor.editor; return { text: e.getValue(), at: e.posToOffset(e.getCursor()) } })
await page.evaluate(() => { const e = window.app.workspace.activeEditor.editor, v = e.getValue(); e.focus(); e.setCursor(e.offsetToPos(v.indexOf("Second line") + 11)) })
await page.keyboard.type(" abc", { delay: 30 })
await until(async () => (await api("GET", `file?path=${encodeURIComponent(P)}`)).text?.includes("abc"), 8000, 250)

// The disk gets a new frontmatter and the body as saved, while " def" is typed but not yet saved.
await page.keyboard.type(" def", { delay: 30 })
await api("PUT", "file", { path: P, text: fm("done") + BODY.replace("Second line", "Second line abc") })
await wait(2500)
const { text, at } = await ed()
const fails = []
if (!text.includes("Second line abc def")) fails.push(`typing lost: ${JSON.stringify(text.slice(text.indexOf("Second")))}`)
if (at !== text.indexOf(" def") + 4) fails.push(`cursor moved to ${at}, not after " def" (${text.indexOf(" def") + 4})`)
if (!text.includes("status: done")) fails.push("the disk's frontmatter didn't arrive")
console.log(fails.length ? `FAIL\n  ${fails.join("\n  ")}` : "ok: cursor kept, nothing lost")
await done()
process.exit(fails.length ? 1 : 0)
