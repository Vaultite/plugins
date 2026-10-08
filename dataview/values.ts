// Dataview's values: links, dates and durations besides JSON's, how they compare, read from text, and are written.
// No imports, so the server, the app and the tests share it.

export class Link {
  path: string
  display: string | undefined
  embed: boolean
  subpath: string | undefined
  /** The file it points to is in the vault (else `path` is the link's target as written). */
  exists: boolean
  constructor(path: string, display?: string, embed = false, subpath?: string, exists = true) {
    this.path = path; this.display = display; this.embed = embed; this.subpath = subpath; this.exists = exists
  }
  /** The file's name without its folder or extension: what a link shows without a display. */
  get name() { return this.path.replace(/^.*\//, "").replace(/\.md$/i, "") }
  get type() { return this.subpath ? (this.subpath.startsWith("^") ? "block" : "header") : "file" }
  withDisplay(display?: string) { return new Link(this.path, display, this.embed, this.subpath, this.exists) }
  markdown() {
    const target = this.path.replace(/\.md$/i, "") + (this.subpath ? `#${this.subpath}` : "")
    return `${this.embed ? "!" : ""}[[${target}${this.display ? `|${this.display}` : ""}]]`
  }
}

/** A moment in this machine's time; `time`: it has a time of day (a date alone shows without one). */
export class DvDate {
  t: number
  time: boolean
  constructor(t: number, time: boolean) { this.t = t; this.time = time }
  get d() { return new Date(this.t) }
}

export const UNITS = ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"] as const
export type Unit = typeof UNITS[number]
// Luxon's casual conversion: a month is 30 days, a year 365.
const MS: Record<Unit, number> = { years: 365 * 864e5, months: 30 * 864e5, weeks: 7 * 864e5, days: 864e5, hours: 36e5, minutes: 6e4, seconds: 1e3, milliseconds: 1 }

export class Duration {
  parts: Partial<Record<Unit, number>>
  constructor(parts: Partial<Record<Unit, number>>) { this.parts = parts }
  get ms() { return UNITS.reduce((n, u) => n + (this.parts[u] ?? 0) * MS[u], 0) }
  /** A length of time in milliseconds as years, months, weeks, days... (Dataview shows `date - date` so). */
  static of(ms: number) {
    const parts: Partial<Record<Unit, number>> = {}
    let rest = Math.abs(ms)
    const sign = ms < 0 ? -1 : 1
    for (const u of UNITS) {
      const n = u === "milliseconds" ? Math.round(rest) : Math.floor(rest / MS[u])
      if (n) parts[u] = sign * n
      rest -= n * MS[u]
    }
    return new Duration(parts)
  }
  negate() { return new Duration(Object.fromEntries(Object.entries(this.parts).map(([k, v]) => [k, -(v as number)]))) }
  plus(o: Duration) {
    const p = { ...this.parts }
    for (const [k, v] of Object.entries(o.parts)) p[k as Unit] = (p[k as Unit] ?? 0) + (v as number)
    return new Duration(p)
  }
  times(n: number) { return new Duration(Object.fromEntries(Object.entries(this.parts).map(([k, v]) => [k, (v as number) * n]))) }
}

export type Fn = ((...args: Value[]) => Value) & { lambda?: true }
export type Value = null | number | string | boolean | Link | DvDate | Duration | Value[] | { [k: string]: Value } | Fn

export const isObject = (v: unknown): v is Record<string, Value> =>
  !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Link) && !(v instanceof DvDate) && !(v instanceof Duration)

export function typeOf(v: Value): string {
  if (v === null || v === undefined) return "null"
  if (typeof v === "number") return "number"
  if (typeof v === "string") return "string"
  if (typeof v === "boolean") return "boolean"
  if (typeof v === "function") return "function"
  if (v instanceof Link) return "link"
  if (v instanceof DvDate) return "date"
  if (v instanceof Duration) return "duration"
  if (Array.isArray(v)) return "array"
  return "object"
}

export function truthy(v: Value): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v)
  if (typeof v === "string") return v.length > 0
  if (typeof v === "boolean") return v
  if (v instanceof Duration) return v.ms !== 0
  if (Array.isArray(v)) return v.length > 0
  if (isObject(v)) return Object.keys(v).length > 0
  return true
}

const ORDER = ["null", "boolean", "number", "string", "date", "duration", "link", "array", "object", "function"]
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Dataview's order: values of one type by value, else by type (null first). */
export function compare(a: Value, b: Value): number {
  const ta = typeOf(a), tb = typeOf(b)
  if (ta !== tb) return ORDER.indexOf(ta) - ORDER.indexOf(tb)
  switch (ta) {
    case "null": return 0
    case "boolean": return Number(a) - Number(b)
    case "number": return (a as number) - (b as number)
    case "string": { const c = collator.compare(a as string, b as string); return c || ((a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0) }
    case "date": return (a as DvDate).t - (b as DvDate).t
    case "duration": return (a as Duration).ms - (b as Duration).ms
    case "link": return collator.compare((a as Link).path, (b as Link).path) || collator.compare((a as Link).subpath ?? "", (b as Link).subpath ?? "")
    case "array": {
      const x = a as Value[], y = b as Value[]
      for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = compare(x[i], y[i]); if (c) return c }
      return x.length - y.length
    }
    case "object": {
      const x = a as Record<string, Value>, y = b as Record<string, Value>
      const kx = Object.keys(x).sort(), ky = Object.keys(y).sort()
      const c = compare(kx, ky)
      if (c) return c
      for (const k of kx) { const d = compare(x[k], y[k]); if (d) return d }
      return 0
    }
    default: return 0
  }
}
export const equal = (a: Value, b: Value) => compare(a, b) === 0

// ---------- reading values from text (inline fields, frontmatter strings, date() and dur())

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0")
const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/

/** An ISO date ("2026-09-27", "2026-09", "2026-09-27T18:30") as a date, or null. A space before the time counts only
 *  where `space` (date() does; a field's text, as in Dataview, doesn't). */
export function parseDate(s: string, space = true): DvDate | null {
  const t = s.trim()
  if (!space && / \d/.test(t)) return null
  const m = DATE.exec(t)
  if (!m || (!m[2] && t.length !== 4)) return null
  if (!m[2]) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (m[4] === undefined) return new DvDate(new Date(y, mo - 1, d).getTime(), false)
  const [h, mi, se, ms] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number((m[7] ?? "0").padEnd(3, "0"))]
  if (m[8]) {
    const z = m[8] === "Z" ? 0 : (m[8][0] === "-" ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2)))
    return new DvDate(Date.UTC(y, mo - 1, d, h, mi, se, ms) - z * 6e4, true)
  }
  return new DvDate(new Date(y, mo - 1, d, h, mi, se, ms).getTime(), true)
}

const UNIT_NAMES: [RegExp, Unit][] = [
  [/^(ms|msecs?|milliseconds?)$/i, "milliseconds"], [/^(s|secs?|seconds?)$/i, "seconds"], [/^(m|mins?|minutes?)$/i, "minutes"],
  [/^(h|hrs?|hours?)$/i, "hours"], [/^(d|days?)$/i, "days"], [/^(w|wks?|weeks?)$/i, "weeks"], [/^(mo|months?)$/i, "months"],
  [/^(y|yrs?|years?)$/i, "years"],
]

/** "3 days 4 hours", "1h 30m", "2 weeks, 1 day" as a duration, or null. */
export function parseDuration(s: string): Duration | null {
  const t = s.trim()
  if (!t) return null
  const parts: Partial<Record<Unit, number>> = {}
  const re = /(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*,?\s*/y
  let at = 0
  while (at < t.length) {
    re.lastIndex = at
    const m = re.exec(t)
    if (!m) return null
    const u = UNIT_NAMES.find(([r]) => r.test(m[2]))?.[1]
    if (!u) return null
    parts[u] = (parts[u] ?? 0) + Number(m[1])
    at = re.lastIndex
  }
  return Object.keys(parts).length ? new Duration(parts) : null
}

const WIKI_ONE = /^(!?)\[\[([^\]|#^]*)([#^][^\]|]*)?(?:\|([^\]]*))?\]\]$/

/** A `[[link]]` written alone as a link (`resolve` turns its target into a path), or null. */
export function parseLink(s: string, resolve?: (t: string) => string | null): Link | null {
  const m = WIKI_ONE.exec(s.trim())
  if (!m) return null
  const target = m[2].trim()
  const sub = m[3] ? m[3].slice(1).trim() : undefined
  const sub2 = m[3]?.startsWith("^") ? `^${sub}` : sub
  const hit = target ? resolve?.(target) ?? null : null
  return new Link(hit ?? target, m[4]?.trim() || undefined, m[1] === "!", sub2 || undefined, !!hit || !resolve)
}

/** A value as Dataview reads a frontmatter string: a date, a duration or a link when it's one, else the text. */
export function fromText(s: string, resolve?: (t: string) => string | null): Value {
  return parseLink(s, resolve) ?? parseDate(s, false) ?? parseDuration(s) ?? s
}

/** Frontmatter as values: strings read as dates, durations and links; YAML's own dates as dates. */
export function fromYaml(v: unknown, resolve?: (t: string) => string | null): Value {
  if (v === null || v === undefined) return null
  if (typeof v === "string") return fromText(v, resolve)
  if (typeof v === "number" || typeof v === "boolean") return v
  if (v instanceof Date) return new DvDate(v.getTime(), v.getUTCHours() + v.getUTCMinutes() + v.getUTCSeconds() !== 0)
  if (Array.isArray(v)) {
    // YAML reads an unquoted [[link]] as a list in a list: [["Alice Park"]].
    return v.map((x) => (Array.isArray(x) && x.length === 1 && Array.isArray(x[0]) && x[0].length === 1 && typeof x[0][0] === "string"
      ? fromText(`[[${x[0][0]}]]`, resolve) : fromYaml(x, resolve)))
  }
  if (typeof v === "object") {
    // A YDate (the app's YAML) or anything with a value that is a date.
    const val = (v as { value?: unknown }).value
    if (typeof val === "string" && Object.keys(v).length <= 1 && parseDate(val)) return parseDate(val)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromYaml(x, resolve)]))
  }
  return String(v)
}

/** An inline field's value (`rating:: 9`, `due:: 2026-10-01`, `with:: [[Alice]], [[Bob]]`), as Dataview reads it. */
export function fromInline(raw: string, resolve?: (t: string) => string | null): Value {
  const s = raw.trim()
  if (!s) return null
  const atom = (x: string): Value | undefined => {
    const t = x.trim()
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true"
    if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return t.slice(1, -1).replace(/\\(.)/g, "$1")
    return parseLink(t, resolve) ?? parseDate(t, false) ?? parseDuration(t) ?? undefined
  }
  const parts = splitTop(s)
  if (parts.length > 1) {
    const list = parts.map(atom)
    if (list.every((x) => x !== undefined)) return list as Value[]
  }
  return atom(s) ?? s
}

/** "a, [[b, c]], d" split on the commas outside brackets and quotes. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0, quote = false, cur = ""
  for (const ch of s) {
    if (ch === '"') quote = !quote
    else if (!quote && (ch === "[" || ch === "(")) depth++
    else if (!quote && (ch === "]" || ch === ")")) depth--
    if (ch === "," && !depth && !quote) { out.push(cur); cur = "" } else cur += ch
  }
  out.push(cur)
  return out
}

/** A key as Dataview also knows it: lower case, formatting out, spaces as dashes ("Due Date" -> due-date). */
export const canonicalKey = (k: string) => k.replace(/[*_~`]/g, "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}\p{Emoji_Presentation}_-]/gu, "")

// ---------- writing values

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** The ISO week and its year (Monday first). */
export function isoWeek(d: Date): [number, number] {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const year = t.getUTCFullYear()
  const first = new Date(Date.UTC(year, 0, 4))
  return [1 + Math.round(((t.getTime() - first.getTime()) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7), year]
}

/** A date written with Luxon's tokens (yyyy-MM-dd, MMMM d, EEE, HH:mm, h:mm a, 'text'), as dateformat() does. */
export function formatDate(v: DvDate, fmt: string): string {
  const d = v.d
  const [week, weekYear] = isoWeek(d)
  const h12 = d.getHours() % 12 || 12
  const tokens: Record<string, () => string> = {
    yyyy: () => String(d.getFullYear()), yy: () => pad(d.getFullYear() % 100), y: () => String(d.getFullYear()),
    kkkk: () => String(weekYear), kk: () => pad(weekYear % 100), WW: () => pad(week), W: () => String(week),
    MMMM: () => MONTHS[d.getMonth()], MMM: () => MONTHS[d.getMonth()].slice(0, 3), MM: () => pad(d.getMonth() + 1), M: () => String(d.getMonth() + 1),
    LLLL: () => MONTHS[d.getMonth()], LLL: () => MONTHS[d.getMonth()].slice(0, 3), LL: () => pad(d.getMonth() + 1), L: () => String(d.getMonth() + 1),
    dd: () => pad(d.getDate()), d: () => String(d.getDate()), o: () => String(Math.round((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 864e5) + 1),
    EEEE: () => DAYS[d.getDay()], EEE: () => DAYS[d.getDay()].slice(0, 3), E: () => String(d.getDay() || 7),
    cccc: () => DAYS[d.getDay()], ccc: () => DAYS[d.getDay()].slice(0, 3), c: () => String(d.getDay() || 7),
    HH: () => pad(d.getHours()), H: () => String(d.getHours()), hh: () => pad(h12), h: () => String(h12),
    mm: () => pad(d.getMinutes()), m: () => String(d.getMinutes()), ss: () => pad(d.getSeconds()), s: () => String(d.getSeconds()),
    SSS: () => pad(d.getMilliseconds(), 3), a: () => (d.getHours() < 12 ? "AM" : "PM"), x: () => String(d.getTime()), X: () => String(Math.floor(d.getTime() / 1000)),
    D: () => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`, DD: () => `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`,
    DDD: () => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`, DDDD: () => `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`,
    t: () => `${h12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`, T: () => `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
  const keys = Object.keys(tokens).sort((a, b) => b.length - a.length)
  let out = "", i = 0
  while (i < fmt.length) {
    if (fmt[i] === "'") {
      const end = fmt.indexOf("'", i + 1)
      out += end < 0 ? fmt.slice(i + 1) : fmt.slice(i + 1, end) || "'"
      i = end < 0 ? fmt.length : end + 1
      continue
    }
    const k = keys.find((t) => fmt.startsWith(t, i))
    if (k) { out += tokens[k](); i += k.length } else out += fmt[i++]
  }
  return out
}

/** durationformat(): S s m h d w M y tokens, counted from the largest the format names; 'text' as written. */
export function formatDuration(v: Duration, fmt: string): string {
  const order: [string, Unit][] = [["y", "years"], ["M", "months"], ["w", "weeks"], ["d", "days"], ["h", "hours"], ["m", "minutes"], ["s", "seconds"], ["S", "milliseconds"]]
  const used = order.filter(([t]) => fmt.replace(/'[^']*'/g, "").includes(t))
  let rest = Math.abs(v.ms)
  const amount: Record<string, number> = {}
  for (const [t, u] of used) { amount[t] = Math.floor(rest / MS[u]); rest -= amount[t] * MS[u] }
  let out = "", i = 0
  while (i < fmt.length) {
    if (fmt[i] === "'") { const end = fmt.indexOf("'", i + 1); out += end < 0 ? fmt.slice(i + 1) : fmt.slice(i + 1, end); i = end < 0 ? fmt.length : end + 1; continue }
    const ch = fmt[i]
    if (ch in amount) { let n = 0; while (fmt[i] === ch) { n++; i++ } out += String(amount[ch]).padStart(n, "0"); continue }
    out += fmt[i++]
  }
  return (v.ms < 0 ? "-" : "") + out
}

/** "2 days, 4 hours": a duration as Dataview writes it. */
export function durationText(v: Duration): string {
  const parts = UNITS.filter((u) => v.parts[u]).map((u) => {
    const n = v.parts[u]!
    const name = Math.abs(n) === 1 ? u.slice(0, -1) : u
    return `${Math.round(n * 1000) / 1000} ${name}`
  })
  return parts.length ? parts.join(", ") : "0 seconds"
}

/** YYYY-MM-DD, with " HH:MM" for a time of day. */
export function dateIso(v: DvDate): string {
  const d = v.d
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return v.time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}${d.getSeconds() ? `:${pad(d.getSeconds())}` : ""}` : day
}

/** A value as Markdown text (agents read results so): links as [[links]], dates as ISO, lists with commas. */
export function toText(v: Value, depth = 0): string {
  if (v === null || v === undefined) return "-"
  if (typeof v === "string") return v
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6)
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "function") return "<function>"
  if (v instanceof Link) return v.markdown()
  if (v instanceof DvDate) return dateIso(v).replace("T", " ")
  if (v instanceof Duration) return durationText(v)
  if (Array.isArray(v)) return depth > 2 ? "[…]" : v.map((x) => toText(x, depth + 1)).join(", ")
  if (isItem(v)) return String(v.text ?? "")
  return depth > 2 ? "{…}" : `{${Object.entries(v as Record<string, Value>).map(([k, x]) => `${k}: ${toText(x, depth + 1)}`).join(", ")}}`
}

/** A list item or task of the index (file.lists, file.tasks): drawn as its text. */
export const isItem = (v: Value): v is Record<string, Value> => isObject(v) && typeof v.text === "string" && typeof v.task === "boolean" && typeof v.symbol === "string"

// ---------- JSON for the app: what a result's values are, drawn by the app's view

export type Wire = null | number | string | boolean | Wire[] | { $: "link"; path: string; display?: string; embed?: boolean; sub?: string; exists: boolean }
  | { $: "date"; iso: string; time: boolean } | { $: "dur"; text: string } | { $: "obj"; v: Record<string, Wire> }
  | { $: "item"; text: string; status: string | null; path: string; line: number } | { $: "fn" }

export function toWire(v: Value, depth = 0): Wire {
  if (v === null || v === undefined) return null
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v)
  if (typeof v === "string" || typeof v === "boolean") return v
  if (typeof v === "function") return { $: "fn" }
  if (v instanceof Link) return { $: "link", path: v.path, ...(v.display ? { display: v.display } : {}), ...(v.embed ? { embed: true } : {}), ...(v.subpath ? { sub: v.subpath } : {}), exists: v.exists }
  if (v instanceof DvDate) return { $: "date", iso: dateIso(v), time: v.time }
  if (v instanceof Duration) return { $: "dur", text: durationText(v) }
  if (depth > 4) return toText(v)
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => toWire(x, depth + 1))
  if (isItem(v)) return { $: "item", text: String(v.text), status: v.task ? String(v.status ?? " ") : null, path: String(v.path ?? ""), line: Number(v.line ?? 0) }
  return { $: "obj", v: Object.fromEntries(Object.entries(v as Record<string, Value>).slice(0, 50).map(([k, x]) => [k, toWire(x, depth + 1)])) }
}
