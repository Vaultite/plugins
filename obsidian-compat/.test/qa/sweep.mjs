// Loads the Obsidian plugins that are on in a lab's vault, in Chrome (desktop size, or a phone's), and writes what each
// did: loaded or failed (why), what it registered, what of Obsidian's API it reached for that isn't here, and the
// errors thrown from its code. Throwaway server only (lab.mjs).
//   node sweep.mjs <base url> [phone] [out.json]
import fs from "node:fs"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, mode = "", out = ""], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const phone = mode === "phone"
const list = (await api("GET", "obsidian-compat/plugins")).filter((p) => p.enabled && p.allowed)
const ctx = await browser.newContext(phone
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }
  : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
const owner = (s) => /obsidian-plugin:([^/\s)]+)\/main\.js/.exec(s ?? "")?.[1] ?? "?"
page.on("pageerror", (e) => errs.push({ by: owner(e.stack), text: String(e.message).slice(0, 300) }))
page.on("console", (m) => { if (m.type() === "error") errs.push({ by: owner(m.location()?.url + " " + m.text()), text: m.text().slice(0, 300) }) })
const started = Date.now()
await page.goto(B)
const client = phone ? "phone" : "web"
const rep = await until(async () => {
  const r = await api("GET", "obsidian-compat/report")
  const mine = Object.entries(r).filter(([k, v]) => k.startsWith(client) && Date.parse(v.at) >= started).map(([, v]) => v)[0]
  return mine && mine.results.length >= list.length ? mine : null
}, 120000, 1000)
await wait(4000) // (what plugins do once the layout is ready)
const last = Object.entries(await api("GET", "obsidian-compat/report")).filter(([k, v]) => k.startsWith(client) && Date.parse(v.at) >= started).map(([, v]) => v)[0] ?? rep
const results = (last?.results ?? []).map((r) => ({ ...r, errors: errs.filter((e) => e.by === r.id).map((e) => e.text).slice(0, 5) }))
const summary = { at: new Date().toISOString(), client, plugins: results, unattributed: errs.filter((e) => e.by === "?").map((e) => e.text).slice(0, 30), workspace: last?.workspace ?? {} }
if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2))
for (const r of results) {
  console.log(`${r.state.padEnd(7)} ${r.id} ${r.ms}ms cmds=${r.commands} views=${r.views} fences=${r.fences} settings=${r.settings} errors=${r.errors.length} missed=${Object.keys(r.missed ?? {}).length}`)
  if (r.error) console.log(`   error: ${r.error.split("\n").slice(0, 2).join(" | ")}`)
}
console.log(`unattributed errors: ${summary.unattributed.length}`)
await ctx.close()
await done()
