// Node's modules that reach the server's machine (fs, child_process, os, crypto, zlib, http…), for plugins on computers;
// any other of Node's modules is the server's own, called through the bridge.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from "../../lib/buffer.js"
import { EventEmitter, inherits } from "./events.ts"
import { browserProcess, Stream, util } from "./pure.ts"
import { Dirent, envOf, errorFrom, listen, newId, post, remoteModule, send, Stats } from "./wire.ts"

type Any = any
const isA = (o: Any, C: Any): boolean => o instanceof C
const make = (C: Any, ...a: Any[]): Any => Reflect.construct(C, a)
const { Readable, Writable, Transform, Duplex } = Stream

// (the desktop app's own Electron; on the web, the one it ships, as current as Obsidian's installer)
const ELECTRON = (/Electron\/([\d.]+)/.exec(navigator.userAgent) ?? [])[1] ?? "44.5.0"

/** process as Obsidian's desktop app has it: the server's platform, environment and versions, the vault as its cwd. */
export function serverProcess(plugin: string): Any {
  const env = envOf(plugin)
  const p = browserProcess()
  const user = env.os.userInfo ?? {}
  return Object.assign(p, { title: "obsidian", browser: false, env: { ...env.env }, argv: [env.execPath], execPath: env.execPath, version: env.version,
    versions: { ...env.versions, electron: ELECTRON, chrome: (/Chrome\/([\d.]+)/.exec(navigator.userAgent) ?? [])[1] ?? "" }, platform: env.platform, arch: env.arch,
    pid: env.pid, ppid: env.ppid, release: { name: "node" }, cwd: () => env.cwd, type: "renderer", config: { variables: {} }, features: {},
    getuid: () => user.uid ?? 0, getgid: () => user.gid ?? 0, geteuid: () => user.uid ?? 0, getegid: () => user.gid ?? 0, umask: () => 0o22 })
}

// --- fs: the server's files; streams and watchers over the socket

function fsModule(plugin: string): Any {
  const fs = remoteModule(plugin, "fs")
  fs.Stats = Stats
  fs.Dirent = Dirent
  fs.realpathSync.native = fs.realpathSync
  fs.realpath.native = fs.realpath
  fs.createReadStream = (p: Any, opts: Any = {}) => {
    const o = typeof opts === "string" ? { encoding: opts } : opts
    const r = new Readable({ encoding: o.encoding })
    Object.assign(r, { path: p, bytesRead: 0, pending: true, close: (cb?: Any) => { r.destroy(); cb?.() } })
    fs.readFile(p, (e: Any, b: Any) => {
      if (e) return r.destroy(e)
      const part = o.start !== undefined || o.end !== undefined ? b.subarray(o.start ?? 0, o.end === undefined ? undefined : o.end + 1) : b
      r.bytesRead = part.length
      r.pending = false
      r.emit("open", 0)
      r.emit("ready")
      r.push(part)
      r.push(null)
    })
    return r
  }
  fs.createWriteStream = (p: Any, opts: Any = {}) => {
    const o = typeof opts === "string" ? { encoding: opts } : opts
    let first = !String(o.flags ?? "w").startsWith("a")
    const w = new Writable({ write(chunk: Any, _e: Any, cb: Any) { const f = first ? "writeFile" : "appendFile"; first = false; w.bytesWritten += chunk.length; fs[f](p, chunk, (e: Any) => cb(e ?? undefined)) },
      final(cb: Any) { if (first) { first = false; fs.writeFile(p, "", (e: Any) => cb(e ?? undefined)) } else cb() } })
    Object.assign(w, { path: p, bytesWritten: 0, pending: false, close: (cb?: Any) => w.end(cb) })
    queueMicrotask(() => { w.emit("open", 0); w.emit("ready") })
    return w
  }
  fs.watch = (p: string, opts: Any, fn?: Any) => {
    if (typeof opts === "function") { fn = opts; opts = {} }
    const id = newId(), w: Any = new EventEmitter()
    if (fn) w.on("change", fn)
    const stop = listen(plugin, id, (m) => { if (m.t === "change") w.emit("change", m.event, m.filename); else if (m.t === "error") w.emit("error", errorFrom(m.err)) })
    send(plugin, { t: "watch", id, path: p, opts: { recursive: !!opts?.recursive } })
    w.close = () => { send(plugin, { t: "unwatch", id }); stop(); w.emit("close") }
    w.ref = w.unref = () => w
    return w
  }
  fs.promises.watch = (p: string, opts: Any = {}) => {
    const queue: Any[] = [], waits: Any[] = []
    let done = false
    const w = fs.watch(p, opts, (eventType: string, filename: string) => { const ev = { eventType, filename }; const r = waits.shift(); if (r) r({ value: ev, done: false }); else queue.push(ev) })
    const end = () => { if (done) return; done = true; w.close(); for (const r of waits.splice(0)) r({ value: undefined, done: true }) }
    opts.signal?.addEventListener?.("abort", end)
    return { [Symbol.asyncIterator]() { return this }, next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waits.push(r))), return: async () => { end(); return { value: undefined, done: true } } }
  }
  const polls = new Map<string, { timer: ReturnType<typeof setInterval>; fns: Any[] }>()
  fs.watchFile = (p: string, opts: Any, fn?: Any) => {
    if (typeof opts === "function") { fn = opts; opts = {} }
    const had = polls.get(p)
    if (had) { had.fns.push(fn); return }
    const empty = new Stats({}, "other")
    let prev: Any = null
    const tick = () => fs.stat(p, (e: Any, s: Any) => {
      const now = e ? empty : s
      if (prev && now.mtimeMs !== prev.mtimeMs) for (const f of polls.get(p)?.fns ?? []) f(now, prev)
      prev = now
    })
    tick()
    polls.set(p, { timer: setInterval(tick, opts?.interval ?? 5007), fns: [fn] })
  }
  fs.unwatchFile = (p: string, fn?: Any) => {
    const had = polls.get(p)
    if (!had) return
    had.fns = fn ? had.fns.filter((f) => f !== fn) : []
    if (!had.fns.length) { clearInterval(had.timer); polls.delete(p) }
  }
  return fs
}

// --- child_process: processes on the server, their output streamed back

function childProcess(plugin: string): Any {
  const remote = remoteModule(plugin, "child_process")
  const ChildProcess: Any = function ChildProcess(this: Any) { EventEmitter.call(this) }
  inherits(ChildProcess, EventEmitter)
  const plain = (o: Any) => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => !["stdio", "signal"].includes(k) && typeof v !== "function" && v !== undefined))
  function spawn(cmd: string, args?: Any, opts?: Any) {
    if (!Array.isArray(args)) { opts = args; args = [] }
    const id = newId(), cp: Any = new ChildProcess()
    cp.stdout = new Readable()
    cp.stderr = new Readable()
    cp.stdin = new Writable({ write(c: Any, _e: Any, cb: Any) { send(plugin, { t: "stdin", id, data: Buffer.from(c).toString("base64") }); cb() }, final(cb: Any) { send(plugin, { t: "stdin-end", id }); cb() } })
    // (its pipes past the first three, fd 3 on: both ways, as Node's are)
    const spec: string[] = (Array.isArray(opts?.stdio) ? opts.stdio : []).map((s: Any) => (s === "pipe" || s === "overlapped" ? "pipe" : "ignore"))
    const extra = spec.map((s, fd) => (fd < 3 || s !== "pipe" ? null : new Duplex({
      read() {}, write(c: Any, _e: Any, cb: Any) { send(plugin, { t: "stdin", id, fd, data: Buffer.from(c).toString("base64") }); cb() }, final(cb: Any) { send(plugin, { t: "stdin-end", id, fd }); cb() } })))
    Object.assign(cp, { stdio: [cp.stdin, cp.stdout, cp.stderr, ...extra.slice(3)], pid: undefined, exitCode: null, signalCode: null, killed: false, connected: false, spawnfile: cmd, spawnargs: [cmd, ...args],
      kill: (signal?: string) => { send(plugin, { t: "kill", id, signal }); cp.killed = true; return true }, ref: () => cp, unref: () => cp, disconnect: () => {} })
    const stop = listen(plugin, id, (m) => {
      if (m.t === "spawned") { cp.pid = m.pid; cp.emit("spawn") }
      else if (m.t === "out") (m.fd > 2 ? extra[m.fd] : m.fd === 2 ? cp.stderr : cp.stdout)?.push(Buffer.from(m.data, "base64"))
      else if (m.t === "error") { const e = errorFrom(m.err); cp.emit("error", e); if (cp.exitCode === null && !cp.pid) { stop(); cp.stdout.push(null); cp.stderr.push(null) } }
      else if (m.t === "exit") {
        stop()
        cp.exitCode = m.code
        cp.signalCode = m.signal
        cp.emit("exit", m.code, m.signal)
        cp.stdout.push(null)
        cp.stderr.push(null)
        for (const s of extra) s?.push(null)
        // (once what it printed has reached its listeners, as Node's close follows its pipes closing)
        setTimeout(() => cp.emit("close", m.code, m.signal), 0)
      }
    })
    send(plugin, { t: "spawn", id, cmd, args: args.map(String), opts: plain(opts), stdio: spec.length > 3 ? spec : undefined })
    return cp
  }
  // exec and execFile: the whole output, to a callback (or, promisified, as { stdout, stderr })
  const collect = (cp: Any, what: string, opts: Any, cb?: Any) => {
    const out: Any[] = [], err: Any[] = []
    cp.stdout.on("data", (c: Any) => out.push(c))
    cp.stderr.on("data", (c: Any) => err.push(c))
    const enc = opts?.encoding ?? "utf8"
    const text = (l: Any[]) => (enc === "buffer" || enc === null ? Buffer.concat(l) : Buffer.concat(l).toString(enc))
    let done = false
    cp.on("error", (e: Any) => { if (!done) { done = true; cb?.(e, text(out), text(err)) } })
    cp.on("close", (code: number, signal: string) => {
      if (done) return
      done = true
      const stdout = text(out), stderr = text(err)
      const e = code === 0 ? null : Object.assign(new Error(`Command failed: ${what}\n${stderr}`), { code, signal, killed: cp.killed, cmd: what, stdout, stderr })
      cb?.(e, stdout, stderr)
    })
    return cp
  }
  function exec(cmd: string, opts?: Any, cb?: Any) {
    if (typeof opts === "function") { cb = opts; opts = {} }
    return collect(spawn(cmd, [], { ...opts, shell: opts?.shell ?? true }), cmd, opts, cb)
  }
  function execFile(file: string, args?: Any, opts?: Any, cb?: Any) {
    if (typeof args === "function") { cb = args; args = []; opts = {} } else if (!Array.isArray(args)) { cb = opts; opts = args; args = [] }
    if (typeof opts === "function") { cb = opts; opts = {} }
    return collect(spawn(file, args ?? [], opts), [file, ...(args ?? [])].join(" "), opts, cb)
  }
  const promised = (f: Any) => (...a: Any[]) => new Promise((ok, no) => { f(...a, (e: Any, stdout: Any, stderr: Any) => (e ? no(Object.assign(e, { stdout, stderr })) : ok({ stdout, stderr }))) })
  ;(exec as Any)[util.promisify.custom] = promised(exec)
  ;(execFile as Any)[util.promisify.custom] = promised(execFile)
  const fork = () => { throw new Error("child_process.fork isn't available to Obsidian plugins here: use spawn") }
  return { ...remote, spawn, exec, execFile, fork, ChildProcess }
}

// --- http and https: requests made by the server; servers listening there, their requests answered here

function httpModule(plugin: string, tls: boolean): Any {
  const IncomingMessage: Any = function IncomingMessage(this: Any, socket?: Any) {
    Readable.call(this)
    Object.assign(this, { headers: {}, rawHeaders: [], trailers: {}, method: undefined, url: "", statusCode: undefined, statusMessage: "", httpVersion: "1.1", httpVersionMajor: 1, httpVersionMinor: 1, complete: false, aborted: false })
    this.socket = this.connection = socket ?? { remoteAddress: "127.0.0.1", encrypted: tls, destroy() {}, setTimeout() {}, on() {}, once() {}, removeListener() {} }
  }
  inherits(IncomingMessage, Readable)
  IncomingMessage.prototype.setTimeout = function (this: Any) { return this }
  const fill = (msg: Any, headers: Any, body: string) => {
    msg.headers = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    msg.rawHeaders = Object.entries(headers ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? v.flatMap((x) => [k, x]) : [k, String(v)]))
    msg.complete = true
    if (body) msg.push(Buffer.from(body, "base64"))
    msg.push(null)
  }

  const OutgoingMessage: Any = function OutgoingMessage(this: Any) { Writable.call(this); this._headers = {}; this.headersSent = false }
  inherits(OutgoingMessage, Writable)
  const O = OutgoingMessage.prototype
  O.setHeader = function (this: Any, k: string, v: Any) { this._headers[k.toLowerCase()] = [k, v]; return this }
  O.getHeader = function (this: Any, k: string) { return this._headers[k.toLowerCase()]?.[1] }
  O.getHeaders = function (this: Any) { return Object.fromEntries(Object.values(this._headers as Record<string, [string, Any]>).map(([k, v]) => [k.toLowerCase(), v])) }
  O.getHeaderNames = function (this: Any) { return Object.keys(this._headers) }
  O.hasHeader = function (this: Any, k: string) { return k.toLowerCase() in this._headers }
  O.removeHeader = function (this: Any, k: string) { delete this._headers[k.toLowerCase()] }
  O.flushHeaders = function () {}
  O.setTimeout = function (this: Any) { return this }
  O.headersOut = function (this: Any) { return Object.fromEntries(Object.values(this._headers as Record<string, [string, Any]>)) }

  const ServerResponse: Any = function ServerResponse(this: Any, req: Any, rid: string) {
    OutgoingMessage.call(this)
    Object.assign(this, { req, statusCode: 200, statusMessage: "", sendDate: true, finished: false, socket: req.socket, connection: req.socket, _rid: rid, _sent: false })
  }
  inherits(ServerResponse, OutgoingMessage)
  const S = ServerResponse.prototype
  S.writeHead = function (this: Any, status: number, msg?: Any, headers?: Any) {
    if (typeof msg === "object") { headers = msg; msg = undefined }
    this.statusCode = status
    if (msg) this.statusMessage = msg
    if (Array.isArray(headers)) for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1])
    else for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v)
    return this
  }
  S._head = function (this: Any) { if (this._sent) return {}; this._sent = true; this.headersSent = true; return { head: true, status: this.statusCode, message: this.statusMessage || undefined, headers: this.headersOut() } }
  S._write = function (this: Any, c: Any, _e: Any, cb: Any) { send(plugin, { t: "res", rid: this._rid, ...this._head(), data: Buffer.from(c).toString("base64") }); cb() }
  S._final = function (this: Any, cb: Any) { send(plugin, { t: "res", rid: this._rid, ...this._head(), end: true }); this.finished = true; cb() }
  S.writeContinue = S.writeProcessing = S.addTrailers = function () {}
  S.assignSocket = S.detachSocket = function () {}

  const Server: Any = function Server(this: Any, opts?: Any, handler?: Any) {
    if (!isA(this, Server)) return make(Server, opts, handler)
    EventEmitter.call(this)
    if (typeof opts === "function") { handler = opts; opts = {} }
    this._opts = opts ?? {}
    this.listening = false
    this._id = newId()
    if (handler) this.on("request", handler)
  }
  inherits(Server, EventEmitter)
  Server.prototype.listen = function (this: Any, ...a: Any[]) {
    const cb = typeof a[a.length - 1] === "function" ? a.pop() : null
    const o = typeof a[0] === "object" && a[0] ? a[0] : { port: a[0], host: typeof a[1] === "string" ? a[1] : undefined }
    if (cb) this.once("listening", cb)
    this._stop = listen(plugin, this._id, (m) => {
      if (m.t === "listening") { this.listening = true; this._address = { address: o.host ?? "127.0.0.1", family: "IPv4", ...m.address }; this.emit("listening") }
      else if (m.t === "error") this.emit("error", errorFrom(m.err))
      else if (m.t === "closed") { this.listening = false; this.emit("close") }
      else if (m.t === "req") {
        const req = new IncomingMessage({ remoteAddress: m.remote, encrypted: tls, destroy() {}, setTimeout() {}, setNoDelay() {}, setKeepAlive() {}, on() {}, once() {}, removeListener() {} })
        Object.assign(req, { method: m.method, url: m.url, httpVersion: m.httpVersion })
        fill(req, m.headers, m.body)
        const res = new ServerResponse(req, m.rid)
        this.emit("request", req, res)
      }
    })
    const key = this._opts.key, cert = this._opts.cert
    send(plugin, { t: "listen", id: this._id, port: Number(o.port ?? 0), host: o.host, tls: tls ? { key: key && String(key), cert: cert && String(cert) } : undefined })
    return this
  }
  Server.prototype.close = function (this: Any, cb?: Any) { if (cb) this.once("close", cb); send(plugin, { t: "close", id: this._id }); return this }
  Server.prototype.address = function (this: Any) { return this._address ?? null }
  Server.prototype.setTimeout = Server.prototype.ref = Server.prototype.unref = function (this: Any) { return this }
  Server.prototype.closeAllConnections = Server.prototype.closeIdleConnections = function () {}

  const ClientRequest: Any = function ClientRequest(this: Any, href: string, o: Any, cb?: Any) {
    OutgoingMessage.call(this)
    const chunks: Any[] = []
    Object.assign(this, { method: (o.method ?? "GET").toUpperCase(), path: o.path, host: o.hostname ?? o.host, protocol: o.protocol, aborted: false, reusedSocket: false })
    for (const [k, v] of Object.entries(o.headers ?? {})) this.setHeader(k, v)
    if (cb) this.once("response", cb)
    this._write = (c: Any, _e: Any, done: Any) => { chunks.push(Buffer.from(c)); done() }
    this._final = (done: Any) => {
      this.headersSent = true
      post("http", { plugin, url: href, method: this.method, headers: this.headersOut(), body: chunks.length ? Buffer.concat(chunks).toString("base64") : undefined, insecure: o.rejectUnauthorized === false })
        .then((r: Any) => {
          if (r.err) throw errorFrom(r.err)
          const res = new IncomingMessage()
          Object.assign(res, { statusCode: r.status, statusMessage: r.message ?? "" })
          this.res = res
          this.emit("response", res)
          fill(res, r.headers, r.body)
        })
        .catch((e: Any) => this.emit("error", e))
      done()
    }
  }
  inherits(ClientRequest, OutgoingMessage)
  ClientRequest.prototype.abort = ClientRequest.prototype.destroy = function (this: Any) { this.aborted = true; return this }
  ClientRequest.prototype.setNoDelay = ClientRequest.prototype.setSocketKeepAlive = function () {}

  const optionsOf = (a: Any, b: Any, cb: Any) => {
    if (typeof b === "function") { cb = b; b = {} }
    let o: Any
    if (typeof a === "string" || a instanceof URL) { const u = new URL(String(a)); o = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, auth: u.username ? `${u.username}:${u.password}` : undefined, ...b } }
    else o = { ...a, ...b }
    const proto = o.protocol ?? (tls ? "https:" : "http:")
    const host = o.hostname ?? (o.host ?? "localhost").replace(/:\d+$/, "")
    const href = `${proto}//${host.includes(":") ? `[${host}]` : host}${o.port ? `:${o.port}` : ""}${o.path ?? "/"}`
    if (o.auth) o.headers = { authorization: `Basic ${btoa(o.auth)}`, ...o.headers }
    return { href, o, cb }
  }
  const request = (a: Any, b?: Any, c?: Any) => { const { href, o, cb } = optionsOf(a, b, c); return make(ClientRequest, href, o, cb) }
  const get = (a: Any, b?: Any, c?: Any) => { const r = request(a, b, c); r.end(); return r }
  const Agent: Any = function Agent(this: Any, o?: Any) { EventEmitter.call(this); this.options = o ?? {}; this.maxSockets = Infinity; this.sockets = {}; this.requests = {} }
  inherits(Agent, EventEmitter)
  Agent.prototype.destroy = function () {}
  const STATUS_CODES: Record<number, string> = { 100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" }
  const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"]
  return { request, get, createServer: (o?: Any, h?: Any) => new Server(o, h), Server, IncomingMessage, ServerResponse, OutgoingMessage, ClientRequest, Agent,
    globalAgent: new Agent(), STATUS_CODES, METHODS, maxHeaderSize: 16384, validateHeaderName: () => {}, validateHeaderValue: () => {} }
}

// --- the rest: the server's own, with what's cheap or needs a stream done here

function osModule(plugin: string) {
  const os = remoteModule(plugin, "os"), s = envOf(plugin).os
  return Object.assign(os, { EOL: s.EOL, platform: () => s.platform, type: () => s.type, release: () => s.release, arch: () => s.arch, homedir: () => s.homedir,
    tmpdir: () => s.tmpdir, hostname: () => s.hostname, endianness: () => s.endianness, machine: () => s.machine, version: () => s.version, availableParallelism: () => s.cpus })
}

function cryptoModule(plugin: string) {
  const c = remoteModule(plugin, "crypto"), hash = c.createHash, hmac = c.createHmac
  const batched = (make: () => Any) => {
    const chunks: Any[] = []
    const h: Any = { update(d: Any, enc?: string) { chunks.push(typeof d === "string" ? Buffer.from(d, enc as Any) : Buffer.from(d)); return h },
      digest(enc?: string) { const r = make(); r.update(Buffer.concat(chunks)); return r.digest(enc) }, copy() { const x = batched(make); for (const ch of chunks) x.update(ch); return x } }
    return h
  }
  const random = (n: number) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)))
  return Object.assign(c, {
    createHash: (algo: string, o?: Any) => batched(() => hash(algo, o)), createHmac: (algo: string, key: Any, o?: Any) => batched(() => hmac(algo, key, o)),
    randomBytes: (n: number, cb?: Any) => { const b = random(n); if (cb) { queueMicrotask(() => cb(null, b)); return undefined } return b },
    randomFillSync: (b: Any) => { globalThis.crypto.getRandomValues(new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength)); return b },
    randomUUID: () => globalThis.crypto.randomUUID(), getRandomValues: (a: Any) => globalThis.crypto.getRandomValues(a),
    randomInt: (a: number, b?: number) => { const [lo, hi] = b === undefined ? [0, a] : [a, b]; return lo + Math.floor(Math.random() * (hi - lo)) },
    webcrypto: globalThis.crypto, subtle: globalThis.crypto.subtle,
  })
}

function zlibModule(plugin: string) {
  const z = remoteModule(plugin, "zlib")
  // (a stream of it: the whole input, then the server's sync function over it)
  for (const k of Object.keys(z)) {
    const sync = /^create(\w+)$/.exec(k)?.[1]
    const fn = sync && z[`${sync[0].toLowerCase()}${sync.slice(1)}Sync`]
    if (!fn) continue
    z[k] = (opts?: Any) => {
      const chunks: Any[] = []
      return make(Transform, { transform(c: Any, _e: Any, cb: Any) { chunks.push(Buffer.from(c)); cb() }, flush(cb: Any) { try { cb(null, fn(Buffer.concat(chunks), opts)) } catch (e) { cb(e) } } })
    }
  }
  return z
}

function noSockets(plugin: string, mod: string) {
  const m = remoteModule(plugin, mod)
  const no = (what: string) => () => { throw new Error(`${mod}.${what}: network sockets aren't available to Obsidian plugins here`) }
  for (const k of ["connect", "createConnection", "createServer", "Socket", "Server", "createSocket", "TLSSocket"]) if (k in m) m[k] = no(k)
  return m
}

/** Electron's BrowserWindow for a page a plugin opens: a hidden one is read by the server (its title, no scripts run);
 *  a shown one (a login) opens in a browser tab. */
function browserWindow() {
  return function BrowserWindow(this: Any, o: Any = {}) {
    const ev = new EventEmitter(), wcEv = new EventEmitter()
    let url = "", title = "", gone = false
    const contents: Any = Object.assign(wcEv, { getTitle: () => title, getURL: () => url, setAudioMuted() {}, isDestroyed: () => gone, session: { clearCache: async () => {} },
      executeJavaScript: async () => { throw new Error("pages opened by plugins here run no scripts") }, loadURL: (u: string) => self.loadURL(u) })
    const self: Any = Object.assign(ev, { webContents: contents, isDestroyed: () => gone, destroy() { gone = true }, close() { gone = true; ev.emit("closed") }, show() { window.open(url, "_blank") }, hide() {}, focus() {},
      async loadURL(u: string) {
        url = u
        if (o.show !== false) { window.open(u, "_blank"); wcEv.emit("did-finish-load", {}); return }
        try {
          const r = await fetch(new URL("api/plugin-compat/request", document.baseURI), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u, method: "GET", headers: {} }) }).then((x) => x.json())
          const html = new TextDecoder().decode(Uint8Array.from(atob(r.body ?? ""), (c) => c.charCodeAt(0)))
          title = new DOMParser().parseFromString(html, "text/html").title || ""
          wcEv.emit(r.status < 400 ? "did-finish-load" : "did-fail-load", {})
        } catch (e) { wcEv.emit("did-fail-load", e) }
      } })
    return self
  }
}

function electronModule(plugin: string, proc: Any, cp: () => Any) {
  const env = envOf(plugin)
  let clip = ""
  const run = (cmd: string, args: string[]) => new Promise((ok) => cp().execFile(cmd, args, (e: Any) => ok(e ? String(e.message) : "")))
  const opener = env.platform === "darwin" ? "open" : env.platform === "win32" ? "explorer" : "xdg-open"
  const shell = {
    openExternal: async (u: string) => { window.open(u, "_blank") }, openPath: (p: string) => run(opener, [p]),
    showItemInFolder: (p: string) => { void run(env.platform === "darwin" ? "open" : opener, env.platform === "darwin" ? ["-R", p] : [p.replace(/\/[^/]*$/, "")]) },
    trashItem: async (p: string) => { if (env.platform !== "darwin") throw new Error("trashItem: only on a Mac here"); await run("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(p)}`]) },
    beep: () => {}, readShortcutLink: () => ({}), writeShortcutLink: () => false,
  }
  const image = { isEmpty: () => true, toPNG: () => Buffer.alloc(0), toJPEG: () => Buffer.alloc(0), toDataURL: () => "", getSize: () => ({ width: 0, height: 0 }) }
  const clipboard = { writeText: (t: string) => { clip = t; void navigator.clipboard?.writeText(t).catch(() => {}) }, readText: () => clip, writeHTML: (h: string) => { clip = h }, readHTML: () => "",
    readImage: () => image, writeImage: () => {}, availableFormats: () => (clip ? ["text/plain"] : []), has: () => false, clear: () => { clip = "" }, write: (o: Any) => { if (o?.text) clipboard.writeText(o.text) }, readRTF: () => "", readBookmark: () => ({ title: "", url: "" }) }
  const contents: Any = { id: 1, printToPDF: async () => { throw new Error("printing to PDF isn't available to Obsidian plugins here") }, openDevTools() {}, closeDevTools() {}, isDevToolsOpened: () => false,
    on() { return contents }, once() { return contents }, removeListener() { return contents }, getZoomFactor: () => 1, setZoomFactor() {}, executeJavaScript: async (c: string) => (0, eval)(c), session: { clearCache: async () => {} }, getURL: () => location.href, send() {} }
  const win: Any = { id: 1, webContents: contents, isMaximized: () => false, isFullScreen: () => false, isMinimized: () => false, isFocused: () => document.hasFocus(), isAlwaysOnTop: () => false, isDestroyed: () => false,
    on() { return win }, once() { return win }, off() { return win }, removeListener() { return win }, setAlwaysOnTop() {}, focus() {}, show() {}, hide() {}, minimize() {}, maximize() {}, unmaximize() {}, close() {}, setTitle() {}, setFullScreen() {},
    getBounds: () => ({ x: window.screenX, y: window.screenY, width: innerWidth, height: innerHeight }), getSize: () => [innerWidth, innerHeight], setBounds() {}, setSize() {}, getTitle: () => document.title }
  const home = env.os.homedir
  const paths: Record<string, string> = { home, appData: `${home}/Library/Application Support`, userData: `${home}/Library/Application Support/obsidian`, temp: env.os.tmpdir, desktop: `${home}/Desktop`, documents: `${home}/Documents`, downloads: `${home}/Downloads`, music: `${home}/Music`, pictures: `${home}/Pictures`, videos: `${home}/Movies`, exe: env.execPath, logs: env.os.tmpdir }
  // (the desktop app's own dialogs when it has them; in a browser, the path typed, on the vault's machine)
  const native = (window as Any).vaultite?.dialogSync as ((k: string, o: Any) => Any) | undefined
  const opts = (a: Any, b?: Any) => (b ?? (a && !a.webContents ? a : {})) ?? {}
  const typed = (o: Any, what: string) => { const p = prompt(`${o.title ?? o.message ?? what} (a path on the vault's machine)`, o.defaultPath ?? home); return p ? p.trim() : null }
  const openSync = (a: Any, b?: Any) => { const o = opts(a, b); const r = native ? native("open", o) : typed(o, "Open"); return r ? (Array.isArray(r) ? r : [r]) : undefined }
  const saveSync = (a: Any, b?: Any) => { const o = opts(a, b); return (native ? native("save", o) : typed(o, "Save as")) ?? undefined }
  const messageSync = (a: Any, b?: Any) => {
    const o = opts(a, b)
    if (native) return native("message", o) ?? 0
    const buttons: string[] = o.buttons ?? ["OK"]
    return buttons.length < 2 || confirm([o.message, o.detail].filter(Boolean).join("\n\n")) ? (o.defaultId ?? 0) : (o.cancelId ?? buttons.length - 1)
  }
  const dialog = {
    showOpenDialogSync: openSync, showSaveDialogSync: saveSync, showMessageBoxSync: messageSync,
    showOpenDialog: async (a: Any, b?: Any) => { const r = openSync(a, b); return { canceled: !r, filePaths: r ?? [] } },
    showSaveDialog: async (a: Any, b?: Any) => { const r = saveSync(a, b); return { canceled: !r, filePath: r } },
    showMessageBox: async (a: Any, b?: Any) => ({ response: messageSync(a, b), checkboxChecked: false }),
    showErrorBox: (t: string, c: string) => { if (native) native("message", { type: "error", message: t, detail: c }); else alert(`${t}\n\n${c}`) },
  }
  const app = { getPath: (n: string) => paths[n] ?? home, getVersion: () => "1.13.1", getName: () => "Obsidian", getAppPath: () => "", getLocale: () => navigator.language, isPackaged: true, on() {}, quit() {}, relaunch() {} }
  const ipcRenderer: Any = { send() {}, sendSync: () => undefined, invoke: async () => undefined, on: () => ipcRenderer, once: () => ipcRenderer, off: () => ipcRenderer, removeListener: () => ipcRenderer, removeAllListeners: () => ipcRenderer }
  const MenuClass: Any = function Menu(this: Any) { this.items = [] }
  MenuClass.prototype.append = function (this: Any, i: Any) { this.items.push(i) }
  MenuClass.prototype.popup = function () {}
  MenuClass.buildFromTemplate = (t: Any[]) => Object.assign(new MenuClass(), { items: t })
  const remote = { app, dialog, shell, clipboard, process: proc, getCurrentWindow: () => win, getCurrentWebContents: () => contents, BrowserWindow: Object.assign(browserWindow(), { getFocusedWindow: () => win, getAllWindows: () => [win], fromWebContents: () => win }),
    nativeTheme: { get shouldUseDarkColors() { return matchMedia("(prefers-color-scheme: dark)").matches }, on() {}, themeSource: "system" }, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: screen.width, height: screen.height }, scaleFactor: devicePixelRatio }), getAllDisplays: () => [] },
    Menu: MenuClass, MenuItem: function MenuItem(this: Any, o: Any) { Object.assign(this, o) }, session: { defaultSession: { clearCache: async () => {}, webRequest: { onBeforeSendHeaders() {}, onHeadersReceived() {} } } }, net: { request: () => { throw new Error("electron.net isn't available here") } }, require: () => ({}) }
  return { shell, clipboard, ipcRenderer, remote, webFrame: { setZoomFactor() {}, getZoomFactor: () => 1, setVisualZoomLevelLimits() {}, insertCSS: () => "" }, webUtils: { getPathForFile: (f: Any) => f?.path ?? "" },
    nativeImage: { createFromPath: () => image, createFromDataURL: () => image, createFromBuffer: () => image, createEmpty: () => image }, contextBridge: { exposeInMainWorld() {} } }
}

/** Node's modules that need the server, for a plugin on a computer: built when it first asks. */
export function bridgedModules(plugin: string, proc: Any) {
  const made = new Map<string, Any>()
  const make: Record<string, () => Any> = {
    fs: () => fsModule(plugin), "fs/promises": () => one("fs").promises, child_process: () => childProcess(plugin), os: () => osModule(plugin), crypto: () => cryptoModule(plugin),
    zlib: () => zlibModule(plugin), http: () => httpModule(plugin, false), https: () => httpModule(plugin, true), net: () => noSockets(plugin, "net"), tls: () => noSockets(plugin, "tls"),
    dgram: () => noSockets(plugin, "dgram"), electron: () => electronModule(plugin, proc, () => one("child_process")), "original-fs": () => one("fs"),
    constants: () => ({ ...envOf(plugin).constants.os, ...envOf(plugin).constants.fs }),
  }
  function one(spec: string): Any {
    if (!made.has(spec)) made.set(spec, make[spec] ? make[spec]() : remoteModule(plugin, spec))
    return made.get(spec)
  }
  return one
}
