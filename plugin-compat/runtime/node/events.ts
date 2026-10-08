// Node's events and stream modules for Obsidian plugins: ES5-style constructors, since the libraries plugins bundle
// inherit them with Ctor.call(this) and util.inherits.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any
const isA = (o: Any, C: Any): boolean => o instanceof C
const make = (C: Any, ...a: Any[]): Any => Reflect.construct(C, a)

export const EventEmitter: Any = function EventEmitter(this: Any, opts?: Any) {
  if (!isA(this, EventEmitter)) return make(EventEmitter, opts)
  EventEmitter.init.call(this)
}
EventEmitter.init = function (this: Any) {
  if (!this._events || this._events === Object.getPrototypeOf(this)._events) { this._events = Object.create(null); this._eventsCount = 0 }
  this._maxListeners ??= undefined
}
EventEmitter.defaultMaxListeners = 10
EventEmitter.errorMonitor = Symbol("events.errorMonitor")
EventEmitter.captureRejectionSymbol = Symbol.for("nodejs.rejection")
EventEmitter.captureRejections = false
const E = EventEmitter.prototype
const listOf = (self: Any, name: string | symbol): Any[] => { self._events ??= Object.create(null); return self._events[name] ?? [] }
E.on = E.addListener = function (this: Any, name: string | symbol, fn: Any) {
  const l = listOf(this, name)
  if (this._events.newListener && name !== "newListener") this.emit("newListener", name, fn.listener ?? fn)
  this._events[name] = [...l, fn]
  return this
}
E.prependListener = function (this: Any, name: string | symbol, fn: Any) { this._events = this._events ?? Object.create(null); this._events[name] = [fn, ...listOf(this, name)]; return this }
const onceWrap = (self: Any, name: string | symbol, fn: Any) => {
  const w: Any = function (this: Any, ...a: Any[]) { self.removeListener(name, w); return fn.apply(self, a) }
  w.listener = fn
  return w
}
E.once = function (this: Any, name: string | symbol, fn: Any) { return this.on(name, onceWrap(this, name, fn)) }
E.prependOnceListener = function (this: Any, name: string | symbol, fn: Any) { return this.prependListener(name, onceWrap(this, name, fn)) }
E.off = E.removeListener = function (this: Any, name: string | symbol, fn: Any) {
  const l = listOf(this, name)
  const i = l.findIndex((x) => x === fn || x.listener === fn)
  if (i < 0) return this
  const next = l.filter((_, j) => j !== i)
  if (next.length) this._events[name] = next; else delete this._events[name]
  if (this._events.removeListener) this.emit("removeListener", name, fn)
  return this
}
E.removeAllListeners = function (this: Any, name?: string | symbol) {
  if (name === undefined) this._events = Object.create(null); else if (this._events) delete this._events[name]
  return this
}
E.emit = function (this: Any, name: string | symbol, ...a: Any[]) {
  const l = listOf(this, name)
  if (name === "error" && this._events[EventEmitter.errorMonitor]) for (const f of this._events[EventEmitter.errorMonitor]) f.apply(this, a)
  if (!l.length) {
    if (name === "error") { const e = a[0]; throw e instanceof Error ? e : new Error(`Unhandled error. (${String(e)})`) }
    return false
  }
  for (const f of l) f.apply(this, a)
  return true
}
E.listeners = function (this: Any, name: string | symbol) { return listOf(this, name).map((f) => f.listener ?? f) }
E.rawListeners = function (this: Any, name: string | symbol) { return [...listOf(this, name)] }
E.listenerCount = function (this: Any, name: string | symbol) { return listOf(this, name).length }
E.eventNames = function (this: Any) { return this._events ? Reflect.ownKeys(this._events) : [] }
E.setMaxListeners = function (this: Any, n: number) { this._maxListeners = n; return this }
E.getMaxListeners = function (this: Any) { return this._maxListeners ?? EventEmitter.defaultMaxListeners }
EventEmitter.EventEmitter = EventEmitter
EventEmitter.once = (em: Any, name: string) => new Promise((ok, no) => {
  const err = (e: Any) => { em.removeListener?.(name, done); no(e) }
  const done = (...a: Any[]) => { em.removeListener?.("error", err); ok(a) }
  em.once(name, done)
  if (name !== "error") em.once("error", err)
})
EventEmitter.on = (em: Any, name: string) => {
  const queue: Any[] = [], waits: Any[] = []
  em.on(name, (...a: Any[]) => { const w = waits.shift(); if (w) w({ value: a, done: false }); else queue.push(a) })
  return { [Symbol.asyncIterator]() { return this }, next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((r) => waits.push(r))), return: async () => ({ value: undefined, done: true }) }
}
EventEmitter.listenerCount = (em: Any, name: string) => em.listenerCount(name)
EventEmitter.setMaxListeners = () => {}
EventEmitter.getEventListeners = (em: Any, name: string) => em.listeners?.(name) ?? []

export function inherits(ctor: Any, sup: Any) {
  if (!sup) return
  ctor.super_ = sup
  Object.setPrototypeOf(ctor.prototype, sup.prototype)
}

// --- streams: enough of Node's for what plugins' libraries do with them (pipes, data events, async iteration)

const asBuffer = (Buf: Any, c: Any, enc?: string) => (typeof c === "string" ? Buf.from(c, enc) : c instanceof Uint8Array && !Buf.isBuffer(c) ? Buf.from(c) : c)

export function streams(Buf: Any) {
  const Stream: Any = function Stream(this: Any, opts?: Any) { EventEmitter.call(this, opts) }
  inherits(Stream, EventEmitter)
  Stream.prototype.pipe = function (this: Any, dest: Any, opts?: Any) {
    this.on("data", (c: Any) => { if (dest.write(c) === false) this.pause?.() })
    dest.on?.("drain", () => this.resume?.())
    if (opts?.end !== false) this.on("end", () => dest.end())
    dest.emit?.("pipe", this)
    this.resume?.()
    return dest
  }

  const Readable: Any = function Readable(this: Any, opts: Any = {}) {
    if (!isA(this, Readable)) return make(Readable, opts)
    Stream.call(this, opts)
    this._rs = { buf: [] as Any[], flowing: null as boolean | null, ended: false, endEmitted: false, encoding: opts.encoding ?? null, objectMode: !!(opts.objectMode || opts.readableObjectMode), reading: false }
    this.readable = true
    this.destroyed = false
    if (typeof opts.read === "function") this._read = opts.read
    if (typeof opts.destroy === "function") this._destroy = opts.destroy
  }
  inherits(Readable, Stream)
  const R = Readable.prototype
  R._read = function () {}
  R.push = function (this: Any, chunk: Any, enc?: string) {
    const s = this._rs
    if (chunk === null) { s.ended = true; queueMicrotask(() => this._flow()); return false }
    if (!s.objectMode) chunk = asBuffer(Buf, chunk, enc)
    if (s.encoding && !s.objectMode && Buf.isBuffer(chunk)) chunk = chunk.toString(s.encoding)
    s.buf.push(chunk)
    queueMicrotask(() => this._flow())
    return s.buf.length < 16
  }
  R.unshift = function (this: Any, chunk: Any) { this._rs.buf.unshift(chunk) }
  R._flow = function (this: Any) {
    const s = this._rs
    if (s.flowing) while (s.buf.length && s.flowing) this.emit("data", s.buf.shift())
    else if (s.buf.length && s.flowing === null && this.listenerCount("readable")) this.emit("readable")
    if (s.ended && !s.buf.length && !s.endEmitted && (s.flowing || this.listenerCount("readable"))) {
      s.endEmitted = true
      this.readable = false
      this.readableEnded = true
      queueMicrotask(() => { this.emit("end"); if (this._autoClose !== false) this.emit("close") })
    }
    if (s.flowing && !s.ended && !s.reading) { s.reading = true; queueMicrotask(() => { s.reading = false; if (!s.ended) this._read(16384) }) }
  }
  R.read = function (this: Any) {
    const s = this._rs
    if (!s.buf.length) { if (!s.ended) this._read(16384); else queueMicrotask(() => this._flow()); return null }
    const out = s.objectMode ? s.buf.shift() : s.encoding ? s.buf.splice(0).join("") : Buf.concat(s.buf.splice(0))
    queueMicrotask(() => this._flow())
    return out
  }
  R.on = R.addListener = function (this: Any, name: string, fn: Any) {
    E.on.call(this, name, fn)
    if (name === "data" && this._rs.flowing !== false) this.resume()
    if (name === "readable" || name === "end") queueMicrotask(() => this._flow())
    return this
  }
  R.resume = function (this: Any) { this._rs.flowing = true; queueMicrotask(() => this._flow()); return this }
  R.pause = function (this: Any) { this._rs.flowing = false; return this }
  R.isPaused = function (this: Any) { return this._rs.flowing === false }
  R.setEncoding = function (this: Any, enc: string) { this._rs.encoding = enc; return this }
  R.unpipe = function (this: Any) { this.removeAllListeners("data"); return this }
  R.destroy = function (this: Any, err?: Any) {
    if (this.destroyed) return this
    this.destroyed = true
    const done = (e?: Any) => queueMicrotask(() => { if (e) this.emit("error", e); this.emit("close") })
    if (this._destroy) this._destroy(err ?? null, done); else done(err)
    return this
  }
  R[Symbol.asyncIterator] = function (this: Any) {
    const queue: Any[] = [], waits: Any[] = []
    let ended = false, failed: Any = null
    const wake = () => { while (waits.length && (queue.length || ended || failed)) { const w = waits.shift(); if (failed) w.no(failed); else if (queue.length) w.ok({ value: queue.shift(), done: false }); else w.ok({ value: undefined, done: true }) } }
    this.on("data", (c: Any) => { queue.push(c); wake() })
    this.on("end", () => { ended = true; wake() })
    this.on("error", (e: Any) => { failed = e; wake() })
    return { next: () => new Promise((ok, no) => { waits.push({ ok, no }); wake() }), return: async () => { this.destroy(); return { value: undefined, done: true } }, [Symbol.asyncIterator]() { return this } }
  }
  Readable.from = (it: Any, opts?: Any) => {
    const r = new Readable({ objectMode: true, ...opts })
    void (async () => { try { for await (const x of it) r.push(x); r.push(null) } catch (e) { r.destroy(e) } })()
    return r
  }

  const Writable: Any = function Writable(this: Any, opts: Any = {}) {
    if (!isA(this, Writable) && !isA(this, Duplex)) return make(Writable, opts)
    Stream.call(this, opts)
    initWritable(this, opts)
  }
  const initWritable = (self: Any, opts: Any) => {
    self._ws = { ended: false, finished: false, pending: 0, objectMode: !!(opts.objectMode || opts.writableObjectMode), decodeStrings: opts.decodeStrings !== false }
    self.writable = true
    if (typeof opts.write === "function") self._write = opts.write
    if (typeof opts.writev === "function") self._writev = opts.writev
    if (typeof opts.final === "function") self._final = opts.final
    if (typeof opts.destroy === "function") self._destroy = opts.destroy
  }
  inherits(Writable, Stream)
  const W = Writable.prototype
  W._write = function (_c: Any, _e: Any, cb: Any) { cb() }
  W.write = function (this: Any, chunk: Any, enc?: Any, cb?: Any) {
    if (typeof enc === "function") { cb = enc; enc = undefined }
    const s = this._ws
    if (s.ended) { const e = new Error("write after end"); queueMicrotask(() => { cb?.(e); this.emit("error", e) }); return false }
    if (!s.objectMode && s.decodeStrings) chunk = asBuffer(Buf, chunk, enc)
    s.pending++
    this._write(chunk, enc ?? "buffer", (e?: Any) => { s.pending--; cb?.(e); if (e) this.emit("error", e); else if (!s.pending) { this.emit("drain"); this._maybeFinish() } })
    return true
  }
  W.cork = W.uncork = function () {}
  W.setDefaultEncoding = function (this: Any) { return this }
  W.end = function (this: Any, chunk?: Any, enc?: Any, cb?: Any) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined } else if (typeof enc === "function") { cb = enc; enc = undefined }
    if (chunk !== undefined && chunk !== null) this.write(chunk, enc)
    if (cb) this.once("finish", cb)
    this._ws.ended = true
    this.writableEnded = true
    this._maybeFinish()
    return this
  }
  W._maybeFinish = function (this: Any) {
    const s = this._ws
    if (!s.ended || s.pending || s.finished || s.finishing) return
    s.finishing = true
    const fin = (e?: Any) => { if (e) return this.emit("error", e); s.finished = true; this.writable = false; this.writableFinished = true; queueMicrotask(() => { this.emit("finish"); if (!isA(this, Readable)) this.emit("close") }) }
    if (this._final) this._final(fin); else fin()
  }
  W.destroy = function (this: Any, err?: Any) {
    if (this.destroyed) return this
    this.destroyed = true
    queueMicrotask(() => { if (err) this.emit("error", err); this.emit("close") })
    return this
  }

  const Duplex: Any = function Duplex(this: Any, opts: Any = {}) {
    if (!isA(this, Duplex)) return make(Duplex, opts)
    Readable.call(this, opts)
    initWritable(this, opts)
    if (opts.allowHalfOpen === false) this.once("end", () => this.end())
  }
  inherits(Duplex, Readable)
  for (const k of ["write", "end", "cork", "uncork", "setDefaultEncoding", "_maybeFinish", "_write"]) Duplex.prototype[k] = W[k]

  const Transform: Any = function Transform(this: Any, opts: Any = {}) {
    if (!isA(this, Transform)) return make(Transform, opts)
    Duplex.call(this, opts)
    if (typeof opts.transform === "function") this._transform = opts.transform
    if (typeof opts.flush === "function") this._flush = opts.flush
  }
  inherits(Transform, Duplex)
  Transform.prototype._transform = function (this: Any, c: Any, _e: Any, cb: Any) { cb(null, c) }
  Transform.prototype._write = function (this: Any, c: Any, e: Any, cb: Any) {
    this._transform(c, e, (err: Any, out: Any) => { if (out !== undefined && out !== null) this.push(out); cb(err) })
  }
  Transform.prototype._final = function (this: Any, cb: Any) {
    const done = (err?: Any, out?: Any) => { if (out !== undefined && out !== null) this.push(out); this.push(null); cb(err) }
    if (this._flush) this._flush(done); else done()
  }
  const PassThrough: Any = function PassThrough(this: Any, opts?: Any) { if (!isA(this, PassThrough)) return make(PassThrough, opts); Transform.call(this, opts) }
  inherits(PassThrough, Transform)

  const finished = (s: Any, opts: Any, cb?: Any) => {
    if (typeof opts === "function") cb = opts
    let done = false
    const end = (e?: Any) => { if (!done) { done = true; cb?.(e) } }
    s.on("end", () => end()); s.on("finish", () => end()); s.on("close", () => end()); s.on("error", end)
    return () => {}
  }
  const pipeline = (...all: Any[]) => {
    const cb = typeof all[all.length - 1] === "function" ? all.pop() : null
    const list = Array.isArray(all[0]) ? all[0] : all
    let last = list[0]
    for (const s of list.slice(1)) last = last.pipe(s)
    let failed = false
    for (const s of list) s.on?.("error", (e: Any) => { if (!failed) { failed = true; cb?.(e) } })
    finished(last, () => { if (!failed) cb?.() })
    return last
  }
  const promises = {
    pipeline: (...all: Any[]) => new Promise((ok, no) => pipeline(...all, (e: Any) => (e ? no(e) : ok(undefined)))),
    finished: (s: Any) => new Promise((ok, no) => finished(s, (e: Any) => (e ? no(e) : ok(undefined)))),
  }
  Object.assign(Stream, { Stream, EventEmitter, Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, promises,
    addAbortSignal: (_s: Any, st: Any) => st, isReadable: (s: Any) => !!s?.readable, isErrored: () => false })
  return Stream
}
