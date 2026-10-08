// Obsidian plugins, unmodified: Obsidian's own in .obsidian/plugins/ and those installed here, each run once this
// machine's owner allowed its code; served to the app's runtime with what Obsidian's API needs from the server.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { HTTPError, OpError, Plugin, Text, type OpCtx, type Request } from "@vaultite/core/plugins.ts"
import { community } from "./server/directory.ts"
import { wireRunner } from "./server/runner.ts"
import { Config } from "./server/config.ts"
import { metadataOf, type CachedMetadata } from "./server/meta.ts"
import { nodeBridge } from "./server/node.ts"
import { Files } from "./server/files.ts"
import { ID, Store } from "./server/store.ts"

export const plugin = new Plugin(import.meta.url)

const text = (f: string) => { try { return fs.readFileSync(f, "utf8") } catch { return null } }
let cfg: Config | null = null, st: Store | null = null
const config = () => (cfg?.root === plugin.vault.path ? cfg : (cfg = new Config(plugin.vault.path)))
const store = () => (st?.config === config() ? st : (st = new Store(config(), { allows: (w) => plugin.allows(w), allow: (w) => plugin.allow(w), local: () => plugin.localDir() })))
const node = nodeBridge(plugin, store, config)
const idOf = (v: unknown) => { const id = String(v ?? ""); if (!ID.test(id)) throw new HTTPError(400, "bad id"); return id }
// Plugins' code, the vault's files (hidden ones too), their settings and the network as the server: this machine's owner only
// (or its allowUsers), like Node's bridge: an allowed plugin's settings may name a program it runs.
const owned = <T>(fn: (req: Request) => T) => async (req: Request) => {
  const why = req.http ? await plugin.refusal(req.http, "Obsidian plugins") : ""
  if (why) throw new HTTPError(403, why)
  return fn(req)
}
const ownRoute = (method: string, pattern: string, fn: (req: Request) => unknown, opts?: Parameters<typeof plugin.route>[3]) => plugin.route(method, pattern, owned(fn), opts)

plugin.route("GET", "obsidian-compat/plugins", () => store().list())

ownRoute("GET", "obsidian-compat/plugin/*", (req) => {
  const id = idOf(req.wild[0]), p = store().get(id)
  if (!p) throw new HTTPError(404, `no Obsidian plugin '${id}'`)
  if (!p.allowed) throw new HTTPError(403, `${p.manifest.name} waits for this machine's owner to allow it`)
  const read = (f: string) => config().read(`.obsidian/plugins/${id}/${f}`)?.toString("utf8") ?? null
  let data: unknown = null
  try { data = JSON.parse(read("data.json") ?? "null") } catch { /* unreadable: none */ }
  return { css: read("styles.css") ?? "", data, hash: p.hash }
})

// Its main.js as a script the page loads by address: compiled off the main thread and kept compiled by the browser
// (cached for good under its code's hash), wrapped as Obsidian runs it (CommonJS, names the runtime gives it).
ownRoute("GET", "obsidian-compat/main/*", (req) => {
  const id = idOf(req.wild[0]), p = store().get(id)
  if (!p) throw new HTTPError(404, `no Obsidian plugin '${id}'`)
  if (!p.allowed) throw new HTTPError(403, `${p.manifest.name} waits for this machine's owner to allow it`)
  const names = String(req.query.s ?? "").split(",").filter(Boolean)
  if (!names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n))) throw new HTTPError(400, "bad names")
  const main = config().read(`.obsidian/plugins/${id}/main.js`)?.toString("utf8") ?? ""
  const vars = names.length ? `var ${names.map((n) => `${n} = __s.${n}`).join(", ")};\n` : ""
  // (main.js in a function of its own: it may declare `app`, `process`… itself)
  const js = `__obsidianMain(${JSON.stringify(id)}, function (__s, module, exports) {\n${vars}const __main = function () {\n${main}\n}\n__main.call(exports)\n})\n//# sourceURL=obsidian-plugin:${id}/main.js\n`
  const fresh = req.query.h === p.hash
  return new Text(js, "text/javascript; charset=utf-8", { "Cache-Control": fresh ? "private, max-age=31536000, immutable" : "no-store" })
})

ownRoute("POST", "obsidian-compat/data/*", (req) => {
  const id = idOf(req.wild[0])
  config().write(`.obsidian/plugins/${id}/data.json`, JSON.stringify(req.body.data ?? null, null, 2))
  return { ok: true }
})

// On or off in this vault; turned on by this machine's owner, its code is allowed here as it is now.
ownRoute("POST", "obsidian-compat/enable", async (req) => {
  const id = idOf(req.body.id), on = !!req.body.on
  if (on) {
    const p = store().get(id)
    if (!p) throw new HTTPError(404, `no Obsidian plugin '${id}'`)
    if (!p.allowed && !(req.http && await plugin.refusal(req.http, "Obsidian plugins"))) store().allow(id)
  }
  store().setEnabled(id, on)
  return store().get(id)
})

/** On, allowed here when this machine's owner asks, and what stands in for it turned off (the core's obsidian.use). */
async function turnOn(id: string, ctx: OpCtx) {
  try { await ctx.op("obsidian.use", { id, with: "original" }); return } catch { /* Obsidian settings is off: just this */ }
  if (!store().get(id)?.allowed && !(await ctx.refusal?.("Obsidian plugins"))) store().allow(id)
  store().setEnabled(id, true)
}
wireRunner(plugin, store)

plugin.op({
  id: "obsidian-compat.allow",
  owner: "Obsidian plugins",
  summary: "Let an Obsidian plugin's code run on this machine as it is now (its owner only)",
  kind: "write",
  params: { id: { type: "string", required: true, description: "the plugin's id" } },
  args: ["id"],
  cli: "obsidian-compat allow",
  run: async ({ id }, ctx) => {
    const p = store().get(idOf(id))
    if (!p) throw new OpError(`no Obsidian plugin '${id}': vau obsidian-compat list`)
    const why = (await ctx.refusal?.("Obsidian plugins")) ?? ""
    if (why) throw new OpError(why)
    store().allow(p.id)
    return { id: p.id, hash: p.hash }
  },
})

plugin.op({
  id: "obsidian-compat.list",
  summary: "The Obsidian plugins this vault has, which are on and which this machine allows",
  kind: "read",
  params: {},
  cli: "obsidian-compat list",
  run: () => store().list().map(({ id, manifest, enabled, allowed, here }) => ({ id, name: manifest.name, version: manifest.version, enabled, allowed, from: here ? "here" : "obsidian" })),
})

plugin.op({
  id: "obsidian-compat.enable",
  owner: "Obsidian plugins",
  summary: "Turn an Obsidian plugin on or off in this vault (on: allowed on this machine too, when its owner asks)",
  kind: "write",
  params: { id: { type: "string", required: true, description: "the plugin's id" }, on: { type: "boolean", description: "false turns it off" } },
  args: ["id"],
  cli: "obsidian-compat enable",
  run: async ({ id, on }, ctx) => {
    const p = store().get(idOf(id))
    if (!p) throw new OpError(`no Obsidian plugin '${id}'`)
    if (on !== false) await turnOn(p.id, ctx); else store().setEnabled(p.id, false)
    return store().get(p.id)
  },
})

// --- the vault as Obsidian sees it: every file and folder, each note's metadata over its whole text

const metas = new Map<string, [bigint, CachedMetadata]>()
function metaOf(rel: string, ns: bigint) {
  const hit = metas.get(rel)
  if (hit?.[0] === ns) return hit[1]
  const t = text(plugin.vault.abs(rel)) ?? ""
  const m = metadataOf(t.replace(/\r\n/g, "\n"))
  metas.set(rel, [ns, m])
  return m
}

ownRoute("GET", "obsidian-compat/vault", (req) => {
  const v = plugin.vault
  const only = req.query.paths ? new Set(String(req.query.paths).split("\n")) : null
  const ms = (ns: bigint) => Number(ns / 1000000n)
  const item = (rel: string) => {
    const st = v.entries.get(rel)?.stat ?? v.others.get(rel)
    return st ? [{ path: rel, size: st.size, mtime: ms(st.ns), ctime: st.born }] : []
  }
  // (asked about some paths: only theirs, a vault of 10,000 notes isn't listed again on every save)
  const files = only ? [...only].flatMap(item) : [...v.entries.keys(), ...v.others.keys()].flatMap(item)
  const cache: Record<string, CachedMetadata> = {}, texts: Record<string, string> = {}
  for (const [rel, e] of v.entries) if (!only || only.has(rel)) cache[rel] = metaOf(rel, e.stat.ns)
  // (the notes asked for come with their text: Obsidian's 'changed' event hands it over)
  if (only) for (const rel of only) if (v.entries.has(rel)) texts[rel] = text(v.abs(rel)) ?? ""
  for (const rel of metas.keys()) if (!v.entries.has(rel)) metas.delete(rel)
  return { name: path.basename(v.path), files, folders: v.folders, cache, texts, partial: !!only }
})

// --- any vault file as bytes, hidden ones too (Obsidian's adapter, binary files): server/files.ts

let fl: Files | null = null
const files = () => (fl?.config === config() ? fl : (fl = new Files(plugin.vault.path, config())))
const fsCall = async <T>(fn: () => T, touched?: string) => {
  let out: T
  try { out = fn() } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new HTTPError(code === "ENOENT" ? 404 : code === "EEXIST" ? 409 : 400, (e as Error).message)
  }
  // (a visible file changed: the app's index, and every window, hear of it)
  if (touched !== undefined && !touched.split("/").some((s) => s.startsWith("."))) await plugin.vault.sync()
  return out
}
// (null for none: plugins ask about many files that aren't there, and a 404 is an error in the page's console)
ownRoute("GET", "obsidian-compat/fs/stat", (req) => files().stat(req.query.path) ?? null)
ownRoute("GET", "obsidian-compat/fs/read", (req) => fsCall(() => {
  const b = files().read(req.query.path)
  if (!b) throw Object.assign(new Error("not there"), { code: "ENOENT" })
  return { base64: b.toString("base64") }
}))
// Many reads at once (a plugin indexing every note asks for each): stats, bytes or text, each answered or null.
ownRoute("POST", "obsidian-compat/fs/batch", (req) => {
  const ops = Array.isArray(req.body.ops) ? (req.body.ops as { op?: string; path?: string }[]) : []
  return { results: ops.map(({ op, path: p }) => {
    try {
      if (op === "stat") return files().stat(p) ?? null
      const b = files().read(p)
      return b === null ? null : op === "text" ? { text: b.toString("utf8") } : { base64: b.toString("base64") }
    } catch { return null }
  }) }
}, { lock: false })
ownRoute("GET", "obsidian-compat/fs/list", (req) => fsCall(() => files().list(req.query.path)))
ownRoute("POST", "obsidian-compat/fs/write", (req) => fsCall(() => { files().write(req.body.path, Buffer.from(String(req.body.base64 ?? ""), "base64"), !!req.body.append); return { ok: true } }, String(req.body.path)))
ownRoute("POST", "obsidian-compat/fs/mkdir", (req) => fsCall(() => { files().mkdir(req.body.path); return { ok: true } }, String(req.body.path)))
ownRoute("POST", "obsidian-compat/fs/remove", (req) => fsCall(() => { files().remove(req.body.path, !!req.body.recursive); return { ok: true } }, String(req.body.path)))
ownRoute("POST", "obsidian-compat/fs/rename", (req) => fsCall(() => { files().rename(req.body.from, req.body.to); return { ok: true } }, [req.body.from, req.body.to].map(String).find((p) => !p.split("/").some((x) => x.startsWith("."))) ?? "."))
ownRoute("POST", "obsidian-compat/fs/copy", (req) => fsCall(() => { files().copy(req.body.from, req.body.to); return { ok: true } }, String(req.body.to)))

// --- the config folder (.obsidian/) as plugins see it: ours over Obsidian's (server/config.ts)

const statOf = (f: string | null) => { try { return f ? fs.statSync(f) : null } catch { return null } }
const cfgPath = (p: unknown) => { try { config().where(String(p ?? "")); return String(p) } catch (e) { throw new HTTPError(400, (e as Error).message) } }
ownRoute("GET", "obsidian-compat/config/stat", (req) => {
  const s = statOf(config().readable(cfgPath(req.query.path)))
  if (!s) throw new HTTPError(404, "not there")
  return { type: s.isDirectory() ? "folder" : "file", size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs }
})
ownRoute("GET", "obsidian-compat/config/read", (req) => {
  const b = config().read(cfgPath(req.query.path))
  if (!b) throw new HTTPError(404, "not there")
  return { base64: b.toString("base64") }
})
ownRoute("GET", "obsidian-compat/config/list", (req) => {
  const rel = cfgPath(req.query.path).replace(/\/+$/, "")
  const l = config().list(rel)
  return { files: l.files.map((n) => `${rel}/${n}`), folders: l.folders.map((n) => `${rel}/${n}`) }
})
ownRoute("POST", "obsidian-compat/config/write", (req) => {
  config().write(cfgPath(req.body.path), Buffer.from(String(req.body.base64 ?? ""), "base64"))
  return { ok: true }
})
ownRoute("POST", "obsidian-compat/config/mkdir", (req) => { fs.mkdirSync(config().where(cfgPath(req.body.path)).ours, { recursive: true }); return { ok: true } })
ownRoute("POST", "obsidian-compat/config/remove", (req) => { config().remove(cfgPath(req.body.path)); return { ok: true } })

// --- Obsidian's requestUrl: the server fetches, so pages' CORS doesn't apply (any address its settings name)

ownRoute("POST", "obsidian-compat/request", async (req) => {
  const b = req.body as { url?: string; method?: string; headers?: Record<string, string>; body?: string; base64?: boolean }
  if (!b.url || !/^https?:\/\//.test(b.url)) throw new HTTPError(400, "url must be http(s)")
  // (as Obsidian's own requests say who they are: some APIs, GitHub's, refuse a request without a User-Agent)
  const headers = { "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) obsidian/1.13.1 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36", ...(b.headers ?? {}) }
  const r = await fetch(b.url, { method: b.method ?? "GET", headers, body: b.body === undefined ? undefined : b.base64 ? Buffer.from(b.body, "base64") : b.body, redirect: "follow" })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, headers: Object.fromEntries(r.headers), body: buf.toString("base64") }
}, { lock: false })

// --- Lucide's icons by name (Obsidian's setIcon names them), as SVG

const LUCIDE = path.join(fileURLToPath(import.meta.resolve("lucide-react")).replace(/dist[\\/].*$/, "dist"), "esm", "icons")
const icons = new Map<string, string | null>()
// Lucide's older names (alert-triangle: triangle-alert), which Obsidian plugins still use.
let aliases: Map<string, string> | null = null
const fileOf = (name: string) => {
  aliases ??= new Map([...(text(path.join(LUCIDE, "..", "dynamicIconImports.mjs")) ?? "").matchAll(/"([a-z0-9-]+)": \(\) => import\('\.\/icons\/([a-z0-9-]+)\.mjs'\)/g)].map((m) => [m[1], m[2]]))
  return aliases.get(name) ?? name
}
/** An icon's shapes (the SVG's inside), by Lucide's name or an older one; null when there's none. */
function shapesOf(name: string) {
  if (!icons.has(name)) {
    const src = text(path.join(LUCIDE, `${fileOf(name)}.mjs`))
    const nodes = src && /node: (\[[\s\S]*?(?:\n {2}\]|\]\]))(?=,?\n)/.exec(src)?.[1]
    let inner: string | null = null
    if (nodes) {
      const list = Function(`return ${nodes}`)() as [string, Record<string, string>][]
      const attrs = (a: Record<string, string>) => Object.entries(a).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ")
      inner = list.map(([t, a]) => `<${t} ${attrs(a)}/>`).join("")
    }
    icons.set(name, inner)
  }
  return icons.get(name) ?? null
}
const svgOf = (name: string, inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${name}">${inner}</svg>`
plugin.route("GET", "obsidian-compat/icon/*", (req) => {
  const name = req.wild[0].replace(/^lucide-/, "")
  if (!/^[a-z0-9-]+$/.test(name)) throw new HTTPError(400, "bad icon name")
  const inner = shapesOf(name)
  if (inner === null) throw new HTTPError(404, `no icon '${name}'`)
  return new Text(svgOf(name, inner), "image/svg+xml")
})
// Every icon at once, for getIcon/getIconIds, which Obsidian answers synchronously for all of Lucide's.
let all: string | null = null
plugin.route("GET", "obsidian-compat/icons", () => {
  if (all === null) {
    const out: Record<string, string> = {}
    for (const f of fs.readdirSync(LUCIDE)) {
      if (!f.endsWith(".mjs")) continue
      const n = f.slice(0, -4), inner = shapesOf(n)
      if (inner !== null) out[n] = inner
    }
    fileOf("")
    all = JSON.stringify({ icons: out, aliases: Object.fromEntries(aliases ?? []) })
  }
  return new Text(all, "application/json", { "Cache-Control": "max-age=86400" })
})

// --- what each client saw when it ran them (live, in memory: a report for whoever tests them)

const reports = new Map<string, unknown>()
plugin.route("POST", "obsidian-compat/report", (req) => { reports.set(String(req.body.client ?? "?"), { ...req.body, at: new Date().toISOString() }); return { ok: true } })
plugin.route("GET", "obsidian-compat/report", () => ({ ...Object.fromEntries(reports), node: node.usage() }))

// --- installing: a plugin's release from GitHub, as Obsidian does, into ours (.vaultite/obsidian/plugins/<id>/)

// The version its repository's manifest.json names, from that release (not a newer beta).
async function download(repo: string, version: string, file: string) {
  const r = await fetch(`https://github.com/${repo}/releases/download/${version}/${file}`, { redirect: "follow" })
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null
}

plugin.op({
  id: "obsidian-compat.install",
  owner: "Obsidian plugins",
  summary: "Install an Obsidian plugin from its GitHub release, as Obsidian does (main.js, manifest.json, styles.css); off until turned on (--on)",
  kind: "write",
  lock: false,
  params: { repo: { type: "string", required: true, description: "its GitHub repository (owner/name), or its id in Obsidian's community list" },
    on: { type: "boolean", description: "turn it on once installed (allowed on this machine when its owner asks)" } },
  args: ["repo"],
  cli: "obsidian-compat install",
  run: async ({ repo: given, on }, ctx) => {
    const repo = String(given).includes("/") ? String(given) : (await community(plugin))?.plugins.find((p) => p.id === given)?.repo
    if (!repo) throw new OpError(`no '${given}' in Obsidian's community plugins`)
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new OpError("repo is owner/name")
    const head = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`).then((r) => (r.ok ? r.json() : null), () => null)
    if (!head?.version) throw new OpError(`${repo} has no manifest.json naming a version`)
    let files: Record<string, Buffer | null> = {}
    for (const tag of [head.version, `v${head.version}`]) {
      files = { "manifest.json": await download(String(repo), tag, "manifest.json"), "main.js": await download(String(repo), tag, "main.js") }
      if (files["main.js"]) { files["styles.css"] = await download(String(repo), tag, "styles.css"); break }
    }
    if (!files["main.js"]) throw new OpError(`${repo} has no release ${head.version} with main.js`)
    const manifest = files["manifest.json"] ? JSON.parse(files["manifest.json"].toString("utf8")) : head
    const id = String(manifest.id ?? "")
    if (!ID.test(id)) throw new OpError(`its manifest's id '${id}' isn't a plain name`)
    files["manifest.json"] ??= Buffer.from(JSON.stringify(head, null, 2))
    for (const [f, b] of Object.entries(files)) {
      if (b) config().write(`.obsidian/plugins/${id}/${f}`, b)
      else config().remove(`.obsidian/plugins/${id}/${f}`)
    }
    if (on) await turnOn(id, ctx)
    return { id, version: String(manifest.version), on: !!on }
  },
  text: (r) => `Installed ${(r as { id: string }).id}${(r as { on: boolean }).on ? " and turned it on" : `: turn it on with vau obsidian-compat enable ${(r as { id: string }).id}`}.`,
})

plugin.op({
  id: "obsidian-compat.uninstall",
  owner: "Obsidian plugins",
  summary: "Remove an Obsidian plugin installed here, and turn it off (Obsidian's own, in .obsidian/plugins/, are only turned off)",
  kind: "destructive",
  params: { id: { type: "string", required: true, description: "the plugin's id" } },
  args: ["id"],
  cli: "obsidian-compat uninstall",
  run: ({ id }) => {
    const p = store().get(idOf(id))
    if (!p) throw new OpError(`no Obsidian plugin '${id}'`)
    store().setEnabled(p.id, false)
    if (p.here) for (const f of ["main.js", "manifest.json", "styles.css"]) config().remove(`.obsidian/plugins/${p.id}/${f}`)
    return { id: p.id, removed: p.here }
  },
})
