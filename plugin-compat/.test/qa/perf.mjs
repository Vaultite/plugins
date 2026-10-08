// What Obsidian plugins cost: time to a usable note and to all plugins loaded, typing latency during and after the
// load, long tasks, heap, and a Node bridge call. Prints one JSON line. Throwaway server only (lab.mjs).
//   node perf.mjs <base url> [phone] [label] [warm]
import { qa, until, wait } from "../../../qa.mjs"

const { args: [B0, mode = "", label = ""], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const phone = mode === "phone"
const ctx = await browser.newContext(phone
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }
  : { viewport: { width: 1400, height: 900 } })
await ctx.addInitScript(() => {
  const w = window
  w.__lt = []; w.__ev = []; w.__ready = 0
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lt.push([e.startTime, e.duration]) }).observe({ type: "longtask", buffered: true })
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "keydown" || e.name === "keypress") w.__ev.push([e.startTime, e.duration]) }).observe({ type: "event", durationThreshold: 16, buffered: true })
  const poll = setInterval(() => { if (w.app?.workspace?.layoutReady) { w.__ready = performance.now(); clearInterval(poll) } }, 25)
})
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send("Performance.enable")
const NOTE = "Notes/Outline.md"
// warm: a load before the measured one, as when the app is opened again (the browser has the plugins' code compiled)
if (process.argv.includes("warm")) { await page.goto(B); await until(() => page.evaluate(() => window.__ready > 0), 180000, 200); await wait(2000); await page.goto("about:blank") }
await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`)
// (phones open a note to read: the editor shows the text either way)
const tNote = await until(() => page.evaluate(() => { const c = [...document.querySelectorAll(".cm-content")].find((e) => e.textContent?.includes("One a") && e.getClientRects().length); return c ? performance.now() : null }), 60000, 20)
if (phone) {
  const t = page.locator("[data-view-toggle]").first()
  if (await t.count() && await t.getAttribute("data-view-toggle") === "read") await t.click()
}
const focusEnd = () => page.evaluate(() => { const c = [...document.querySelectorAll(".cm-content")].find((e) => e.textContent?.includes("One a") && e.getClientRects().length); c?.focus(); const s = getSelection(); if (c && s) { s.selectAllChildren(c); s.collapseToEnd() } })
await focusEnd()
// Typing while plugins load: a key every 250 ms until they're all in (or 90 s).
const during = []
for (let i = 0; i < 360; i++) {
  if (await page.evaluate(() => window.__ready > 0)) break
  const t = Date.now()
  await page.keyboard.type("x")
  during.push(Date.now() - t)
  await wait(250)
}
const tReady = await until(() => page.evaluate(() => window.__ready || null), 180000, 50)
const loadEv = await page.evaluate(() => window.__ev.map((e) => e[1]))
const loadLt = await page.evaluate(() => window.__lt.filter((e) => e[0] < window.__ready))
await wait(3000)
// Typing once loaded.
await focusEnd()
const mark = await page.evaluate(() => performance.now())
const keys = []
for (let i = 0; i < 40; i++) { const t = Date.now(); await page.keyboard.type(i % 10 === 9 ? " " : "y"); keys.push(Date.now() - t); await wait(50) }
await wait(500)
const after = await page.evaluate((m) => ({ ev: window.__ev.filter((e) => e[0] >= m).map((e) => e[1]), lt: window.__lt.filter((e) => e[0] >= m) }), mark)
await page.evaluate(() => window.gc?.())
const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]))
// One Node bridge call (computers only).
const bridge = await page.evaluate(() => {
  const r = window.require
  if (!r) return null
  try {
    const cp = r("child_process"), t0 = performance.now()
    for (let i = 0; i < 5; i++) cp.execSync("echo hi")
    const t1 = performance.now(), fs = r("fs")
    for (let i = 0; i < 20; i++) fs.existsSync("/tmp")
    return { exec: Math.round((t1 - t0) / 5), stat: Math.round((performance.now() - t1) / 20) }
  } catch (e) { return { error: String(e).slice(0, 120) } }
})
const n = await page.evaluate(() => Object.keys(window.app?.plugins?.plugins ?? {}).length)
const sum = (l) => Math.round(l.reduce((a, b) => a + b, 0))
const pct = (l, p) => (l.length ? [...l].sort((a, b) => a - b)[Math.min(l.length - 1, Math.floor(l.length * p))] : 0)
const out = { label, phone, plugins: n, noteMs: Math.round(tNote), readyMs: Math.round(tReady),
  duringKeys: during.length, duringKeyP95: pct(during, 0.95), duringKeyMax: Math.max(0, ...during), loadLongTasks: loadLt.length, loadLongMs: sum(loadLt.map((e) => e[1])), loadLongMax: Math.round(Math.max(0, ...loadLt.map((e) => e[1]))),
  keyP50: pct(keys, 0.5), keyP95: pct(keys, 0.95), keyEvSlow: after.ev.length, keyEvMax: Math.round(Math.max(0, ...after.ev)), typingLongMs: sum(after.lt.map((e) => e[1])),
  heapMB: Math.round(metrics.JSHeapUsedSize / 1048576), nodes: metrics.Nodes, listeners: metrics.JSEventListeners, bridge }
console.log(JSON.stringify(out))
await ctx.close()
await done()
