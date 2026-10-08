// Calls into Node on the server (server/node.ts): values both ways, sync calls over a blocking XHR, async ones over
// fetch, objects kept there as handles, and one socket per plugin for streams.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from "../../lib/buffer.js"

type Any = any
const url = (route: string) => new URL(`api/plugin-compat/node/${route}`, document.baseURI).href

/** fs's Stats, as Node makes them. */
export class Stats {
  [k: string]: Any
  constructor(s: Record<string, number>, kind: string) {
    Object.assign(this, s)
    for (const k of ["atime", "mtime", "ctime", "birthtime"]) this[k] = new Date(s[`${k}Ms`] ?? 0)
    Object.defineProperty(this, "kind", { value: kind, enumerable: false })
  }
  isFile() { return this.kind === "file" }
  isDirectory() { return this.kind === "dir" }
  isSymbolicLink() { return this.kind === "link" }
  isFIFO() { return false }
  isSocket() { return false }
  isBlockDevice() { return false }
  isCharacterDevice() { return false }
}
export class Dirent {
  [k: string]: Any
  constructor(d: Record<string, string>, kind: string) { Object.assign(this, d, { path: d.parentPath }); Object.defineProperty(this, "kind", { value: kind, enumerable: false }) }
  isFile() { return this.kind === "file" }
  isDirectory() { return this.kind === "dir" }
  isSymbolicLink() { return this.kind === "link" }
  isFIFO() { return false }
  isSocket() { return false }
  isBlockDevice() { return false }
  isCharacterDevice() { return false }
}

const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64")
export function encode(v: Any, depth = 0): Any {
  if (v === undefined) return { $u: 1 }
  if (v === null || typeof v === "boolean" || typeof v === "string") return v
  if (typeof v === "number") return Number.isFinite(v) ? v : { $num: String(v) }
  if (typeof v === "bigint") return { $n: String(v) }
  if (typeof v === "function") return v.$cb !== undefined ? { $cb: v.$cb } : { $u: 1 }
  if (Buffer.isBuffer(v)) return { $b: b64(v), k: "buffer" }
  if (ArrayBuffer.isView(v)) return { $b: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), k: "u8" }
  if (v instanceof ArrayBuffer) return { $b: b64(new Uint8Array(v)), k: "ab" }
  if (v instanceof Date) return { $d: v.getTime() }
  if (v instanceof URL) return v.href
  if (v.$h !== undefined && handleOf.has(v)) return { $h: handleOf.get(v) }
  if (depth > 20) return null
  if (Array.isArray(v)) return v.map((x) => encode(x, depth + 1))
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x, depth + 1)]))
}

export function errorFrom(e: Any) {
  const err: Any = new Error(e?.message ?? "failed")
  for (const [k, x] of Object.entries(e ?? {})) if (x !== undefined && x !== null && k !== "message") err[k] = k === "stdout" || k === "stderr" ? decode(x, "") : x
  return err
}

const handleOf = new WeakMap<object, number>()
const gone: number[] = []
const registry = new FinalizationRegistry<number>((h) => { gone.push(h) })

export function decode(v: Any, plugin: string): Any {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map((x) => decode(x, plugin))
  if ("$u" in v) return undefined
  if ("$num" in v) return Number(v.$num)
  if ("$n" in v) return BigInt(v.$n)
  if ("$b" in v) { const b = Buffer.from(v.$b, "base64"); return v.k === "ab" ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : v.k === "u8" ? new Uint8Array(b) : b }
  if ("$d" in v) return new Date(v.$d)
  if ("$e" in v) return errorFrom(v.$e)
  if ("$stat" in v) return new Stats(v.$stat, v.kind)
  if ("$dirent" in v) return new Dirent(v.$dirent, v.kind)
  if ("$fn" in v) return undefined
  if ("$h" in v) {
    const o: Any = { ...v.props }
    for (const m of v.methods) o[m] = remoteFn(plugin, { h: v.$h }, m, false)
    handleOf.set(o, v.$h)
    Object.defineProperty(o, "$h", { value: v.$h, enumerable: false })
    registry.register(o, v.$h)
    return o
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x, plugin)]))
}

type Target = { mod?: string; h?: number }
type Answer = { ok?: Any; promise?: boolean; cb?: Any[]; err?: Any }

function bodyOf(plugin: string, t: Target, path: string, args: Any[], extra: object = {}) {
  return JSON.stringify({ plugin, ...t, path, args: args.map((a) => encode(a)), release: gone.splice(0), ...extra })
}
/** A call that blocks until the server answers (Node's sync APIs). */
export function callSync(plugin: string, t: Target, path: string, args: Any[], extra: object = {}): Answer {
  const x = new XMLHttpRequest()
  x.open("POST", url("call"), false)
  x.setRequestHeader("Content-Type", "application/json")
  x.send(bodyOf(plugin, t, path, args, extra))
  if (x.status !== 200) throw new Error(`Node for ${plugin}: ${x.status} ${x.responseText.slice(0, 200)}`)
  return JSON.parse(x.responseText)
}
export async function callAsync(plugin: string, t: Target, path: string, args: Any[], extra: object = {}): Promise<Answer> {
  const r = await fetch(url("call"), { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyOf(plugin, t, path, args, extra) })
  if (!r.ok) throw new Error(`Node for ${plugin}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
export async function post(route: string, body: object) {
  const r = await fetch(url(route), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

/** One of Node's functions, run on the server: with a callback it's async, under `promises` it answers a promise. */
export function remoteFn(plugin: string, t: Target, path: string, async: boolean) {
  const f: Any = function (this: Any, ...args: Any[]) {
    if (new.target) { const r = callSync(plugin, t, path, args, { ctor: true }); if (r.err) throw errorFrom(r.err); return decode(r.ok, plugin) }
    let at = -1
    for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === "function") { at = i; break }
    if (at >= 0) {
      const cb = args[at]
      const sent = args.map((a, i) => (i === at ? Object.assign(() => {}, { $cb: 0 }) : a))
      callAsync(plugin, t, path, sent).then((r) => {
        if (r.err) return cb(errorFrom(r.err))
        cb(...(r.cb ?? []).map((x) => decode(x, plugin)))
      }, (e) => cb(e))
      return undefined
    }
    if (async) return callAsync(plugin, t, path, args).then((r) => { if (r.err) throw errorFrom(r.err); return decode(r.ok, plugin) })
    const r = callSync(plugin, t, path, args)
    if (r.err) throw errorFrom(r.err)
    const v = decode(r.ok, plugin)
    return r.promise ? Promise.resolve(v) : v
  }
  Object.defineProperty(f, "name", { value: path.split(".").pop() })
  return f
}

/** A module of Node's as the server has it: its functions run there, its values copied. */
// (a module's shape is the same for every plugin: asked of the server once)
const shapes = new Map<string, Answer>()
export function remoteModule(plugin: string, mod: string): Any {
  const r = shapes.get(mod) ?? callSync(plugin, { mod }, "", [], { get: true })
  if (r.err) throw errorFrom(r.err)
  shapes.set(mod, r)
  const build = (shape: Any, prefix: string): Any => {
    const out: Any = {}
    for (const [k, v] of Object.entries(shape ?? {})) {
      const p = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === "object" && "$fn" in (v as object)) out[k] = remoteFn(plugin, { mod }, p, mod.endsWith("/promises") || p.startsWith("promises."))
      else if (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).some((x) => x.startsWith("$"))) out[k] = build(v, p)
      else out[k] = decode(v, plugin)
    }
    return out
  }
  return build(r.ok, "")
}

// --- the socket: processes, watchers and servers send their events here, by the id each was given

const sockets = new Map<string, { ws: WebSocket; queue: string[]; on: Map<number, (m: Any) => void> }>()
let nextId = 1
export const newId = () => nextId++

export function socketOf(plugin: string) {
  let s = sockets.get(plugin)
  if (s && s.ws.readyState <= 1) return s
  const ws = new WebSocket(url(`socket?plugin=${encodeURIComponent(plugin)}`).replace(/^http/, "ws"))
  const made = { ws, queue: [] as string[], on: s?.on ?? new Map<number, (m: Any) => void>() }
  ws.onopen = () => { for (const m of made.queue.splice(0)) ws.send(m) }
  ws.onmessage = (e) => { let m: Any; try { m = JSON.parse(String(e.data)) } catch { return } made.on.get(m.id)?.(m) }
  ws.onclose = () => { for (const f of made.on.values()) f({ t: "error", err: { message: "the connection to the server closed", code: "ECONNRESET" } }) }
  sockets.set(plugin, made)
  return made
}
export function send(plugin: string, m: object) {
  const s = socketOf(plugin), text = JSON.stringify(m)
  if (s.ws.readyState === 1) s.ws.send(text); else s.queue.push(text)
}
export function listen(plugin: string, id: number, fn: (m: Any) => void) {
  socketOf(plugin).on.set(id, fn)
  return () => { sockets.get(plugin)?.on.delete(id) }
}

// --- the server's process as plugins see it (asked once)

let env: Any = null
export function envOf(plugin: string) {
  if (env) return env
  const x = new XMLHttpRequest()
  x.open("GET", url(`env?plugin=${encodeURIComponent(plugin)}`), false)
  x.send()
  if (x.status !== 200) throw new Error(`Node for ${plugin}: ${x.status} ${x.responseText.slice(0, 200)}`)
  env = JSON.parse(x.responseText)
  return env
}
