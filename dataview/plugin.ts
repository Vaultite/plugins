// Dataview's server side: the vault's notes as Dataview pages (from the index the server keeps, each note parsed once
// per version), queries run here for the app (/api/dataview/...) and as text for agents (fences, inline `= ...`).
import fs from "node:fs"
import { HTTPError, type LinkFile, linkResolver, OpError, Plugin } from "@vaultite/core/plugins.ts"
import { type Entry, FM, writeAtomic } from "@vaultite/core/vault.ts"
import { DqlError, parseExpr, parseQuery, type Query } from "./dql.ts"
import { type Context, evaluateInline, execute, type Result, type Row } from "./engine.ts"
import { linkUp, page } from "./pages.ts"
import { inlineText, markdown } from "./text.ts"
import { DvDate, dateIso, toWire, type Wire } from "./values.ts"

export const plugin = new Plugin(import.meta.url)

// ---------- the index

type Index = { version: string; pages: Row[]; byPath: Map<string, Row>; resolve: (t: string) => string | null }
let kept: Index | null = null
// Each note's page, kept while its text is the same and what its links resolved to still is: a new or renamed file
// parses again only the notes whose links it changes.
const parsed = new WeakMap<Entry, { fm: unknown; body: string; names: string; row: Row; asked: [string, string | null][] }>()

/** What links resolve to as of now: the files' names (and aliases) and a resolver over them, kept while they're the same. */
let linking: { version: string; names: string; resolver: (t: string) => string | null; resolve: (t: string) => string | null } | null = null
function links() {
  const vault = plugin.vault, version = String(vault.version)
  if (linking?.version === version) return linking
  const files: LinkFile[] = []
  for (const [rel, e] of vault.entries) {
    const aliases = e.fm.aliases ?? e.fm.alias
    files.push({ path: rel, aliases: (Array.isArray(aliases) ? aliases : aliases ? [aliases] : []).map(String), archived: e.archived })
  }
  for (const rel of vault.others.keys()) files.push({ path: rel })
  const names = JSON.stringify(files.map((f) => [f.path, f.aliases]))
  const resolver = linking?.names === names ? linking.resolver : linkResolver(files), now = new Map<string, string | null>()
  const resolve = (t: string) => { let r = now.get(t); if (r === undefined) now.set(t, r = resolver(t)); return r }
  return linking = { version, names, resolver, resolve }
}

/** A note's page, parsed again only when it changed or what its links resolved to did. */
function pageOf(rel: string, e: Entry): Row {
  const { names, resolve } = links()
  let c = parsed.get(e)
  if (c && c.fm === e.fm && c.body === e.body && c.names !== names && c.asked.every(([t, r]) => resolve(t) === r)) c.names = names
  if (!c || c.fm !== e.fm || c.body !== e.body || c.names !== names) {
    const asked: [string, string | null][] = []
    const row = page({ path: rel, fm: e.fm, body: e.body, ctime: e.stat.born, mtime: Number(e.stat.ns / 1000000n), size: e.stat.size },
      (t) => { const r = resolve(t); asked.push([t, r]); return r })
    parsed.set(e, c = { fm: e.fm, body: e.body, names, row, asked })
  }
  return c.row
}

const noted = (rel: string) => rel[0] !== "." && !rel.includes("/.")

/** The notes as pages, rebuilt when the vault changes: only changed notes are parsed again, and their inlinks worked
 *  out again only when a page changed. */
function pages(): Index {
  const vault = plugin.vault
  const version = String(vault.version)
  if (kept?.version === version) return kept
  const out: Row[] = []
  for (const [rel, e] of vault.entries) if (noted(rel)) out.push(pageOf(rel, e))
  if (kept && out.length === kept.pages.length && out.every((r, i) => r === kept!.pages[i])) return kept = { ...kept, version, resolve: links().resolve }
  linkUp(out)
  kept = { version, pages: out, byPath: new Map(out.map((p) => [String((p.file as Row).path), p])), resolve: links().resolve }
  return kept
}

/** Some notes alone as pages (dataview:within), by `scope`: their links resolved among themselves only, so nothing
 *  outside them is seen, not even by name. */
const scoped = new Map<string, Index>()
function pagesWithin(scope: string, only: (rel: string) => boolean): Index {
  const vault = plugin.vault, version = String(vault.version), had = scoped.get(scope)
  if (had?.version === version) return had
  const files: LinkFile[] = []
  for (const [rel, e] of vault.entries) {
    if (!only(rel)) continue
    const aliases = e.fm.aliases ?? e.fm.alias
    files.push({ path: rel, aliases: (Array.isArray(aliases) ? aliases : aliases ? [aliases] : []).map(String), archived: e.archived })
  }
  for (const rel of vault.others.keys()) if (only(rel)) files.push({ path: rel })
  const resolve = linkResolver(files), out: Row[] = []
  for (const [rel, e] of vault.entries) {
    if (noted(rel) && only(rel)) out.push(page({ path: rel, fm: e.fm, body: e.body, ctime: e.stat.born, mtime: Number(e.stat.ns / 1000000n), size: e.stat.size }, resolve))
  }
  linkUp(out)
  const ix = { version, pages: out, byPath: new Map(out.map((p) => [String((p.file as Row).path), p])), resolve }
  scoped.delete(scope)
  scoped.set(scope, ix)
  if (scoped.size > 20) scoped.delete(scoped.keys().next().value!)
  return ix
}

// A vault's notes parsed a few at a time once the server is up, so the first query doesn't wait seconds for them all.
let unloaded = false
plugin.onUnload(() => { unloaded = true })
setTimeout(async () => {
  let n = 0
  try {
    for (const [rel, e] of [...plugin.vault.entries]) {
      if (unloaded || plugin.isOff()) return
      if (!noted(rel) || plugin.vault.entries.get(rel) !== e) continue
      pageOf(rel, e)
      if (++n % 50 === 0) await new Promise((r) => setImmediate(r))
    }
    if (!unloaded) pages()
  } catch (e) { console.error("dataview: reading the notes ahead:", e) }
}, 5000).unref()

function context(path: string | undefined, now = new Date(), ix = pages(), bounded?: { until: number }): Context {
  // Sample folders (the app's files.json `samples`): examples, listed only for a query in that folder.
  const samples = ((plugin.vault as { samples?: () => string[] }).samples?.() ?? []).map((d) => `${d}/`).filter((d) => !path?.startsWith(d))
  const listed = samples.length ? ix.pages.filter((p) => !samples.some((d) => String((p.file as Row).path).startsWith(d))) : ix.pages
  return { pages: listed, page: (p) => ix.byPath.get(p) ?? null, resolve: ix.resolve, self: path ? ix.byPath.get(path) ?? null : null, now, ...(bounded ? { bounded } : {}) }
}

// ---------- results for the app (JSON)

type WireTask = { text: string; status: string | null; path: string; line: number; raw: string; children: WireTask[] }
const wireTask = (t: Row): WireTask => {
  const own = (t as { $task?: Row }).$task ?? t
  return {
    text: String(t.text ?? ""), status: t.task ? String(t.status ?? " ") : null, path: String(t.path ?? ""), line: Number(t.line ?? 0),
    raw: String((own as { $raw?: string }).$raw ?? ""), children: ((t.children as Row[]) ?? []).map(wireTask),
  }
}

export type Answer =
  | { type: "table"; headers: string[]; id: boolean; rows: { cells: Wire[]; path?: string }[] }
  | { type: "list"; id: boolean; items: { id?: Wire; value?: Wire; has: boolean }[] }
  | { type: "task"; grouped: boolean; groups: { key: Wire; tasks: WireTask[] }[] }
  | { type: "calendar"; items: { date: string; link: Wire }[] }

function wire(r: Result): Answer {
  if (r.type === "table") return { type: "table", headers: r.headers, id: r.id, rows: r.rows.map((x) => ({ cells: x.cells.map((c) => toWire(c)), ...(x.path ? { path: x.path } : {}) })) }
  if (r.type === "list") return { type: "list", id: r.id, items: r.items.map((i) => ({ ...(i.id !== undefined ? { id: toWire(i.id) } : {}), ...(i.value !== undefined ? { value: toWire(i.value) } : {}), has: i.value !== undefined })) }
  if (r.type === "task") return { type: "task", grouped: r.grouped, groups: r.groups.map((g) => ({ key: toWire(g.key ?? null), tasks: g.tasks.map(wireTask) })) }
  return { type: "calendar", items: r.items.map((i) => ({ date: dateIso(new DvDate(i.date.t, false)), link: toWire(i.link) })) }
}

/** A card's title: what the query lists from, when it's one thing (#book, Books, links to Lighthouse). */
function titleOf(q: Query): string | undefined {
  const s = q.from
  if (s.k === "tag") return s.tag
  if (s.k === "folder") return s.path.replace(/\/+$/, "").split("/").pop() || undefined
  if (s.k === "link" && s.target) return `${s.outgoing ? "Linked from" : "Links to"} ${s.target.replace(/^.*\//, "")}`
  return undefined
}

/** A query's text run in the note at `path` (over the pages `ix`, within `bounded`): its answer, or the error to show. */
function runQuery(text: string, path?: string, ix?: Index, bounded?: { until: number }): { result: Result; title?: string } | { error: string } {
  try {
    const q = parseQuery(text)
    return { result: execute(q, context(path, new Date(), ix, bounded)), title: titleOf(q) }
  } catch (e) {
    if (e instanceof DqlError) return { error: e.message }
    throw e
  }
}

const param = (v: unknown) => (typeof v === "string" && v ? v : undefined)

plugin.route("GET", "dataview/query", (req) => {
  const q = String(req.query.q ?? "")
  const r = runQuery(q, param(req.query.path))
  return "error" in r ? r : { result: wire(r.result), ...(r.title ? { title: r.title } : {}) }
})

plugin.route("GET", "dataview/inline", (req) => {
  try {
    const v = evaluateInline(parseExpr(String(req.query.q ?? "")), context(param(req.query.path)))
    return { value: toWire(v), text: inlineText(v) }
  } catch (e) {
    if (e instanceof DqlError) return { error: e.message }
    throw e
  }
})

/** Queries over some notes alone (a shared folder's: the app's share plugin), named `scope`: their pages and links only,
 *  so nothing else of the vault is seen; bounded (engine.ts), as someone else's. As the routes answer them. */
const QUICK = 250
plugin.provide("dataview:within", (scope: string, only: (rel: string) => boolean) => ({
  query: (text: string, path?: string) => {
    if (text.length > 4000) return { error: "this query is too long here" }
    const r = runQuery(text, path, pagesWithin(scope, only), { until: Date.now() + QUICK })
    return "error" in r ? r : { result: wire(r.result), ...(r.title ? { title: r.title } : {}) }
  },
  inline: (text: string, path?: string) => {
    if (text.length > 1000) return { error: "this query is too long here" }
    try {
      const v = evaluateInline(parseExpr(text), context(path, new Date(), pagesWithin(scope, only), { until: Date.now() + QUICK }))
      return { value: toWire(v), text: inlineText(v) }
    } catch (e) {
      if (e instanceof DqlError) return { error: e.message }
      throw e
    }
  },
}))

// A task's box ticked from a TASK query: that line's box changed, the rest as it is (409 if the line changed).
plugin.route("POST", "dataview/task", (req) => {
  const b = req.body ?? {}
  const rel = String(b.path ?? ""), raw = String(b.raw ?? ""), line = Math.trunc(Number(b.line))
  if (!plugin.vault.entries.has(rel)) throw new HTTPError(404, `no note '${rel}'`)
  const abs = plugin.vault.abs(rel)
  const text = fs.readFileSync(abs, "utf8")
  const lines = text.split("\n")
  // The index's lines count from the body's first line (frontmatter and blank lines before it left out).
  const fm = FM.exec(text)
  let start = fm ? fm[0].split("\n").length - (fm[0].endsWith("\n") ? 1 : 0) : 0
  while (start < lines.length && !lines[start].trim()) start++
  const same = (i: number) => lines[i]?.replace(/\r$/, "") === raw
  let at = start + line
  if (!same(at)) {
    const hits = lines.map((_l, i) => i).filter(same)
    if (hits.length !== 1) throw new HTTPError(409, `${rel} changed there since: look again`)
    at = hits[0]
  }
  const m = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)(.)(\])/.exec(lines[at])
  if (!m) throw new HTTPError(409, `that line in ${rel} isn't a task any more`)
  const to = typeof b.status === "string" && b.status.length === 1 ? b.status : m[2] === " " ? "x" : " "
  lines[at] = m[1] + to + m[3] + lines[at].slice(m[0].length)
  writeAtomic(abs, lines.join("\n"))
  return { path: rel, line: at, status: to }
})

// ---------- text for agents

const JS_NOTE = "_(dataviewjs: this block runs JavaScript, which this app doesn't run. Its code is left as it is in the note.)_"

plugin.provide("fence:dataview", (ctx: { path: string; text: string }) => {
  const r = runQuery(ctx.text, ctx.path)
  return "error" in r ? `_(Dataview: ${r.error})_` : markdown(r.result)
})
plugin.provide("fence:dataviewjs", () => JS_NOTE)

// `= expr` in inline code, as its value; `$= ...` (dataviewjs) as a note. Asked by the app's /api/render.
plugin.provide("inline-code", (ctx: { path: string; code: string }) => {
  const code = ctx.code.trim()
  if (code.startsWith("$=")) return "_(dataviewjs)_"
  if (!code.startsWith("=")) return null
  try {
    return inlineText(evaluateInline(parseExpr(code.slice(1)), context(ctx.path)))
  } catch (e) {
    if (e instanceof DqlError) return `_(Dataview: ${e.message})_`
    throw e
  }
})

// ---------- the op agents run queries with

plugin.op({
  id: "dataview.query",
  cli: "dataview",
  summary: "Run a Dataview (DQL) query over the vault: LIST, TABLE, TASK or CALENDAR, as Dataview does.",
  help: `The query as you'd write it in a \`\`\`dataview fence (vau docs dataview). \`this\` is the note given with --path.

  vau dataview 'TABLE rating, author FROM #book SORT rating DESC'
  vau dataview 'TASK WHERE !completed AND due <= date(today)'
  vau dataview 'LIST FROM [[]]' --path "Projects/Lighthouse.md"      what links to Lighthouse`,
  kind: "read",
  params: {
    query: { type: "string", required: true, description: "the DQL query (LIST, TABLE, TASK or CALENDAR ...)" },
    path: { type: "string", format: "path", description: "the note the query is in: `this`, and [[]] in FROM" },
  },
  args: ["query"],
  run: (p) => {
    const path = param(p.path) ? plugin.vault.relocated(String(p.path)) : undefined
    if (path && !plugin.vault.entries.has(path)) throw new OpError(`no note '${p.path}'`)
    const r = runQuery(String(p.query), path)
    if ("error" in r) throw new OpError(`Dataview: ${r.error}`)
    return { ...wire(r.result), text: markdown(r.result) }
  },
  text: (r) => String(r.text ?? ""),
})
