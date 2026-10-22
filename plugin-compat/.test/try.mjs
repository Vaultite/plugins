// Obsidian plugins tried as a user would: each installed from GitHub (plugin-compat.install, its id in Obsidian's list or
// owner/repo) on a throwaway lab (lab.mjs, isolated), turned on, loaded in Chrome; prints JSON: per plugin, whether it
// loaded, its errors, what it registered (commands, views, code blocks, settings...) and what of the API it missed.
//   node try.mjs <id|owner/repo>... [--port 8962] [--out file.json] [--keep: leave the lab up]
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { apiAt, qa, until, wait } from "../../qa.mjs"

const { args, browser } = await qa(import.meta.url)
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v }
const keep = args.includes("--keep") ? (args.splice(args.indexOf("--keep"), 1), true) : false
const port = Number(opt("port", "8962")), out = opt("out", "")
const wanted = args.filter(Boolean)
if (!wanted.length) { console.error("node try.mjs <id|owner/repo>... [--port N] [--out file] [--keep]"); process.exit(2) }

const HERE = import.meta.dirname, APP = path.resolve(process.env.VAULTITE_APP ?? path.join(HERE, "..", "..", "..", "vaultite"))
const lab = `try-${port}`
const node = (...a) => execFileSync(process.execPath, a, { encoding: "utf8", env: { ...process.env, OC_ISOLATE: "1" } })
const base = node(path.join(HERE, "lab.mjs"), "up", lab, String(port), "none").trim().split("\n").pop()
const api = apiAt(base)

const report = { at: new Date().toISOString(), app: APP, plugins: {}, unattributed: [] }
try {
  const ids = []
  for (const w of wanted) {
    const r = await api("POST", "ops/plugin-compat.install", { repo: w, on: true }).catch((e) => ({ error: String(e) }))
    const got = r?.result ?? r
    if (got?.id) { ids.push(got.id); report.plugins[got.id] = { asked: w, version: got.version } }
    else report.plugins[w] = { asked: w, state: "not installed", error: typeof r === "string" ? r.slice(0, 300) : r?.error ?? r }
  }
  if (ids.length) {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    const errs = []
    // (whose: its main.js in the stack, or the runtime's "Obsidian plugin <id>:" when it caught what the plugin threw)
    const owner = (s) => /obsidian-plugin:([^/\s)]+)\/main\.js/.exec(s ?? "")?.[1] ?? /(?:Obsidian plugin|Plugin failure:) ([^\s:()]+)/.exec(s ?? "")?.[1] ?? "?"
    page.on("pageerror", (e) => errs.push({ by: owner(e.stack), text: String(e.stack ?? e).slice(0, 400) }))
    page.on("console", (m) => { if (m.type() === "error" || (m.type() === "warning" && /Obsidian plugin/.test(m.text()))) errs.push({ by: owner(m.text()), text: m.text().slice(0, 400) }) })
    const started = Date.now()
    await page.goto(base)
    const mine = async () => Object.values(await api("GET", "plugin-compat/report")).find((v) => v?.client?.startsWith("web") && Date.parse(v.at) >= started)
    await until(async () => ((await mine())?.results.length ?? 0) >= ids.length, 120000, 1000)
    await wait(4000) // (what plugins do once the layout is ready)
    const got = (await mine())?.results ?? []
    const seen = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, {
      commands: Object.keys(window.app.commands.commands).filter((k) => k.startsWith(`${id}:`)),
    }])), ids)
    for (const id of ids) {
      const r = got.find((x) => x.id === id)
      Object.assign(report.plugins[id], r ? { state: r.state, error: r.error, ms: r.ms, commands: seen[id].commands, views: r.views, codeBlocks: r.fences, settings: r.settings,
        ribbon: r.ribbon, statusBar: r.statusBar, postProcessors: r.postProcessors, editorExtensions: r.editorExtensions, suggests: r.suggests, missed: r.missed }
        : { state: "not loaded" }, { errors: errs.filter((e) => e.by === id).map((e) => e.text).slice(0, 10) })
    }
    report.unattributed = errs.filter((e) => !ids.includes(e.by)).map((e) => e.text).slice(0, 20)
    await page.context().close()
  }
  // (the server's side: what the app recorded, with stacks)
  const se = await api("POST", "ops/errors.list", {}).catch((e) => String(e))
  report.server = se?.result ?? se
} finally {
  if (!keep) node(path.join(HERE, "lab.mjs"), "down", lab)
}
const text = JSON.stringify(report, null, 2)
if (out) fs.writeFileSync(out, text)
console.log(text)
if (keep) console.error(`lab up at ${base} (node lab.mjs down ${lab})`)
// (not done(): its verdict line would follow the JSON)
await browser.close()
process.exit(0)
