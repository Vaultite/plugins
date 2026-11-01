// Compatibility measured: the most downloaded Obsidian plugins, each installed from its release and loaded headless
// (try.mjs, in batches; any that doesn't pass is tried again alone), written to measured/ as data.
//   node measure.mjs top [N]                 the list to measure: Obsidian's N most downloaded (measured/top.tsv)
//   node measure.mjs run [--batch 10] [--port 8962] [--only id,id] [--first N] [--open]   measure them: measured/results.json, a line in history.tsv
//     (--open: each one's views opened and its settings drawn too, try.mjs --open)
//   node measure.mjs gaps [N]                what they reach for that isn't here, by the downloads of the plugins that do
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const HERE = import.meta.dirname, OUT = path.join(HERE, "measured"), APP = path.resolve(process.env.VAULTITE_APP ?? path.join(HERE, "..", "..", "..", "vaultite"))
const RAW = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD"
const [cmd = "", ...args] = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1] }
const TOP = path.join(OUT, "top.tsv"), RESULTS = path.join(OUT, "results.json"), HISTORY = path.join(OUT, "history.tsv")
fs.mkdirSync(OUT, { recursive: true })

const readTop = () => fs.readFileSync(TOP, "utf8").trim().split("\n").slice(1).map((l) => {
  const [rank, id, repo, downloads, name] = l.split("\t")
  return { rank: Number(rank), id, repo, downloads: Number(downloads), name }
})

/** pass: loaded, registered what it does, reached for nothing missing, threw nothing. partial: loaded, but missed
 *  something of the API or threw from its code. fail: didn't install, didn't load, or its onload threw. */
function verdict(p) {
  if (!p || p.state === "not installed") return { verdict: "fail", why: `not installed: ${String(p?.error ?? "?").slice(0, 200)}` }
  if (p.state === "skipped") return { verdict: "standin", why: p.error }
  if (p.state !== "ok") return { verdict: "fail", why: String(p.error ?? p.state).split("\n")[0].slice(0, 300) }
  if (/^onload threw/.test(p.error ?? "")) return { verdict: "fail", why: p.error.split("\n").slice(0, 2).join(" ").slice(0, 300) }
  const missed = Object.keys(p.missed ?? {}), errors = [...(p.errors ?? []), ...(p.thrown ?? [])]
  // (one that caught its own failure to start: an error, and nothing of it registered)
  const nothing = !p.commands?.length && !p.views?.length && !p.codeBlocks?.length && !p.settings && !p.ribbon && !p.statusBar && !p.postProcessors && !p.editorExtensions && !p.suggests
  if (nothing && errors.length) return { verdict: "fail", why: `started, then stopped: ${errors[0].split("\n")[0].slice(0, 280)}` }
  if (missed.length || errors.length || p.error) return { verdict: "partial", why: p.error ?? (missed.length ? `missed ${missed.join(", ")}`.slice(0, 300) : errors[0].split("\n")[0].slice(0, 300)) }
  return { verdict: "pass" }
}

const OPEN = args.includes("--open")
function tryBatch(ids, port, n) {
  const out = path.join("/var/tmp", `compat-batch-${port}-${n}.json`)
  try {
    execFileSync(process.execPath, [path.join(HERE, "try.mjs"), ...ids, "--port", String(port), "--out", out, ...(OPEN ? ["--open"] : [])],
      { stdio: ["ignore", "ignore", "inherit"], timeout: 300000, env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/var/tmp" } })
  } catch (e) { console.error(`batch ${n} (${ids.join(",")}): ${String(e.message).split("\n")[0]}`) }
  try { return JSON.parse(fs.readFileSync(out, "utf8")) } catch { return { plugins: {} } } finally { fs.rmSync(out, { force: true }) }
}

const git = (dir) => { try { return execFileSync("git", ["-C", dir, "rev-parse", "--short=8", "HEAD"], { encoding: "utf8" }).trim() } catch { return "?" } }

if (cmd === "top") {
  const n = Number(args[0] ?? 300)
  const [list, stats] = await Promise.all([fetch(`${RAW}/community-plugins.json`).then((r) => r.json()), fetch(`${RAW}/community-plugin-stats.json`).then((r) => r.json())])
  const top = list.map((p) => ({ ...p, downloads: stats[p.id]?.downloads ?? 0 })).sort((a, b) => b.downloads - a.downloads).slice(0, n)
  fs.writeFileSync(TOP, ["rank\tid\trepo\tdownloads\tname", ...top.map((p, i) => [i + 1, p.id, p.repo, p.downloads, p.name.replace(/\s+/g, " ")].join("\t"))].join("\n") + "\n")
  console.log(`${top.length} plugins in ${path.relative(process.cwd(), TOP)} (${new Date().toISOString().slice(0, 10)})`)
} else if (cmd === "run") {
  const size = Number(opt("batch", 10)), port = Number(opt("port", 8962)), only = opt("only", "")?.split(",").filter(Boolean)
  let top = readTop()
  if (only?.length) top = top.filter((p) => only.includes(p.id))
  if (opt("first", "")) top = top.slice(0, Number(opt("first", "")))
  const prev = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : { plugins: [] }
  const got = new Map()
  const keep = (p, t) => {
    const r = t.plugins[p.id] ?? Object.values(t.plugins).find((x) => x.asked === p.id)
    if (r) got.set(p.id, { ...r, unattributed: t.unattributed })
  }
  for (let i = 0; i < top.length; i += size) {
    const batch = top.slice(i, i + size)
    const t = tryBatch(batch.map((p) => p.id), port, i / size)
    for (const p of batch) keep(p, t)
    const v = batch.map((p) => verdict(got.get(p.id)).verdict)
    console.error(`${i + batch.length}/${top.length}: ${batch.map((p, j) => `${p.id} ${v[j]}`).join(", ")}`)
  }
  // (one plugin can trip another sharing its page: whatever didn't pass gets a page of its own)
  for (const p of top.filter((x) => verdict(got.get(x.id)).verdict !== "pass")) {
    const t = tryBatch([p.id], port, `alone-${p.id}`)
    if (Object.keys(t.plugins).length) keep(p, t)
    console.error(`alone: ${p.id} ${verdict(got.get(p.id)).verdict}`)
  }
  const rows = top.map((p) => {
    const r = got.get(p.id), v = verdict(r)
    return { rank: p.rank, id: p.id, name: p.name, repo: p.repo, downloads: p.downloads, version: r?.version ?? null, ...v,
      missed: Object.keys(r?.missed ?? {}).sort(), errors: [...(r?.errors ?? []), ...(r?.thrown ?? [])].map((e) => e.split("\n")[0].slice(0, 300)).slice(0, 5),
      registered: r?.state === "ok" ? { commands: r.commands?.length ?? 0, views: r.views?.length ?? 0, codeBlocks: r.codeBlocks?.length ?? 0, settings: !!r.settings,
        ribbon: r.ribbon ?? 0, statusBar: r.statusBar ?? 0, postProcessors: r.postProcessors ?? 0, editorExtensions: !!r.editorExtensions } : null }
  })
  // (a partial run updates its plugins in the full list)
  const merged = new Map(prev.plugins.map((p) => [p.id, p]))
  for (const r of rows) merged.set(r.id, r)
  const ranked = new Map(readTop().map((p) => [p.id, p.rank]))
  const plugins = [...merged.values()].filter((p) => ranked.has(p.id)).sort((a, b) => ranked.get(a.id) - ranked.get(b.id))
  const count = (v) => plugins.filter((p) => p.verdict === v).length
  const counts = { pass: count("pass"), partial: count("partial"), fail: count("fail"), standin: count("standin") }
  const at = new Date().toISOString(), app = git(APP), compat = git(HERE)
  fs.writeFileSync(RESULTS, JSON.stringify({ at, app, compat, client: "web, desktop size, headless Chrome", checks: OPEN ? "load, views, settings" : "load", of: plugins.length, counts, plugins }, null, 1) + "\n")
  if (!fs.existsSync(HISTORY)) fs.writeFileSync(HISTORY, "at\tapp\tplugin-compat\tmeasured\tpass\tpartial\tfail\tstandin\tchecks\n")
  // (what Browse shows for those nobody tried by hand: a verdict on loading, never "works")
  fs.writeFileSync(path.join(HERE, "..", "measured.json"), JSON.stringify(Object.fromEntries(plugins.map((p) => [p.id, { pass: "loads", partial: "partly", fail: "no", standin: "unneeded" }[p.verdict]])), null, 1) + "\n")
  fs.appendFileSync(HISTORY, [at, app, compat, rows.length, counts.pass, counts.partial, counts.fail, counts.standin, OPEN ? "load, views, settings" : "load"].join("\t") + "\n")
  console.log(`${plugins.length} plugins: ${counts.pass} pass, ${counts.partial} partial, ${counts.fail} fail, ${counts.standin} stand-in`)
} else if (cmd === "gaps") {
  const { plugins } = JSON.parse(fs.readFileSync(RESULTS, "utf8"))
  const gaps = new Map()
  const add = (key, p) => { const g = gaps.get(key) ?? { key, downloads: 0, plugins: [] }; g.downloads += p.downloads; g.plugins.push(p.id); gaps.set(key, g) }
  for (const p of plugins) {
    for (const m of p.missed) add(`missed ${m}`, p)
    if (p.verdict === "fail") add(`fail ${p.why.replace(/\d+/g, "N").slice(0, 120)}`, p)
    for (const e of new Set(p.errors.map((e) => e.replace(/\d+/g, "N").slice(0, 120)))) add(`error ${e}`, p)
  }
  for (const g of [...gaps.values()].sort((a, b) => b.downloads - a.downloads).slice(0, Number(args[0] ?? 40)))
    console.log(`${String(g.downloads).padStart(9)} ${String(g.plugins.length).padStart(3)}  ${g.key}\n             ${g.plugins.slice(0, 8).join(" ")}`)
} else {
  console.error("node measure.mjs top [N] | run [--batch 10] [--port 8962] [--only ids] [--first N] [--open] | gaps [N]")
  process.exit(2)
}
