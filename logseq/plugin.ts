import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { formatDate, HTTPError, OpError, Plugin, reply, type Request, Text, vaultPath } from "@vaultite/core/plugins.ts"
import { exportGraph } from "./exporter.ts"
import { runImport, type Where } from "./importer.ts"
import { type Job, newJob } from "./job.ts"

export const plugin = new Plugin(import.meta.url)

const MAX = 8 * 1024 ** 3
const jobs: Job[] = []
let queue: Promise<unknown> = Promise.resolve()
let n = 0

const setting = (key: string, fallback: string) => {
  const v = plugin.settings({})[key]
  return typeof v === "string" ? v.trim() : fallback
}
const folderOf = (given?: string) => {
  const f = (given ?? setting("folder", "Logseq")).trim().replace(/^\/+|\/+$/g, "")
  return f ? vaultPath(f, false, plugin.vault).replace(/\/+$/, "") : ""
}

function scratch() {
  const dir = path.join(plugin.localDir(), "uploads")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const f of fs.readdirSync(dir)) {
    try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 86400_000) fs.rmSync(path.join(dir, f), { recursive: true, force: true }) } catch { /* (gone meanwhile) */ }
  }
  return dir
}

async function where(folder: string): Promise<Where> {
  const files = plugin.vault.configWithDefaults("files")
  const at = typeof files.attachmentFolder === "string" ? files.attachmentFolder.trim() : ""
  // "./x" puts a pasted file beside its note: a graph's assets go beside its pages then
  const attachments = !at ? "Attachments" : at === "/" ? "" : at.startsWith("./") ? [folder, at.slice(2) || "assets"].filter(Boolean).join("/") : at.replace(/^\/+|\/+$/g, "")
  const tasks = plugin.peer("tasks")?.settings({}).format === "dataview" ? "dataview" : "emoji"
  const typed = plugin.vault.folderSet("days") === null
  // a day's note as Daily notes names it (its format, its folder), worked out here: asking its route for each of
  // thousands of journals takes a minute
  const daily = plugin.peer("daily-notes"), format = daily ? String(daily.seeded().format ?? "").trim() || "YYYY-MM-DD" : null
  const home = plugin.vault.home("days") ?? "Daily"
  const day = async (iso: string) => {
    const had = plugin.vault.get("days", iso)
    if (had) return { path: `${String(had.id)}.md`, exists: true }
    if (format) return { path: `${[home, formatDate(new Date(`${iso}T12:00:00`), format)].filter(Boolean).join("/")}.md`, exists: false }
    try {
      const r = await plugin.host.api("GET", `daily-notes/day?date=${iso}`)
      if (r && typeof r === "object" && "path" in r && typeof r.path === "string") return { path: r.path, exists: "exists" in r && r.exists === true }
    } catch { /* (Daily notes is off) */ }
    const rel = `${home}/${iso}.md`
    return { path: rel, exists: plugin.vault.entries.has(rel) }
  }
  return { folder, attachments, day, typed, tasks }
}

function start(source: string, name: string, folder: string, temporary: string | null) {
  const job = newJob(`${Date.now().toString(36)}-${++n}`, name)
  jobs.unshift(job)
  jobs.splice(20)
  queue = queue.then(async () => {
    try {
      await runImport(plugin.vault, source, await where(folder), job)
      plugin.emit("logseq.imported", { job: job.id, graph: job.graph ?? name, created: job.created })
    } catch (e) {
      job.state = "failed"
      job.error = e instanceof Error ? e.message : String(e)
    } finally {
      job.finished = Date.now()
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true })
    }
  })
  return job
}

/** A graph named by the caller: a folder or zip in the vault, or anywhere on this machine (an absolute path). */
function sourceOf(given: string) {
  if (path.isAbsolute(given) || given.startsWith("~")) {
    const abs = given.startsWith("~") ? path.join(process.env.HOME ?? "", given.slice(1)) : given
    if (!fs.existsSync(abs)) throw new OpError(`${given} isn't there: give the graph's folder (with pages/ and journals/) or a zip of it`)
    return abs
  }
  const rel = vaultPath(given, false, plugin.vault)
  if (!fs.existsSync(plugin.vault.abs(rel))) throw new OpError(`${given} isn't in the vault: give an absolute path for a graph elsewhere on this machine`)
  return plugin.vault.abs(rel)
}

const isJson = (req: Request) => /json/i.test(String(req.http?.headers["content-type"] ?? ""))
const on = () => { if (plugin.isOff()) throw new HTTPError(404, "the Logseq plugin is off (Plugins)") }

async function body(req: Request): Promise<Record<string, unknown>> {
  // (an op's ctx.api passes its body as it is, with the op's request, already read)
  if (!req.http || (req.body && typeof req.body === "object" && Object.keys(req.body).length)) return req.body ?? {}
  const chunks: Buffer[] = []
  for await (const c of req.http) { const piece: Buffer = c; chunks.push(piece) }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") } catch { throw new HTTPError(400, "the body isn't JSON") }
}

// a graph's folder picked in the app comes file by file, then starts as one import
plugin.route("POST", "logseq/upload/*", async (req) => {
  on()
  const token = req.arg(0)
  const rel = path.posix.normalize(String(req.query.path ?? "")).replace(/^\/+/, "")
  if (!/^[\w-]{8,64}$/.test(token) || !rel || rel.startsWith("..") || rel.includes("\0")) throw new HTTPError(400, "a token and a path in the graph")
  const file = path.join(scratch(), token, ...rel.split("/"))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (req.http) await pipeline(req.http, fs.createWriteStream(file))
  return { ok: true }
}, { stream: true })

plugin.route("POST", "logseq/import", async (req) => {
  on()
  const folder = folderOf(req.query.folder)
  if (!req.http || isJson(req)) {
    const b = await body(req)
    if (typeof b.upload === "string" && /^[\w-]{8,64}$/.test(b.upload)) {
      const dir = path.join(scratch(), b.upload)
      if (!fs.existsSync(dir)) throw new HTTPError(404, "nothing was uploaded for it")
      return reply(202, start(dir, typeof b.name === "string" ? b.name : "graph", folder, dir))
    }
    if (typeof b.path !== "string" || !b.path) throw new HTTPError(400, "send the graph's zip as the body, or {path} of its folder")
    if (path.isAbsolute(b.path) || b.path.startsWith("~")) plugin.ownerOnly(req, "importing from this machine's folders")
    return reply(202, start(sourceOf(b.path), path.basename(b.path), folder, null))
  }
  if (Number(req.http.headers["content-length"] ?? 0) > MAX) throw new HTTPError(413, "a graph over 8 GB")
  const file = path.join(scratch(), `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.zip`)
  try { await pipeline(req.http, fs.createWriteStream(file)) } catch (e) {
    fs.rmSync(file, { force: true })
    throw new HTTPError(400, `the upload broke off: ${e instanceof Error ? e.message : String(e)}`)
  }
  return reply(202, start(file, String(req.query.name ?? "graph.zip"), folder, file))
}, { stream: true })

plugin.route("GET", "logseq/jobs/*", (req) => {
  const job = jobs.find((j) => j.id === req.arg(0))
  if (!job) throw new HTTPError(404, `no import ${req.arg(0)}`)
  return job
})

plugin.route("GET", "logseq/export", async (req) => {
  on()
  const folder = folderOf(req.query.folder ?? "")
  const r = await exportGraph(plugin.vault, folder, { journals: req.query.journals !== "false", zip: true })
  const name = `${(folder.split("/").pop() || "vault").replace(/[^\w.-]+/g, "-")}-logseq.zip`
  return new Text(r.zip!, "application/zip", { "Content-Disposition": `attachment; filename="${name}"` })
})

async function jobOf(id: string, wait: boolean): Promise<Job> {
  for (;;) {
    const job = jobs.find((j) => j.id === id)
    if (!job) throw new OpError(`no import ${id} (the last 20 are kept, in memory: a restart forgets them)`, 404)
    if (!wait || (job.state !== "queued" && job.state !== "running")) return job
    await new Promise((ok) => setTimeout(ok, 300))
  }
}

export function jobText(job: Job) {
  if (job.state === "queued" || job.state === "running") return `Importing ${job.name} (job ${job.id}): ${job.state}, ${job.notes} of ${job.total || "?"} pages so far. vau logseq.job ${job.id} --wait follows it.`
  if (job.state === "failed") return `Couldn't import ${job.name}: ${job.error}`
  const kept = Object.entries(job.macrosKept).map(([k, v]) => `{{${k}}} ×${v}`)
  return [
    `Logseq graph ${job.graph}: ${job.pages} pages in ${job.folder || "the vault"}/ and ${job.journals} journals as daily notes (${job.blocks} blocks): ${job.created} new, ${job.unchanged} imported before (left as they are)${job.files ? `, ${job.files} assets and drawings copied` : ""}${job.cards ? `, ${job.cards} flashcards` : ""}.`,
    `Queries: ${job.queries} made Tasks or Dataview queries, ${job.queriesKept} kept as Logseq wrote them.`,
    ...(kept.length ? [`Macros kept as written (no Vaultite equivalent): ${kept.join(", ")}.`] : []),
    ...(job.brokenRefs ? [`${job.brokenRefs} block refs point at blocks that aren't in the graph (kept as written).`] : []),
    ...(job.orgKept ? [`${job.orgKept} Org pages kept as .org files (the Org mode plugin opens them).`] : []),
    ...(job.whiteboards.length ? [`Whiteboards not imported: ${job.whiteboards.join(", ")}.`] : []),
    ...(job.problems.length ? [`Not read: ${job.problems.join("; ")}`] : []),
  ].join("\n")
}

plugin.op({
  id: "logseq.import",
  summary: "Import a Logseq graph (its folder or a zip of it): pages as notes, journals as daily notes, assets as attachments, with links, block refs, tasks and properties kept.",
  help: `A graph is a folder with pages/, journals/, assets/ and logseq/config.edn (or a zip of it, or the Logseq DB
version's Markdown export). Pages go in the folder setting's place (Logseq/; namespaces a/b/c as folders, the title kept
as an alias), journals become daily notes where Daily notes puts them, assets go in the attachments folder. Blocks are
nested list items; page properties frontmatter; block properties Dataview fields; id:: a block id (^id) that ((refs))
link to; TODO/DOING/DONE tasks in the Tasks plugin's format with SCHEDULED and DEADLINE; simple queries Tasks or
Dataview queries where they mean the same. Importing again adds only what's new (by ext_id). wait: answer once it's done.

  vau logseq.import ~/Documents/my-graph --wait
  vau logseq.import Imports/graph.zip --folder Notes/Logseq`,
  kind: "write",
  lock: false,
  owner: "importing a Logseq graph",
  params: {
    path: { type: "string", required: true, description: "the graph: its folder or a zip, an absolute path on this machine or one in the vault" },
    folder: { type: "string", description: "the folder its pages go in (default the setting's: Logseq)" },
    wait: { type: "boolean", description: "answer once the import is done (else at once, with the job to follow)" },
  },
  args: ["path"],
  run: async (p, ctx) => {
    on()
    const started = await ctx.api("POST", `logseq/import${p.folder !== undefined ? `?folder=${encodeURIComponent(p.folder)}` : ""}`, { path: p.path })
    const id = started && typeof started === "object" && "id" in started ? String(started.id) : ""
    return p.wait ? await jobOf(id, true) : jobs.find((j) => j.id === id) ?? started
  },
  text: (job: Job) => jobText(job),
  did: ({ path: p }) => ({ action: "create", text: `Imported the Logseq graph ${p}` }),
})

plugin.op({
  id: "logseq.job",
  summary: "A Logseq import's job: how far it got, what it made; the last one without an id.",
  help: "  vau logseq.job\n  vau logseq.job mg3k2a-1 --wait",
  kind: "read",
  params: {
    id: { type: "string", description: "the job's id (default the latest import)" },
    wait: { type: "boolean", description: "answer once it's done" },
  },
  args: ["id"],
  run: async ({ id, wait }) => {
    const which = id ?? jobs[0]?.id
    if (!which) throw new OpError("no Logseq import since the server started", 404)
    return await jobOf(which, !!wait)
  },
  text: (job: Job) => jobText(job),
})

plugin.op({
  id: "logseq.export",
  summary: "Export a vault folder as a Logseq graph (a folder or a .zip): notes as pages, daily notes as journals, frontmatter as page properties, tasks as TODO/DONE.",
  help: `Each note becomes a page (a heading and what's under it a block, list items blocks with their nesting, frontmatter
the page's properties, ^ids id:: properties), daily notes journals (journals: false leaves them out), the attachments the
notes embed assets/. Tasks become TODO/DOING/DONE/CANCELED with SCHEDULED and DEADLINE; wikilinks [[page]] links and
block links ((refs)). A folder imported from Logseq goes back as it came (its logseq/config.edn too).

  vau logseq.export Logseq ~/Documents/graph-back
  vau logseq.export Projects Exports/projects-graph.zip --journals false`,
  kind: "write",
  owner: "writing a Logseq graph",
  params: {
    folder: { type: "string", required: true, description: "the vault folder to export (/ the whole vault)" },
    out: { type: "string", required: true, description: "where the graph goes: a folder or a .zip, an absolute path on this machine or one in the vault" },
    journals: { type: "boolean", description: "export the daily notes as journals (default true)" },
  },
  args: ["folder", "out"],
  run: async ({ folder, out, journals }) => {
    on()
    const from = folder === "/" ? "" : folderOf(folder)
    const abs = path.isAbsolute(out) ? out : out.startsWith("~") ? path.join(process.env.HOME ?? "", out.slice(1)) : plugin.vault.abs(vaultPath(out, false, plugin.vault))
    const zip = /\.zip$/i.test(abs)
    if (!zip && fs.existsSync(abs) && fs.readdirSync(abs).length && !fs.existsSync(path.join(abs, "logseq"))) throw new OpError(`${out} has files in it and isn't a Logseq graph: give a new folder`)
    const r = await exportGraph(plugin.vault, from, { journals: journals !== false, zip, out: zip ? undefined : abs })
    if (zip && r.zip) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, r.zip) }
    await plugin.vault.sync()
    return { out, pages: r.pages, journals: r.journals, assets: r.assets, blocks: r.blocks }
  },
  text: (r) => `Exported ${r.pages} pages, ${r.journals} journals and ${r.assets} assets (${r.blocks} blocks) to ${r.out}.`,
  did: ({ folder, out }) => ({ action: "create", text: `Exported ${folder} as a Logseq graph to ${out}` }),
})
