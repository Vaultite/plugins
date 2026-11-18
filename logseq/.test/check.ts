// One graph through a throwaway server: imported, then checked against its source (counts, links and block refs that
// resolve, frontmatter that parses, notes that render), imported again (nothing changes) and exported back (equivalent).
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { APP } from "../../testkit.ts"
import { differ, pageKey, useMacros } from "./same.ts"

const core = (m: string) => import(pathToFileURL(path.join(APP, "core", m)).href)
const { linkResolver, fenced } = await core("links.ts")
const { parseText } = await core("frontmatter.ts")
const P = (m: string) => import(new URL(`../${m}`, import.meta.url).href)
const { graphConfig, DEFAULT_CONFIG } = await P("edn.ts")
const { titleOfFile, nameKey } = await P("names.ts")
const { readDate } = await P("dates.ts")
const { parsePage, allBlocks, blockParts } = await P("outline.ts")
const { parseOrg } = await P("org.ts")
const { openGraph } = await P("graph.ts")

type Api = (method: string, route: string, body?: unknown) => Promise<[number, any]> // eslint-disable-line @typescript-eslint/no-explicit-any
export type Server = { vault: string; api: Api }
const UUID = /\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)/gi

function files(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith(".")) return []
    const rel = base ? `${base}/${d.name}` : d.name
    return d.isDirectory() ? files(path.join(dir, d.name), rel) : [rel]
  })
}
const sha = (f: string) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex")
const ms = (t: number) => Math.round(performance.now() - t)

/** The source graph as Logseq sees it: its pages by title (aliases too), journals by date, block ids, counts. */
async function source(src: string) {
  const g = openGraph(src)
  const read = async (rel: string) => (await g.files.find((f: { rel: string }) => f.rel === rel)!.read()).toString("utf8")
  const cfgFile = g.files.find((f: { rel: string }) => /^logseq\/config\.edn$/i.test(f.rel))
  const fileGraph = !!cfgFile || g.files.some((f: { rel: string }) => /^(pages|journals)\//i.test(f.rel))
  const cfg = cfgFile ? graphConfig(await read(cfgFile.rel)) : fileGraph ? DEFAULT_CONFIG : graphConfig(null)
  const hidden = (rel: string) => cfg.hidden.some((h: string) => rel === h || rel.startsWith(`${h}/`))
  const out = { pages: new Map<string, { rel: string; org: boolean; text: string }>(), journals: new Map<string, { rel: string; org: boolean; text: string }>(),
    names: new Set<string>(), ids: new Set<string>(), assets: 0, drawings: 0, whiteboards: 0, blocks: 0, orgPages: 0, bytes: 0, cfg }
  for (const f of g.files) {
    out.bytes += f.size
    if (hidden(f.rel) || /^logseq\//i.test(f.rel)) continue
    if (/^assets\//i.test(f.rel)) { out.assets++; continue }
    if (/^draws\/[^/]+\.excalidraw$/i.test(f.rel)) { out.drawings++; continue }
    if (/^whiteboards\/.+\.edn$/i.test(f.rel)) { out.whiteboards++; continue }
    const m = /^(?:(.*)\/)?([^/]+)\.(md|markdown|org)$/i.exec(f.rel)
    if (!m) continue
    const org = m[3].toLowerCase() === "org", text = await read(f.rel)
    if (org) out.orgPages++
    const page = org ? parseOrg(text) : parsePage(text)
    let date = (m[1] ?? "").toLowerCase() === cfg.journalsDir.toLowerCase() ? readDate(m[2], cfg.journalFileFormat) ?? readDate(m[2], "yyyy_MM_dd") ?? readDate(m[2], "yyyy-MM-dd") : null
    if (!fileGraph && !date) date = readDate(m[2], cfg.journalTitleFormat)
    if (page) for (const b of allBlocks(page.blocks)) {
      out.blocks++
      const id = blockParts(b.lines).props.find((p: { key: string }) => p.key.toLowerCase() === "id")?.value.trim().toLowerCase()
      if (id) out.ids.add(id)
    }
    if (date) { out.journals.set(date, { rel: f.rel, org, text }); out.names.add(date); continue }
    const own = page?.props.find((p: { key: string }) => p.key.toLowerCase() === "title")?.value.trim()
    const title = own || titleOfFile(fileGraph ? m[2] : (m[1] ? `${m[1]}/${m[2]}` : m[2]), cfg.fileNameFormat)
    out.pages.set(nameKey(title), { rel: f.rel, org, text })
    out.names.add(nameKey(title))
    for (const a of page?.props.filter((p: { key: string }) => p.key.toLowerCase() === "alias") ?? []) for (const x of a.value.split(",")) out.names.add(nameKey(x.replace(/^\s*\[\[|\]\]\s*$/g, "")))
  }
  return out
}

/** `merged`: journals whose day had a daily note already (the export has its own lines too). */
export async function verify(s: Server, name: string, src: string, { folder = "Logseq", sample = Infinity, merged = [] as string[] } = {}) {
  const fails: string[] = []
  const fail = (what: string) => { if (fails.length < 40) fails.push(what) }
  const t0 = performance.now()
  const g = await source(src)
  const t1 = performance.now()
  const [st, job] = await s.api("POST", "ops/logseq.import", { path: src, wait: true, folder })
  const importMs = ms(t1)
  if (st !== 200 || job.state !== "done") return { name, error: `import: ${st} ${JSON.stringify(job).slice(0, 300)}`, fails: ["import failed"] }
  if (job.pages !== g.pages.size) fail(`pages: imported ${job.pages}, the graph has ${g.pages.size}`)
  if (job.journals !== g.journals.size) fail(`journals: imported ${job.journals}, the graph has ${g.journals.size}`)

  // the vault: every imported note's frontmatter, links and block refs
  const all = files(s.vault)
  const metas = all.map((rel) => {
    if (!/\.md$/i.test(rel)) return { path: rel }
    try { const [fm] = parseText(fs.readFileSync(path.join(s.vault, rel), "utf8")); const a = fm.aliases; return { path: rel, aliases: (Array.isArray(a) ? a : a ? [a] : []).map(String), fm } } catch { return { path: rel, bad: true } }
  })
  const resolve = linkResolver(metas.map((m) => ({ path: m.path, aliases: m.aliases })))
  const ours = metas.filter((m) => m.fm && typeof m.fm.ext_id === "string" && m.fm.ext_id.startsWith("logseq-"))
  const bad = metas.filter((m) => m.bad && m.path.startsWith(folder ? `${folder}/` : ""))
  for (const b of bad) fail(`frontmatter doesn't parse: ${b.path}`)
  const links = { total: 0, resolved: 0, danglingInSource: 0, blockRefs: 0, assets: 0, refsLeft: 0 }
  for (const m of ours) {
    const text = fs.readFileSync(path.join(s.vault, m.path), "utf8")
    for (const [line, code] of fenced(text)) {
      if (code) continue
      const bare = line.replace(/(`+)(?:(?!\1).)+?\1/g, "")
      for (const r of bare.matchAll(UUID)) { links.refsLeft++; if (g.ids.has(r[1].toLowerCase())) fail(`${m.path}: ((${r[1]})) is a block in the graph, left unconverted`) }
      for (const l of bare.matchAll(/(!?)\[\[([^\]|#]+?)(#\^?[^\]|]*)?(\|[^\]]*)?\]\]/g)) {
        links.total++
        const target = l[2].trim(), hit = resolve(target, m.path)
        if (hit) {
          links.resolved++
          if (!/\.md$/i.test(hit)) links.assets++
          if (l[3]?.startsWith("#^")) {
            links.blockRefs++
            const id = l[3].slice(2)
            if (!new RegExp(`(^|\\s)\\^${id}\\s*$`, "m").test(fs.readFileSync(path.join(s.vault, hit), "utf8"))) fail(`${m.path}: [[${target}${l[3]}]] finds ${hit}, which has no ^${id}`)
          }
          continue
        }
        if (target.includes("/") && !g.names.has(nameKey(target))) { if (/\.\w{2,5}$/.test(target)) fail(`${m.path}: ${l[0]} (a file) isn't there`); else links.danglingInSource++; continue }
        if (g.names.has(nameKey(target)) || g.names.has(target)) fail(`${m.path}: ${l[0]} finds nothing, but the graph has that page`)
        else links.danglingInSource++
      }
    }
  }
  const cardNotes = ours.filter((m) => m.fm.type === "cards").length
  if (ours.length !== g.pages.size + g.journals.size - job.orgKept + cardNotes) fail(`notes with an ext_id: ${ours.length}; pages and journals: ${g.pages.size + g.journals.size}, ${job.orgKept} kept as .org, ${cardNotes} of cards`)

  // every note renders
  const t2 = performance.now()
  let rendered = 0
  for (const m of ours.slice(0, sample)) {
    const [rs, r] = await s.api("GET", `render?path=${encodeURIComponent(m.path)}`)
    if (rs !== 200 || /couldn't be read/.test(typeof r === "string" ? r : JSON.stringify(r))) fail(`render ${m.path}: ${rs} ${String(typeof r === "string" ? r : JSON.stringify(r)).slice(0, 160)}`)
    else rendered++
  }
  const renderMs = ms(t2)

  // importing again changes nothing
  const before = new Map(files(s.vault).map((f) => [f, sha(path.join(s.vault, f))]))
  const t3 = performance.now()
  const [st2, again] = await s.api("POST", "ops/logseq.import", { path: src, wait: true, folder })
  const reimportMs = ms(t3)
  const after = files(s.vault)
  const changed = after.filter((f) => before.get(f) !== sha(path.join(s.vault, f)))
  if (st2 !== 200 || again.created || again.files) fail(`imported again: ${again.created} new notes, ${again.files} files`)
  for (const f of changed.slice(0, 5)) fail(`imported again, ${f} changed`)

  // exported back: each page and journal equivalent to the graph's
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-export-"))
  const t4 = performance.now()
  const [st3, ex] = await s.api("POST", "ops/logseq.export", { folder, out })
  const exportMs = ms(t4)
  const trip = { compared: 0, same: 0, missing: 0, differ: [] as string[] }
  useMacros(g.cfg.macros)
  if (st3 !== 200) fail(`export: ${st3} ${JSON.stringify(ex).slice(0, 200)}`)
  else {
    const cfg = graphConfig(fs.readFileSync(path.join(out, "logseq/config.edn"), "utf8"))
    const pages = new Map<string, string>(), journals = new Map<string, string>()
    for (const f of files(path.join(out, "pages"))) pages.set(nameKey(titleOfFile(f.replace(/\.(md|org)$/, ""), "triple-lowbar")), path.join(out, "pages", f))
    for (const f of files(path.join(out, "journals"))) { const d = readDate(f.replace(/\.md$/, ""), cfg.journalFileFormat); if (d) journals.set(d, path.join(out, "journals", f)) }
    const compare = (what: string, src: { org: boolean; text: string }, file: string | undefined) => {
      trip.compared++
      if (!file) { trip.missing++; if (trip.differ.length < 12) trip.differ.push(`${what}: not exported`); return }
      const back = fs.readFileSync(file, "utf8")
      const d = src.org && file.endsWith(".org") ? (src.text === back ? null : "the .org file changed") : differ(pageKey(src.text, src.org), pageKey(back))
      if (d) { if (trip.differ.length < 12) trip.differ.push(`${what}: ${d}`) } else trip.same++
    }
    for (const [key, p] of g.pages) compare(p.rel, p, pages.get(key))
    for (const [date, p] of g.journals) if (!merged.includes(date)) compare(p.rel, p, journals.get(date))
  }
  fs.rmSync(out, { recursive: true, force: true })
  return {
    name, ms: { read: ms(t0) - importMs - renderMs - reimportMs - exportMs, import: importMs, render: renderMs, reimport: reimportMs, export: exportMs },
    source: { mb: +(g.bytes / 1e6).toFixed(1), pages: g.pages.size, journals: g.journals.size, blocks: g.blocks, assets: g.assets, drawings: g.drawings, whiteboards: g.whiteboards, orgPages: g.orgPages, blockIds: g.ids.size },
    job: { created: job.created, unchanged: job.unchanged, files: job.files, blocks: job.blocks, cards: job.cards, queries: job.queries, queriesKept: job.queriesKept, macrosKept: job.macrosKept, brokenRefs: job.brokenRefs, orgKept: job.orgKept, whiteboards: job.whiteboards.length, problems: job.problems },
    notes: ours.length, rendered, links, reimport: { created: again.created, files: again.files, changed: changed.length },
    export: st3 === 200 ? { pages: ex.pages, journals: ex.journals, assets: ex.assets, blocks: ex.blocks } : null, trip, fails,
  }
}
