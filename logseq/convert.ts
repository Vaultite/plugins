// A Logseq page's outline as a Vaultite note: blocks as nested list items, tasks in the Tasks plugin's format, page
// properties as frontmatter.
import { dayName } from "./dates.ts"
import { type Ctx, line, tagOf, wikilink } from "./inline.ts"
import { type Block, blockParts, type Page, type Prop, PROP } from "./outline.ts"
import { convertQuery } from "./query.ts"

export const MARKERS = /^(TODO|DOING|NOW|LATER|DONE|WAITING|WAIT|CANCELED|CANCELLED|IN-PROGRESS|STARTED)(?:\s+|$)/
const STATUS: Record<string, string> = { TODO: " ", LATER: " ", DOING: "/", NOW: "/", "IN-PROGRESS": "/", STARTED: "/", DONE: "x", WAITING: " ", WAIT: " ", CANCELED: "-", CANCELLED: "-" }
const PRIORITY: Record<string, [string, string]> = { A: ["⏫", "high"], B: ["🔼", "medium"], C: ["🔽", "low"] }
const UNIT: Record<string, string> = { d: "day", w: "week", m: "month", y: "year" }
const CALLOUT: Record<string, string> = { NOTE: "note", TIP: "tip", IMPORTANT: "important", CAUTION: "caution", WARNING: "warning", PINNED: "pinned", EXAMPLE: "example", QUOTE: "quote" }
/** Block properties Logseq keeps for itself: shown another way, or not at all. */
const DROPPED = new Set(["collapsed", "heading", "logseq.order-list-type"])
const CARD = /^card-(last-interval|repeats|ease-factor|next-schedule|last-reviewed|last-score)$/

export type Card = { front: string; back: string[] }
export type Options = { tasks: "emoji" | "dataview" }
export type NoteOut = { fm: Record<string, unknown>; body: string; cards: Card[] }

/** <2024-01-05 Fri 10:00 .+1d>: its date, whether it has a time, and its repeater as the Tasks plugin's recurrence. */
export function timestamp(ts: string) {
  const m = /^<(\d{4}-\d\d-\d\d)(?:\s+[^\s>\d.+]+)?(\s+\d{1,2}:\d\d(?:-\d{1,2}:\d\d)?)?(?:\s+(\.?\+\+?)(\d+)([hdwmy]))?\s*>$/.exec(ts.trim())
  if (!m) return null
  const [, date, time, kind, n, unit] = m
  let every: string | null = null, exact = !time
  if (unit && UNIT[unit]) every = `every ${n === "1" ? UNIT[unit] : `${n} ${UNIT[unit]}s`}${kind === ".+" ? " when done" : ""}`
  if (unit && (!UNIT[unit] || kind === "++")) exact = false
  return { date, every, exact }
}

function task(ctx: Ctx, opts: Options, title: string, sched: string | null, dead: string | null, extra: string[]) {
  const m = MARKERS.exec(title)
  if (!m) return null
  let rest = title.slice(m[0].length)
  const p = /^\[#([ABC])\]\s*/.exec(rest)
  if (p) rest = rest.slice(p[0].length)
  const fields: string[] = []
  const s = sched ? timestamp(sched) : null, d = dead ? timestamp(dead) : null
  const every = s?.every ?? d?.every
  const dv = opts.tasks === "dataview"
  if (p) fields.push(dv ? `[priority:: ${PRIORITY[p[1]][1]}]` : PRIORITY[p[1]][0])
  if (every) fields.push(dv ? `[repeat:: ${every}]` : `🔁 ${every}`)
  if (s) fields.push(dv ? `[scheduled:: ${s.date}]` : `⏳ ${s.date}`)
  if (d) fields.push(dv ? `[due:: ${d.date}]` : `📅 ${d.date}`)
  // a time or a repeater the Tasks plugin can't say: the line as Logseq wrote it, hidden, for an export back
  for (const [ts, t, w] of [[sched, s, "SCHEDULED"], [dead, d, "DEADLINE"]] as const) if (ts && (!t || !t.exact)) extra.push(`%%${w}: ${ts}%%`)
  // (the Tasks plugin has no waiting: a todo that says so, which the export reads back)
  const desc = `${/^WAIT/.test(m[1]) ? "WAITING " : ""}${line(ctx, rest)}`.trimEnd()
  return `[${STATUS[m[1]]}] ${[desc, ...fields].filter(Boolean).join(dv ? "  " : " ")}`
}

/** A block's text lines after its title: Logseq's #+BEGIN blocks, queries and code as Markdown's. */
function content(ctx: Ctx, lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const fence = /^\s*(`{3,}|~{3,})/.exec(l)
    if (fence) {
      const end = lines.findIndex((x, j) => j > i && x.trim().startsWith(fence[1]) && /^\s*(`+|~+)\s*$/.test(x))
      const stop = end < 0 ? lines.length - 1 : end
      out.push(...lines.slice(i, stop + 1))
      i = stop
      continue
    }
    const begin = /^\s*#\+BEGIN_(\w+)\s*(.*)$/i.exec(l)
    if (begin) {
      const kind = begin[1].toUpperCase()
      const end = lines.findIndex((x, j) => j > i && new RegExp(`^\\s*#\\+END_${begin[1]}\\b`, "i").test(x))
      if (end < 0) { out.push(line(ctx, l)); continue }
      const inner = lines.slice(i + 1, end)
      i = end
      const tick = "`".repeat(Math.max(3, ...inner.map((x) => Math.max(0, ...[...x.matchAll(/`+/g)].map((r) => r[0].length + 1)))))
      if (kind === "SRC") out.push(`${tick}${begin[2].split(/\s+/)[0] ?? ""}`, ...inner, tick)
      else if (kind === "EXAMPLE") out.push(`${tick}example`, ...inner, tick)
      else if (kind === "QUERY") { out.push("Advanced Logseq query (not converted):", `${tick}clojure`, ...inner, tick); ctx.stats.queriesKept++ }
      else if (kind === "COMMENT") out.push("%%", ...inner, "%%")
      else if (CALLOUT[kind]) {
        out.push(`> [!${CALLOUT[kind]}]`, ...content(ctx, inner).map((x) => (x ? `> ${x}` : ">")))
        // (else the next line would join the quote)
        if (lines[i + 1]?.trim()) out.push("")
      }
      else out.push(l, ...inner, lines[end])
      continue
    }
    const q = /^\s*\{\{query\s+(.*)\}\}\s*$/.exec(l)
    if (q) {
      const c = convertQuery(q[1], (t) => ctx.page(t))
      if (c) { ctx.stats.queries++; out.push(`%%logseq: ${l.trim()}%%`, `\`\`\`${c.lang}`, ...c.text.split("\n"), "```"); continue }
      ctx.stats.queriesKept++
    }
    out.push(line(ctx, l))
  }
  return out
}

function propLine(ctx: Ctx, p: Prop) {
  return `${p.key}::${p.value ? ` ${line(ctx, p.value)}` : ""}`
}

/** A block and its children as list items, `depth` tabs in. */
function blockLines(ctx: Ctx, opts: Options, b: Block, depth: number, cards: Card[]): string[] {
  const parts = blockParts(b.lines)
  const props = new Map(parts.props.map((p) => [p.key.toLowerCase(), p.value.trim()]))
  // (a ((ref)) needs a uuid: another id, an Org file's own, stays a property)
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.get("id") ?? "") ? props.get("id")!.toLowerCase() : null
  const extra: string[] = []
  let title = parts.title
  const level = props.get("heading")
  if (level && !/^#{1,6}\s/.test(title)) title = `${"#".repeat(/^[1-6]$/.test(level) ? Number(level) : 2)} ${title}`
  const area = props.get("hl-type") === "area" && id && ctx.title?.startsWith("hls__") ? ctx.asset(`../assets/${ctx.title.slice(5)}/${props.get("hl-page")}_${id}_${props.get("hl-stamp")}.png`) : null
  if (area && (!title.trim() || title.trim() === "[:span]")) title = `![[${area}]]`
  const done = task(ctx, opts, title, parts.scheduled, parts.deadline, extra)
  const planning = done ? [] : [parts.scheduled && `SCHEDULED: ${parts.scheduled}`, parts.deadline && `DEADLINE: ${parts.deadline}`].filter((x): x is string => !!x)
  const kept = parts.props.filter((p) => !DROPPED.has(p.key.toLowerCase()) && !CARD.test(p.key.toLowerCase()) && !(id && p.key.toLowerCase() === "id"))
  const own = done !== null ? [done, ...content(ctx, parts.body)] : content(ctx, [title, ...parts.body])
  const isCard = /(^|\s)#card(\s|$)/i.test(title)
  if (isCard) cards.push({ front: line(ctx, title).replace(/(^|\s)#card(?=\s|$)/gi, "").trim(), back: b.children.map((c) => line(ctx, blockParts(c.lines).title)) })
  const logbook = parts.logbook.length ? ["%%", ...parts.logbook, "%%"] : []
  // (text ending in " ^2" would read as a block id: its ^ escaped)
  let code = false
  for (let k = 0; k < own.length; k++) {
    if (/^\s*(```|~~~)/.test(own[k])) code = !code
    else if (!code) own[k] = own[k].replace(/(\s)\^([\w-]+)\s*$/, "$1\\^$2")
  }
  // (a callout, a table or code on a list item's first line isn't drawn as one: it goes under the item; deeper than
  // the first level the app draws a callout as a quote and a table as text anyway, so only code goes under)
  const lead = (depth ? /^(```|~~~)/ : /^(> \[!|```|~~~|\|)/).test(own[0] ?? "")
  const after = [...kept.map((p) => propLine(ctx, p)), ...planning, ...extra, ...logbook]
  let lines = lead ? ["", ...after, ...own] : [own[0] ?? "", ...after, ...own.slice(1)]
  if (!lines[0] && kept.length && !lead) lines = lines.slice(1)
  if (id) {
    const plain = lines[0] && !/^(\s*$|```|~~~|>|%%|\|)/.test(lines[0]) && !PROP.test(lines[0])
    if (plain) lines[0] = `${lines[0]} ^${id}`
    else lines.push(`^${id}`)
  }
  const marker = b.numbered || props.get("logseq.order-list-type") === "number" ? "1." : "-"
  // (spaces, not tabs: under a tab the app draws a quote, a callout or a fence in a list item as code)
  const pad = "    ".repeat(depth), cont = `${pad}${" ".repeat(marker.length + 1)}`
  return [
    `${pad}${marker}${lines[0] ? ` ${lines[0]}` : ""}`,
    ...lines.slice(1).map((l) => (l ? cont + l : "")),
    ...b.children.flatMap((c) => blockLines(ctx, opts, c, depth + 1, cards)),
  ]
}

const LIST_KEYS = new Set(["alias", "tags"])

/** A page property's value as frontmatter: links, lists, numbers, booleans and dates typed. */
export function fmValue(ctx: Ctx, key: string, raw: string): unknown {
  const v = raw.trim()
  if (LIST_KEYS.has(key)) {
    const items = splitList(v)
    return key === "tags" ? items.map((x) => tagOf(ctx, x).replace(/^#/, "").replace(/^\[\[|\]\]$/g, "")) : items
  }
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v) && String(Number(v)) === v) return Number(v)
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true"
  if (/^\d{4}-\d\d-\d\d$/.test(v)) return v
  const refs = [...v.matchAll(/\[\[([^\]]+)\]\]|#\[\[([^\]]+)\]\]|(?<=^|\s|,)#([^\s,]+)/g)]
  if (refs.length && v.replace(/\[\[[^\]]+\]\]|#\[\[[^\]]+\]\]|(?<=^|\s|,)#[^\s,]+|[\s,]/g, "") === "") {
    const links = refs.map((r) => wikilink(ctx, r[1] ?? r[2] ?? r[3]))
    return links.length === 1 ? links[0] : links
  }
  return line(ctx, v)
}

export function splitList(v: string): string[] {
  const out: string[] = []
  for (const m of v.matchAll(/\s*(?:#?\[\[([^\]]+)\]\]|"([^"]*)"|([^,]+))/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/^#/, "")
    if (s) out.push(s)
  }
  return out
}

export function pageNote(ctx: Ctx, opts: Options, page: Page): NoteOut {
  let props = page.props, blocks = page.blocks
  // an older Logseq kept page properties in the first block
  const first = blocks[0]
  if (!props.length && first && !first.children.length && first.lines.every((l) => !l.trim() || PROP.test(l)) && PROP.test(first.lines[0])) {
    props = blockParts(first.lines).props
    blocks = blocks.slice(1)
  }
  const fm: Record<string, unknown> = {}
  for (const p of props) {
    const key = p.key.toLowerCase()
    if (key === "title" || key === "filters") continue
    const name = key === "alias" ? "aliases" : key === "tags" ? "tags" : p.key
    const value = fmValue(ctx, key, p.value)
    if (Array.isArray(fm[name]) && Array.isArray(value)) fm[name] = [...(fm[name] as unknown[]), ...value]
    else fm[name] = value
  }
  const cards: Card[] = []
  const lines: string[] = []
  // a heading Logseq wrote without a bullet is the note's own heading, what's under it after it (unless a block beside
  // it, not a heading itself, would then be under it too); text before the first bullet a paragraph
  const heading = blocks.map(() => false)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i], parts = blockParts(b.lines)
    heading[i] = !!b.bare && !parts.props.length && !parts.scheduled && !parts.deadline && !parts.logbook.length && /^#{1,6}\s/.test(parts.title) &&
      !parts.body.some((l) => l.trim()) && (i === blocks.length - 1 || heading[i + 1])
  }
  blocks.forEach((b, i) => {
    const parts = blockParts(b.lines)
    const plain = b.bare && !parts.props.length && !parts.scheduled && !parts.deadline && !parts.logbook.length
    if (heading[i]) {
      if (lines.length) lines.push("")
      lines.push(line(ctx, parts.title), ...b.children.flatMap((c) => blockLines(ctx, opts, c, 0, cards)))
      return
    }
    if (plain && !/^#{1,6}\s/.test(parts.title) && !b.children.length) { lines.push(...content(ctx, b.lines), ""); return }
    lines.push(...blockLines(ctx, opts, b, 0, cards))
  })
  return { fm, body: lines.join("\n"), cards }
}

/** A <2024-01-05 Fri> stamp again. */
export const stampOf = (iso: string) => `<${iso} ${dayName(iso)}>`
