// Runs a query over the vault's pages (pages.ts): FROM, then each data command in order, then the query type's
// output, its values still Dataview's (values.ts). Expressions and the functions Dataview's docs list are here.
import { DqlError, type Command, type Expr, type Query, type Source } from "./dql.ts"
import {
  canonicalKey, compare as compareValues, DvDate, Duration, fromText, isObject, isoWeek, Link, parseDate, parseDuration, truthy, typeOf, UNITS,
  type Fn, type Value, formatDate, formatDuration, toText,
} from "./values.ts"

export type Row = Record<string, Value>
/** What a query runs against: every page (each a row: its fields and `file`), how links resolve, and today. */
export type Context = {
  pages: Row[]
  /** A page by its path. */
  page: (path: string) => Row | null
  /** A [[link]]'s target as a path, or null. */
  resolve: (target: string) => string | null
  /** The page the query is in (`this`, `[[]]`). */
  self: Row | null
  now: Date
  /** Run for someone the vault isn't theirs (a shared folder's guest): done by `until` (ms), no regular expressions (one
   *  can run forever), no huge text. */
  bounded?: { until: number }
}

let bounded: { until: number; steps: number; next: number; out: number } | null = null
/** Bounded, the most of a text, of a value (all it holds, all the way down), of a query's rows and all it shows, and of
 *  the work in all (each step a value made or compared: memory too). */
const MAX_TEXT = 100_000, MAX_SIZE = 250_000, MAX_ROWS = 10_000, MAX_OUTPUT = 500_000, MAX_WORK = 2_000_000
/** `fn` under `b`'s bounds (none: as ever). */
function inBounds<T>(b: { until: number } | undefined, fn: () => T): T {
  if (!b) return fn()
  const was = bounded
  bounded = { until: b.until, steps: 0, next: 1000, out: 0 }
  try { return fn() } finally { bounded = was }
}
/** `n` steps of work (bounded: the clock looked at every thousand). */
function work(n = 1) {
  if (!bounded) return
  bounded.steps += n
  if (bounded.steps < bounded.next) return
  bounded.next = bounded.steps + 1000
  if (bounded.steps > MAX_WORK || Date.now() > bounded.until) throw new DqlError("this query takes too long here")
}
const sizes = new WeakMap<object, number>()
/** How many values `v` holds, all the way down: a list held twice counts twice (one made of itself n times is 2^n). */
function size(v: Value): number {
  if (!v || typeof v !== "object" || !(Array.isArray(v) || isObject(v))) return 1
  const had = sizes.get(v)
  if (had !== undefined) return had
  sizes.set(v, 1) // (while it's counted: one that holds itself counts it once)
  let n = 1
  for (const x of Array.isArray(v) ? v : Object.values(v)) if ((n += size(x)) > MAX_SIZE) break
  sizes.set(v, n)
  return n
}
// (comparing walks both values down: as much work as the smaller holds)
const compare = (a: Value, b: Value) => { if (bounded) work(Math.min(size(a), size(b))); return compareValues(a, b) }
const equal = (a: Value, b: Value) => compare(a, b) === 0
const noRegex = () => { if (bounded) throw new DqlError("regular expressions aren't run here") }
/** A text this long or less (bounded). */
const fits = (n: number) => { if (bounded && n > MAX_TEXT) throw new DqlError("that text is too long here"); return n }

export type ListItem = { id: Value | undefined; value: Value | undefined }
export type TaskGroup = { key: Value | undefined; tasks: Row[] }
export type Result =
  | { type: "table"; headers: string[]; id: boolean; rows: { cells: Value[]; path?: string }[] }
  | { type: "list"; id: boolean; items: ListItem[] }
  | { type: "task"; groups: TaskGroup[]; grouped: boolean }
  | { type: "calendar"; items: { date: DvDate; link: Link; value: Value }[] }

// ---------- evaluation

type Scope = { row: Row; vars?: Record<string, Value>; ctx: Context }

const fileOf = (r: Row) => (isObject(r.file) ? r.file : null)

/** A field of a row by name: as written, else as Dataview also knows it ("Due Date" is due-date). */
export function field(o: Value, name: string, ctx: Context): Value {
  if (o === null || o === undefined) return null
  if (o instanceof Link) {
    if (name === "path") return o.path
    if (name === "display") return o.display ?? null
    if (name === "embed") return o.embed
    if (name === "subpath") return o.subpath ?? null
    if (name === "type") return o.type
    const p = ctx.page(o.path)
    return p ? field(p, name, ctx) : null
  }
  if (o instanceof DvDate) {
    const d = o.d
    switch (name) {
      case "year": return d.getFullYear()
      case "month": return d.getMonth() + 1
      case "day": return d.getDate()
      case "hour": return d.getHours()
      case "minute": return d.getMinutes()
      case "second": return d.getSeconds()
      case "millisecond": return d.getMilliseconds()
      case "week": return isoWeek(d)[0]
      case "weekyear": return isoWeek(d)[1]
      case "weekday": return d.getDay() || 7
      case "ts": return o.t
      default: return null
    }
  }
  if (o instanceof Duration) {
    const u = UNITS.find((x) => x === name || x.slice(0, -1) === name)
    return u ? o.parts[u] ?? 0 : null
  }
  if (Array.isArray(o)) {
    if (name === "length") return o.length
    // (swizzling: rows.file.link is every row's file.link)
    return o.map((x) => field(x, name, ctx))
  }
  if (isObject(o)) {
    if (Object.hasOwn(o, name)) return o[name] ?? null
    const low = canonicalKey(name)
    if (Object.hasOwn(o, low)) return o[low] ?? null
    for (const k of Object.keys(o)) if (canonicalKey(k) === low) return o[k] ?? null
    // (a task's row: its page's fields under its own)
    const page = (o as { $page?: Row }).$page
    return page ? field(page, name, ctx) : null
  }
  if (typeof o === "string" && name === "length") return o.length
  return null
}

function lookup(name: string, s: Scope): Value {
  if (s.vars && Object.hasOwn(s.vars, name)) return s.vars[name]
  if (name === "row") return s.row
  return field(s.row, name, s.ctx)
}

const linkTo = (target: string, ctx: Context, display?: string, embed = false): Link => {
  if (!target) {
    const f = ctx.self ? fileOf(ctx.self) : null
    return new Link(String(f?.path ?? ""), display, embed)
  }
  const [t, sub] = target.split("#")
  const hit = ctx.resolve(t)
  return new Link(hit ?? t, display, embed, sub || undefined, !!hit)
}

function dateWord(word: string, now: Date): DvDate | null {
  const day = (y: number, m: number, d: number) => new DvDate(new Date(y, m, d).getTime(), false)
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()]
  const dow = (now.getDay() + 6) % 7
  switch (word.toLowerCase()) {
    case "today": return day(y, m, d)
    case "now": return new DvDate(now.getTime(), true)
    case "tomorrow": return day(y, m, d + 1)
    case "yesterday": return day(y, m, d - 1)
    case "sow": return day(y, m, d - dow)
    case "eow": return day(y, m, d - dow + 6)
    case "som": return day(y, m, 1)
    case "eom": return day(y, m + 1, 0)
    case "soy": return day(y, 0, 1)
    case "eoy": return day(y, 11, 31)
    default: return parseDate(word)
  }
}

export function evaluate(e: Expr, s: Scope): Value {
  const v = evaluateOnce(e, s)
  if (bounded && v && typeof v === "object" && size(v) > MAX_SIZE) throw new DqlError("that value is too big here")
  return v
}
function evaluateOnce(e: Expr, s: Scope): Value {
  work()
  switch (e.k) {
    case "lit": return e.v as Value
    case "var": return lookup(e.name, s)
    case "this": return s.ctx.self ?? null
    case "link": return linkTo(e.target, s.ctx, e.display, e.embed)
    case "date": {
      const d = dateWord(e.word, s.ctx.now)
      if (!d) throw new DqlError(`date(${e.word}) isn't a date: date(today), date(2026-10-06)...`)
      return d
    }
    case "dur": {
      const d = parseDuration(e.text)
      if (!d) throw new DqlError(`dur(${e.text}) isn't a duration: dur(1 day), dur(3 hours 20 minutes)...`)
      return d
    }
    case "list": return e.items.map((x) => evaluate(x, s))
    case "obj": return Object.fromEntries(e.entries.map(([k, x]) => [k, evaluate(x, s)]))
    case "field": return field(evaluate(e.of, s), e.name, s.ctx)
    case "index": {
      const o = evaluate(e.of, s), at = evaluate(e.at, s)
      if (typeof at === "number" && (Array.isArray(o) || typeof o === "string")) return (at < 0 ? o[o.length + at] : o[at]) ?? null
      if (typeof at === "string") return field(o, at, s.ctx)
      return null
    }
    case "lambda": {
      const f = ((...args: Value[]) => evaluate(e.body, { ...s, vars: { ...s.vars, ...Object.fromEntries(e.params.map((p, i) => [p, args[i] ?? null])) } })) as Fn
      f.lambda = true
      return f
    }
    case "call": {
      if (typeof e.fn !== "string") {
        const f = evaluate(e.fn, s)
        if (typeof f !== "function") throw new DqlError("only functions can be called")
        return f(...e.args.map((a) => evaluate(a, s)))
      }
      const name = e.fn.toLowerCase()
      // (a variable holding a lambda: map(xs, (f) => f(1)))
      const own = s.vars && Object.hasOwn(s.vars, e.fn) ? s.vars[e.fn] : undefined
      if (typeof own === "function") return own(...e.args.map((a) => evaluate(a, s)))
      const f = FUNCTIONS[name]
      if (!f) throw new DqlError(`there's no function ${e.fn}()`)
      return f(e.args.map((a) => evaluate(a, s)), s.ctx)
    }
    case "un": {
      const v = evaluate(e.e, s)
      if (e.op === "!") return !truthy(v)
      if (typeof v === "number") return -v
      if (v instanceof Duration) return v.negate()
      return null
    }
    case "bin": {
      if (e.op === "and") { const a = evaluate(e.a, s); return truthy(a) ? truthy(evaluate(e.b, s)) : false }
      if (e.op === "or") { const a = evaluate(e.a, s); return truthy(a) ? true : truthy(evaluate(e.b, s)) }
      return binary(e.op, evaluate(e.a, s), evaluate(e.b, s))
    }
  }
}

function addDur(d: DvDate, dur: Duration, sign: number): DvDate {
  const x = new Date(d.t)
  const p = dur.parts
  x.setFullYear(x.getFullYear() + sign * (p.years ?? 0), x.getMonth() + sign * (p.months ?? 0), x.getDate() + sign * ((p.weeks ?? 0) * 7 + (p.days ?? 0)))
  const ms = sign * ((p.hours ?? 0) * 36e5 + (p.minutes ?? 0) * 6e4 + (p.seconds ?? 0) * 1e3 + (p.milliseconds ?? 0))
  const time = d.time || ms % 864e5 !== 0
  return new DvDate(x.getTime() + ms, time)
}

export function binary(op: string, a: Value, b: Value): Value {
  switch (op) {
    case "=": return equal(a, b)
    case "!=": return !equal(a, b)
    case "<": return compare(a, b) < 0
    case "<=": return compare(a, b) <= 0
    case ">": return compare(a, b) > 0
    case ">=": return compare(a, b) >= 0
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    // (text + nothing is the text, as Dataview writes "x" + null as "x-")
    if (op === "+" && (typeof a === "string" || typeof b === "string")) return toText(a ?? null).replace(/^-$/, "") + toText(b ?? null).replace(/^-$/, "")
    return null
  }
  if (op === "+") {
    if (typeof a === "number" && typeof b === "number") return a + b
    if (a instanceof DvDate && b instanceof Duration) return addDur(a, b, 1)
    if (a instanceof Duration && b instanceof DvDate) return addDur(b, a, 1)
    if (a instanceof Duration && b instanceof Duration) return a.plus(b)
    if (Array.isArray(a) && Array.isArray(b)) { work(fits(a.length + b.length)); return [...a, ...b] }
    if (isObject(a) && isObject(b)) return { ...a, ...b }
    if (typeof a === "string" || typeof b === "string") { const x = toText(a), y = toText(b); fits(x.length + y.length); return x + y }
    return null
  }
  if (op === "-") {
    if (typeof a === "number" && typeof b === "number") return a - b
    if (a instanceof DvDate && b instanceof Duration) return addDur(a, b, -1)
    if (a instanceof DvDate && b instanceof DvDate) return Duration.of(a.t - b.t)
    if (a instanceof Duration && b instanceof Duration) return a.plus(b.negate())
    return null
  }
  if (op === "*") {
    if (typeof a === "number" && typeof b === "number") return a * b
    if (a instanceof Duration && typeof b === "number") return a.times(b)
    if (typeof a === "number" && b instanceof Duration) return b.times(a)
    if (typeof a === "string" && typeof b === "number") { const n = Math.max(0, Math.floor(b)); fits(a.length * n); return a.repeat(n) }
    return null
  }
  if (op === "/") {
    if (typeof a === "number" && typeof b === "number") return a / b
    if (a instanceof Duration && typeof b === "number") return a.times(1 / b)
    if (a instanceof Duration && b instanceof Duration) return a.ms / b.ms
    return null
  }
  if (op === "%") return typeof a === "number" && typeof b === "number" ? a % b : null
  return null
}

// ---------- functions

type Impl = (args: Value[], ctx: Context) => Value
const str = (v: Value) => (typeof v === "string" ? v : v === null ? "" : toText(v))
const num = (v: Value) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null)
const list = (v: Value): Value[] => (Array.isArray(v) ? (work(v.length), v) : v === null ? [] : [v])
const call = (f: Value, ...args: Value[]): Value => {
  if (typeof f !== "function") throw new DqlError("expected a function, like (x) => x.rating")
  return f(...args)
}
/** A function of one value applied to each of a list's (Dataview's vectorization). */
const each = (f: (v: Value, ...rest: Value[]) => Value): Impl => (args) => {
  const [first, ...rest] = args
  return Array.isArray(first) ? (work(first.length), first.map((x) => f(x ?? null, ...rest))) : f(first ?? null, ...rest)
}
const nums = (args: Value[]) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).filter((x) => x !== null)

function containsIn(c: Value, v: Value, how: "case" | "nocase" | "exact"): boolean {
  if (c === null) return false
  if (typeof c === "string") {
    const s = str(v)
    return how === "nocase" ? c.toLowerCase().includes(s.toLowerCase()) : c.includes(s)
  }
  if (Array.isArray(c)) {
    if (how === "exact") return c.some((x) => equal(x, v))
    return c.some((x) => equal(x, v) || (typeof x === "string" && typeof v === "string" && (how === "nocase" ? x.toLowerCase().includes(v.toLowerCase()) : x.includes(v))) || (Array.isArray(x) && containsIn(x, v, how)))
  }
  if (c instanceof Link) return v instanceof Link ? c.path === v.path : typeof v === "string" && (c.path.includes(v) || (c.display ?? "").includes(v))
  if (isObject(c)) return typeof v === "string" && (how === "nocase" ? Object.keys(c).some((k) => k.toLowerCase() === v.toLowerCase()) : Object.hasOwn(c, v))
  return equal(c, v)
}

function toDate(v: Value, ctx: Context, format?: string): Value {
  if (v instanceof DvDate) return v
  if (v instanceof Link) { const p = ctx.page(v.path); const f = p ? fileOf(p) : null; return (f?.day as Value) ?? null }
  if (typeof v === "string") {
    if (format) return parseWithFormat(v, format)
    return dateWord(v, ctx.now)
  }
  if (typeof v === "number") return new DvDate(v, true)
  return null
}

/** date(text, format): the Luxon tokens yyyy MM dd HH mm ss (and M d H m) read back. */
function parseWithFormat(s: string, fmt: string): DvDate | null {
  const parts: Record<string, number> = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0 }
  let re = "^", order: string[] = []
  const toks = ["yyyy", "MM", "dd", "HH", "mm", "ss", "M", "d", "H", "m", "s"]
  for (let i = 0; i < fmt.length;) {
    const t = toks.find((x) => fmt.startsWith(x, i))
    if (t) { re += t.length === 4 ? "(\\d{4})" : t.length === 2 ? "(\\d{2})" : "(\\d{1,2})"; order.push(t[0]); i += t.length }
    else { re += fmt[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i++ }
  }
  const m = new RegExp(re + "$").exec(s.trim())
  if (!m) return null
  order.forEach((k, i) => { parts[k] = Number(m[i + 1]) })
  return new DvDate(new Date(parts.y, parts.M - 1, parts.d, parts.H, parts.m, parts.s).getTime(), order.some((k) => "Hms".includes(k)))
}

function round(v: Value, digits: Value): Value {
  const n = num(v)
  if (n === null) return null
  const f = 10 ** (typeof digits === "number" ? digits : 0)
  return Math.round(n * f) / f
}

const flat = (v: Value[], depth: number): Value[] => v.flatMap((x) => (Array.isArray(x) && depth > 0 ? (work(x.length), flat(x, depth - 1)) : [x]))

export const FUNCTIONS: Record<string, Impl> = {
  // constructors
  object: (a) => { const o: Record<string, Value> = {}; for (let i = 0; i + 1 < a.length; i += 2) o[str(a[i])] = a[i + 1]; return o },
  list: (a) => a,
  array: (a) => a,
  date: (a, ctx) => (Array.isArray(a[0]) ? a[0].map((x) => toDate(x, ctx, typeof a[1] === "string" ? a[1] : undefined)) : toDate(a[0] ?? null, ctx, typeof a[1] === "string" ? a[1] : undefined)),
  dur: each((v) => (v instanceof Duration ? v : typeof v === "string" ? parseDuration(v) : null)),
  number: each((v) => {
    if (typeof v === "number") return v
    const m = typeof v === "string" ? /-?\d+(\.\d+)?/.exec(v) : null
    return m ? Number(m[0]) : null
  }),
  string: each((v) => (v instanceof DvDate ? toText(v) : toText(v))),
  link: (a, ctx) => {
    const one = (p: Value) => (p instanceof Link ? p.withDisplay(typeof a[1] === "string" ? a[1] : p.display) : typeof p === "string" ? linkTo(p.replace(/^\[\[|\]\]$/g, ""), ctx, typeof a[1] === "string" ? a[1] : undefined) : null)
    return Array.isArray(a[0]) ? a[0].map(one) : one(a[0] ?? null)
  },
  embed: each((v, e) => (v instanceof Link ? new Link(v.path, v.display, e === null || e === undefined ? true : truthy(e), v.subpath, v.exists) : null)),
  elink: (a) => (typeof a[0] === "string" ? `[${typeof a[1] === "string" ? a[1] : a[0]}](${a[0]})` : null),
  typeof: (a) => typeOf(a[0] ?? null),
  // numbers
  round: each((v, d) => round(v, d ?? null)),
  trunc: each((v) => (typeof v === "number" ? Math.trunc(v) : null)),
  floor: each((v) => (typeof v === "number" ? Math.floor(v) : null)),
  ceil: each((v) => (typeof v === "number" ? Math.ceil(v) : null)),
  abs: each((v) => (typeof v === "number" ? Math.abs(v) : null)),
  min: (a) => { const xs = nums(a); return xs.length ? xs.reduce((m, x) => (compare(x, m) < 0 ? x : m)) : null },
  max: (a) => { const xs = nums(a); return xs.length ? xs.reduce((m, x) => (compare(x, m) > 0 ? x : m)) : null },
  sum: (a) => {
    const xs: Value[] = list(a[0] ?? null).filter((x) => x !== null)
    if (!xs.length) return 0
    return xs.reduce((s, x) => binary("+", s, x))
  },
  product: (a) => list(a[0] ?? null).filter((x) => typeof x === "number").reduce<number>((p, x) => p * (x as number), 1),
  average: (a) => {
    const xs: Value[] = list(a[0] ?? null).filter((x) => x !== null)
    if (!xs.length) return null
    const total = xs.reduce((s, x) => binary("+", s, x))
    return binary("/", total, xs.length)
  },
  reduce: (a) => {
    const xs = list(a[0] ?? null)
    const op = a[1]
    if (!xs.length) return null
    if (typeof op === "string") return xs.reduce((s, x) => binary(op === "&" ? "and" : op === "|" ? "or" : op, s, x))
    return xs.reduce((s, x) => call(op ?? null, s, x))
  },
  minby: (a) => { const xs = list(a[0] ?? null); return xs.length ? xs.reduce((m, x) => (compare(call(a[1] ?? null, x), call(a[1] ?? null, m)) < 0 ? x : m)) : null },
  maxby: (a) => { const xs = list(a[0] ?? null); return xs.length ? xs.reduce((m, x) => (compare(call(a[1] ?? null, x), call(a[1] ?? null, m)) > 0 ? x : m)) : null },
  // lists, objects, text
  contains: (a) => containsIn(a[0] ?? null, a[1] ?? null, "case"),
  icontains: (a) => containsIn(a[0] ?? null, a[1] ?? null, "nocase"),
  econtains: (a) => containsIn(a[0] ?? null, a[1] ?? null, "exact"),
  containsword: (a) => {
    const word = str(a[1] ?? null).toLowerCase()
    const has = (s: Value) => typeof s === "string" && s.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).includes(word)
    return Array.isArray(a[0]) ? a[0].map(has) : has(a[0] ?? null)
  },
  extract: (a) => { const o = a[0]; return isObject(o) ? Object.fromEntries(a.slice(1).map((k) => [str(k), o[str(k)] ?? null])) : {} },
  sort: (a) => {
    const xs = [...list(a[0] ?? null)]
    const key = a[1]
    return xs.sort((x, y) => (typeof key === "function" ? compare(key(x), key(y)) : compare(x, y)))
  },
  reverse: (a) => (typeof a[0] === "string" ? [...a[0]].reverse().join("") : [...list(a[0] ?? null)].reverse()),
  length: (a) => { const v = a[0] ?? null; return Array.isArray(v) || typeof v === "string" ? v.length : isObject(v) ? Object.keys(v).length : 0 },
  nonnull: (a) => (Array.isArray(a[0]) ? a[0] : a).filter((x) => x !== null && x !== undefined),
  firstvalue: (a) => list(a[0] ?? null).find((x) => x !== null && x !== undefined) ?? null,
  all: (a) => (typeof a[1] === "function" ? list(a[0] ?? null).every((x) => truthy(call(a[1] ?? null, x))) : (a.length === 1 && Array.isArray(a[0]) ? a[0] : a).every(truthy)),
  any: (a) => (typeof a[1] === "function" ? list(a[0] ?? null).some((x) => truthy(call(a[1] ?? null, x))) : (a.length === 1 && Array.isArray(a[0]) ? a[0] : a).some(truthy)),
  none: (a) => (typeof a[1] === "function" ? !list(a[0] ?? null).some((x) => truthy(call(a[1] ?? null, x))) : !(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).some(truthy)),
  join: (a) => { const t = list(a[0] ?? null).map((x) => toText(x)).join(typeof a[1] === "string" ? a[1] : ", "); fits(t.length); return t },
  filter: (a) => list(a[0] ?? null).filter((x) => truthy(call(a[1] ?? null, x))),
  map: (a) => list(a[0] ?? null).map((x) => call(a[1] ?? null, x)),
  flat: (a) => flat(list(a[0] ?? null), typeof a[1] === "number" ? a[1] : 1),
  slice: (a) => {
    const v = a[0] ?? null
    const s = typeof a[1] === "number" ? a[1] : undefined, e = typeof a[2] === "number" ? a[2] : undefined
    return typeof v === "string" ? v.slice(s, e) : list(v).slice(s, e)
  },
  unique: (a) => list(a[0] ?? null).filter((x, i, xs) => xs.findIndex((y) => equal(x, y)) === i),
  // text
  regextest: (a) => { noRegex(); try { return new RegExp(str(a[0] ?? null)).test(str(a[1] ?? null)) } catch { return false } },
  regexmatch: (a) => { noRegex(); try { return new RegExp(`^(?:${str(a[0] ?? null)})$`).test(str(a[1] ?? null)) } catch { return false } },
  regexreplace: each((v, p, r) => { noRegex(); try { return typeof v === "string" ? v.replace(new RegExp(str(p), "g"), str(r)) : null } catch { return v } }),
  replace: each((v, p, r) => {
    if (typeof v !== "string") return null
    const parts = v.split(str(p))
    fits(v.length + (parts.length - 1) * str(r).length)
    return parts.join(str(r))
  }),
  lower: each((v) => (typeof v === "string" ? v.toLowerCase() : v)),
  upper: each((v) => (typeof v === "string" ? v.toUpperCase() : v)),
  split: (a) => {
    const s = str(a[0] ?? null)
    // (bounded, the separator is text: a regular expression could run forever)
    let parts: string[]
    try { parts = s.split(bounded ? str(a[1] ?? null) : new RegExp(str(a[1] ?? null))) } catch { return [s] }
    work(parts.length)
    return typeof a[2] === "number" ? parts.slice(0, a[2]) : parts
  },
  startswith: each((v, p) => typeof v === "string" && v.startsWith(str(p))),
  endswith: each((v, p) => typeof v === "string" && v.endsWith(str(p))),
  padleft: each((v, n, c) => str(v).padStart(typeof n === "number" ? fits(n) : 0, typeof c === "string" ? c : " ")),
  padright: each((v, n, c) => str(v).padEnd(typeof n === "number" ? fits(n) : 0, typeof c === "string" ? c : " ")),
  substring: each((v, s, e) => str(v).substring(typeof s === "number" ? s : 0, typeof e === "number" ? e : undefined)),
  truncate: each((v, n, suffix) => {
    const s = str(v), len = typeof n === "number" ? n : s.length, suf = typeof suffix === "string" ? suffix : "..."
    return s.length <= len ? s : s.slice(0, Math.max(0, len - suf.length)) + suf
  }),
  // utility
  default: (a) => (Array.isArray(a[0]) ? a[0].map((x) => x ?? a[1] ?? null) : a[0] ?? a[1] ?? null),
  ldefault: (a) => a[0] ?? a[1] ?? null,
  choice: each((c, x, y) => (truthy(c) ? x : y) ?? null),
  display: each((v) => (v instanceof Link ? v.display ?? v.name : toText(v))),
  striptime: each((v) => (v instanceof DvDate ? new DvDate(new Date(v.d.getFullYear(), v.d.getMonth(), v.d.getDate()).getTime(), false) : null)),
  dateformat: each((v, f) => (v instanceof DvDate ? formatDate(v, str(f)) : null)),
  durationformat: each((v, f) => (v instanceof Duration ? formatDuration(v, str(f)) : null)),
  localtime: each((v) => v),
  currencyformat: each((v, c) => {
    if (typeof v !== "number") return null
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: typeof c === "string" ? c : "USD" }).format(v) } catch { return String(v) }
  }),
  hash: (a) => {
    let h = 2166136261
    for (const ch of a.map((x) => toText(x)).join("\0")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
    return h % 100
  },
  meta: (a) => {
    const l = a[0]
    if (!(l instanceof Link)) return null
    return { display: l.display ?? null, embed: l.embed, path: l.path, subpath: l.subpath ?? null, type: l.type }
  },
  striphtml: each((v) => (typeof v === "string" ? v.replace(/<[^>]*>/g, "") : v)),
}

// ---------- sources

function tagMatch(tags: Value, want: string) {
  const w = want.toLowerCase()
  return list(tags).some((t) => typeof t === "string" && (t.toLowerCase() === w || t.toLowerCase().startsWith(`${w}/`)))
}

function inSource(src: Source, page: Row, ctx: Context): boolean {
  const f = fileOf(page)!
  switch (src.k) {
    case "all": return true
    case "tag": return tagMatch(f.tags ?? null, src.tag)
    case "folder": {
      const p = String(f.path).toLowerCase(), want = src.path.replace(/^\/+|\/+$/g, "").toLowerCase()
      if (!want) return true
      return p.startsWith(`${want}/`) || p === want || p === `${want}.md`
    }
    case "link": {
      const target = src.target ? ctx.resolve(src.target) : String(ctx.self ? fileOf(ctx.self)?.path : "")
      if (!target) return false
      if (src.outgoing) {
        const from = ctx.page(target)
        return !!from && list(fileOf(from)?.outlinks ?? null).some((l) => l instanceof Link && l.path === f.path)
      }
      return list(f.outlinks ?? null).some((l) => l instanceof Link && l.path === target)
    }
    case "not": return !inSource(src.s, page, ctx)
    case "and": return inSource(src.a, page, ctx) && inSource(src.b, page, ctx)
    case "or": return inSource(src.a, page, ctx) || inSource(src.b, page, ctx)
  }
}

// ---------- running a query

/** Every task of these pages, nested ones too, each with its page's fields under its own (and `file`). */
function tasksOf(pages: Row[]): Row[] {
  const out: Row[] = []
  for (const p of pages) {
    const f = fileOf(p)!
    for (const t of list(f.tasks ?? null)) if (isObject(t)) out.push(withPage(t, p))
  }
  return out
}
/** A task as a row: its own fields, then its page's (looked up there: `field`), `file` the page's. */
function withPage(t: Row, page: Row): Row {
  const r: Row = { ...t, file: page.file }
  Object.defineProperty(r, "$task", { value: t, enumerable: false })
  Object.defineProperty(r, "$page", { value: page, enumerable: false })
  return r
}

function setPath(row: Row, name: string, value: Value): Row {
  const parts = name.split(".")
  const out: Row = { ...row }
  if (parts.length > 1 && isObject(out[parts[0]])) {
    out[parts[0]] = setPath(out[parts[0]] as Row, parts.slice(1).join("."), value)
    return out
  }
  out[name] = value
  return out
}

type Grouped = { key: Value; rows: Row[] }

function run(cmds: Command[], rows: Row[], ctx: Context): { rows: Row[]; grouped: boolean } {
  let grouped = false
  for (const c of cmds) {
    const ev = (e: Expr, row: Row) => evaluate(e, { row, ctx })
    if (c.k === "where") rows = rows.filter((r) => truthy(ev(c.e, r)))
    else if (c.k === "sort") {
      const keyed = rows.map((r, i) => ({ r, i, keys: c.by.map((b) => ev(b.e, r)) }))
      keyed.sort((x, y) => {
        for (let j = 0; j < c.by.length; j++) {
          const d = compare(x.keys[j], y.keys[j])
          if (d) return c.by[j].desc ? -d : d
        }
        return x.i - y.i
      })
      rows = keyed.map((k) => k.r)
    } else if (c.k === "limit") {
      const n = ev(c.e, {})
      if (typeof n !== "number" || n < 0) throw new DqlError("LIMIT takes a number")
      rows = rows.slice(0, n)
    } else if (c.k === "flatten") {
      const out: Row[] = []
      for (const r of rows) {
        const v = ev(c.e, r)
        for (const x of Array.isArray(v) ? v : [v]) {
          work()
          if (bounded && out.length >= MAX_ROWS) throw new DqlError("that's too many rows here")
          out.push(setPath(r, c.as, x))
        }
      }
      rows = out
    } else if (c.k === "group") {
      const groups: Grouped[] = []
      for (const r of rows) {
        const key = ev(c.e, r)
        const g = groups.find((x) => equal(x.key, key))
        if (g) g.rows.push(r)
        else groups.push({ key, rows: [r] })
      }
      groups.sort((a, b) => compare(a.key, b.key))
      rows = groups.map((g) => {
        const row: Row = { key: g.key, rows: g.rows }
        if (c.as !== "key" && c.as !== "rows") row[c.as] = g.key
        return row
      })
      grouped = true
    }
  }
  return { rows, grouped }
}

/** The query run: its rows as the query type draws them. Throws DqlError. */
export function execute(q: Query, ctx: Context): Result {
  return inBounds(ctx.bounded, () => executeAll(q, ctx))
}
function executeAll(q: Query, ctx: Context): Result {
  const pages = ctx.pages.filter((p) => inSource(q.from, p, ctx))
  pages.sort((a, b) => compare(fileOf(a)?.path ?? null, fileOf(b)?.path ?? null))
  if (q.type === "task") {
    const { rows, grouped } = run(q.commands, tasksOf(pages), ctx)
    if (grouped) return { type: "task", grouped: true, groups: rows.map((g) => ({ key: g.key, tasks: nest((g.rows as Row[]) ?? []) })) }
    // Ungrouped, each file's tasks under it, the files in the order their first task comes.
    const byFile = new Map<string, Row[]>()
    for (const t of rows) {
      const p = String(fileOf(t)?.path ?? "")
      byFile.set(p, [...(byFile.get(p) ?? []), t])
    }
    return { type: "task", grouped: false, groups: [...byFile.entries()].map(([p, ts]) => ({ key: fileOf(ctx.page(p) ?? {})?.link ?? new Link(p), tasks: nest(ts) })) }
  }
  const { rows, grouped } = run(q.commands, pages, ctx)
  // (bounded, what it shows in all: each cell is written out whole, however cheaply it was made)
  const shown = (v: Value) => {
    if (bounded && (bounded.out += size(v)) > MAX_OUTPUT) throw new DqlError("that's too much to show here")
    return v
  }
  const id = (r: Row): Value => shown(grouped ? r.key ?? null : fileOf(r)?.link ?? null)
  const ev = (e: Expr, row: Row) => shown(evaluate(e, { row, ctx }))
  if (q.type === "table") {
    const headers = [...(q.withoutId ? [] : [grouped ? "Group" : "File"]), ...q.columns.map((c) => c.name)]
    return {
      type: "table", id: !q.withoutId, headers,
      rows: rows.map((r) => ({ cells: [...(q.withoutId ? [] : [id(r)]), ...q.columns.map((c) => ev(c.e, r))], ...(grouped ? {} : { path: String(fileOf(r)?.path ?? "") }) })),
    }
  }
  if (q.type === "list") {
    const col = q.columns[0]
    return {
      type: "list", id: !q.withoutId,
      items: rows.map((r) => (col ? { id: q.withoutId ? undefined : id(r), value: ev(col.e, r) } : { id: id(r), value: undefined })),
    }
  }
  // calendar
  const items: { date: DvDate; link: Link; value: Value }[] = []
  for (const r of rows) {
    const d = ev(q.columns[0].e, r)
    const l = fileOf(r)?.link
    if (d instanceof DvDate && l instanceof Link) items.push({ date: d, link: l, value: d })
  }
  return { type: "calendar", items }
}

/** Tasks whose parent task is also listed go under it (as its children already are), not again on their own. */
function nest(tasks: Row[]): Row[] {
  const lines = new Map<string, Set<number>>()
  for (const t of tasks) {
    const p = String(t.path ?? "")
    if (!lines.has(p)) lines.set(p, new Set())
    lines.get(p)!.add(Number(t.line))
  }
  return tasks.filter((t) => {
    const set = lines.get(String(t.path ?? ""))!
    for (const a of list(t.$ancestors ?? (t as { $task?: Row }).$task?.$ancestors ?? null)) if (set.has(Number(a))) return false
    return true
  })
}

/** An inline query's value (`= this.file.name`): the expression over the page it's in. Throws DqlError. */
export function evaluateInline(e: Expr, ctx: Context): Value {
  return inBounds(ctx.bounded, () => evaluate(e, { row: ctx.self ?? {}, ctx }))
}

/** A frontmatter value or a field's text read as Dataview does, for callers that have only text. */
export const readValue = fromText
