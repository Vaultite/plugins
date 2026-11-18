// A Logseq graph into the vault: pages as notes in the import folder (namespaces as folders), journals as daily notes,
// assets as attachments. Each note has an ext_id, so importing again adds only what's new.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { setImmediate as turn } from "node:timers/promises"
import { frontmatter, parseText, setPropertyText, type Vault, writeAtomic } from "@vaultite/core/vault.ts"
import { readDate, writeDate } from "./dates.ts"
import { DEFAULT_CONFIG, type GraphConfig, graphConfig } from "./edn.ts"
import { type Graph, type GraphFile, openGraph } from "./graph.ts"
import type { Ctx, Stats } from "./inline.ts"
import { type Card, MARKERS, type Options, pageNote } from "./convert.ts"
import { line } from "./inline.ts"
import { labelOf } from "./labels.ts"
import type { Job } from "./job.ts"
import { nameKey, safePart, titleOfFile } from "./names.ts"
import { parseOrg } from "./org.ts"
import { allBlocks, blockParts, type Page, parsePage } from "./outline.ts"

export type Where = {
  /** Where pages go ("" the vault's top). */
  folder: string
  /** The vault's attachments folder. */
  attachments: string
  /** A day's daily note: its path, and whether one is there. */
  day: (iso: string) => Promise<{ path: string; exists: boolean }>
  /** Daily notes need `type: day` (no daily notes folder is set). */
  typed: boolean
  tasks: Options["tasks"]
}

type Source = { file: GraphFile; title: string; kind: "page" | "journal"; date: string | null; page: Page | null; org: boolean }
type Planned = Source & { rel: string; ext: string; skip: boolean; merge: boolean }

const BATCH = 250
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const join = (...p: string[]) => p.filter(Boolean).join("/")
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16)
const say = (job: Job, p: string) => { if (job.problems.length < 30) job.problems.push(p) }
const text = async (f: GraphFile) => (await f.read()).toString("utf8")

export function knownIds(vault: Vault) {
  const out = new Map<string, string>()
  for (const e of vault.entries.values()) if (typeof e.fm.ext_id === "string" && e.fm.ext_id.startsWith("logseq-")) out.set(e.fm.ext_id, e.rel)
  return out
}

/** Free paths, by lower case (on a Mac "Ideas.md" and "ideas.md" are one file), with folders' case kept as first met. */
function planner(vault: Vault) {
  const taken = new Set<string>(), folders = new Map<string, string>()
  const there = (rel: string) => taken.has(rel.toLowerCase()) || vault.entries.has(rel) || fs.existsSync(vault.abs(rel))
  const canon = (dir: string) => dir.split("/").filter(Boolean).reduce((acc, part) => {
    const p = join(acc, part), k = p.toLowerCase()
    if (!folders.has(k)) folders.set(k, p)
    return folders.get(k)!
  }, "")
  return (want: string, same?: (abs: string) => boolean) => {
    const i = want.lastIndexOf("/"), dir = canon(want.slice(0, i + 1)), name = want.slice(i + 1)
    const d = name.lastIndexOf("."), ext = d > 0 ? name.slice(d) : "", stem = d > 0 ? name.slice(0, d) : name
    const inside = path.resolve(vault.abs(dir || "."))
    if (inside !== path.resolve(vault.path) && !inside.startsWith(path.resolve(vault.path) + path.sep)) throw new Error(`${want} is outside the vault`)
    for (let n = 0; ; n++) {
      const p = join(dir, `${n ? `${stem} ${n}` : stem}${ext}`)
      if (!there(p)) { taken.add(p.toLowerCase()); return { rel: p, exists: false } }
      if (same && !taken.has(p.toLowerCase()) && fs.existsSync(vault.abs(p)) && same(vault.abs(p))) { taken.add(p.toLowerCase()); return { rel: p, exists: true } }
    }
  }
}

/** The graph's files, sorted out: pages and journals read, whiteboards and what Logseq hides left out. */
async function sources(graph: Graph, cfg: GraphConfig, job: Job, fileGraph: boolean) {
  const out: Source[] = [], assets: GraphFile[] = [], drawings: GraphFile[] = []
  const hidden = (rel: string) => cfg.hidden.some((h) => rel === h || rel.startsWith(`${h}/`))
  for (const f of graph.files) {
    const rel = f.rel
    if (hidden(rel) || /^logseq\//i.test(rel)) continue
    if (/^assets\//i.test(rel)) { assets.push(f); continue }
    if (/^draws\/[^/]+\.excalidraw$/i.test(rel)) { drawings.push(f); continue }
    if (/^whiteboards\/.+\.edn$/i.test(rel)) { job.whiteboards.push(rel.slice(12)); continue }
    const m = /^(?:(.*)\/)?([^/]+)\.(md|markdown|org)$/i.exec(rel)
    if (!m) { if (!/\.(edn|css|js)$/i.test(rel)) job.skipped.push(rel); continue }
    const dir = m[1] ?? "", stem = m[2], org = m[3].toLowerCase() === "org"
    const journalDir = dir.toLowerCase() === cfg.journalsDir.toLowerCase()
    let date = journalDir ? readDate(stem, cfg.journalFileFormat) ?? readDate(stem, "yyyy_MM_dd") ?? readDate(stem, "yyyy-MM-dd") : null
    if (!fileGraph && !date) date = readDate(stem, cfg.journalTitleFormat)
    const body = await text(f)
    const page = org ? parseOrg(body) : parsePage(body)
    if (org && !page) job.orgKept++
    const own = page?.props.find((p) => p.key.toLowerCase() === "title")?.value.trim()
    const title = date ? writeDate(date, cfg.journalTitleFormat) : own || titleOfFile(fileGraph ? stem : join(dir, stem), cfg.fileNameFormat)
    out.push({ file: f, title, kind: date ? "journal" : "page", date, page, org })
  }
  return { pages: out, assets, drawings }
}

export async function runImport(vault: Vault, source: string, where: Where, job: Job) {
  job.state = "running"
  const graph = openGraph(source)
  const configFile = graph.files.find((f) => /^logseq\/config\.edn$/i.test(f.rel))
  const fileGraph = !!configFile || graph.files.some((f) => /^(pages|journals)\//i.test(f.rel))
  const cfg = configFile ? graphConfig(await text(configFile)) : fileGraph ? DEFAULT_CONFIG : graphConfig(null)
  job.graph = graph.name
  job.folder = where.folder
  const { pages, assets, drawings } = await sources(graph, cfg, job, fileGraph)
  if (!pages.length) throw new Error("no pages or journals in it: is it a Logseq graph (a folder with pages/ and journals/)?")
  job.total = pages.length
  const known = knownIds(vault)
  const free = planner(vault)

  // where each page goes, journals where the daily notes are
  const plan: Planned[] = []
  const byName = new Map<string, Planned>(), byFile = new Map<string, Planned>()
  for (const s of pages) {
    const ext = `logseq-${hash(`${where.folder}\n${s.kind}\n${s.date ?? nameKey(s.title)}`)}`
    const had = known.get(ext)
    let rel: string, skip = false, merge = false
    if (had) { rel = had; skip = true }
    else if (s.kind === "journal") {
      const d = await where.day(s.date!)
      rel = d.path
      if (d.exists) merge = true
      else free(rel)
    } else {
      const want = join(where.folder, ...s.title.split("/").map(safePart)) + (s.page ? ".md" : ".org")
      const p = free(want, s.page ? undefined : (abs) => fs.statSync(abs).size === s.file.size)
      rel = p.rel
      skip = p.exists
    }
    const p: Planned = { ...s, rel, ext, skip, merge }
    plan.push(p)
    byFile.set(s.file.rel.toLowerCase(), p)
    const key = nameKey(s.title)
    if (!byName.has(key)) byName.set(key, p)
    if (s.date) byName.set(s.date, p)
  }
  for (const p of plan) {
    for (const a of p.page?.props.filter((x) => x.key.toLowerCase() === "alias") ?? []) {
      for (const name of a.value.split(",").map((x) => x.trim().replace(/^\[\[|\]\]$/g, "")).filter(Boolean)) if (!byName.has(nameKey(name))) byName.set(nameKey(name), p)
    }
  }

  // block ids, for ((refs)) and embeds
  const blocks = new Map<string, { p: Planned; title: string; label?: string }>()
  for (const p of plan) {
    if (!p.page) continue
    for (const b of allBlocks(p.page.blocks)) {
      const parts = blockParts(b.lines)
      const id = parts.props.find((x) => x.key.toLowerCase() === "id")?.value.trim()
      if (id && UUID.test(id)) blocks.set(id.toLowerCase(), { p, title: parts.title.replace(MARKERS, "").replace(/^\[#[ABC]\]\s*/, "") })
    }
  }

  // assets and drawings
  const copied = new Map<string, string>()
  const writes: { rel: string; data: () => Promise<Buffer | string>; note: boolean }[] = []
  for (const a of assets) {
    // (a [ ] # ^ or | in a file's name would end the [[link]] to it)
    const name = a.rel.slice(7).split("/").map((s) => s.replace(/[[\]#^|]/g, (c) => (c === "[" ? "(" : c === "]" ? ")" : "-"))).join("/")
    const p = free(join(where.attachments, name), (abs) => fs.statSync(abs).size === a.size)
    copied.set(a.rel.toLowerCase(), p.rel)
    if (p.exists) job.unchanged++
    else writes.push({ rel: p.rel, data: a.read, note: false })
  }
  const drawn = new Map<string, string>()
  for (const d of drawings) {
    const p = free(join(where.folder, d.rel), (abs) => fs.statSync(abs).size === d.size)
    drawn.set(d.rel.slice(6).toLowerCase(), p.rel)
    if (!p.exists) writes.push({ rel: p.rel, data: d.read, note: false })
  }

  // a note's link: its name when that's the only note with it, else its path
  const stems = new Map<string, number>(), paths = new Set([...vault.entries.keys()].map((k) => k.toLowerCase()))
  for (const e of vault.entries.keys()) { const s = e.replace(/^.*\//, "").replace(/\.md$/i, "").toLowerCase(); stems.set(s, (stems.get(s) ?? 0) + 1) }
  for (const p of plan) if (!p.skip && !p.merge) { const s = p.rel.replace(/^.*\//, "").replace(/\.(md|org)$/i, "").toLowerCase(); stems.set(s, (stems.get(s) ?? 0) + 1) }
  const linkOf = (rel: string, title?: string) => {
    if (rel.endsWith(".org")) return rel
    const noExt = rel.replace(/\.md$/i, ""), stem = noExt.replace(/^.*\//, "")
    // a namespaced title finds its note by its path's end ([[a/b/c]] -> Logseq/a/b/c.md), as a name does
    if (title?.includes("/") && `/${noExt.toLowerCase()}`.endsWith(`/${title.toLowerCase()}`) && (noExt.toLowerCase() === title.toLowerCase() || !paths.has(`${title.toLowerCase()}.md`))) return title
    return (stems.get(stem.toLowerCase()) ?? 0) > 1 ? noExt : stem
  }

  const stats: Stats = { queries: 0, queriesKept: 0, macrosKept: new Map(), brokenRefs: 0 }
  const ctxFor = (p: Planned): Ctx => {
    const dir = (p.file.rel.includes("/") ? p.file.rel.slice(0, p.file.rel.lastIndexOf("/")) : "")
    return {
      cfg, stats, title: p.title,
      page: (title) => {
        const hit = byName.get(nameKey(title))
        if (!hit) return null
        // an alias finds its note in Vaultite too, when no note has it as its name
        const named = stems.get(title.toLowerCase()) ?? 0
        if (nameKey(title) !== nameKey(hit.title) && !title.includes("/") && (!named || (named === 1 && hit.rel.replace(/^.*\//, "").replace(/\.md$/i, "").toLowerCase() === title.toLowerCase()))) return title
        return linkOf(hit.rel, hit.title)
      },
      day: (iso) => { const hit = byName.get(iso); return hit ? linkOf(hit.rel) : iso },
      block: (uuid) => {
        const b = blocks.get(uuid)
        if (!b) return null
        // its label: its title as converted, without markup (a ref in it to a block being labelled: its uuid)
        if (b.label === undefined) {
          b.label = uuid
          const quiet: Stats = { queries: 0, queriesKept: 0, macrosKept: new Map(), brokenRefs: 0 }
          b.label = labelOf(b.title.trim() === "[:span]" ? "" : line({ ...ctxFor(b.p), stats: quiet }, b.title))
        }
        return { note: linkOf(b.p.rel), label: b.label }
      },
      asset: (href) => {
        let h = href.trim().replace(/^<|>$/g, "").replace(/^file:\/\//, "")
        try { h = decodeURIComponent(h) } catch { /* (as written) */ }
        const rel = path.posix.normalize(path.posix.join(dir, h))
        return copied.get(rel.toLowerCase()) ?? copied.get(path.posix.normalize(h).toLowerCase()) ?? null
      },
      drawing: (name) => drawn.get(name.toLowerCase()) ?? null,
      file: (href) => {
        let h = href.trim()
        try { h = decodeURIComponent(h) } catch { /* (as written) */ }
        const hit = byFile.get(path.posix.normalize(path.posix.join(dir, h)).toLowerCase())
        return hit ? hit.title : null
      },
    }
  }

  const flush = async () => {
    while (writes.length) {
      const batch = writes.splice(0, BATCH)
      const data = await Promise.all(batch.map((w) => w.data().catch((e) => { say(job, `${w.rel}: ${e instanceof Error ? e.message : String(e)}`); return null })))
      await vault.lock(async () => {
        batch.forEach((w, i) => {
          const d = data[i]
          if (d === null) return
          fs.mkdirSync(path.dirname(vault.abs(w.rel)), { recursive: true })
          writeAtomic(vault.abs(w.rel), d)
          if (w.note) job.created++
          else job.files++
        })
        await vault.sync()
      })
      await turn()
    }
  }

  const cards: { p: Planned; cards: Card[] }[] = []
  for (const p of plan) {
    job.notes++
    if (p.kind === "journal") job.journals++
    else job.pages++
    if (p.skip) { job.unchanged++; continue }
    if (!p.page) { writes.push({ rel: p.rel, data: p.file.read, note: true }); continue }
    job.blocks += [...allBlocks(p.page.blocks)].length
    const out = pageNote(ctxFor(p), { tasks: where.tasks }, p.page)
    if (out.cards.length) cards.push({ p, cards: out.cards })
    const fm: Record<string, unknown> = {}
    if (p.kind === "journal" && where.typed) fm.type = "day"
    const shown = p.rel.replace(/^.*\//, "").replace(/\.md$/, "")
    const aliases = Array.isArray(out.fm.aliases) ? out.fm.aliases.map(String) : []
    if (p.kind === "page" && shown !== p.title && !aliases.includes(p.title)) aliases.unshift(p.title)
    if (aliases.length) fm.aliases = aliases
    for (const [k, v] of Object.entries(out.fm)) if (k !== "aliases") fm[k] = v
    fm.ext_id = p.ext
    if (p.merge) {
      writes.push({ rel: p.rel, note: true, data: async () => mergeDay(vault, p, fm, out.body, job) })
      continue
    }
    writes.push({ rel: p.rel, note: true, data: async () => frontmatter(fm, out.body) })
    if (writes.length >= BATCH) await flush()
  }
  for (const { p, cards: cs } of cards) {
    const ext = `logseq-${hash(`${where.folder}\ncards\n${nameKey(p.title)}`)}`
    if (known.has(ext)) continue
    const rel = free(join(where.folder, "Cards", `${safePart(p.title.replace(/\//g, " - "))}.md`)).rel
    const body = cs.map((c) => [`## ${c.front}`, c.back.join("\n")].filter(Boolean).join("\n")).join("\n\n")
    writes.push({ rel, note: true, data: async () => frontmatter({ type: "cards", source: `[[${linkOf(p.rel)}]]`, ext_id: ext }, body) })
    job.cards += cs.length
  }
  for (const f of graph.files.filter((x) => /^logseq\/(config\.edn|custom\.css)$/i.test(x.rel))) {
    const rel = join(where.folder, ".logseq", f.rel.slice(7))
    if (!fs.existsSync(vault.abs(rel))) writes.push({ rel, data: f.read, note: false })
  }
  await flush()
  job.queries = stats.queries
  job.queriesKept = stats.queriesKept
  job.macrosKept = Object.fromEntries(stats.macrosKept)
  job.brokenRefs = stats.brokenRefs
  job.state = "done"
}

/** A journal for a day that already has a daily note: its blocks after what the note has. */
async function mergeDay(vault: Vault, p: Planned, fm: Record<string, unknown>, body: string, job: Job) {
  const was = fs.readFileSync(vault.abs(p.rel), "utf8")
  let have: Record<string, unknown> = {}
  try { have = parseText(was)[0] } catch { /* (its body is kept as it is) */ }
  if (typeof have.ext_id === "string" && have.ext_id !== p.ext) { say(job, `${p.rel} came from elsewhere (ext_id ${have.ext_id}): left as it is`); return was }
  let next = setPropertyText(was, "ext_id", p.ext) ?? was
  for (const [k, v] of Object.entries(fm)) if (k !== "ext_id" && k !== "type" && have[k] === undefined) next = setPropertyText(next, k, v) ?? next
  return `${next.replace(/\s+$/, "")}\n\n${body}\n`
}
