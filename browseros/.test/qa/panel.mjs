// The Browser agents panel and tab against a made-up BrowserOS neo (served here on 127.0.0.1:8949): a working session
// and one asking for help, their previews, desktop and 390px, with screenshots. Start the throwaway server with
// BROWSEROS_NEO_API=http://127.0.0.1:8949/api/v1.   node browseros/.test/qa/panel.mjs <base url> [out dir]
import http from "node:http"
import { mkdirSync } from "node:fs"
import { install, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, OUT0], browser, check, watch, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const OUT = (OUT0 ?? "/tmp/browseros-shots").replace(/\/?$/, "/")
mkdirSync(OUT, { recursive: true })

// (a 2x2 grey JPEG)
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64")
const neo = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  if (url.pathname === "/api/v1/sessions") {
    res.setHeader("content-type", "application/json")
    return res.end(JSON.stringify({ items: [
      { sessionId: "s1", slug: "claude-code", label: "claude-code", name: "invoice processing", site: "example.com", startedAt: 1,
        live: { state: "active", browserTabs: [{ browserTabId: 11, url: "https://example.com/", title: "Invoices", lastActivityAt: 5 }] } },
      { sessionId: "s2", slug: "codex", label: "codex", name: "calendar check", site: "lighthouse.example", startedAt: 2,
        live: { state: "idle", browserTabs: [{ browserTabId: 21, url: "https://lighthouse.example/", title: "Sign in" }], helpRequest: { requestedAt: 7, reason: "a one-time code" } } },
    ] }))
  }
  if (/^\/api\/v1\/sessions\/s[12]\/preview$/.test(url.pathname)) { res.setHeader("content-type", "image/jpeg"); return res.end(JPEG) }
  res.statusCode = 404; res.end("{}")
})
await new Promise((r) => neo.listen(8949, "127.0.0.1", r))
install(B, "browseros")

for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  const page = watch(await ctx.newPage(), { label: `${w}px`, console: true })
  if (!mobile) {
    await page.goto(B)
    await until(() => page.locator("[data-browseros-panel]").count(), 8000)
    const rows = page.locator("[data-browseros-panel] [data-browseros-session]")
    await until(async () => (await rows.count()) === 2, 8000)
    check("panel: both sessions", (await rows.count()) === 2)
    check("panel: named by the session, the agent beside", (await rows.first().innerText()).includes("invoice processing") && (await rows.first().innerText()).includes("claude-code"))
    await page.locator("[data-browseros-panel]").screenshot({ path: `${OUT}panel.png` })
  }
  await page.goto("about:blank")
  await page.goto(`${B}#view/browseros`)
  const cards = page.locator("main [data-browseros-session]")
  await until(async () => (await cards.count()) === 2, 8000)
  check(`${w}px tab: both sessions`, (await cards.count()) === 2)
  check(`${w}px tab: a help request said`, (await cards.nth(1).innerText()).includes("needs you: a one-time code"))
  await until(() => page.evaluate(() => [...document.querySelectorAll("main [data-browseros-session] img")].every((i) => i.complete && i.naturalWidth > 0)), 8000)
  check(`${w}px tab: the previews load`, await page.evaluate(() => document.querySelectorAll("main [data-browseros-session] img").length === 2))
  await wait(400)
  await page.screenshot({ path: `${OUT}tab-${w}.png` })
  await ctx.close()
}
neo.close()
await done()
