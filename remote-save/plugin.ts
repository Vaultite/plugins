// Remote save: syncs or backs up the vault's folder with storage the user owns (an S3-compatible bucket, a WebDAV
// folder). Which remotes and how they sync are vault settings; how to reach each (addresses, keys, passphrase) is a
// secret of the machine they were entered on, where the sync runs; what was synced last is kept there too.
import fs from "node:fs"
import path from "node:path"
import { HTTPError, localDate, OpError, Plugin, type Request } from "@vaultite/core/plugins.ts"
import { type Codec, META, type Meta, newKeyInfo, plainCodec, sealedCodec } from "./codec.ts"
import { skipper } from "./glob.ts"
import { type Remote, RemoteError } from "./remote.ts"
import { s3Remote } from "./s3.ts"
import { fsLocal, type State, sync } from "./sync.ts"
import { DEFAULT_SKIP, type Direction, type Kind, type RemoteSettings, type RemoteView, type Report, type Run, SCHEDULES } from "./types.ts"
import { webdavRemote } from "./webdav.ts"

export const plugin = new Plugin(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>
/** How to reach a remote, on this machine only (data/config.json). */
export type Connection = { endpoint?: string; region?: string; bucket?: string; prefix?: string; pathStyle?: boolean; accessKeyId?: string
  secretAccessKey?: string; url?: string; username?: string; password?: string; passphrase?: string }

const DIRECTIONS: Direction[] = ["two-way", "push", "pull"]
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/

// ---------- settings and secrets

export function remotes(): RemoteSettings[] {
  const list = plugin.settings({}).remotes
  return (Array.isArray(list) ? list : []).filter((r: Item) => r && ID.test(String(r.id))).map((r: Item) => ({
    id: String(r.id), name: String(r.name || r.id), type: r.type === "webdav" ? "webdav" : "s3",
    direction: DIRECTIONS.includes(r.direction) ? r.direction : "two-way", every: SCHEDULES.includes(r.every) ? r.every : "",
    skip: Array.isArray(r.skip) ? r.skip.map(String) : DEFAULT_SKIP, encrypt: r.encrypt === true, machine: typeof r.machine === "string" ? r.machine : null,
  }))
}

const connectionOf = (id: string): Connection | null => {
  const c = plugin.secrets()[plugin.id]?.[id]
  return c && typeof c === "object" ? c : null
}

function find(ref: string) {
  const r = remotes().find((x) => x.id === ref || x.name.toLowerCase() === ref.trim().toLowerCase())
  if (!r) throw new OpError(`there's no remote '${ref}' (vau remote-save status lists them)`, 404)
  return r
}

/** The service a remote's connection reaches. */
function open(type: Kind, c: Connection): Remote {
  if (type === "s3") {
    if (!c.endpoint || !c.bucket || !c.accessKeyId || !c.secretAccessKey) throw new RemoteError(0, "the endpoint, bucket and both keys are needed")
    return s3Remote({ endpoint: c.endpoint, region: c.region || "us-east-1", bucket: c.bucket, prefix: c.prefix ?? "", accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey, pathStyle: c.pathStyle !== false })
  }
  if (!c.url) throw new RemoteError(0, "the folder's address is needed")
  return webdavRemote({ url: c.url, username: c.username ?? "", password: c.password ?? "" })
}

/** The remote folder's own file, or null when there's none. */
async function metaOf(remote: Remote): Promise<Meta | null> {
  try {
    return JSON.parse((await remote.get(META)).toString("utf8"))
  } catch (e) {
    if (e instanceof RemoteError && e.status === 404) return null
    if (e instanceof SyntaxError) throw new RemoteError(0, `${remote.where} has a ${META} that isn't one this plugin wrote`)
    throw e
  }
}

/** How files are kept on this remote: plain, or encrypted (a new encrypted remote gets its salt when `make`). */
async function codecFor(r: { encrypt: boolean }, remote: Remote, c: Connection, make: boolean): Promise<{ codec: Codec | null; note: string }> {
  const meta = await metaOf(remote)
  if (meta?.encryption) {
    if (!r.encrypt || !c.passphrase) throw new RemoteError(0, "the remote is encrypted: turn on encryption and give its passphrase")
    try { return { codec: sealedCodec(c.passphrase, meta.encryption), note: "encrypted, and the passphrase fits" } } catch (e) { throw new RemoteError(0, (e as Error).message) }
  }
  if (!r.encrypt) return { codec: plainCodec, note: "not encrypted" }
  if (!c.passphrase) throw new RemoteError(0, "encryption is on: give a passphrase")
  if ((await remote.list()).some((f) => f.key !== META)) throw new RemoteError(0, "the folder already has files that aren't encrypted: use an empty one (another folder in the bucket) for an encrypted remote")
  if (!make) return { codec: null, note: "encrypted from the first sync" }
  const meta2: Meta = { format: 1, encryption: newKeyInfo(c.passphrase) }
  await remote.put(META, Buffer.from(JSON.stringify(meta2, null, 2) + "\n"), { ifNoneMatch: true })
  return { codec: sealedCodec(c.passphrase, meta2.encryption!), note: "encrypted" }
}

// ---------- what was synced and how it went, on this machine

const fileOf = (id: string, what: "state" | "runs") => path.join(plugin.localDir(), `${id}.${what}.json`)
const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return fallback } }
function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}
export const runsOf = (id: string): Run[] => readJson<Run[]>(fileOf(id, "runs"), [])
const running = new Map<string, Promise<Run>>()

// ---------- the sync

async function syncOne(r: RemoteSettings, o: { dryRun?: boolean; deletions?: boolean; by: string }): Promise<Run> {
  const t0 = Date.now()
  let report: Report | null = null, error: string | null = null
  try {
    const c = connectionOf(r.id)
    if (!c) throw new RemoteError(0, `how to reach it isn't on this machine${r.machine ? ` (it was set up on ${r.machine})` : ""}`)
    const remote = open(r.type, c)
    const { codec } = await codecFor(r, remote, c, !o.dryRun)
    const fingerprint = [r.type, c.endpoint ?? c.url, c.bucket ?? "", c.prefix ?? "", codec?.encrypted ? "sealed" : "plain"].join("|")
    let state = readJson<State>(fileOf(r.id, "state"), { fingerprint, files: {} })
    if (state.fingerprint !== fingerprint) state = { fingerprint, files: {} } // (another place: a first sync again, which never deletes)
    const vault = plugin.vault
    // Written on disk under the vault's lock, as iCloud would: the API can't write bytes over an existing file.
    const local = fsLocal(vault.path, { lock: (fn) => vault.lock(fn), trash: (rel) => vault.trash(rel) })
    report = await sync({ remote, codec: codec ?? plainCodec, local, state, save: (s) => { if (!o.dryRun) writeJson(fileOf(r.id, "state"), s) },
      direction: r.direction, skip: skipper(r.skip), deletions: o.deletions, dryRun: o.dryRun, day: localDate(Date.now()), signal: stop.signal })
    if (report.down || report.deletedLocal || report.conflicts.length) await vault.lock(() => vault.sync())
    if (report.stopped) error = `stopped: ${report.stopped}`
    else if (report.errors.length) error = `${report.errors.length} file${report.errors.length === 1 ? "" : "s"} failed: ${report.errors[0].path}: ${report.errors[0].error}`
  } catch (e) {
    error = (e as Error).message ?? String(e)
  }
  const run: Run = { at: new Date(t0).toISOString(), ms: Date.now() - t0, ok: !error, error, by: o.by, report }
  if (o.dryRun || !remotes().some((x) => x.id === r.id)) return run // (removed while it ran)
  const trimmed = report ? { ...report, skipped: report.skipped.slice(0, 50), errors: report.errors.slice(0, 50), held: report.held.slice(0, 50) } : null
  writeJson(fileOf(r.id, "runs"), [{ ...run, report: trimmed }, ...runsOf(r.id)].slice(0, 20))
  plugin.emit("remote-save.synced", { remote: r.id, ok: run.ok, error, up: report?.up ?? 0, down: report?.down ?? 0, conflicts: report?.conflicts.length ?? 0 })
  if (report?.conflicts.length) await tellConflicts(r, report)
  return run
}

/** Kept both versions: the user hears it in their inbox, with links to both. */
async function tellConflicts(r: RemoteSettings, rep: Report) {
  const n = rep.conflicts.length
  const lines = rep.conflicts.map((c) => c.kept === "here"
    ? `- [[${c.path}]] changed here and on ${r.name}: this vault's version keeps the name, ${r.name}'s is [[${c.copy}]]${r.direction === "push" ? ` (on ${r.name} only)` : ""}`
    : `- [[${c.path}]] changed here and on ${r.name}: ${r.name}'s version keeps the name, this vault's is [[${c.copy}]]`)
  await plugin.runOp("inbox.add", {
    title: `Remote save kept both versions of ${n} file${n === 1 ? "" : "s"}`,
    tldr: `${n === 1 ? "A file" : `${n} files`} changed both here and on ${r.name} since the last sync, so both versions were kept. Compare them, keep what you want and delete the other.`,
    body: `## Kept both\n\n${lines.join("\n")}\n`,
    from: "Remote save",
  }).catch((e: Error) => console.error(`remote-save: couldn't tell the inbox: ${e.message}`))
}

function syncNow(r: RemoteSettings, o: { dryRun?: boolean; deletions?: boolean; by: string }) {
  if (o.dryRun) return syncOne(r, o)
  const was = running.get(r.id)
  if (was) return was
  const p = syncOne(r, o).finally(() => running.delete(r.id))
  running.set(r.id, p)
  return p
}

// Unloaded, a sync under way stops between files. (The same module can be loaded again after: a fresh controller.)
let stop = new AbortController()
plugin.onUnload(() => { stop.abort(); stop = new AbortController() })

// ---------- the schedule: a job per remote that has one, on the machine its connection was entered on

const scheduled = new Map<string, string>()
function schedule() {
  if (!plugin.loaded) return
  const want = new Map(remotes().filter((r) => r.every).map((r) => [`sync-${r.id}`, { every: r.every, ...(r.machine ? { machine: r.machine } : {}) }]))
  for (const name of [...scheduled.keys()]) if (!want.has(name)) { plugin.every(name, null); scheduled.delete(name) }
  for (const [name, when] of want) {
    const key = JSON.stringify(when)
    if (scheduled.get(name) === key) continue
    const id = name.slice("sync-".length)
    plugin.every(name, when, async () => {
      const r = remotes().find((x) => x.id === id)
      if (!r || !connectionOf(id)) return
      const run = await syncNow(r, { by: "schedule" })
      if (!run.ok) throw new Error(run.error ?? "failed")
    })
    scheduled.set(name, key)
  }
}
plugin.onSync(schedule) // (its settings may change on another device)
setTimeout(schedule, 0) // (once loaded: the vault is set right after this module runs)

// ---------- what the app and agents see

/** A remote as the app shows it: its connection's details only for this machine's owner, never its secrets. */
function view(r: RemoteSettings, owner: boolean): RemoteView {
  const c = connectionOf(r.id)
  const runs = runsOf(r.id)
  return {
    ...r, here: !!c, running: running.has(r.id), last: runs[0] ?? null, lastOk: runs.find((x) => x.ok)?.at ?? null,
    connection: c && owner ? { endpoint: c.endpoint ?? "", region: c.region ?? "", bucket: c.bucket ?? "", prefix: c.prefix ?? "", pathStyle: c.pathStyle !== false,
      accessKeyId: c.accessKeyId ?? "", url: c.url ?? "", username: c.username ?? "", secret: !!(c.secretAccessKey || c.password), passphrase: !!c.passphrase } : null,
  }
}

const isOwner = async (req: Request) => !req.http || !(await plugin.refusal(req.http, "Remote save's connections"))
async function ownerOnly(req: Request) {
  const why = req.http ? await plugin.refusal(req.http, "Remote save's connections") : ""
  if (why) throw new HTTPError(403, why)
}

plugin.route("GET", "remote-save", async (req) => {
  schedule()
  const owner = await isOwner(req)
  return { remotes: remotes().map((r) => view(r, owner)) }
})

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** A remote from the settings sheet's form: what's checked, and its connection (blank secrets keep the saved ones). */
function fromForm(b: Item, was: RemoteSettings | null) {
  const type: Kind = b.type === "webdav" ? "webdav" : "s3"
  const name = str(b.name) || (type === "s3" ? "Bucket" : "WebDAV")
  if (b.direction !== undefined && !DIRECTIONS.includes(b.direction)) throw new HTTPError(400, `direction is ${DIRECTIONS.join(", ")}`)
  if (b.every !== undefined && !SCHEDULES.includes(b.every)) throw new HTTPError(400, `every is one of ${SCHEDULES.map((s) => s || '""').join(", ")}`)
  const skip = Array.isArray(b.skip) ? b.skip.map(str).filter(Boolean) : was?.skip ?? DEFAULT_SKIP
  const old = was ? connectionOf(was.id) ?? {} : {}
  const fc: Item = b.connection ?? {}
  const keep = (k: keyof Connection) => str(fc[k]) || (old[k] as string | undefined) || ""
  const conn: Connection = type === "s3"
    ? { endpoint: str(fc.endpoint), region: str(fc.region) || "us-east-1", bucket: str(fc.bucket), prefix: str(fc.prefix).replace(/^\/+/, ""), pathStyle: fc.pathStyle !== false,
      accessKeyId: str(fc.accessKeyId), secretAccessKey: keep("secretAccessKey") }
    : { url: str(fc.url), username: str(fc.username), password: keep("password") }
  const encrypt = b.encrypt === true
  if (encrypt) conn.passphrase = keep("passphrase")
  if (type === "s3" && !/^https?:\/\/[^/\s]+/.test(conn.endpoint!)) throw new HTTPError(400, "the endpoint is an address: https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com")
  if (type === "s3" && !conn.bucket) throw new HTTPError(400, "which bucket?")
  if (type === "s3" && (!conn.accessKeyId || !conn.secretAccessKey)) throw new HTTPError(400, "the access key and its secret are both needed")
  if (type === "webdav" && !/^https?:\/\/[^/\s]+/.test(conn.url!)) throw new HTTPError(400, "the folder's address is an https address")
  if (encrypt && !conn.passphrase) throw new HTTPError(400, "encryption needs a passphrase")
  return { type, name, direction: (b.direction ?? was?.direction ?? "two-way") as Direction, every: String(b.every ?? was?.every ?? ""), skip, encrypt, conn }
}

plugin.route("POST", "remote-save/remotes", async (req) => {
  await ownerOnly(req)
  const list = remotes()
  const was = req.body.id ? list.find((r) => r.id === req.body.id) ?? null : null
  if (req.body.id && !was) throw new HTTPError(404, `there's no remote '${req.body.id}'`)
  const f = fromForm(req.body, was)
  let id = was?.id ?? (f.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "remote")
  if (!was) for (let n = 2; list.some((r) => r.id === id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`
  const machine = String(await plugin.ask("machines:self", null) ?? "") || null
  const r: RemoteSettings = { id, name: f.name, type: f.type, direction: f.direction, every: f.every, skip: f.skip, encrypt: f.encrypt, machine }
  const data = plugin.readSettings() ?? {}
  const rows = (Array.isArray(data.remotes) ? data.remotes : []).filter((x: Item) => x?.id !== id)
  const { machine: _m, ...row } = r
  plugin.saveSettings({ ...data, remotes: was ? (data.remotes as Item[]).map((x) => (x?.id === id ? { ...row, ...(machine ? { machine } : {}) } : x)) : [...rows, { ...row, ...(machine ? { machine } : {}) }] })
  plugin.saveSecrets({ ...(plugin.secrets()[plugin.id] ?? {}), [id]: f.conn })
  schedule()
  return view(remotes().find((x) => x.id === id)!, true)
})

plugin.route("DELETE", "remote-save/remotes/*", async (req) => {
  await ownerOnly(req)
  const id = req.arg(0)
  const data = plugin.readSettings() ?? {}
  plugin.saveSettings({ ...data, remotes: (Array.isArray(data.remotes) ? data.remotes : []).filter((x: Item) => x?.id !== id) })
  const all = { ...(plugin.secrets()[plugin.id] ?? {}) }
  delete all[id]
  plugin.saveSecrets(Object.keys(all).length ? all : null)
  for (const what of ["state", "runs"] as const) fs.rmSync(fileOf(id, what), { force: true })
  schedule()
  return { ok: true }
})

/** Test connection: the form as it is (unsaved), against the service: it lists, writes, reads and deletes a small file. */
plugin.route("POST", "remote-save/test", async (req) => {
  await ownerOnly(req)
  const was = req.body.id ? remotes().find((r) => r.id === req.body.id) ?? null : null
  let f: ReturnType<typeof fromForm>
  try { f = fromForm(req.body, was) } catch (e) { return { ok: false, message: capital((e as Error).message) } }
  try {
    const remote = open(f.type, f.conn)
    const files = (await remote.list()).filter((x) => x.key !== META).length
    const { note } = await codecFor(f, remote, f.conn, false)
    const probe = `.vaultite-remote-save-test-${Date.now().toString(36)}`
    await remote.put(probe, Buffer.from("test"))
    const back = (await remote.get(probe)).toString()
    await remote.del(probe)
    if (back !== "test") throw new RemoteError(0, "a file written there read back differently")
    return { ok: true, message: `Connected to ${remote.where}: ${files ? `${files} file${files === 1 ? "" : "s"} there` : "it's empty"}, ${note}. Writing works.` }
  } catch (e) {
    return { ok: false, message: capital((e as Error).message) }
  }
}, { lock: false })

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ---------- text, for agents and the block

const when = (iso: string) => `${localDate(Date.parse(iso))} ${new Date(iso).toTimeString().slice(0, 5)}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const DIRECTION_TEXT: Record<Direction, string> = { "two-way": "two-way", push: "push only (a backup)", pull: "pull only" }
const EVERY_TEXT: Record<string, string> = { "": "by hand", "15m": "every 15 minutes", "1h": "every hour", "6h": "every 6 hours", "1d": "every day" }

export function reportText(rep: Report) {
  const parts = [rep.up && `${rep.up} up`, rep.down && `${rep.down} down`, rep.deletedRemote && `${rep.deletedRemote} deleted there`,
    rep.deletedLocal && `${rep.deletedLocal} to the trash here`, rep.conflicts.length && `${plural(rep.conflicts.length, "conflict")} (both kept)`,
    rep.held.length && `${plural(rep.held.length, "deletion")} held`, rep.skipped.length && `${rep.skipped.length} left for next time`,
    rep.waiting && `${rep.waiting} waiting for iCloud`].filter(Boolean)
  return parts.length ? parts.join(", ") : "nothing to do"
}

function remoteText(r: RemoteSettings) {
  const last = runsOf(r.id)[0]
  const head = `**${r.name}** (${r.type === "s3" ? "S3" : "WebDAV"}, ${DIRECTION_TEXT[r.direction]}, ${EVERY_TEXT[r.every]}${r.encrypt ? ", encrypted" : ""})`
  const where = connectionOf(r.id) ? "" : `; its connection is on ${r.machine ?? "another machine"}, not this one`
  if (running.has(r.id)) return `${head}: syncing now${where}`
  if (!last) return `${head}: never synced here${where}`
  const res = last.ok ? `synced ${when(last.at)}: ${last.report ? reportText(last.report) : ""}` : `failed ${when(last.at)}: ${last.error}`
  const held = last.report?.held.length ? ` Held deletions: ${last.report.held.slice(0, 5).join(", ")}${last.report.held.length > 5 ? "…" : ""} (sync with deletions to make them).` : ""
  return `${head}: ${res}${where}.${held}`
}

export function statusText(list: RemoteSettings[]) {
  return list.length ? list.map((r) => `- ${remoteText(r)}`).join("\n") : "No remotes yet: add one in Remote save's settings."
}

plugin.block("remote-save", (ctx) => {
  const ref = str(ctx.options.remote)
  const list = remotes().filter((r) => !ref || r.id === ref || r.name.toLowerCase() === ref.toLowerCase())
  return `### Remote save\n\n${statusText(list)}`
})

// ---------- operations

plugin.op({
  id: "remote-save.sync",
  cli: "remote-save sync",
  mcp: true,
  summary: "Sync the vault with its remotes now (an S3 bucket, a WebDAV folder): what went up, came down, conflicted or was held.",
  help: `Runs each remote whose connection is on this machine (or the one named) the way its settings say: two-way, push only
or pull only. A file changed on both sides is kept twice (the other as "name (conflict <date>).md", and the inbox says
so); a deletion follows only a file synced before; many deletions at once wait for --deletions.

  vau remote-save sync
  vau remote-save sync "Cloudflare R2" --dry-run`,
  kind: "write",
  lock: false,
  params: {
    remote: { type: "string", description: "one remote, by its name or id (default: every remote set up on this machine)" },
    dryRun: { type: "boolean", description: "say what it would do, without doing it" },
    deletions: { type: "boolean", description: "make deletions that were held (many at once, or a whole folder gone from here)" },
  },
  args: ["remote"],
  run: async (p, ctx) => {
    const list = p.remote ? [find(p.remote)] : remotes().filter((r) => connectionOf(r.id))
    if (!list.length) throw new OpError(remotes().length ? "no remote's connection is on this machine: sync from the machine it was set up on" : "there's no remote yet: add one in Remote save's settings")
    const out = []
    for (const r of list) out.push({ remote: r.id, name: r.name, ...(await syncNow(r, { dryRun: p.dryRun, deletions: p.deletions, by: ctx.who?.label ?? "you" })) })
    return out
  },
  text: (rows: (Run & { name: string })[]) => rows.map((r) => `- **${r.name}**: ${r.report?.dryRun ? "would do: " : ""}${r.ok ? (r.report ? reportText(r.report) : "") : `failed: ${r.error}`}${
    r.report?.conflicts.length && !r.report.dryRun ? `\n${r.report.conflicts.map((c) => `  - kept both: ${c.path} and ${c.copy}`).join("\n")}` : ""}${
    r.report?.held.length ? `\n  - held deletions (vau remote-save sync --deletions to make them): ${r.report.held.slice(0, 10).join(", ")}` : ""}`).join("\n"),
})

plugin.op({
  id: "remote-save.status",
  cli: "remote-save status",
  mcp: true,
  summary: "The vault's remotes (S3 buckets, WebDAV folders): how each syncs and how its last sync went.",
  kind: "read",
  params: { remote: { type: "string", description: "one remote, by its name or id" } },
  args: ["remote"],
  run: (p) => (p.remote ? [find(p.remote)] : remotes()).map((r) => view(r, false)),
  text: (rows: RemoteView[]) => statusText(rows.map((r) => remotes().find((x) => x.id === r.id)!).filter(Boolean)),
})
