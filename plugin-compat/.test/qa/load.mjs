// Loads every Obsidian plugin installed in the test vault, in Chrome at a desktop and a phone size, and prints what
// each window reported (state, what it registered, what it missed). WRITES the plugin's data.json: throwaway server only.
//   node plugin-compat/.test/qa/load.mjs <base url> [ids,comma,separated]
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, only], browser, watch, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const list = await api("GET", "plugin-compat/plugins")
const want = only ? only.split(",") : list.map((p) => p.id)
for (const p of list) await api("POST", "plugin-compat/enable", { id: p.id, on: want.includes(p.id) })

for (const [label, viewport, mobile] of [["desktop", { width: 1400, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, ...(mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : {}) })
  const page = await ctx.newPage()
  const errs = []
  watch(page, { label, fail: false })
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 300)) })
  page.on("pageerror", (e) => errs.push(`pageerror: ${String(e).slice(0, 300)}`))
  await page.goto(B)
  const rep = await until(async () => {
    const r = await api("GET", "plugin-compat/report")
    const mine = Object.entries(r).filter(([k]) => k.startsWith(mobile ? "phone" : "web")).map(([, v]) => v).sort((a, b) => b.at.localeCompare(a.at))[0]
    return mine && mine.results.length >= want.length ? mine : null
  }, 60000, 1000)
  await wait(3000)
  console.log(`\n=== ${label}`)
  for (const r of rep?.results ?? []) {
    console.log(`${r.state.padEnd(7)} ${r.id} ${r.version} ${r.ms}ms cmds=${r.commands} views=${r.views} fences=${r.fences} settings=${r.settings} ribbon=${r.ribbon} status=${r.statusBar} pp=${r.postProcessors} suggest=${r.suggests}`)
    if (r.error) console.log(`   error: ${r.error.split("\n").slice(0, 2).join(" | ")}`)
    const m = Object.keys(r.missed ?? {})
    if (m.length) console.log(`   missed: ${m.join(", ")}`)
  }
  console.log(`console errors (${errs.length}):`, errs.slice(0, 12))
  await page.screenshot({ path: `/tmp/oc/shots/load-${label}.png` })
  await ctx.close()
}
await done()
