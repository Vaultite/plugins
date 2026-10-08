// Kanban's server: the ops agents manage Obsidian Kanban boards with (list, read, add, move, tick, archive, new). Each
// write reads the board as it is, changes the lines it's about and saves it as a merge with what's on disk.
import fs from "node:fs"
import { OpError, Plugin, type OpCtx } from "@vaultite/core/plugins.ts"
import {
  addCard, archiveCard, type Board, BoardError, type Card, type CardRef, isBoard, isDone, moveCard, newBoard, parseBoard, rawOf,
  summarize, type Summary, summaryText, toggleCard,
} from "./format.ts"

export const plugin = new Plugin(import.meta.url)

const name = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "")
const boards = () => [...plugin.vault.entries]
  .filter(([p, e]) => p.endsWith(".md") && !p.startsWith(".") && (e.type === "kanban" || (!e.fm.type && typeof e.fm["kanban-plugin"] === "string")))
  .map(([p]) => p).sort()

async function read(ctx: OpCtx, path: string) {
  let text: string
  try { text = String((await ctx.api("GET", `file?path=${encodeURIComponent(path)}`)).text ?? "") } catch { throw new OpError(`there's no board ${path}: kanban.list lists them`, 404) }
  if (!isBoard(text)) throw new OpError(`${path} isn't a board (no kanban-plugin in its frontmatter): kanban.list lists the boards`)
  return text
}

/** `change` applied to the board as it is now, saved as a merge (someone may be dragging a card meanwhile). */
async function write(ctx: OpCtx, path: string, change: (text: string, b: Board) => string) {
  const text = await read(ctx, path)
  let next: string
  try { next = change(text, parseBoard(text)) } catch (e) { throw e instanceof BoardError ? new OpError(e.message) : e }
  if (next !== text) await ctx.api("PUT", "file", { path, text: next, base: text })
  return { path, board: summarize(parseBoard(next), name(path)) }
}

/** A lane by its name (any case) or its number from 1. */
function lane(b: Board, which: string): number {
  const w = String(which).trim()
  if (/^\d+$/.test(w) && Number(w) >= 1 && Number(w) <= b.lanes.length) return Number(w) - 1
  const i = b.lanes.findIndex((l) => l.title.toLowerCase() === w.toLowerCase())
  if (i >= 0) return i
  const near = b.lanes.map((l, n) => ({ l, n })).filter(({ l }) => l.title.toLowerCase().includes(w.toLowerCase()))
  if (near.length === 1) return near[0].n
  throw new OpError(`no lane "${w}": the lanes are ${b.lanes.map((l, n) => `${n + 1}. ${l.title}`).join(", ") || "none yet"}`)
}

/** A card by its number in `from`, or by words of its text (in `from`, else anywhere): exactly one, or an error. */
function card(b: Board, which: string, from?: string): CardRef & { card: Card } {
  const w = String(which).trim()
  const lanes = from ? [lane(b, from)] : b.lanes.map((_, i) => i)
  if (from && /^\d+$/.test(w)) {
    const l = lanes[0], c = b.lanes[l].cards[Number(w) - 1]
    if (!c) throw new OpError(`lane ${b.lanes[l].title} has ${b.lanes[l].cards.length} cards, no card ${w}`)
    return { lane: l, index: Number(w) - 1, raw: rawOf(b, c), card: c }
  }
  const hits = lanes.flatMap((l) => b.lanes[l].cards.map((c, i) => ({ lane: l, index: i, raw: rawOf(b, c), card: c })))
    .filter((h) => h.card.text.toLowerCase().includes(w.toLowerCase()))
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new OpError(`no card says "${w}"${from ? ` in ${b.lanes[lanes[0]].title}` : ""}: kanban.read shows them`, 404)
  throw new OpError(`${hits.length} cards say "${w}": ${hits.slice(0, 6).map((h) => `${b.lanes[h.lane].title} ${h.index + 1} (${h.card.text.split("\n")[0].slice(0, 50)})`).join("; ")}. Give more of its words, or from and its number`)
}

const PATH = { type: "string" as const, format: "path", required: true, description: "the board's vault path (Boards/Launch.md): kanban.list lists them" }
const CARD = { type: "string" as const, required: true, description: "words of the card's text, or its number in the lane `from` names" }
const FROM = { type: "string" as const, description: "the lane the card is in, by name or number from 1 (to tell cards apart)" }
const shown = (r: { board: Summary }) => summaryText(r.board)

plugin.op({
  id: "kanban.list",
  summary: "The vault's Kanban boards (Obsidian Kanban's Markdown files), with how many lanes and cards each has.",
  kind: "read",
  cli: "kanban list",
  mcp: true,
  run: () => boards().map((path) => {
    let text = ""
    try { text = fs.readFileSync(plugin.vault.abs(path), "utf8") } catch { /* (not downloaded yet) */ }
    const b = parseBoard(text), cards = b.lanes.flatMap((l) => l.cards)
    return { path, lanes: b.lanes.length, cards: cards.length, done: cards.filter(isDone).length }
  }),
  text: (r: { path: string; lanes: number; cards: number; done: number }[]) => r.length
    ? r.map((x) => `- [[${x.path.replace(/\.md$/, "")}]]: ${x.lanes} lanes, ${x.cards} cards (${x.done} done) · ${x.path}`).join("\n")
    : "_No boards yet: kanban.new makes one._",
})

plugin.op({
  id: "kanban.read",
  summary: "A Kanban board as text: its lanes in order, each card numbered with whether it's done.",
  help: `The numbers are what kanban.move and kanban.done take with \`from\` (a lane's name or number).

  vau kanban read Boards/Launch.md`,
  kind: "read",
  params: { path: PATH },
  args: ["path"],
  cli: "kanban read",
  mcp: true,
  run: async (p: { path: string }, ctx: OpCtx) => ({ path: p.path, board: summarize(parseBoard(await read(ctx, p.path)), name(p.path)) }),
  text: shown,
})

plugin.op({
  id: "kanban.add",
  summary: "Add a card to a lane of a Kanban board (at its end, or where the board's settings put new cards).",
  help: `The card is Markdown: [[links]], #tags and a date as \`@{2026-10-08}\` show on it. Into a lane marked complete it's ticked.

  vau kanban add Boards/Launch.md Doing "Write the FAQ for [[Lighthouse]]"
  vau kanban add Boards/Launch.md 1 "Call Alice Park @{2026-10-08}" --position top`,
  kind: "write",
  params: {
    path: PATH,
    lane: { type: "string", required: true, description: "the lane, by name (any case) or number from 1" },
    text: { type: "string", required: true, description: "the card's text (Markdown; a line break makes a second line)" },
    position: { type: "string", description: "top, bottom, or its place from 1 (default: the board's setting, else bottom)" },
  },
  args: ["path", "lane", "text"],
  cli: "kanban add",
  mcp: true,
  run: (p: { path: string; lane: string; text: string; position?: string }, ctx: OpCtx) =>
    write(ctx, p.path, (text, b) => addCard(text, lane(b, p.lane), p.text, place(p.position))),
  text: shown,
})

/** A position: top, bottom or a place from 1 (as an index), else undefined. */
function place(pos: string | number | undefined): "top" | "bottom" | number | undefined {
  if (pos === undefined || pos === "") return undefined
  const s = String(pos).trim().toLowerCase()
  if (s === "top" || s === "bottom") return s
  if (/^\d+$/.test(s) && Number(s) >= 1) return Number(s) - 1
  throw new OpError(`position is top, bottom or a place from 1, not "${pos}"`)
}

plugin.op({
  id: "kanban.move",
  summary: "Move a card to another lane (or another place in its lane) of a Kanban board.",
  help: `Find the card by words of its text, or by its number with \`from\`. Into a lane marked complete it's ticked, out of one
unticked (Obsidian Kanban's way).

  vau kanban move Boards/Launch.md "pricing page" Done
  vau kanban move Boards/Launch.md 2 Doing --from Backlog --position 1`,
  kind: "write",
  params: {
    path: PATH, card: CARD,
    to: { type: "string", required: true, description: "the lane it goes to, by name or number from 1" },
    from: FROM,
    position: { type: "string", description: "top, bottom (the default) or its place from 1 in that lane" },
  },
  args: ["path", "card", "to"],
  cli: "kanban move",
  mcp: true,
  run: (p: { path: string; card: string; to: string; from?: string; position?: string }, ctx: OpCtx) => write(ctx, p.path, (text, b) => {
    const c = card(b, p.card, p.from), to = lane(b, p.to)
    const at = place(p.position)
    const size = b.lanes[to].cards.length - (c.lane === to ? 1 : 0)
    return moveCard(text, c, to, at === undefined || at === "bottom" ? size : at === "top" ? 0 : at)
  }),
  text: shown,
})

plugin.op({
  id: "kanban.done",
  summary: "Tick a card of a Kanban board done (or open again with done false).",
  help: `  vau kanban done Boards/Launch.md "pricing page"`,
  kind: "write",
  params: { path: PATH, card: CARD, from: FROM, done: { type: "boolean", default: true, description: "false opens it again" } },
  args: ["path", "card"],
  cli: "kanban done",
  mcp: true,
  run: (p: { path: string; card: string; from?: string; done?: boolean }, ctx: OpCtx) =>
    write(ctx, p.path, (text, b) => toggleCard(text, card(b, p.card, p.from), p.done !== false)),
  text: shown,
})

plugin.op({
  id: "kanban.archive",
  summary: "Move a card of a Kanban board into its archive (the ## Archive after the lanes, as Obsidian Kanban keeps it).",
  help: `  vau kanban archive Boards/Launch.md "old card"`,
  kind: "write",
  params: { path: PATH, card: CARD, from: FROM },
  args: ["path", "card"],
  cli: "kanban archive",
  mcp: true,
  run: (p: { path: string; card: string; from?: string }, ctx: OpCtx) => write(ctx, p.path, (text, b) => archiveCard(text, card(b, p.card, p.from))),
  text: shown,
})

plugin.op({
  id: "kanban.new",
  summary: "Make a Kanban board (Obsidian Kanban's format): To do, Doing and Done, or the lanes you name.",
  help: `It goes where the vault's other boards are (else the vault's top), or in \`folder\`; a last lane named Done is marked
complete (cards moved there are ticked).

  vau kanban new "Garden" --lanes Ideas --lanes Planted --lanes Done`,
  kind: "write",
  params: {
    name: { type: "string", required: true, description: "the board's name (its file's)" },
    folder: { type: "string", format: "path", description: "where it goes (default: with the other boards, else the vault's top)" },
    lanes: { type: "array", items: { type: "string" }, description: "its lanes' names, in order (default: To do, Doing, Done)" },
  },
  args: ["name"],
  cli: "kanban new",
  mcp: true,
  run: async (p: { name: string; folder?: string; lanes?: string[] }, ctx: OpCtx) => {
    const title = p.name.trim().replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ")
    if (!title) throw new OpError("a board needs a name")
    const folder = (p.folder ?? home()).replace(/^\/+|\/+$/g, "")
    const lanes = p.lanes?.map((l) => l.trim()).filter(Boolean)
    const made = await ctx.api("POST", "file", { path: `${folder ? `${folder}/` : ""}${title}.md`, text: newBoard(lanes?.length ? lanes : undefined), unique: true })
    const path = String(made.path)
    return { path, board: summarize(parseBoard(String(made.text ?? "")), name(path)) }
  },
  text: shown,
})

/** The folder most boards are in, else the vault's top (Obsidian's default for new notes). */
function home() {
  const n = new Map<string, number>()
  for (const p of boards()) { const d = p.slice(0, Math.max(0, p.lastIndexOf("/"))); n.set(d, (n.get(d) ?? 0) + 1) }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ""
}
