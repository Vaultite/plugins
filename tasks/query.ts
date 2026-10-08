// Tasks' query language (```tasks blocks): one instruction a line, filters combined with AND / OR / XOR / NOT,
// then sort by, group by, limit and how results look. Run on the server; the app draws what it answers.
import { type Day, daysBetween, isDay, spanOf, WEEKDAYS, type Span } from "./dates.ts"
import type { Found } from "./scan.ts"
import { DATE_KEYS, fullDescription, isDone, PRIORITIES, type DateKey, type Priority, type StatusType, STATUS_NAMES } from "./task.ts"

export type Ctx = { today: Day; blocked: (t: Found) => boolean; blocking: (t: Found) => boolean }
type Test = (t: Found, ctx: Ctx) => boolean
export type Filter = { line: string; explain: string; test: Test }
type Key = string | number | null
type Sorter = { line: string; key: (t: Found, ctx: Ctx) => Key; desc?: boolean; reverse: boolean }
type Grouper = { line: string; keys: (t: Found, ctx: Ctx) => { key: Key; name: string }[]; reverse: boolean }

/** What a result shows of each task; names as in `hide <name>` (spaces as they're written). */
export type Layout = { short: boolean; hide: string[] }
export type Query = {
  filters: Filter[]; sorts: Sorter[]; groups: Grouper[]; limit: number | null; groupLimit: number | null
  layout: Layout; explain: boolean; ignoreGlobal: boolean; problems: string[]
}

export const COMPONENTS = ["edit button", "backlink", "task count", "priority", "recurrence rule", "on completion", "due date", "scheduled date",
  "start date", "created date", "done date", "cancelled date", "tags", "id", "depends on", "urgency", "tree", "postpone button", "toolbar"]

// ---------- the task's values

const DATE_NAMES: Record<string, DateKey | "happens"> = {
  due: "due", scheduled: "scheduled", start: "start", starts: "start", created: "created", done: "done", cancelled: "cancelled", happens: "happens",
}
const happens = (t: Found) => (["start", "scheduled", "due"] as DateKey[]).map((k) => t.dates[k]).filter(isDay).sort()[0]
const dateOf = (t: Found, k: DateKey | "happens") => (k === "happens" ? happens(t) : t.dates[k])

/** Tasks' urgency score: due date, scheduled, start and priority weighed. */
export function urgency(t: Found, today: Day): number {
  let u = 0
  if (isDay(t.dates.due)) {
    const over = daysBetween(t.dates.due!, today)
    u += 12 * (over >= 7 ? 1 : over >= -14 ? ((over + 14) * 0.8) / 21 + 0.2 : 0.2)
  }
  if (isDay(t.dates.scheduled) && t.dates.scheduled! <= today) u += 5
  if (isDay(t.dates.start) && t.dates.start! > today) u -= 3
  u += { highest: 9, high: 6, medium: 3.9, none: 1.95, low: 0, lowest: -1.8 }[t.priority]
  return Math.round(u * 100) / 100
}

const STATUS_ORDER: StatusType[] = ["IN_PROGRESS", "TODO", "DONE", "CANCELLED", "NON_TASK"]
const file = (t: Found) => t.path.split("/").pop()!.replace(/\.md$/, "")
const folder = (t: Found) => (t.path.includes("/") ? `${t.path.slice(0, t.path.lastIndexOf("/"))}/` : "/")
const root = (t: Found) => (t.path.includes("/") ? `${t.path.split("/")[0]}/` : "/")
const TEXTS: Record<string, (t: Found) => string | string[]> = {
  description: (t) => fullDescription(t),
  path: (t) => t.path.replace(/\.md$/, ""),
  filename: (t) => `${file(t)}.md`,
  folder, root,
  heading: (t) => t.heading,
  tag: (t) => t.tags, tags: (t) => t.tags,
  recurrence: (t) => t.recurrence,
  id: (t) => t.id,
  "status.name": (t) => STATUS_NAMES[t.status],
  "status.type": (t) => t.status,
}
const PRIO: Record<string, Priority> = { highest: "highest", high: "high", medium: "medium", normal: "none", none: "none", low: "low", lowest: "lowest" }
const rank = (p: Priority) => PRIORITIES.indexOf(p)

// ---------- parsing

function filterOf(line: string, today: Day): Filter | string {
  const s = line.trim(), low = s.toLowerCase()
  const f = (explain: string, test: Test): Filter => ({ line: s, explain, test })
  if (low === "done") return f("done", (t) => isDone(t))
  if (low === "not done") return f("not done", (t) => !isDone(t))
  if (low === "is recurring") return f("is recurring", (t) => !!t.recurrence)
  if (low === "is not recurring") return f("is not recurring", (t) => !t.recurrence)
  if (low === "is blocked") return f("is blocked", (t, c) => c.blocked(t))
  if (low === "is not blocked") return f("is not blocked", (t, c) => !c.blocked(t))
  if (low === "is blocking") return f("is blocking", (t, c) => c.blocking(t))
  if (low === "is not blocking") return f("is not blocking", (t, c) => !c.blocking(t))
  if (low === "exclude sub-items") return f("not indented", (t) => !/[ \t]/.test(t.indent.replace(/^(\s*>\s?)*/, "")))
  if (low === "has id") return f("has an id", (t) => !!t.id)
  if (low === "no id") return f("has no id", (t) => !t.id)
  if (low === "has depends on") return f("depends on another", (t) => t.dependsOn.length > 0)
  if (low === "no depends on") return f("depends on none", (t) => !t.dependsOn.length)
  let m = /^(has|no) (due|scheduled|start|created|done|cancelled|happens) dates?$/.exec(low)
  if (m) {
    const k = DATE_NAMES[m[2]], want = m[1] === "has"
    return f(`${m[1]} ${m[2]} date`, (t) => isDay(dateOf(t, k)) === want)
  }
  if ((m = /^(due|scheduled|start|created|done|cancelled) date is invalid$/.exec(low))) {
    const k = m[1] as DateKey
    return f(low, (t) => !!t.dates[k] && !isDay(t.dates[k]))
  }
  if ((m = /^(due|scheduled|starts?|created|done|cancelled|happens)(?: (before|after|on or before|on or after|on|in))? (.+)$/.exec(low))) {
    const k = DATE_NAMES[m[1]], rel = m[2] ?? "on", span = spanOf(m[3], today)
    if (!span) return `can't read the date "${s.slice(s.length - m[3].length)}"`
    const name = m[1] === "starts" ? "start" : m[1]
    const test = within(rel, span)
    const explain = `${name} date ${describe(rel, span)}`
    // A task without a start date can be started any time, so it matches every starts filter (as in Tasks).
    if (k === "start") return f(explain, (t) => !t.dates.start || (isDay(t.dates.start) && test(t.dates.start)))
    if (k === "happens") return f(explain, (t) => (["start", "scheduled", "due"] as DateKey[]).some((d) => isDay(t.dates[d]) && test(t.dates[d]!)))
    return f(explain, (t) => isDay(t.dates[k]) && test(t.dates[k]!))
  }
  if ((m = /^priority is (?:(above|below|not) )?(\w+)(?: priority)?$/.exec(low))) {
    const p = PRIO[m[2]]
    if (!p) return `there's no priority "${m[2]}" (highest, high, medium, normal, low, lowest)`
    const op = m[1]
    return f(`priority is ${op ? `${op} ` : ""}${m[2]}`, (t) => (op === "above" ? rank(t.priority) < rank(p) : op === "below" ? rank(t.priority) > rank(p) : op === "not" ? t.priority !== p : t.priority === p))
  }
  if ((m = /^status\.type is (not )?(\w+)$/.exec(low))) {
    const want = m[2].toUpperCase() as StatusType
    if (!STATUS_ORDER.includes(want)) return `there's no status type "${m[2]}" (TODO, IN_PROGRESS, DONE, CANCELLED)`
    return f(low, (t) => (t.status === want) !== !!m![1])
  }
  if ((m = /^(description|path|filename|folder|root|heading|tags?|recurrence|id|status\.name|status\.type) (includes?|does not include|do not include|regex matches|regex does not match|is not|is) (.*)$/i.exec(s))) {
    m[1] = m[1].toLowerCase(); m[2] = m[2].toLowerCase()
    const get = TEXTS[m[1]], op = m[2], raw = m[3]
    const neg = /not/.test(op)
    if (op.startsWith("regex")) {
      const r = /^\/(.*)\/([a-z]*)$/.exec(raw.trim())
      if (!r) return `a regex is written /like this/i`
      let re: RegExp
      try { re = new RegExp(r[1], r[2].replace(/[^imsu]/g, "")) } catch (e) { return `the regex doesn't parse: ${(e as Error).message}` }
      return f(`${m[1]} ${op} ${raw.trim()}`, (t) => { const v = get(t); return (Array.isArray(v) ? v.some((x) => re.test(x)) : re.test(v)) !== neg })
    }
    const want = raw.trim().toLowerCase()
    const tagged = m[1].startsWith("tag")
    const has = (v: string) => {
      const x = v.toLowerCase()
      if (op.startsWith("is")) return x === want
      // A tag includes its nested ones: #work matches #work/meetings.
      return tagged && !want.startsWith("#") ? x.replace(/^#/, "").includes(want) : x.includes(want)
    }
    return f(`${m[1]} ${op} ${raw.trim()}`, (t) => { const v = get(t); return (Array.isArray(v) ? v.some(has) : has(v)) !== neg })
  }
  return `don't understand "${s}"`
}

const within = (rel: string, s: Span) => (d: Day) => {
  switch (rel) {
    case "before": return d < s.from!
    case "after": return d > s.to!
    case "on or before": return d <= s.to!
    case "on or after": return d >= s.from!
    default: return d >= s.from! && d <= s.to!
  }
}
const describe = (rel: string, s: Span) => {
  const one = s.from === s.to
  switch (rel) {
    case "before": return `is before ${s.from}`
    case "after": return `is after ${s.to}`
    case "on or before": return `is on or before ${s.to}`
    case "on or after": return `is on or after ${s.from}`
    default: return one ? `is on ${s.from} (${WEEKDAYS[new Date(`${s.from}T00:00:00Z`).getUTCDay()].replace(/^./, (c) => c.toUpperCase())})` : `is between ${s.from} and ${s.to} inclusive`
  }
}

// Boolean combinations: (a) AND (b), NOT (c), (a) OR [b] XOR "c"; NOT binds tightest, then AND, XOR, OR.
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"' }
type Tok = { op: string } | { operand: string }
function tokens(s: string): Tok[] | string {
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (OPEN[c]) {
      const close = OPEN[c]
      let j = i
      if (c === close) j = s.indexOf(close, i + 1)
      else for (let depth = 0; j < s.length; j++) {
        if (s[j] === c) depth++
        else if (s[j] === close && --depth === 0) break
      }
      if (j < 0 || j >= s.length) return `a ${c} isn't closed`
      out.push({ operand: s.slice(i + 1, j) })
      i = j + 1
      continue
    }
    const w = /^(AND|OR|XOR|NOT)\b/.exec(s.slice(i))
    if (!w) return `expected AND, OR, XOR or NOT at "${s.slice(i, i + 20)}"`
    out.push({ op: w[1] })
    i += w[1].length
  }
  return out
}
const looksBoolean = (s: string) => /^\s*(NOT\s*)?[([{"]/.test(s) && /[)\]}"]\s*$/.test(s)

function booleanOf(line: string, today: Day): Filter | string {
  const toks = tokens(line)
  if (typeof toks === "string") return toks
  let i = 0
  const operand = (s: string): Filter | string => (/^\s*(NOT\b|[([{"])/.test(s) ? booleanOf(s, today) : filterOf(s, today))
  const unary = (): Filter | string => {
    const t = toks[i++]
    if (!t) return "an operator is missing its filter"
    if ("op" in t) {
      if (t.op !== "NOT") return `${t.op} needs a filter before it`
      const x = unary()
      if (typeof x === "string") return x
      return { line, explain: `NOT (${x.explain})`, test: (task, c) => !x.test(task, c) }
    }
    return operand(t.operand)
  }
  const binary = (ops: string[], next: () => Filter | string) => (): Filter | string => {
    let a = next()
    while (typeof a !== "string" && i < toks.length) {
      const t = toks[i]
      if (!("op" in t) || !ops.includes(t.op)) break
      i++
      // AND NOT / OR NOT
      const b = next()
      if (typeof b === "string") return b
      const l = a, op = t.op
      a = {
        line, explain: `(${l.explain}) ${op} (${b.explain})`,
        test: op === "AND" ? (x, c) => l.test(x, c) && b.test(x, c) : op === "OR" ? (x, c) => l.test(x, c) || b.test(x, c) : (x, c) => l.test(x, c) !== b.test(x, c),
      }
    }
    return a
  }
  const and = binary(["AND"], unary), xor = binary(["XOR"], and), or = binary(["OR"], xor)
  const r = or()
  if (typeof r !== "string" && i < toks.length) return `don't understand "${line.trim()}"`
  return typeof r === "string" ? r : { ...r, line: line.trim() }
}

// ---------- sorting and grouping

const PRIO_NAMES: Record<Priority, string> = { highest: "Highest priority", high: "High priority", medium: "Medium priority", none: "Normal priority", low: "Low priority", lowest: "Lowest priority" }
const dayName = (d: Day) => `${d} ${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()].replace(/^./, (c) => c.toUpperCase())}`

function sortKey(prop: string): ((t: Found, c: Ctx) => Key) | null {
  if (DATE_NAMES[prop]) { const k = DATE_NAMES[prop]; return (t) => (isDay(dateOf(t, k)) ? dateOf(t, k)! : null) }
  switch (prop) {
    case "status": return (t) => (isDone(t) ? 1 : 0)
    case "status.type": return (t) => STATUS_ORDER.indexOf(t.status)
    case "status.name": return (t) => STATUS_NAMES[t.status].toLowerCase()
    case "priority": return (t) => rank(t.priority)
    case "urgency": return (t, c) => -urgency(t, c.today)
    case "description": return (t) => fullDescription(t).replace(/^[\s*_~=`[\]]+/, "").toLowerCase()
    case "path": return (t) => t.path.toLowerCase()
    case "filename": return (t) => file(t).toLowerCase()
    case "heading": return (t) => (t.heading ? t.heading.toLowerCase() : null)
    case "tag": case "tags": return (t) => t.tags[0]?.toLowerCase() ?? null
    case "id": return (t) => t.id || null
    case "recurring": return (t) => (t.recurrence ? 0 : 1)
    case "random": return (t) => hash(fullDescription(t))
  }
  return null
}
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

function groupKeys(prop: string): ((t: Found, c: Ctx) => { key: Key; name: string }[]) | null {
  const one = (key: Key, name: string) => [{ key, name }]
  if (DATE_NAMES[prop]) {
    const k = DATE_NAMES[prop], label = prop === "starts" ? "start" : prop
    return (t) => {
      const d = dateOf(t, k)
      if (d && !isDay(d)) return one("~1", `Invalid ${label} date`)
      return d ? one(d, dayName(d)) : one("~2", `No ${label} date`)
    }
  }
  switch (prop) {
    case "filename": return (t) => one(file(t).toLowerCase(), file(t))
    case "path": return (t) => one(t.path.toLowerCase(), t.path.replace(/\.md$/, ""))
    case "folder": return (t) => one(folder(t).toLowerCase(), folder(t))
    case "root": return (t) => one(root(t).toLowerCase(), root(t))
    case "heading": return (t) => (t.heading ? one(t.heading.toLowerCase(), t.heading) : one("~", "(No heading)"))
    case "backlink": return (t) => { const n = t.heading ? `${file(t)} > ${t.heading}` : file(t); return one(n.toLowerCase(), n) }
    case "status": return (t) => (isDone(t) ? one(1, "Done") : one(0, "Todo"))
    case "status.type": return (t) => one(STATUS_ORDER.indexOf(t.status), STATUS_NAMES[t.status])
    case "status.name": return (t) => one(STATUS_NAMES[t.status].toLowerCase(), STATUS_NAMES[t.status])
    case "priority": return (t) => one(rank(t.priority), PRIO_NAMES[t.priority])
    case "tags": case "tag": return (t) => (t.tags.length ? t.tags.map((x) => ({ key: x.toLowerCase(), name: x })) : one("~", "(No tags)"))
    case "recurring": return (t) => (t.recurrence ? one(0, "Recurring") : one(1, "Not recurring"))
    case "recurrence": return (t) => (t.recurrence ? one(t.recurrence.toLowerCase(), t.recurrence) : one("~", "None"))
    case "urgency": return (t, c) => { const u = urgency(t, c.today); return one(-u, u.toFixed(2)) }
    case "id": return (t) => (t.id ? one(t.id, t.id) : one("~", "No id"))
  }
  return null
}

function cmp(a: Key, b: Key): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : 1
}

// ---------- the whole query

/** A query from a block's text; `file` fills {{query.file.path}} and the like; `global` is the global query. */
export function parseQuery(text: string, today: Day, file = "", global = ""): Query {
  const q: Query = { filters: [], sorts: [], groups: [], limit: null, groupLimit: null, layout: { short: false, hide: ["urgency"] }, explain: false, ignoreGlobal: false, problems: [] }
  const vars: Record<string, string> = {
    "query.file.path": file, "query.file.pathWithoutExtension": file.replace(/\.md$/, ""), "query.file.filename": file.split("/").pop() ?? "",
    "query.file.filenameWithoutExtension": (file.split("/").pop() ?? "").replace(/\.md$/, ""),
    "query.file.folder": file.includes("/") ? `${file.slice(0, file.lastIndexOf("/"))}/` : "/", "query.file.root": file.includes("/") ? `${file.split("/")[0]}/` : "/",
  }
  const lines = joinLines(text)
  if (!lines.some((l) => l.trim().toLowerCase() === "ignore global query") && global.trim()) lines.unshift(...joinLines(global))
  for (const raw of lines) {
    const line = raw.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k) => vars[k] ?? all).trim()
    if (!line || line.startsWith("#")) continue
    const low = line.toLowerCase().replace(/\s+/g, " ")
    let m: RegExpExecArray | null
    if (low === "explain") { q.explain = true; continue }
    if (low === "ignore global query") { q.ignoreGlobal = true; continue }
    if (low === "short mode" || low === "short") { q.layout.short = true; continue }
    if (low === "full mode" || low === "full") { q.layout.short = false; continue }
    if ((m = /^(hide|show) (.+)$/.exec(low))) {
      const what = m[2].replace(/^backlinks$/, "backlink").replace(/ dates$/, " date")
      if (!COMPONENTS.includes(what)) { q.problems.push(`don't know what to ${m[1]}: "${m[2]}"`); continue }
      q.layout.hide = m[1] === "hide" ? [...new Set([...q.layout.hide, what])] : q.layout.hide.filter((x) => x !== what)
      continue
    }
    if ((m = /^limit (groups )?(?:to )?(\d+)(?: tasks?)?$/.exec(low))) { if (m[1]) q.groupLimit = +m[2]; else q.limit = +m[2]; continue }
    if ((m = /^sort by ([\w.]+)( reverse)?$/.exec(low))) {
      const key = sortKey(m[1])
      if (!key) { q.problems.push(`can't sort by "${m[1]}"`); continue }
      q.sorts.push({ line, key, reverse: !!m[2] })
      continue
    }
    if ((m = /^group by ([\w.]+)( reverse)?$/.exec(low))) {
      const keys = groupKeys(m[1])
      if (!keys) { q.problems.push(`can't group by "${m[1]}"`); continue }
      q.groups.push({ line, keys, reverse: !!m[2] })
      continue
    }
    const f = looksBoolean(line) ? booleanOf(line, today) : filterOf(line, today)
    if (typeof f === "string") q.problems.push(f); else q.filters.push(f)
  }
  return q
}
function joinLines(text: string): string[] {
  const out: string[] = []
  let cur = ""
  for (const l of text.split("\n")) {
    if (/\\\s*$/.test(l)) { cur += l.replace(/\\\s*$/, " "); continue }
    out.push(cur + l)
    cur = ""
  }
  if (cur) out.push(cur)
  return out
}

export type Group = { names: string[]; tasks: Found[] }
export type Result = { groups: Group[]; total: number; shown: number; layout: Layout; explain: string | null; problems: string[] }

const DEFAULT_SORT = ["status", "urgency", "due", "priority", "path"]

/** Runs a query over every task: `all` is the vault's tasks (for dependencies too). */
export function runQuery(q: Query, all: Found[], today: Day): Result {
  const byId = new Map<string, Found[]>()
  for (const t of all) if (t.id) byId.set(t.id, [...(byId.get(t.id) ?? []), t])
  const waitedOn = new Set<string>()
  for (const t of all) if (!isDone(t)) for (const d of t.dependsOn) waitedOn.add(d)
  const ctx: Ctx = {
    today,
    blocked: (t) => !isDone(t) && t.dependsOn.some((d) => (byId.get(d) ?? []).some((x) => !isDone(x))),
    blocking: (t) => !isDone(t) && !!t.id && waitedOn.has(t.id),
  }
  if (q.problems.length) return { groups: [], total: 0, shown: 0, layout: q.layout, explain: q.explain ? explainText(q) : null, problems: q.problems }
  let hits = all.filter((t) => q.filters.every((f) => f.test(t, ctx)))
  const sorts = [...q.sorts.map((s) => ({ key: s.key, reverse: s.reverse })), ...DEFAULT_SORT.map((p) => ({ key: sortKey(p)!, reverse: false }))]
  const keyed = hits.map((t) => ({ t, keys: sorts.map((s) => s.key(t, ctx)) }))
  keyed.sort((a, b) => {
    for (let i = 0; i < sorts.length; i++) {
      const c = cmp(a.keys[i], b.keys[i])
      if (c) return sorts[i].reverse ? -c : c
    }
    return a.t.path === b.t.path ? a.t.line - b.t.line : a.t.path < b.t.path ? -1 : 1
  })
  hits = keyed.map((x) => x.t)
  const total = hits.length
  if (q.limit !== null) hits = hits.slice(0, q.limit)
  let groups: Group[]
  if (!q.groups.length) groups = hits.length ? [{ names: [], tasks: hits }] : []
  else {
    const map = new Map<string, { keys: Key[]; names: string[]; tasks: Found[] }>()
    const combos = (t: Found) => {
      let out: { keys: Key[]; names: string[] }[] = [{ keys: [], names: [] }]
      for (const g of q.groups) out = out.flatMap((o) => g.keys(t, ctx).map((k) => ({ keys: [...o.keys, k.key], names: [...o.names, k.name] })))
      return out
    }
    for (const t of hits) for (const c of combos(t)) {
      const id = JSON.stringify(c.keys)
      const g = map.get(id) ?? map.set(id, { ...c, tasks: [] }).get(id)!
      g.tasks.push(t)
    }
    const list = [...map.values()].sort((a, b) => {
      for (let i = 0; i < q.groups.length; i++) {
        const c = cmp(a.keys[i], b.keys[i])
        if (c) return q.groups[i].reverse ? -c : c
      }
      return 0
    })
    groups = list.map((g) => ({ names: g.names, tasks: q.groupLimit !== null ? g.tasks.slice(0, q.groupLimit) : g.tasks }))
  }
  const shown = new Set(groups.flatMap((g) => g.tasks)).size
  return { groups, total, shown, layout: q.layout, explain: q.explain ? explainText(q) : null, problems: [] }
}

function explainText(q: Query): string {
  const out: string[] = []
  if (!q.filters.length) out.push("No filters: every task.")
  for (const f of q.filters) out.push(f.line.toLowerCase() === f.explain ? f.line : `${f.line} =>\n  ${f.explain}`)
  if (q.sorts.length) out.push(...q.sorts.map((s) => s.line))
  if (q.groups.length) out.push(...q.groups.map((g) => g.line))
  if (q.limit !== null) out.push(`At most ${q.limit} task${q.limit === 1 ? "" : "s"}.`)
  if (q.groupLimit !== null) out.push(`At most ${q.groupLimit} task${q.groupLimit === 1 ? "" : "s"} a group.`)
  return out.join("\n")
}

export const isDateKey = (k: string): k is DateKey => (DATE_KEYS as string[]).includes(k)
