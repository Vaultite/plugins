// A task line as Obsidian Tasks writes it: `- [ ] Call Alice ⏫ 🔁 every week 📅 2026-10-08`, or with Dataview's
// fields (`[due:: 2026-10-08]`). Parsed from the end, as Tasks does; edits change only the field they're about.
import { type Day, isDay } from "./dates.ts"
import { nextDate, parseRule } from "./recur.ts"

export type StatusType = "TODO" | "DONE" | "IN_PROGRESS" | "CANCELLED" | "NON_TASK"
export type Priority = "highest" | "high" | "medium" | "none" | "low" | "lowest"
export const PRIORITIES: Priority[] = ["highest", "high", "medium", "none", "low", "lowest"]
export type DateKey = "created" | "start" | "scheduled" | "due" | "cancelled" | "done"
export const DATE_KEYS: DateKey[] = ["created", "start", "scheduled", "due", "cancelled", "done"]
export type Key = DateKey | "priority" | "recurrence" | "onCompletion" | "id" | "dependsOn"
export type Format = "emoji" | "dataview"

/** What follows the description: a field or a trailing #tag, with the spaces before it, as written. */
type Token = { key: Key | "tag"; value: string; text: string }

export type Task = {
  /** What's before the list marker: indentation, a quote's `>`. */
  indent: string
  marker: string
  symbol: string
  status: StatusType
  /** The text before the fields, without the global filter's tag removed. */
  description: string
  tokens: Token[]
  /** A trailing ` ^block-id`. */
  blockLink: string
  priority: Priority
  dates: Partial<Record<DateKey, string>>
  recurrence: string
  onCompletion: string
  id: string
  dependsOn: string[]
  tags: string[]
  /** The format its fields are in (null: none yet). */
  format: Format | null
}

export const LINE = /^([\s>]*)([-*+]|\d+[.)])[ \t]+\[(.)\](?:[ \t]+(.*?))?[ \t]*$/

export function statusOf(symbol: string): StatusType {
  if (symbol === "x" || symbol === "X") return "DONE"
  if (symbol === "/") return "IN_PROGRESS"
  if (symbol === "-") return "CANCELLED"
  return "TODO"
}
export const STATUS_NAMES: Record<StatusType, string> = { TODO: "Todo", DONE: "Done", IN_PROGRESS: "In progress", CANCELLED: "Cancelled", NON_TASK: "Non-task" }
export const isDone = (t: { status: StatusType }) => t.status === "DONE" || t.status === "CANCELLED" || t.status === "NON_TASK"

const PRIO_EMOJI: Record<string, Priority> = { "🔺": "highest", "⏫": "high", "🔼": "medium", "🔽": "low", "⏬": "lowest" }
const EMOJI_OF: Record<Priority, string> = { highest: "🔺", high: "⏫", medium: "🔼", none: "", low: "🔽", lowest: "⏬" }
const DATE_EMOJI: Record<DateKey, string> = { created: "➕", start: "🛫", scheduled: "⏳", due: "📅", cancelled: "❌", done: "✅" }
const VS = "\\uFE0F?"
const ID = "[a-zA-Z0-9_-]+"
/** Each field written the emoji way, at the end of what's left: [key, pattern, value group]. */
const EMOJI_FIELDS: [Key, RegExp][] = [
  ["priority", new RegExp(`\\s*(🔺|⏫|🔼|🔽|⏬)${VS}$`, "u")],
  ["done", new RegExp(`\\s*✅${VS}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u")],
  ["cancelled", new RegExp(`\\s*❌${VS}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u")],
  ["due", new RegExp(`\\s*(?:📅|📆|🗓)${VS}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u")],
  ["scheduled", new RegExp(`\\s*(?:⏳|⌛)${VS}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u")],
  ["start", new RegExp(`\\s*🛫${VS}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u")],
  ["created", new RegExp(`\\s*➕${VS}\\s*(\\d{4}-\\d{2}-\\d{2})$`, "u")],
  ["recurrence", new RegExp(`\\s*🔁${VS}\\s*([a-zA-Z0-9, !]+)$`, "u")],
  ["onCompletion", new RegExp(`\\s*🏁${VS}\\s*([a-zA-Z]+)$`, "u")],
  ["id", new RegExp(`\\s*🆔${VS}\\s*(${ID})$`, "u")],
  ["dependsOn", new RegExp(`\\s*⛔${VS}\\s*(${ID}(?:\\s*,\\s*${ID})*)$`, "u")],
]
const DV_KEYS: Record<string, Key> = {
  due: "due", scheduled: "scheduled", start: "start", created: "created", completion: "done", cancelled: "cancelled",
  priority: "priority", repeat: "recurrence", oncompletion: "onCompletion", id: "id", dependson: "dependsOn",
}
const DV_NAME: Record<Key, string> = {
  due: "due", scheduled: "scheduled", start: "start", created: "created", done: "completion", cancelled: "cancelled",
  priority: "priority", recurrence: "repeat", onCompletion: "onCompletion", id: "id", dependsOn: "dependsOn",
}
const DV_FIELD = /\s*[[(]\s*([a-zA-Z]+)\s*::\s*([^\])]*?)\s*[\])]$/
const TAG_END = /(^|\s+)(#[^\s!@#$%^&*(),.?":{}|<>]+)$/u
const BLOCK_LINK = /\s+(\^[a-zA-Z0-9-]+)$/

/** A line as a task, or null when it isn't a checkbox item. */
export function parseTask(line: string): Task | null {
  const m = LINE.exec(line)
  if (!m) return null
  const [, indent, marker, symbol] = m
  let rest = m[4] ?? ""
  let blockLink = ""
  const bl = BLOCK_LINK.exec(rest)
  if (bl) { blockLink = rest.slice(bl.index); rest = rest.slice(0, bl.index) }
  const tokens: Token[] = []
  let format: Format | null = null
  for (let runs = 0; runs < 40; runs++) {
    let hit: Token | null = null
    for (const [key, re] of EMOJI_FIELDS) {
      const f = re.exec(rest)
      if (f) {
        hit = { key, value: f[1], text: rest.slice(f.index) }
        format ??= "emoji"
        rest = rest.slice(0, f.index)
        break
      }
    }
    if (!hit) {
      const f = DV_FIELD.exec(rest)
      const key = f && DV_KEYS[f[1].toLowerCase()]
      if (f && key) {
        hit = { key, value: f[2], text: rest.slice(f.index) }
        format ??= "dataview"
        rest = rest.slice(0, f.index)
      }
    }
    if (!hit) {
      // Tags mixed in with the fields stay where they are (a small edit keeps them there).
      const f = TAG_END.exec(rest)
      if (f) { hit = { key: "tag", value: f[2], text: rest.slice(f.index) }; rest = rest.slice(0, f.index) }
    }
    if (!hit) break
    tokens.unshift(hit)
  }
  // Trailing tags before any field belong to the description after all.
  while (tokens.length && tokens[0].key === "tag") rest += tokens.shift()!.text
  const t: Task = {
    indent, marker, symbol, status: statusOf(symbol), description: rest, tokens, blockLink,
    priority: "none", dates: {}, recurrence: "", onCompletion: "", id: "", dependsOn: [], tags: [], format,
  }
  for (const tok of tokens) read(t, tok)
  t.tags = tagsIn(t.description + tokens.filter((x) => x.key === "tag").map((x) => x.text).join(""))
  return t
}

function read(t: Task, tok: Token) {
  const v = tok.value.trim()
  switch (tok.key) {
    case "tag": return
    case "priority": t.priority = PRIO_EMOJI[v.replace(/️/g, "")] ?? (PRIORITIES.includes(v.toLowerCase() as Priority) ? v.toLowerCase() as Priority : "none"); return
    case "recurrence": t.recurrence = v; return
    case "onCompletion": t.onCompletion = v.toLowerCase(); return
    case "id": t.id = v; return
    case "dependsOn": t.dependsOn = v.split(",").map((x) => x.trim()).filter(Boolean); return
    default: t.dates[tok.key] = v
  }
}

const TAGS = /(?:^|\s)(#[^\s!@#$%^&*(),.?":{}|<>]+)/gu
export const tagsIn = (s: string) => [...s.matchAll(TAGS)].map((m) => m[1]).filter((x) => !/^#\d+$/.test(x))

/** The description with its trailing tags (what Tasks calls the description). */
export const fullDescription = (t: Task) => (t.description + t.tokens.filter((x) => x.key === "tag").map((x) => x.text).join("")).trim()

export function serialize(t: Task): string {
  const body = t.description + t.tokens.map((x) => x.text).join("") + t.blockLink
  return `${t.indent}${t.marker} [${t.symbol}]${body ? ` ${body.replace(/^\s+/, "")}` : ""}`
}

function fieldText(key: Key, value: string, format: Format): string {
  if (format === "dataview") return `[${DV_NAME[key]}:: ${value}]`
  if (key === "priority") return EMOJI_OF[value as Priority]
  if (key in DATE_EMOJI) return `${DATE_EMOJI[key as DateKey]} ${value}`
  const sym = { recurrence: "🔁", onCompletion: "🏁", id: "🆔", dependsOn: "⛔" }[key as string]
  return `${sym} ${value}`
}
/** Where Tasks puts each field, for one added to a task that has none of it. */
const ORDER: Key[] = ["id", "dependsOn", "priority", "recurrence", "onCompletion", "created", "start", "scheduled", "due", "cancelled", "done"]

/** A copy with one field changed in place, added after the fields Tasks puts before it, or removed ("" or none). */
export function withField(t: Task, key: Key, value: string, format: Format = t.format ?? "emoji"): Task {
  const fmt = t.format ?? format
  const out: Task = { ...t, tokens: [...t.tokens], dates: { ...t.dates }, format: t.format ?? (value ? fmt : null) }
  const empty = !value || (key === "priority" && value === "none")
  const at = out.tokens.findIndex((x) => x.key === key)
  if (empty) {
    if (at >= 0) out.tokens.splice(at, 1)
  } else if (at >= 0) {
    const lead = /^\s*/.exec(out.tokens[at].text)![0] || " "
    out.tokens[at] = { key, value, text: lead + fieldText(key, value, fmt) }
  } else {
    const rank = ORDER.indexOf(key)
    let i = out.tokens.length
    while (i > 0 && out.tokens[i - 1].key !== "tag" && ORDER.indexOf(out.tokens[i - 1].key as Key) > rank) i--
    // Dataview's fields are kept apart by two spaces, as Tasks writes them.
    const sep = fmt === "dataview" ? "  " : " "
    out.tokens.splice(i, 0, { key, value, text: sep + fieldText(key, value, fmt) })
  }
  out.priority = "none"; out.dates = {}; out.recurrence = ""; out.onCompletion = ""; out.id = ""; out.dependsOn = []
  for (const tok of out.tokens) read(out, tok)
  return out
}

export const withStatus = (t: Task, symbol: string): Task => ({ ...t, symbol, status: statusOf(symbol) })

export type Prefs = { doneDate: boolean; cancelledDate: boolean; createdDate: boolean; recurrenceBelow: boolean; format: Format }
export const DEFAULT_PREFS: Prefs = { doneDate: true, cancelledDate: true, createdDate: false, recurrenceBelow: false, format: "emoji" }

/** What a click does to a status: done is undone, cancelled starts again, anything else is done. */
export const toggled = (symbol: string) => (statusOf(symbol) === "DONE" || statusOf(symbol) === "CANCELLED" ? " " : "x")

/** The lines a task's line becomes when its status changes: the done (or cancelled) date written, and a recurring
 *  task's next occurrence added above it (below with `recurrenceBelow`); `🏁 delete` drops the done one. */
export function changeStatus(line: string, symbol: string, today: Day, prefs: Prefs = DEFAULT_PREFS): string[] {
  const t = parseTask(line)
  if (!t) return [line]
  const to = statusOf(symbol), was = t.status
  let done = withStatus(t, symbol)
  if (to === "DONE") {
    if (prefs.doneDate && !done.dates.done) done = withField(done, "done", today, prefs.format)
    done = withField(done, "cancelled", "")
  } else if (to === "CANCELLED") {
    if (prefs.cancelledDate && !done.dates.cancelled) done = withField(done, "cancelled", today, prefs.format)
    done = withField(done, "done", "")
  } else {
    done = withField(withField(done, "done", ""), "cancelled", "")
  }
  const out = [serialize(done)]
  if (to === "DONE" && was !== "DONE" && t.recurrence) {
    const next = nextOccurrence(t, today, prefs)
    if (next) {
      if (prefs.recurrenceBelow) out.push(serialize(next)); else out.unshift(serialize(next))
    }
  }
  if (to === "DONE" && t.onCompletion === "delete") out.splice(out.indexOf(serialize(done)), 1)
  return out
}

/** A recurring task's next one: its dates moved on by its rule (from its due, else scheduled, else start date; from
 *  today when done), not done, with no block link (that names the old one). null when the rule isn't understood. */
export function nextOccurrence(t: Task, today: Day, prefs: Prefs = DEFAULT_PREFS): Task | null {
  const rule = parseRule(t.recurrence)
  if (!rule) return null
  const ref = (["due", "scheduled", "start"] as DateKey[]).find((k) => isDay(t.dates[k]))
  let n: Task = { ...withStatus(t, " "), blockLink: "" }
  n = withField(withField(n, "done", ""), "cancelled", "")
  n = withField(n, "created", prefs.createdDate ? today : "")
  if (ref) {
    const base = rule.whenDone ? today : t.dates[ref]!
    const to = nextDate(rule, base)
    const shift = Math.round((Date.parse(to) - Date.parse(t.dates[ref]!)) / 86_400_000)
    for (const k of ["start", "scheduled", "due"] as DateKey[]) {
      const d = t.dates[k]
      if (isDay(d)) n = withField(n, k, new Date(Date.parse(d) + shift * 86_400_000).toISOString().slice(0, 10))
    }
  }
  return n
}

/** A new task's line, its fields in Tasks' order. */
export function newTaskLine(description: string, fields: Partial<Record<Key, string>>, format: Format, indent = ""): string {
  let t = parseTask(`${indent}- [ ] ${description.trim()}`)!
  for (const k of ORDER) if (fields[k]) t = withField(t, k, fields[k]!, format)
  return serialize(t)
}
