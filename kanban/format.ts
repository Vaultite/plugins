// Obsidian Kanban's boards (mgmeyers/obsidian-kanban): a Markdown file with `kanban-plugin: board` in its frontmatter,
// `## Lane` headings, `- [ ] card` items, `**Complete**`, an archive after `***` and a `%% kanban:settings %%` block.
// Shared by the app and the server (no Node). Parsed leniently by line; every edit changes only the lines it's about.

export type Card = {
  /** Its lines in the file, [start, end): the item and the lines under it. */
  start: number; end: number
  /** The checkbox's character: " " open, "x" done (others kept); "" for an item without one (`- text`). */
  check: string
  /** Its Markdown: the item's text and the lines under it, dedented, `<br>` as a line break, without its block id. */
  text: string
  /** `^id` at the end of its first line (a link to it), kept when it's edited. */
  blockId: string
}
export type Lane = {
  title: string
  /** Its limit (`## Doing (3)`), 0 for none. */
  max: number
  /** `**Complete**` under its heading: cards moved here are ticked. */
  complete: boolean
  /** Its heading's line, and the first line after its section. */
  line: number; end: number
  /** The `**Complete**` line, or -1. */
  marker: number
  cards: Card[]
}
export type Board = {
  lines: string[]
  lanes: Lane[]
  /** `## Archive` after a `***` line, or null; `rule` is that line. */
  archive: (Lane & { rule: number }) | null
  /** The settings (JSON in the `%% kanban:settings` block), {} without one; `settingsAt`: its first line, or -1. */
  settings: Record<string, unknown>
  settingsAt: number
  /** Continuation lines are indented with this (a tab, Obsidian's default, or what the file uses). */
  indent: string
}
/** A card as the app or an agent last saw it: by lane and place, checked against its lines (the board may have changed). */
export type CardRef = { lane: number; index: number; raw?: string }

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/
const ITEM = /^( {0,3})([-*+])[ \t]+(.*?)\r?$/
const TASK = /^\[(.)\](?:[ \t]+|$)(.*)$/s
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const BLOCK_ID = /\s+\^([A-Za-z0-9-]+)$/
export const COMPLETE = "**Complete**"
const blank = (l: string | undefined) => l !== undefined && !l.trim()

/** The first line after the frontmatter. */
function bodyStart(lines: string[]) {
  if (lines[0]?.trimEnd() !== "---") return 0
  for (let i = 1; i < lines.length; i++) if (lines[i].trimEnd() === "---" || lines[i].trimEnd() === "...") return i + 1
  return 0
}

/** Whether `text` is a board: `kanban-plugin` in its frontmatter. */
export function isBoard(text: string) {
  const lines = text.split("\n"), end = bodyStart(lines)
  return end > 0 && lines.slice(1, end - 1).some((l) => /^kanban-plugin\s*:\s*\S/.test(l))
}

export const laneTitle = (raw: string) => {
  const t = raw.replace(/<br>/g, "\n").trim()
  const m = /^(.*?)\s*\((\d+)\)$/s.exec(t)
  return m ? { title: m[1], max: Number(m[2]) } : { title: t, max: 0 }
}

/** The lines of one card from `at` (an item line): its text and where it ends (blank lines at its end aren't its). */
function readCard(lines: string[], at: number, until: number): Card {
  const m = ITEM.exec(lines[at])!
  let first = m[3], check = ""
  const t = TASK.exec(first)
  if (t) { check = t[1]; first = t[2] }
  let end = at + 1
  for (let i = at + 1; i < until; i++) {
    const l = lines[i]
    if (blank(l)) continue
    if (!/^[ \t]/.test(l) || ITEM.exec(l)?.[1] === m[1]) break
    end = i + 1
  }
  const rest = lines.slice(at + 1, end).map((l) => l.replace(/\r$/, "").replace(/^(\t| {1,4})/, ""))
  const id = BLOCK_ID.exec(first)
  if (id) first = first.slice(0, id.index)
  const text = [first, ...rest].join("\n").replace(/<br>/g, "\n").trim()
  return { start: at, end, check, text, blockId: id ? id[1] : "" }
}

/** A lane's section, `line` its heading, up to `end`: its first list is its cards (Obsidian's rule). */
function readLane(lines: string[], line: number, end: number, raw: string): Lane {
  const { title, max } = laneTitle(raw)
  const lane: Lane = { title, max, complete: false, line, end, marker: -1, cards: [] }
  let i = line + 1
  for (; i < end; i++) {
    const l = lines[i].trim()
    if (!l) continue
    if (l === COMPLETE && !lane.cards.length) { lane.complete = true; lane.marker = i; continue }
    if (ITEM.test(lines[i])) break
  }
  const indent = i < end ? ITEM.exec(lines[i])![1] : ""
  while (i < end) {
    const card = readCard(lines, i, end)
    lane.cards.push(card)
    i = card.end
    while (i < end && blank(lines[i])) i++
    const m = i < end ? ITEM.exec(lines[i]) : null
    if (!m || m[1] !== indent) break
  }
  return lane
}

export function parseBoard(text: string): Board {
  const lines = text.split("\n")
  const heads: { line: number; raw: string }[] = []
  let settingsAt = -1, settingsEnd = -1, fence = ""
  for (let i = bodyStart(lines); i < lines.length; i++) {
    const l = lines[i]
    const f = FENCE.exec(l)
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.trim().slice(f[1].length).trim()) fence = ""; continue }
    if (f) { fence = f[1]; continue }
    if (l.trimStart().startsWith("%% kanban:settings")) {
      settingsAt = i
      settingsEnd = lines.length
      for (let j = i + 1; j < lines.length; j++) if (lines[j].trimEnd().endsWith("%%")) { settingsEnd = j + 1; break }
      break
    }
    const h = HEADING.exec(l)
    if (h) heads.push({ line: i, raw: h[2] })
  }
  const stop = settingsAt >= 0 ? settingsAt : lines.length
  const lanes: Lane[] = []
  let archive: Board["archive"] = null
  heads.forEach((h, n) => {
    let end = n + 1 < heads.length ? heads[n + 1].line : stop
    // (the `***` before the archive isn't the last lane's)
    const next = heads[n + 1]
    const rule = next && laneTitle(next.raw).title === "Archive" ? ruleBefore(lines, next.line) : -1
    if (rule >= 0) end = rule
    const mine = ruleBefore(lines, h.line)
    if (laneTitle(h.raw).title === "Archive" && mine >= 0) archive = { ...readLane(lines, h.line, end, h.raw), rule: mine }
    else if (!archive) lanes.push(readLane(lines, h.line, end, h.raw))
  })
  let settings: Record<string, unknown> = {}
  if (settingsAt >= 0) {
    const json = lines.slice(settingsAt + 1, settingsEnd).filter((l) => !FENCE.test(l) && !l.trim().startsWith("%%")).join("\n").trim()
    try { const v = JSON.parse(json || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) settings = v } catch { /* (kept as it is) */ }
  }
  const sample = lanes.flatMap((l) => l.cards).find((c) => c.end - c.start > 1)
  const indent = sample && lines[sample.start + 1].startsWith(" ") ? "    " : "\t"
  return { lines, lanes, archive, settings, settingsAt, indent }
}

/** The `***` line just before line `at` (blank lines between), or -1. */
function ruleBefore(lines: string[], at: number) {
  let i = at - 1
  while (i >= 0 && blank(lines[i])) i--
  return i >= 0 && RULE.test(lines[i]) ? i : -1
}

// ---------- writing

export class BoardError extends Error {}

/** A card's lines as Obsidian writes them: `- [ ] text`, a line break as an indented line, its block id kept. */
export function cardLines(text: string, check: string, blockId = "", indent = "\t"): string[] {
  const [first, ...rest] = text.trim().replace(/\r/g, "").split("\n")
  return [`- [${check || " "}] ${first}${blockId ? ` ^${blockId}` : ""}`.trimEnd(), ...rest.map((l) => (l.trim() ? indent + l : indent))]
}

const done = (c: string) => c === "x" || c === "X"
const laneAt = (b: Board, i: number) => {
  const l = b.lanes[i]
  if (!l) throw new BoardError(`there's no lane ${i + 1}: the board has ${b.lanes.length}`)
  return l
}

/** The card `ref` names in the board as it is now: at its place if its lines are the same, else the one card with them. */
export function findCard(b: Board, ref: CardRef): { lane: number; index: number; card: Card } {
  const raw = (c: Card) => b.lines.slice(c.start, c.end).join("\n")
  const at = b.lanes[ref.lane]?.cards[ref.index]
  if (at && (ref.raw === undefined || raw(at) === ref.raw)) return { lane: ref.lane, index: ref.index, card: at }
  if (ref.raw !== undefined) {
    const hits = b.lanes.flatMap((l, li) => l.cards.map((c, ci) => ({ lane: li, index: ci, card: c }))).filter((h) => raw(h.card) === ref.raw)
    if (hits.length === 1) return hits[0]
  }
  throw new BoardError("that card changed on the board meanwhile: look again")
}

export const rawOf = (b: Board, c: Card) => b.lines.slice(c.start, c.end).join("\n")

/** Where a card goes in a lane: before its `index`th card, or after its last (or under its heading when it has none). */
function insertAt(lines: string[], lane: Lane, index: number, card: string[]) {
  if (lane.cards.length) {
    const at = index < lane.cards.length ? lane.cards[Math.max(0, index)].start : lane.cards[lane.cards.length - 1].end
    lines.splice(at, 0, ...card)
    return
  }
  let at = (lane.marker >= 0 ? lane.marker : lane.line) + 1
  const add = [...card]
  if (lane.marker < 0) { if (blank(lines[at]) && at < lane.end) at++; else add.unshift("") }
  if (at < lines.length && !blank(lines[at])) add.push("")
  lines.splice(at, 0, ...add)
}

/** The lane's cards ticked or not as a move into it says: into a complete lane done, out of one open (Obsidian's). */
function checkFor(from: Lane | null, to: Lane, check: string) {
  if (to.complete) return done(check) ? check : "x"
  if (from?.complete && done(check)) return " "
  return check
}

/** An item's line with its checkbox set to `check` (one added to an item without). */
const withCheck = (line: string, had: string, check: string) => had
  ? line.replace(/^(\s*[-*+][ \t]+)\[.\]/, `$1[${check}]`)
  : line.replace(/^(\s*[-*+][ \t]+)/, `$1[${check}] `)

export function toggleCard(text: string, ref: CardRef, on?: boolean): string {
  const b = parseBoard(text), { card } = findCard(b, ref)
  const lines = [...b.lines]
  lines[card.start] = withCheck(lines[card.start], card.check, (on ?? !done(card.check)) ? "x" : " ")
  return lines.join("\n")
}

export function setCardText(text: string, ref: CardRef, md: string): string {
  const b = parseBoard(text), { card } = findCard(b, ref)
  if (!md.trim()) throw new BoardError("a card needs some text")
  const lines = [...b.lines]
  lines.splice(card.start, card.end - card.start, ...cardLines(md, card.check, card.blockId, b.indent))
  return lines.join("\n")
}

/** Where a new card goes when nobody says: the board's setting (Obsidian's `new-card-insertion-method`), else the end. */
export const newCardAt = (b: Board): "top" | "bottom" => (String(b.settings["new-card-insertion-method"] ?? "append").startsWith("prepend") ? "top" : "bottom")

export function addCard(text: string, lane: number, md: string, at?: "top" | "bottom" | number): string {
  const b = parseBoard(text), l = laneAt(b, lane)
  if (!md.trim()) throw new BoardError("a card needs some text")
  const where = at ?? newCardAt(b)
  const lines = [...b.lines]
  insertAt(lines, l, where === "top" ? 0 : where === "bottom" ? l.cards.length : where, cardLines(md, l.complete ? "x" : " ", "", b.indent))
  return lines.join("\n")
}

/** The card moved to lane `to`, before that lane's `index`th card as it is without the card (its length: the end). */
export function moveCard(text: string, ref: CardRef, to: number, index: number): string {
  const b = parseBoard(text), { lane: from, card } = findCard(b, ref)
  laneAt(b, to)
  const lines = [...b.lines]
  const moved = lines.slice(card.start, card.end)
  const check = checkFor(b.lanes[from], b.lanes[to], card.check)
  if (check !== card.check) moved[0] = withCheck(moved[0], card.check, check)
  cut(lines, [card])
  const after = parseBoard(lines.join("\n"))
  const dest = after.lanes[to]
  insertAt(after.lines, dest, Math.max(0, Math.min(index, dest.cards.length)), moved)
  return after.lines.join("\n")
}

/** Several cards out of the board, the archive's or a lane's, in one go (from the last line up). */
function cut(lines: string[], cards: Card[]) {
  for (const c of [...cards].sort((a, z) => z.start - a.start)) {
    lines.splice(c.start, c.end - c.start)
    // (a loose list keeps one blank line between its items)
    if (blank(lines[c.start - 1]) && blank(lines[c.start]) && ITEM.test(lines[c.start + 1] ?? "")) lines.splice(c.start, 1)
  }
}

export function removeCard(text: string, ref: CardRef): string {
  const b = parseBoard(text), { card } = findCard(b, ref)
  const lines = [...b.lines]
  cut(lines, [card])
  return lines.join("\n")
}

/** A date as Obsidian Kanban's archive writes it (moment's YYYY MM DD HH mm ss and the like; other letters as they are). */
export function formatDate(d: Date, format: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  const parts: Record<string, string> = {
    YYYY: String(d.getFullYear()), YY: p(d.getFullYear() % 100), MM: p(d.getMonth() + 1), M: String(d.getMonth() + 1),
    DD: p(d.getDate()), D: String(d.getDate()), HH: p(d.getHours()), H: String(d.getHours()), mm: p(d.getMinutes()), ss: p(d.getSeconds()),
  }
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|HH|H|mm|ss/g, (t, lit?: string) => lit ?? parts[t])
}

/** Cards' lines as they go into the archive: dated when the board's settings say so (`archive-with-date`). */
function archived(b: Board, cards: Card[], now: Date): string[] {
  const s = b.settings
  return cards.flatMap((c) => {
    if (!s["archive-with-date"]) return b.lines.slice(c.start, c.end)
    const date = formatDate(now, String(s["archive-date-format"] || "YYYY-MM-DD HH:mm"))
    const sep = String(s["archive-date-separator"] || "")
    const words = [date, ...(sep ? [sep] : []), c.text]
    return cardLines((s["append-archive-date"] ? words.reverse() : words).join(" "), c.check, c.blockId, b.indent)
  })
}

/** `cards` (lines) appended to the board's archive, made after the lanes when there's none. */
function toArchive(b: Board, cards: string[]) {
  const lines = b.lines, a = b.archive
  if (a?.cards.length) { lines.splice(a.cards[a.cards.length - 1].end, 0, ...cards); return }
  if (a) {
    let at = a.line + 1
    const add = [...cards]
    if (blank(lines[at])) at++; else add.unshift("")
    if (at < lines.length && !blank(lines[at])) add.push("")
    lines.splice(at, 0, ...add)
    return
  }
  let at = b.settingsAt >= 0 ? b.settingsAt : lines.length
  while (at > 0 && blank(lines[at - 1])) at--
  lines.splice(at, 0, "", "", "***", "", "## Archive", "", ...cards, ...(at < lines.length && !blank(lines[at]) ? ["", ""] : []))
}

export function archiveCard(text: string, ref: CardRef, now = new Date()): string {
  const b = parseBoard(text), { card } = findCard(b, ref)
  return archiveCards(b, [card], now)
}

/** Every done card (ticked, or in a complete lane) into the archive, `lane` only when given. */
export function archiveDone(text: string, lane?: number, now = new Date()): string {
  const b = parseBoard(text)
  const lanes = lane === undefined ? b.lanes : [laneAt(b, lane)]
  const cards = lanes.flatMap((l) => l.cards.filter((c) => l.complete || done(c.check)))
  return cards.length ? archiveCards(b, cards, now) : text
}

function archiveCards(b: Board, cards: Card[], now: Date) {
  const moving = archived(b, cards, now)
  const lines = [...b.lines]
  cut(lines, cards)
  const after = parseBoard(lines.join("\n"))
  toArchive(after, moving)
  return after.lines.join("\n")
}

/** The settings line rewritten (only it), or the block made when there's none. */
function setSettings(b: Board, lines: string[], change: (s: Record<string, unknown>) => Record<string, unknown>) {
  const next = change({ ...b.settings })
  const json = JSON.stringify(next)
  if (b.settingsAt >= 0) {
    for (let i = b.settingsAt + 1; i < lines.length && !lines[i].trim().startsWith("%%"); i++) {
      if (lines[i].trim().startsWith("{")) { lines[i] = json; return }
    }
    return
  }
  while (lines.length && blank(lines[lines.length - 1])) lines.pop()
  lines.push("", "", "%% kanban:settings", "```", json, "```", "%%", "")
}

/** The lanes' collapsed flags (Obsidian's `list-collapse`, by lane) changed by `f`, when the board keeps them. */
function collapse(b: Board, lines: string[], f: (flags: boolean[]) => boolean[]) {
  const c = b.settings["list-collapse"]
  if (!Array.isArray(c)) return
  setSettings(b, lines, (s) => ({ ...s, "list-collapse": f(b.lanes.map((_, i) => !!c[i])) }))
}

/** Where the lanes end: the archive's `***`, else the settings block, else the end of the file (blank lines before it). */
function lanesEnd(b: Board) {
  let at = b.archive ? b.archive.rule : b.settingsAt >= 0 ? b.settingsAt : b.lines.length
  while (at > 0 && blank(b.lines[at - 1])) at--
  return at
}

const headingOf = (title: string, max = 0) => `## ${title.trim().replace(/\r?\n/g, "<br>")}${max ? ` (${max})` : ""}`

export function addLane(text: string, title: string, complete = false): string {
  if (!title.trim()) throw new BoardError("a lane needs a name")
  const b = parseBoard(text)
  const lines = [...b.lines]
  const at = lanesEnd(b)
  const add = [...(b.lanes.length ? ["", ""] : at > 0 ? [""] : []), headingOf(title), "", ...(complete ? [COMPLETE] : [])]
  if (at < lines.length && !blank(lines[at])) add.push("", "")
  lines.splice(at, 0, ...add)
  const after = parseBoard(lines.join("\n"))
  collapse(after, after.lines, (f) => f)
  return after.lines.join("\n")
}

export function renameLane(text: string, lane: number, title: string): string {
  if (!title.trim()) throw new BoardError("a lane needs a name")
  const b = parseBoard(text), l = laneAt(b, lane)
  const lines = [...b.lines]
  const level = HEADING.exec(lines[l.line])?.[1] ?? "##"
  lines[l.line] = headingOf(title, l.max).replace(/^##/, level)
  return lines.join("\n")
}

export function removeLane(text: string, lane: number): string {
  const b = parseBoard(text), l = laneAt(b, lane)
  const lines = [...b.lines]
  collapse(b, lines, (f) => f.filter((_, i) => i !== lane))
  lines.splice(l.line, l.end - l.line)
  return lines.join("\n")
}

/** Lane `from` moved before lane `to` as the lanes are without it (their count: the end). */
export function moveLane(text: string, from: number, to: number): string {
  const b = parseBoard(text), l = laneAt(b, from)
  if (to === from) return text
  const lines = [...b.lines]
  collapse(b, lines, (f) => { const x = [...f]; x.splice(to, 0, ...x.splice(from, 1)); return x })
  const section = lines.slice(l.line, l.end)
  while (section.length && blank(section[section.length - 1])) section.pop()
  lines.splice(l.line, l.end - l.line)
  const after = parseBoard(lines.join("\n"))
  if (to < after.lanes.length) after.lines.splice(after.lanes[to].line, 0, ...section, "", "")
  else after.lines.splice(lanesEnd(after), 0, "", "", ...section)
  return after.lines.join("\n")
}

export function setCollapsed(text: string, lane: number, on: boolean): string {
  const b = parseBoard(text)
  laneAt(b, lane)
  const lines = [...b.lines]
  const c = Array.isArray(b.settings["list-collapse"]) ? b.settings["list-collapse"] as unknown[] : []
  setSettings(b, lines, (s) => ({ ...s, "list-collapse": b.lanes.map((_, i) => (i === lane ? on : !!c[i])) }))
  return lines.join("\n")
}

/** Whether lane `i` is collapsed (Obsidian's `list-collapse`). */
export const collapsed = (b: Board, i: number) => Array.isArray(b.settings["list-collapse"]) && !!(b.settings["list-collapse"] as unknown[])[i]

export const isDone = (c: Card) => done(c.check)

/** A new board as Obsidian makes one, with these lanes (a last one named Done is its complete lane). */
export function newBoard(lanes = ["To do", "Doing", "Done"]): string {
  const out = ["---", "", "kanban-plugin: board", "", "---", ""]
  lanes.forEach((t, i) => out.push(headingOf(t), "", ...(i === lanes.length - 1 && /^done$/i.test(t.trim()) ? [COMPLETE] : []), "", "", ""))
  out.push("", "", "%% kanban:settings", "```", JSON.stringify({ "kanban-plugin": "board", "list-collapse": lanes.map(() => false) }), "```", "%%")
  return out.join("\n")
}

// ---------- reading a card: its dates, times and tags (shown under it), as Obsidian Kanban writes them

export type Bits = { text: string; date: string; time: string; tags: string[] }
/** `@{2026-10-08}` (or `@[[2026-10-08]]`) and `@@{10:00}` taken out of a card's text, its #tags listed. */
export function bitsOf(md: string): Bits {
  let date = "", time = ""
  const text = md
    .replace(/(^|\s)@@\{([^}\n]+)\}/g, (_, s: string, t: string) => { time ||= t; return s })
    .replace(/(^|\s)@(?:\{([^}\n]+)\}|\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\])/g, (_, s: string, a?: string, b?: string) => { date ||= (a ?? b ?? ""); return s })
    .replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").trim()
  const tags = [...new Set([...md.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)].map((m) => m[1]))]
  return { text, date, time, tags }
}

// ---------- as text, for agents

/** What the ops answer: the board's lanes and cards, plain. */
export type Summary = {
  name: string
  lanes: { title: string; limit?: number; complete?: boolean; collapsed?: boolean; cards: { text: string; done: boolean }[] }[]
  archived: number
}
export const summarize = (b: Board, name: string): Summary => ({
  name,
  lanes: b.lanes.map((l, i) => ({
    title: l.title, ...(l.max ? { limit: l.max } : {}), ...(l.complete ? { complete: true } : {}), ...(collapsed(b, i) ? { collapsed: true } : {}),
    cards: l.cards.map((c) => ({ text: c.text, done: isDone(c) })),
  })),
  archived: b.archive?.cards.length ?? 0,
})

/** A board as Markdown: each lane with its cards numbered (what kanban.move takes), and how many are archived. */
export function summaryText(s: Summary): string {
  const all = s.lanes.flatMap((l) => l.cards), finished = all.filter((c) => c.done).length
  const out = [`# ${s.name}`, "", `${s.lanes.length} ${s.lanes.length === 1 ? "lane" : "lanes"}, ${all.length} ${all.length === 1 ? "card" : "cards"} (${finished} done)${s.archived ? `, ${s.archived} archived` : ""}`]
  s.lanes.forEach((l, i) => {
    const notes = [l.limit ? `limit ${l.limit}` : "", l.complete ? "cards here are done" : "", l.collapsed ? "collapsed" : ""].filter(Boolean)
    out.push("", `## ${i + 1}. ${l.title} (${l.cards.length})${notes.length ? ` _${notes.join(", ")}_` : ""}`, "")
    if (!l.cards.length) out.push("_No cards._")
    l.cards.forEach((c, j) => {
      const [first, ...rest] = c.text.split("\n")
      out.push(`${j + 1}. [${c.done ? "x" : " "}] ${first}`, ...rest.map((r) => `   ${r}`))
    })
  })
  return out.join("\n")
}
