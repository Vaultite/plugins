// Node's modules that need no server: util, url, querystring, assert, string_decoder, timers, readline and the like,
// the same on every device.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from "../../lib/buffer.js"
import pathFor from "../../lib/path.js"
import { EventEmitter, inherits, streams } from "./events.ts"

type Any = any
export const Stream = streams(Buffer)

const custom = Symbol.for("nodejs.util.promisify.custom")
function promisify(f: Any) {
  if (f[custom]) return f[custom]
  const p = function (this: Any, ...a: Any[]) { return new Promise((ok, no) => f.call(this, ...a, (e: Any, ...v: Any[]) => (e ? no(e) : ok(v.length > 1 ? v : v[0])))) }
  Object.setPrototypeOf(p, Object.getPrototypeOf(f))
  return Object.defineProperties(p, Object.getOwnPropertyDescriptors(f))
}
promisify.custom = custom

function inspect(x: Any, opts?: Any): string {
  const seen = new WeakSet()
  const depth = opts?.depth ?? 2
  const go = (v: Any, d: number): string => {
    if (typeof v === "string") return d ? `'${v}'` : v
    if (typeof v === "function") return `[Function: ${v.name || "(anonymous)"}]`
    if (typeof v === "bigint") return `${v}n`
    if (v === null || typeof v !== "object") return String(v)
    if (v instanceof Error) return v.stack ?? String(v)
    if (v instanceof Date) return v.toISOString()
    if (seen.has(v)) return "[Circular]"
    seen.add(v)
    if (d > depth) return Array.isArray(v) ? "[Array]" : "[Object]"
    if (Array.isArray(v)) return `[ ${v.map((x) => go(x, d + 1)).join(", ")} ]`
    const ents = Object.entries(v).map(([k, x]) => `${k}: ${go(x, d + 1)}`)
    return ents.length ? `{ ${ents.join(", ")} }` : "{}"
  }
  return go(x, 0)
}
inspect.custom = Symbol.for("nodejs.util.inspect.custom")
inspect.defaultOptions = {}

function format(f?: Any, ...a: Any[]): string {
  if (typeof f !== "string") return [f, ...a].map((x) => inspect(x)).join(" ")
  let i = 0
  const out = f.replace(/%[sdifjoOc%]/g, (m) => {
    if (m === "%%") return "%"
    if (i >= a.length) return m
    const v = a[i++]
    return m === "%s" ? (typeof v === "string" ? v : inspect(v)) : m === "%d" || m === "%i" ? String(m === "%i" ? parseInt(v) : Number(v)) : m === "%f" ? String(parseFloat(v)) : m === "%j" ? JSON.stringify(v) : m === "%c" ? "" : inspect(v)
  })
  return [out, ...a.slice(i).map((x) => (typeof x === "string" ? x : inspect(x)))].join(" ")
}

const tag = (x: Any) => Object.prototype.toString.call(x)
const types = {
  isDate: (x: Any) => x instanceof Date, isRegExp: (x: Any) => x instanceof RegExp, isPromise: (x: Any) => x instanceof Promise,
  isNativeError: (x: Any) => x instanceof Error, isTypedArray: (x: Any) => ArrayBuffer.isView(x) && !(x instanceof DataView), isUint8Array: (x: Any) => x instanceof Uint8Array,
  isArrayBuffer: (x: Any) => x instanceof ArrayBuffer, isAnyArrayBuffer: (x: Any) => x instanceof ArrayBuffer || tag(x) === "[object SharedArrayBuffer]",
  isMap: (x: Any) => x instanceof Map, isSet: (x: Any) => x instanceof Set, isAsyncFunction: (x: Any) => tag(x) === "[object AsyncFunction]",
  isGeneratorFunction: (x: Any) => /GeneratorFunction/.test(tag(x)), isBoxedPrimitive: () => false, isProxy: () => false, isDataView: (x: Any) => x instanceof DataView,
  isWeakMap: (x: Any) => x instanceof WeakMap, isWeakSet: (x: Any) => x instanceof WeakSet, isArrayBufferView: (x: Any) => ArrayBuffer.isView(x),
}
function deepEqual(a: Any, b: Any): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (a instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Map || a instanceof Set) return deepEqual([...a], [...b])
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
}

export const util = {
  promisify, inspect, format, formatWithOptions: (_o: Any, ...a: Any[]) => format(...a), inherits, types, isDeepStrictEqual: deepEqual,
  callbackify: (f: Any) => (...a: Any[]) => { const cb = a.pop(); f(...a).then((v: Any) => cb(null, v), (e: Any) => cb(e)) },
  deprecate: (f: Any) => f, debuglog: () => Object.assign(() => {}, { enabled: false }), debug: () => Object.assign(() => {}, { enabled: false }),
  TextEncoder, TextDecoder, stripVTControlCharacters: (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""), toUSVString: (s: string) => s,
  isArray: Array.isArray, isString: (x: Any) => typeof x === "string", isNumber: (x: Any) => typeof x === "number", isFunction: (x: Any) => typeof x === "function",
  isObject: (x: Any) => x !== null && typeof x === "object", isBuffer: (x: Any) => Buffer.isBuffer(x), isDate: types.isDate, isRegExp: types.isRegExp, isError: types.isNativeError,
  isNullOrUndefined: (x: Any) => x == null, isUndefined: (x: Any) => x === undefined, isPrimitive: (x: Any) => x === null || (typeof x !== "object" && typeof x !== "function"),
  getSystemErrorName: (n: number) => `E${n}`, parseArgs: () => ({ values: {}, positionals: [] }), styleText: (_f: Any, s: string) => s,
  aborted: () => new Promise(() => {}), transferableAbortSignal: (s: Any) => s,
}

export class AssertionError extends Error {
  code = "ERR_ASSERTION"
  actual: Any; expected: Any; operator: string
  constructor(o: Any = {}) { super(o.message ?? `${inspect(o.actual)} ${o.operator ?? "=="} ${inspect(o.expected)}`); this.name = "AssertionError"; this.actual = o.actual; this.expected = o.expected; this.operator = o.operator }
}
const fail = (actual: Any, expected: Any, message: Any, operator: string) => { if (message instanceof Error) throw message; throw new AssertionError({ actual, expected, message, operator }) }
const assert: Any = (v: Any, m?: Any) => { if (!v) fail(v, true, m, "==") }
Object.assign(assert, {
  ok: assert, AssertionError, fail: (m?: Any) => fail(undefined, undefined, m ?? "Failed", "fail"),
  equal: (a: Any, b: Any, m?: Any) => { if (a != b) fail(a, b, m, "==") }, notEqual: (a: Any, b: Any, m?: Any) => { if (a == b) fail(a, b, m, "!=") },
  strictEqual: (a: Any, b: Any, m?: Any) => { if (!Object.is(a, b)) fail(a, b, m, "===") }, notStrictEqual: (a: Any, b: Any, m?: Any) => { if (Object.is(a, b)) fail(a, b, m, "!==") },
  deepEqual: (a: Any, b: Any, m?: Any) => { if (!deepEqual(a, b)) fail(a, b, m, "deepEqual") }, deepStrictEqual: (a: Any, b: Any, m?: Any) => { if (!deepEqual(a, b)) fail(a, b, m, "deepStrictEqual") },
  notDeepEqual: (a: Any, b: Any, m?: Any) => { if (deepEqual(a, b)) fail(a, b, m, "notDeepEqual") }, notDeepStrictEqual: (a: Any, b: Any, m?: Any) => { if (deepEqual(a, b)) fail(a, b, m, "notDeepStrictEqual") },
  throws: (f: Any, _e?: Any, m?: Any) => { try { f() } catch { return } fail(undefined, undefined, m ?? "Missing expected exception.", "throws") },
  doesNotThrow: (f: Any) => f(), rejects: async (p: Any) => { try { await (typeof p === "function" ? p() : p) } catch { return } fail(undefined, undefined, "Missing expected rejection.", "rejects") },
  doesNotReject: async (p: Any) => { await (typeof p === "function" ? p() : p) }, ifError: (e: Any) => { if (e !== null && e !== undefined) throw e },
  match: (s: string, r: RegExp, m?: Any) => { if (!r.test(s)) fail(s, r, m, "match") }, doesNotMatch: (s: string, r: RegExp, m?: Any) => { if (r.test(s)) fail(s, r, m, "doesNotMatch") },
})
assert.strict = assert

// --- url and querystring

const qsEscape = (s: string) => encodeURIComponent(s)
const qsUnescape = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")) } catch { return s } }
export const querystring = {
  escape: qsEscape, unescape: qsUnescape,
  parse(s: string, sep = "&", eq = "=", opts?: Any) {
    const out: Record<string, Any> = Object.create(null)
    if (typeof s !== "string" || !s) return out
    for (const part of s.split(sep).slice(0, opts?.maxKeys || undefined)) {
      if (!part) continue
      const i = part.indexOf(eq)
      const k = qsUnescape(i < 0 ? part : part.slice(0, i)), v = i < 0 ? "" : qsUnescape(part.slice(i + eq.length))
      out[k] = k in out ? [...(Array.isArray(out[k]) ? out[k] : [out[k]]), v] : v
    }
    return out
  },
  stringify(o: Any, sep = "&", eq = "=") {
    if (!o || typeof o !== "object") return ""
    const one = (v: Any) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "boolean" ? String(v) : "")
    return Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${qsEscape(k)}${eq}${qsEscape(one(x))}`)).join(sep)
  },
}
Object.assign(querystring, { decode: querystring.parse, encode: querystring.stringify })

function urlParse(u: string, parseQuery = false, slashes = false) {
  const out: Any = { protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null, hash: null, search: null, query: parseQuery ? {} : null, pathname: null, path: null, href: u }
  let rest = String(u).trim()
  const hash = rest.indexOf("#")
  if (hash >= 0) { out.hash = rest.slice(hash); rest = rest.slice(0, hash) }
  const q = rest.indexOf("?")
  if (q >= 0) { out.search = rest.slice(q); out.query = parseQuery ? querystring.parse(rest.slice(q + 1)) : rest.slice(q + 1); rest = rest.slice(0, q) } else if (parseQuery) out.query = {}
  const proto = /^([a-z][a-z0-9.+-]*:)/i.exec(rest)
  if (proto) { out.protocol = proto[1].toLowerCase(); rest = rest.slice(proto[1].length) }
  if (rest.startsWith("//") && (proto || slashes)) {
    out.slashes = true
    rest = rest.slice(2)
    const end = rest.search(/[/\\]/)
    let host = end < 0 ? rest : rest.slice(0, end)
    rest = end < 0 ? "" : rest.slice(end)
    const at = host.lastIndexOf("@")
    if (at >= 0) { out.auth = decodeURIComponent(host.slice(0, at)); host = host.slice(at + 1) }
    out.host = host.toLowerCase()
    const port = /:(\d*)$/.exec(host)
    if (port) { out.port = port[1] || null; host = host.slice(0, -port[0].length) }
    out.hostname = host.toLowerCase().replace(/^\[|\]$/g, "")
    if (!rest) rest = "/"
  }
  out.pathname = rest || null
  out.path = (out.pathname ?? "") + (out.search ?? "") || null
  return out
}
function urlFormat(o: Any) {
  if (typeof o === "string") return o
  if (o instanceof URL) return o.href
  const proto = o.protocol ? (o.protocol.endsWith(":") ? o.protocol : `${o.protocol}:`) : ""
  const host = o.host ?? (o.hostname ? `${o.hostname}${o.port ? `:${o.port}` : ""}` : "")
  const auth = o.auth ? `${encodeURIComponent(o.auth).replace(/%3A/i, ":")}@` : ""
  const search = o.search ?? (o.query && typeof o.query === "object" && Object.keys(o.query).length ? `?${querystring.stringify(o.query)}` : "")
  return `${proto}${o.slashes || host || /^(https?|ftp|file):$/.test(proto) ? "//" : ""}${auth}${host}${o.pathname ?? ""}${search}${o.hash ?? ""}`
}
export const url = {
  URL, URLSearchParams, parse: urlParse, format: urlFormat,
  resolve: (from: string, to: string) => { try { return new URL(to, new URL(from, "resolve://")).href.replace(/^resolve:\/\/\/?/, "") } catch { return to } },
  fileURLToPath: (u: string | URL) => decodeURIComponent(new URL(String(u)).pathname), pathToFileURL: (p: string) => new URL(`file://${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}`),
  domainToASCII: (d: string) => { try { return new URL(`http://${d}`).hostname } catch { return "" } }, domainToUnicode: (d: string) => d,
  urlToHttpOptions: (u: URL) => ({ protocol: u.protocol, hostname: u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: `${u.pathname}${u.search}`, href: u.href, port: u.port ? Number(u.port) : undefined }),
}

// --- the rest

export class StringDecoder {
  encoding: string
  private dec: TextDecoder | null
  constructor(enc = "utf8") { this.encoding = enc.toLowerCase().replace("-", ""); this.dec = this.encoding === "utf8" ? new TextDecoder("utf-8") : null }
  write(b: Any) { if (typeof b === "string") return b; return this.dec ? this.dec.decode(b, { stream: true }) : Buffer.from(b).toString(this.encoding) }
  end(b?: Any) { const s = b ? this.write(b) : ""; return this.dec ? s + this.dec.decode() : s }
}

// setImmediate as a message to ourselves: a timer's 4 ms floor would slow libraries that step through work with it.
const channel = new MessageChannel(), queued = new Map<number, () => void>()
let lastImmediate = 0
channel.port1.onmessage = (e) => { const f = queued.get(e.data); queued.delete(e.data); f?.() }
const immediate = (fn: Any, ...a: Any[]) => {
  const id = ++lastImmediate
  queued.set(id, () => fn(...a))
  channel.port2.postMessage(id)
  return { id, ref() { return this }, unref() { return this }, hasRef: () => true, [Symbol.toPrimitive]: () => id }
}
const clearImmediate = (h: Any) => { queued.delete(typeof h === "object" ? h?.id : h) }
export const timers = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: immediate, clearImmediate }
const timersPromises = {
  setTimeout: (ms?: number, v?: Any) => new Promise((ok) => setTimeout(ok, ms, v)),
  setImmediate: (v?: Any) => new Promise((ok) => immediate(ok, v)),
  async *setInterval(ms?: number, v?: Any) { for (;;) { await new Promise((ok) => setTimeout(ok, ms)); yield v } },
  scheduler: { wait: (ms: number) => new Promise((ok) => setTimeout(ok, ms)), yield: () => new Promise((ok) => setTimeout(ok, 0)) },
}

/** readline over a readable stream: its lines as 'line' events, and async iteration. */
function createInterface(o: Any, out?: Any) {
  const input = o?.input ?? o
  const rl: Any = new EventEmitter()
  let rest = "", closed = false
  const dec = new StringDecoder("utf8")
  const lines: string[] = [], waits: Any[] = []
  const line = (l: string) => { const w = waits.shift(); if (w) w({ value: l, done: false }); else lines.push(l); rl.emit("line", l) }
  rl.close = () => { if (closed) return; closed = true; if (rest) { line(rest); rest = "" } rl.emit("close"); for (const w of waits.splice(0)) w({ value: undefined, done: true }) }
  input?.on?.("data", (c: Any) => {
    rest += typeof c === "string" ? c : dec.write(c)
    const parts = rest.split(/\r?\n/)
    rest = parts.pop() ?? ""
    for (const p of parts) line(p)
  })
  input?.on?.("end", () => rl.close())
  input?.on?.("close", () => rl.close())
  rl.question = (_q: string, a: Any, b?: Any) => { (typeof a === "function" ? a : b)?.("") }
  rl.write = (s: string) => { out?.write?.(s) }
  rl.setPrompt = () => {}
  rl.prompt = () => {}
  rl.pause = () => rl
  rl.resume = () => rl
  rl.getPrompt = () => ""
  rl[Symbol.asyncIterator] = () => ({ next: () => (lines.length ? Promise.resolve({ value: lines.shift(), done: false }) : closed ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waits.push(r))), return: async () => { rl.close(); return { value: undefined, done: true } }, [Symbol.asyncIterator]() { return this } })
  return rl
}
const readline = { createInterface, Interface: EventEmitter, clearLine: () => true, cursorTo: () => true, moveCursor: () => true, clearScreenDown: () => true, emitKeypressEvents: () => {}, promises: { createInterface } }

class AsyncLocalStorage {
  private store: Any = undefined
  getStore() { return this.store }
  run(store: Any, fn: Any, ...a: Any[]) { const was = this.store; this.store = store; try { return fn(...a) } finally { this.store = was } }
  exit(fn: Any, ...a: Any[]) { return this.run(undefined, fn, ...a) }
  enterWith(store: Any) { this.store = store }
  disable() { this.store = undefined }
  static bind(fn: Any) { return fn }
  static snapshot() { return (fn: Any, ...a: Any[]) => fn(...a) }
}
class AsyncResource {
  type: string
  constructor(type: string) { this.type = type }
  runInAsyncScope(fn: Any, self?: Any, ...a: Any[]) { return fn.apply(self, a) }
  emitDestroy() { return this }
  bind(fn: Any) { return fn.bind(this) }
  asyncId() { return 0 }
  triggerAsyncId() { return 0 }
  static bind(fn: Any) { return fn }
}

const Script = class {
  code: string
  constructor(code: string) { this.code = code }
  runInContext(ctx: Any) { return new Function("__ctx", `with (__ctx) { return eval(${JSON.stringify(this.code)}) }`)(ctx) }
  runInNewContext(ctx: Any = {}) { return this.runInContext(ctx) }
  runInThisContext() { return (0, eval)(this.code) }
}
const vm = { Script, createContext: (o: Any = {}) => o, isContext: () => true, runInNewContext: (c: string, ctx?: Any) => new Script(c).runInNewContext(ctx), runInContext: (c: string, ctx: Any) => new Script(c).runInContext(ctx), runInThisContext: (c: string) => new Script(c).runInThisContext() }

const BUILTIN = ["assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "events", "fs", "http", "http2", "https", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib"]
export const builtin = (spec: string) => BUILTIN.includes(spec.replace(/^node:/, "").split("/")[0])

/** process as a browser has it (Obsidian's phones): no server's. */
export function browserProcess(): Any {
  const p: Any = new EventEmitter()
  return Object.assign(p, { title: "browser", browser: true, env: {}, argv: [], execArgv: [], version: "", versions: {}, platform: "browser", arch: "arm64", pid: 1, release: { name: "browser" },
    nextTick: (fn: Any, ...a: Any[]) => queueMicrotask(() => fn(...a)), cwd: () => "/", chdir: () => { throw new Error("process.chdir is not supported") }, umask: () => 0,
    hrtime: hrtime, uptime: () => performance.now() / 1000, memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), emitWarning: (w: Any) => console.warn(w),
    exit: () => {}, stdout: { write: (s: string) => { console.log(s); return true }, isTTY: false }, stderr: { write: (s: string) => { console.error(s); return true }, isTTY: false }, binding: () => { throw new Error("process.binding is not supported") } })
}
function hrtime(prev?: [number, number]) {
  const t = performance.now(), s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6)
  if (!prev) return [s, ns]
  let ds = s - prev[0], dns = ns - prev[1]
  if (dns < 0) { ds--; dns += 1e9 }
  return [ds, dns]
}
hrtime.bigint = () => BigInt(Math.floor(performance.now() * 1e6))

/** The modules here, for a plugin whose process is `proc` and whose require is `req`. */
export function pureModules(proc: Any, req: Any): Record<string, Any> {
  const path = pathFor(proc)
  path.posix = path
  path.win32 = path
  return {
    events: EventEmitter, stream: Stream, "stream/promises": Stream.promises, util, "util/types": types, assert, "assert/strict": assert, url, querystring,
    path, "path/posix": path, string_decoder: { StringDecoder }, buffer: { Buffer, SlowBuffer: Buffer, kMaxLength: 2 ** 31 - 1, constants: { MAX_LENGTH: 2 ** 31 - 1, MAX_STRING_LENGTH: 2 ** 29 }, Blob, atob, btoa, File: globalThis.File },
    timers, "timers/promises": timersPromises, readline, "readline/promises": readline.promises, tty: { isatty: () => false, ReadStream: Stream.Readable, WriteStream: Stream.Writable },
    module: { createRequire: () => req, builtinModules: BUILTIN, isBuiltin: builtin, Module: class Module {} },
    worker_threads: { isMainThread: true, parentPort: null, workerData: null, threadId: 0, Worker: class { constructor() { throw new Error("worker_threads aren't available to Obsidian plugins here") } }, MessageChannel, MessagePort, BroadcastChannel },
    async_hooks: { AsyncLocalStorage, AsyncResource, createHook: () => ({ enable() { return this }, disable() { return this } }), executionAsyncId: () => 0, triggerAsyncId: () => 0, executionAsyncResource: () => ({}) },
    punycode: { toASCII: url.domainToASCII, toUnicode: (d: string) => d, encode: (s: string) => s, decode: (s: string) => s, ucs2: { decode: (s: string) => [...s].map((c) => c.codePointAt(0)), encode: (a: number[]) => String.fromCodePoint(...a) } },
    vm, perf_hooks: { performance, PerformanceObserver: globalThis.PerformanceObserver, monitorEventLoopDelay: () => ({ enable() {}, disable() {}, percentile: () => 0 }) },
    process: proc, console, diagnostics_channel: { channel: () => ({ hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() {} }), hasSubscribers: () => false, subscribe() {}, unsubscribe() {}, tracingChannel: () => ({ hasSubscribers: false, traceSync: (f: Any, _c: Any, t: Any, ...a: Any[]) => f.apply(t, a), tracePromise: (f: Any, _c: Any, t: Any, ...a: Any[]) => f.apply(t, a) }) },
  }
}
export { hrtime }
