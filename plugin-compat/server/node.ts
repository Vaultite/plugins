// Node for Obsidian plugins on computers: their calls into Node's modules run here, on the vault's machine (a call per
// request, sync ones over a blocking XHR), and streams (processes, watchers, servers) over a socket. Owner only.
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import { isBuiltin } from "node:module"
import os from "node:os"
import path from "node:path"
import type { WebSocket } from "ws"
import { HTTPError, type Plugin, type Request } from "@vaultite/core/plugins.ts"
import { real, type Config } from "./config.ts"
import type { Store } from "./store.ts"

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
type Usage = { modules: Record<string, number>; calls: Record<string, number>; hosts: Record<string, number>; commands: Record<string, number> }

// --- values both ways: Buffers, Dates, errors, fs's Stats and Dirents, handles to objects kept here

const handles = new Map<number, unknown>()
let nextHandle = 1
const STAT_KEYS = ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks", "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs"]

export function encode(v: unknown, seen = 0): Any {
  if (v === undefined) return { $u: 1 }
  if (v === null || typeof v === "boolean" || typeof v === "string") return v
  if (typeof v === "number") return Number.isFinite(v) ? v : { $num: String(v) }
  if (typeof v === "bigint") return { $n: String(v) }
  if (typeof v === "function") return { $fn: v.name }
  if (Buffer.isBuffer(v)) return { $b: v.toString("base64"), k: "buffer" }
  if (v instanceof Uint8Array) return { $b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64"), k: "u8" }
  if (v instanceof ArrayBuffer) return { $b: Buffer.from(v).toString("base64"), k: "ab" }
  if (v instanceof Date) return { $d: v.getTime() }
  if (v instanceof Error) return { $e: errorOf(v) }
  if (v instanceof fs.Stats) {
    const s = v as Any
    return { $stat: Object.fromEntries(STAT_KEYS.map((k) => [k, s[k]])), kind: s.isFile() ? "file" : s.isDirectory() ? "dir" : s.isSymbolicLink() ? "link" : "other" }
  }
  if (v instanceof fs.Dirent) {
    const d = v as Any
    return { $dirent: { name: d.name, parentPath: d.parentPath ?? d.path }, kind: d.isFile() ? "file" : d.isDirectory() ? "dir" : d.isSymbolicLink() ? "link" : "other" }
  }
  if (seen > 20) return null
  if (Array.isArray(v)) return v.map((x) => encode(x, seen + 1))
  const proto = Object.getPrototypeOf(v)
  if (proto === Object.prototype || proto === null) return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, encode(x, seen + 1)]))
  // Anything else (a database, a hash, a statement): kept here, called through its handle.
  const id = nextHandle++
  handles.set(id, v)
  const methods = new Set<string>()
  for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor" && typeof (v as Any)[k] === "function") methods.add(k)
  }
  const props: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as object)) if (x === null || ["string", "number", "boolean"].includes(typeof x)) props[k] = x
  return { $h: id, methods: [...methods], props }
}

export function decode(v: Any, cb?: (i: number) => (...a: unknown[]) => void): unknown {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map((x) => decode(x, cb))
  if ("$u" in v) return undefined
  if ("$num" in v) return Number(v.$num)
  if ("$n" in v) return BigInt(v.$n)
  if ("$b" in v) { const b = Buffer.from(v.$b, "base64"); return v.k === "ab" ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : v.k === "u8" ? new Uint8Array(b) : b }
  if ("$d" in v) return new Date(v.$d)
  if ("$h" in v) return handles.get(v.$h)
  if ("$cb" in v && cb) return cb(v.$cb)
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x, cb)]))
}

const errorOf = (e: Any) => ({ message: String(e?.message ?? e), name: e?.name, code: e?.code, errno: e?.errno, syscall: e?.syscall, path: e?.path, dest: e?.dest,
  status: e?.status, signal: e?.signal, stdout: e?.stdout === undefined ? undefined : encode(e.stdout), stderr: e?.stderr === undefined ? undefined : encode(e.stderr) })

// --- the vault's .obsidian/ through the overlay; relative paths from the vault, as plugins' process.cwd() says

const WRITES = /^(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|truncate|ftruncate|utimes|lutimes|chmod|lchmod|chown|lchown|createWriteStream)(Sync)?$/
const TWO = /^(rename|copyFile|cp|symlink|link)(Sync)?$/
const LISTS = /^(readdir|opendir)(Sync)?$/

class Paths {
  vault: string
  config: Config
  constructor(vault: string, config: Config) { this.vault = vault; this.config = config }
  rel(abs: string) {
    // (by where it really is: ".Obsidian" on a Mac's disk, or a symlink into it, is Obsidian's folder too)
    const dir = path.join(this.vault, ".obsidian")
    if (!this.config.isTheirs(abs)) return null
    const r = path.relative(real(dir), real(abs)).split(path.sep).join("/")
    return r ? `.obsidian/${r}` : ".obsidian"
  }
  /** fs's arguments with paths made absolute and .obsidian/ ones moved to ours (writes) or whichever has it (reads). */
  map(fn: string, args: unknown[]) {
    const name = fn.split(".").pop()!
    const at = TWO.test(name) ? [0, 1] : [0]
    const write = WRITES.test(name) || (/^open(Sync)?$/.test(name) && /[wa+]/.test(String(args[1] ?? "r")))
    return args.map((a, i) => {
      if (!at.includes(i) || typeof a !== "string") return a
      const abs = path.resolve(this.vault, a), rel = this.rel(abs)
      if (!rel) return abs
      const { ours, theirs } = this.config.where(rel)
      const isWrite = write && (i === at[at.length - 1] || !/^(rename|copyFile|cp)/.test(name))
      if (isWrite) {
        // (a folder Obsidian has: made in ours too, so a write into it lands)
        if (fs.existsSync(path.dirname(theirs))) fs.mkdirSync(path.dirname(ours), { recursive: true })
        return ours
      }
      return fs.existsSync(ours) ? ours : theirs
    })
  }
  /** A path given to a program: one in .obsidian/ is wherever it is (ours or theirs). */
  forProgram(a: unknown) {
    if (typeof a !== "string" || !a.startsWith(path.join(this.vault, ".obsidian"))) return a
    const rel = this.rel(a)
    if (!rel) return a
    const { ours, theirs } = this.config.where(rel)
    return fs.existsSync(ours) || !fs.existsSync(theirs) ? ours : theirs
  }
  /** readdir of a folder in .obsidian/ (as the plugin named it): ours and theirs together. */
  merged(fn: string, orig: unknown[], got: unknown) {
    if (!LISTS.test(fn.split(".").pop()!) || typeof orig[0] !== "string" || !Array.isArray(got)) return got
    const rel = this.rel(path.resolve(this.vault, orig[0]))
    if (!rel) return got
    const key = (x: Any) => (typeof x === "string" ? x : x.name)
    const all = new Map<string, unknown>()
    for (const d of Object.values(this.config.where(rel))) {
      try { for (const x of fs.readdirSync(d, orig[1] as Any) as Any[]) if (!all.has(key(x))) all.set(key(x), x) } catch { /* not there */ }
    }
    return all.size ? [...all.values()] : got
  }
}

// --- the bridge

export function nodeBridge(plugin: Plugin, store: () => Store, config: () => Config) {
  const usage = new Map<string, Usage>()
  const use = (id: string) => usage.get(id) ?? (usage.set(id, { modules: {}, calls: {}, hosts: {}, commands: {} }), usage.get(id)!)
  const count = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }
  const paths = () => new Paths(plugin.vault.path, config())
  const modules = new Map<string, Any>()
  const load = async (mod: string) => {
    if (!isBuiltin(mod)) throw new HTTPError(400, `${mod} isn't one of Node's modules`)
    if (!modules.has(mod)) modules.set(mod, await import(mod.startsWith("node:") ? mod : `node:${mod}`))
    const m = modules.get(mod)
    return m.default && typeof m.default === "object" ? { ...m, ...m.default } : m.default ?? m
  }

  /** Only this machine's owner, for an Obsidian plugin that's on and allowed here. */
  async function check(http: Request["http"] | undefined, id: unknown) {
    const why = http ? await plugin.refusal(http, "Node for plugins from other apps") : ""
    if (why) throw new HTTPError(403, why)
    if (!id) return "runtime" // (the runtime's own: the vault's adapter)
    // (a plugin's sync calls come by the dozen: whether it's on and allowed is looked up once a second)
    const hit = checked.get(String(id))
    if (hit && Date.now() - hit < 1000) return String(id)
    const p = store().get(String(id))
    if (!p?.enabled || !p.allowed) throw new HTTPError(403, `plugin '${id}' from another app isn't on and allowed here`)
    checked.set(p.id, Date.now())
    return p.id
  }
  const checked = new Map<string, number>()

  plugin.route("GET", "plugin-compat/node/env", async (req) => {
    await check(req.http, req.query.plugin)
    const vault = plugin.vault.path
    return { platform: process.platform, arch: process.arch, versions: process.versions, version: process.version, pid: process.pid, ppid: process.ppid,
      execPath: process.execPath, cwd: vault, vault, env: { ...process.env, PWD: vault }, sep: path.sep,
      os: { EOL: os.EOL, homedir: os.homedir(), tmpdir: os.tmpdir(), hostname: os.hostname(), type: os.type(), release: os.release(), arch: os.arch(),
        platform: os.platform(), endianness: os.endianness(), cpus: os.cpus().length, totalmem: os.totalmem(), userInfo: encode(os.userInfo()), version: os.version?.(), machine: os.machine?.() },
      constants: { fs: fs.constants, os: os.constants } }
  })

  // One call into a module (or a handle): `path` names the function from the module ("promises.readFile"); a callback
  // argument ({$cb}) is answered with its arguments, a promise with its value.
  plugin.route("POST", "plugin-compat/node/call", async (req) => {
    const b = req.body as { plugin?: string; mod?: string; path?: string; args?: Any[]; h?: number; ctor?: boolean; get?: boolean; release?: number[] }
    const id = await check(req.http, b.plugin)
    for (const h of b.release ?? []) handles.delete(h)
    if (b.path === undefined) return { ok: null }
    const u = use(id)
    if (b.mod) { count(u.modules, b.mod); count(u.calls, `${b.mod}.${b.path}`) }
    try {
      let target: Any = b.h ? handles.get(b.h) : await load(String(b.mod))
      if (target === undefined) throw Object.assign(new Error("that object is gone (the server restarted?)"), { code: "ERR_GONE" })
      const keys = b.path ? b.path.split(".") : []
      let parent = target
      for (const k of keys) { parent = target; target = target?.[k] }
      if (b.get) return { ok: encode(target) }
      if (typeof target !== "function") throw new TypeError(`${b.mod ?? "object"}.${b.path} is not a function`)
      let done: ((v: unknown[]) => void) | null = null
      const answered = new Promise<unknown[]>((r) => { done = r })
      const orig = (b.args ?? []).map((a) => decode(a, () => (...got: unknown[]) => done?.(got)))
      const fsCall = b.mod === "fs" || b.mod === "fs/promises"
      let args = fsCall ? paths().map(b.path, orig) : orig
      // (a file moved out of Obsidian's folder is copied: the app never changes .obsidian/)
      if (fsCall && /^rename(Sync)?$/.test(keys[keys.length - 1] ?? "") && typeof args[0] === "string" && config().isTheirs(args[0])) {
        const sync = keys[keys.length - 1].endsWith("Sync"), promises = keys[0] === "promises" || b.mod === "fs/promises"
        const fsm = await load("fs")
        target = promises ? fsm.promises.cp : sync ? fsm.cpSync : fsm.cp
        parent = promises ? fsm.promises : fsm
        args = [args[0], args[1], { recursive: true }, ...args.slice(2)]
      }
      if (b.mod === "child_process") args = forPrograms(paths(), withCwd(b.path, args, plugin.vault.path, (c) => count(u.commands, c)))
      const hasCb = (b.args ?? []).some((a) => a && typeof a === "object" && "$cb" in a)
      let out = b.ctor ? new target(...args) : target.apply(parent, args)
      if (hasCb) {
        const got = await answered
        if (fsCall && !got[0]) got[1] = paths().merged(b.path, orig, got[1])
        return { cb: got.map((x) => encode(x)) }
      }
      let promise = false
      if (out && typeof out.then === "function") { out = await out; promise = true }
      if (fsCall) out = paths().merged(b.path, orig, out)
      return { ok: encode(out), promise }
    } catch (e) {
      return { err: errorOf(e) }
    }
  }, { lock: false })

  // A request from Node's http/https client, made here (no CORS, any header, a local server's own certificate).
  plugin.route("POST", "plugin-compat/node/http", async (req) => {
    const b = req.body as { plugin?: string; url: string; method?: string; headers?: Record<string, string>; body?: string; insecure?: boolean }
    const id = await check(req.http, b.plugin)
    const url = new URL(b.url)
    count(use(id).hosts, url.host)
    const lib = url.protocol === "https:" ? https : http
    return await new Promise((resolve) => {
      const r = lib.request(url, { method: b.method ?? "GET", headers: b.headers, rejectUnauthorized: !b.insecure }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode, message: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks).toString("base64") }))
        res.on("error", (e) => resolve({ err: errorOf(e) }))
      })
      r.on("error", (e) => resolve({ err: errorOf(e) }))
      if (b.body) r.write(Buffer.from(b.body, "base64"))
      r.end()
    })
  }, { lock: false })

  // Streams: processes, watchers and servers, one socket per Obsidian plugin; all of them end when it closes.
  plugin.socket("plugin-compat/node/socket", (ws: WebSocket, _req, { query }) => {
    const id = query.plugin || "runtime"
    const u = use(id)
    const procs = new Map<number, ChildProcess>(), watchers = new Map<number, fs.FSWatcher>(), servers = new Map<number, http.Server>()
    const waiting = new Map<string, http.ServerResponse>()
    const send = (m: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
    ws.on("message", (data) => {
      let m: Any
      try { m = JSON.parse(String(data)) } catch { return }
      try {
        if (m.t === "spawn") {
          count(u.modules, "child_process")
          const [cmd, a, opts] = forPrograms(paths(), withCwd("spawn", [m.cmd, m.args ?? [], m.opts ?? {}], plugin.vault.path, (c) => count(u.commands, c))) as [string, string[], Any]
          // (pipes or nothing, never this server's own descriptors: fd 3 on only when the plugin asked for a pipe there)
          const stdio = Array.isArray(m.stdio) ? m.stdio.map((x: unknown, i: number) => (i < 3 || x === "pipe" ? "pipe" : "ignore")) : "pipe"
          const p = spawn(cmd, a, { ...opts, stdio })
          procs.set(m.id, p)
          p.on("spawn", () => send({ t: "spawned", id: m.id, pid: p.pid }))
          p.stdio.forEach((s, fd) => { if (fd > 0) (s as NodeJS.ReadableStream | null)?.on("data", (c: Buffer) => send({ t: "out", id: m.id, fd, data: c.toString("base64") })) })
          p.on("error", (e) => send({ t: "error", id: m.id, err: errorOf(e) }))
          p.on("close", (code, signal) => { procs.delete(m.id); send({ t: "exit", id: m.id, code, signal }) })
        } else if (m.t === "stdin") (procs.get(m.id)?.stdio[m.fd ?? 0] as NodeJS.WritableStream | null)?.write(Buffer.from(m.data, "base64"))
        else if (m.t === "stdin-end") (procs.get(m.id)?.stdio[m.fd ?? 0] as NodeJS.WritableStream | null)?.end()
        else if (m.t === "kill") procs.get(m.id)?.kill(m.signal ?? "SIGTERM")
        else if (m.t === "watch") {
          const [p] = paths().map("watch", [m.path]) as string[]
          const w = fs.watch(p, { recursive: !!m.opts?.recursive, persistent: false }, (event, filename) => send({ t: "change", id: m.id, event, filename }))
          w.on("error", (e) => send({ t: "error", id: m.id, err: errorOf(e) }))
          watchers.set(m.id, w)
        } else if (m.t === "unwatch") { watchers.get(m.id)?.close(); watchers.delete(m.id) }
        else if (m.t === "listen") {
          count(u.modules, m.tls ? "https" : "http")
          const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
            const chunks: Buffer[] = []
            req.on("data", (c: Buffer) => chunks.push(c))
            req.on("end", () => {
              const rid = `${m.id}:${nextHandle++}`
              waiting.set(rid, res)
              send({ t: "req", id: m.id, rid, method: req.method, url: req.url, headers: req.headers, httpVersion: req.httpVersion, remote: req.socket.remoteAddress, body: Buffer.concat(chunks).toString("base64") })
            })
          }
          const s = m.tls ? https.createServer({ key: m.tls.key, cert: m.tls.cert }, handler) : http.createServer(handler)
          s.on("error", (e) => send({ t: "error", id: m.id, err: errorOf(e) }))
          s.listen(m.port ?? 0, m.host ?? "127.0.0.1", () => { const a = s.address(); send({ t: "listening", id: m.id, address: typeof a === "object" ? a : { port: m.port } }) })
          servers.set(m.id, s)
        } else if (m.t === "res") {
          const res = waiting.get(m.rid)
          if (!res) return
          if (m.head && !res.headersSent) res.writeHead(m.status ?? 200, m.message, m.headers ?? {})
          if (m.data) res.write(Buffer.from(m.data, "base64"))
          if (m.end) { res.end(); waiting.delete(m.rid) }
        } else if (m.t === "close") { servers.get(m.id)?.close(() => send({ t: "closed", id: m.id })); servers.delete(m.id) }
      } catch (e) { send({ t: "error", id: m.id, err: errorOf(e) }) }
    })
    ws.on("close", () => {
      for (const p of procs.values()) p.kill()
      for (const w of watchers.values()) w.close()
      for (const s of servers.values()) s.close()
      for (const r of waiting.values()) r.destroy()
    })
  }, { accept: async (req, { query }) => { await check(req, query.plugin) } })

  return { usage: () => Object.fromEntries(usage) }
}

/** A program's command, arguments, working folder and environment, with paths in .obsidian/ where they are. */
function forPrograms(p: Paths, args: unknown[]) {
  const one = (a: unknown) => (typeof a === "string" ? p.forProgram(a) : a)
  return args.map((a) => {
    if (Array.isArray(a)) return a.map(one)
    if (a && typeof a === "object" && !Buffer.isBuffer(a)) {
      const o = { ...(a as Any) }
      if (o.cwd) o.cwd = one(o.cwd)
      if (o.env) o.env = Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, one(v)]))
      return o
    }
    return one(a)
  })
}

/** child_process's options with the vault as the working folder when it names none, and the command noted. */
function withCwd(fn: string, args: unknown[], vault: string, note: (cmd: string) => void) {
  const name = fn.split(".").pop()!
  const out = [...args]
  note(String(out[0] ?? "").split(/\s/)[0])
  // exec(cmd, opts?, cb?), execFile(file, args?, opts?, cb?), spawn(cmd, args?, opts?): the options are the object
  const at = out.findIndex((a, i) => i > 0 && a && typeof a === "object" && !Array.isArray(a) && !("$cb" in (a as object)))
  if (at > 0) out[at] = { cwd: vault, ...(out[at] as object) }
  else {
    const where = /^exec(Sync)?$/.test(name) ? 1 : Array.isArray(out[1]) ? 2 : 1
    const cb = typeof out[where] === "function" ? out.splice(where, 1) : []
    while (out.length < where) out.push(name.startsWith("exec") && !name.startsWith("execFile") ? undefined : [])
    out.splice(where, 0, { cwd: vault }, ...cb)
  }
  return out
}
