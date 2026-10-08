// Kanban: Obsidian Kanban boards parsed and written back as small edits (made-up boards shaped like Obsidian's), then
// the ops on a throwaway server: reading a board, adding and moving cards, and the file staying Obsidian's.
//   node kanban/.test/test.ts
import fs from "node:fs"
import path from "node:path"
import { check, done, serve } from "../../testkit.ts"

const k = await import("../format.ts")
const SAMPLE = fs.readFileSync(path.join(import.meta.dirname, "sample.md"), "utf8")

/** The lines that differ between two texts: what's left once their common start and end are taken off. */
function diff(a: string, b: string) {
  const x = a.split("\n"), y = b.split("\n")
  let s = 0
  while (s < x.length && s < y.length && x[s] === y[s]) s++
  let e = 0
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
  return { removed: x.slice(s, x.length - e), added: y.slice(s, y.length - e) }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const titles = (t: string) => k.parseBoard(t).lanes.map((l) => `${l.title}: ${l.cards.map((c) => `${k.isDone(c) ? "x" : "o"} ${c.text.split("\n")[0]}`).join(" | ")}`)
const ref = (t: string, lane: number, index: number) => { const b = k.parseBoard(t); return { lane, index, raw: k.rawOf(b, b.lanes[lane].cards[index]) } }

// ---------- reading
{
  const b = k.parseBoard(SAMPLE)
  check("parse: lanes in order, with limits and the complete lane", same(b.lanes.map((l) => [l.title, l.max, l.complete]),
    [["Backlog", 0, false], ["Doing", 2, false], ["Done", 0, true], ["Empty lane", 0, false]]), b.lanes.map((l) => [l.title, l.max, l.complete]))
  check("parse: cards with their checkboxes; a card's indented lines (and a list in it) are its text", same(b.lanes[0].cards.map((c) => c.text), [
    "Draft the Lighthouse launch post @{2026-10-12} #writing", "Ask [[Alice Park]] about the beta list\nShe said maybe next week\n- [ ] a sub-task inside the card", "Order sample prints"]),
  b.lanes[0].cards.map((c) => c.text))
  check("parse: a block id is kept apart from the text", b.lanes[0].cards[2].blockId === "k3v9")
  check("parse: the archive after *** isn't a lane; settings read", b.archive?.cards.length === 1 && b.archive.cards[0].text === "2026-09-30 10:15 Old card" &&
    same(b.settings["list-collapse"], [false, false, false, true]) && k.collapsed(b, 3) && !k.collapsed(b, 0))
  check("parse: the frontmatter marks a board", k.isBoard(SAMPLE) && !k.isBoard("# Just a note\n\n## A heading\n- [ ] a task\n") && k.isBoard("---\nkanban-plugin: basic\n---\n"))
  const odd = "---\nkanban-plugin: board\n---\n\n## One\n\n* plain item\n+ [x] done with a plus\n\nA paragraph ends the list.\n\n- [ ] not a card (a second list)\n\n```\n## Not a lane\n```\n### Two\n- [ ] deeper heading<br>with a break\n"
  check("parse: leniently: * and + items, a card without a checkbox, a second list and a fenced heading left out, any heading level",
    same(titles(odd), ["One: o plain item | x done with a plus", "Two: o deeper heading"]) && k.parseBoard(odd).lanes[1].cards[0].text === "deeper heading\nwith a break", titles(odd))
  check("parse: CRLF-free empty board, no lanes", k.parseBoard("---\nkanban-plugin: board\n---\n").lanes.length === 0)
  const bits = k.bitsOf("Call [[Alice Park]] @{2026-10-08} @@{14:30} #work #web/design")
  check("card bits: date and time taken out of the text, its tags listed", bits.text === "Call [[Alice Park]] #work #web/design" && bits.date === "2026-10-08" && bits.time === "14:30" && same(bits.tags, ["work", "web/design"]), bits)
  check("card bits: a date linked to a daily note", k.bitsOf("Plan @[[2026-10-09]]").date === "2026-10-09")
}

// ---------- writing: each edit changes only its lines, and the result reads back as meant
{
  const t1 = k.toggleCard(SAMPLE, ref(SAMPLE, 0, 0))
  check("tick: one character of one line", same(diff(SAMPLE, t1), { removed: ["- [ ] Draft the Lighthouse launch post @{2026-10-12} #writing"], added: ["- [x] Draft the Lighthouse launch post @{2026-10-12} #writing"] }), diff(SAMPLE, t1))
  check("tick: and back", k.toggleCard(t1, ref(t1, 0, 0)) === SAMPLE)

  const t2 = k.setCardText(SAMPLE, ref(SAMPLE, 0, 2), "Order sample prints\nfrom the shop on Main St")
  check("edit: the card's lines only, a line break indented, the block id kept", same(diff(SAMPLE, t2), { removed: [], added: ["\tfrom the shop on Main St"] }), diff(SAMPLE, t2))

  const t3 = k.addCard(SAMPLE, 0, "New idea from [[Bob Lee]]")
  check("add: at the end of the lane (Obsidian's default)", same(diff(SAMPLE, t3).added, ["- [ ] New idea from [[Bob Lee]]"]) && titles(t3)[0].endsWith("o New idea from [[Bob Lee]]"), diff(SAMPLE, t3))
  const t4 = k.addCard(SAMPLE, 1, "Urgent", "top")
  check("add: at the top when asked", titles(t4)[1] === "Doing: o Urgent | o Fix the onboarding copy #web | x Update the pricing page", titles(t4))
  const t5 = k.addCard(SAMPLE, 3, "First card")
  check("add: into an empty lane, under its heading", same(diff(SAMPLE, t5).added, ["- [ ] First card"]) && titles(t5)[3] === "Empty lane: o First card", diff(SAMPLE, t5))
  const t6 = k.addCard(SAMPLE, 2, "Already shipped")
  check("add: into the complete lane, ticked", titles(t6)[2] === "Done: x Ship the beta to Bob Lee | x Already shipped", titles(t6))
  const prepend = SAMPLE.replace(`"archive-with-date":true`, `"archive-with-date":true,"new-card-insertion-method":"prepend"`)
  check("add: the board's prepend setting puts new cards on top", titles(k.addCard(prepend, 0, "Top"))[0].startsWith("Backlog: o Top |"))

  const m1 = k.moveCard(SAMPLE, ref(SAMPLE, 0, 1), 1, 1)
  check("move: a card with its lines to another lane, at a place", same(titles(m1).slice(0, 2), ["Backlog: o Draft the Lighthouse launch post @{2026-10-12} #writing | o Order sample prints",
    "Doing: o Fix the onboarding copy #web | o Ask [[Alice Park]] about the beta list | x Update the pricing page"]) && m1.includes("- [ ] Ask [[Alice Park]] about the beta list\n\tShe said maybe next week\n\t- [ ] a sub-task inside the card\n- [x] Update"), titles(m1))
  check("move: nothing else changes (same lines, reordered)", same(m1.split("\n").sort(), SAMPLE.split("\n").sort()))
  const m2 = k.moveCard(SAMPLE, ref(SAMPLE, 0, 0), 2, 0)
  check("move: into the complete lane ticks it", titles(m2)[2] === "Done: x Draft the Lighthouse launch post @{2026-10-12} #writing | x Ship the beta to Bob Lee", titles(m2))
  const m3 = k.moveCard(SAMPLE, ref(SAMPLE, 2, 0), 0, 3)
  check("move: out of the complete lane unticks it", titles(m3)[0].endsWith("o Ship the beta to Bob Lee") && titles(m3)[2] === "Done: ", titles(m3))
  const m4 = k.moveCard(SAMPLE, ref(SAMPLE, 0, 0), 0, 2)
  check("move: within a lane", titles(m4)[0] === "Backlog: o Ask [[Alice Park]] about the beta list | o Order sample prints | o Draft the Lighthouse launch post @{2026-10-12} #writing", titles(m4))
  const m5 = k.moveCard(SAMPLE, ref(SAMPLE, 1, 0), 3, 0)
  check("move: into an empty lane", titles(m5)[3] === "Empty lane: o Fix the onboarding copy #web" && titles(m5)[1] === "Doing: x Update the pricing page", titles(m5))
  let threw = ""
  try { k.moveCard(SAMPLE, { lane: 0, index: 0, raw: "- [ ] something else" }, 1, 0) } catch (e) { threw = (e as Error).message }
  check("move: a card that changed meanwhile is refused", /changed/.test(threw), threw)
  const moved = k.parseBoard(t4)
  check("find: a card found by its lines after others moved", k.findCard(moved, ref(SAMPLE, 1, 0)).index === 1)

  const a1 = k.archiveCard(SAMPLE, ref(SAMPLE, 1, 1), new Date(2026, 9, 6, 9, 5))
  check("archive: out of its lane, dated (archive-with-date) at the end of the archive", titles(a1)[1] === "Doing: o Fix the onboarding copy #web" &&
    same(k.parseBoard(a1).archive?.cards.map((c) => c.text), ["2026-09-30 10:15 Old card", "2026-10-06 09:05 Update the pricing page"]), k.parseBoard(a1).archive)
  const plain = "---\n\nkanban-plugin: board\n\n---\n\n## A\n\n- [ ] one\n- [x] two\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\"}\n```\n%%"
  const a2 = k.archiveCard(plain, ref(plain, 0, 1))
  check("archive: made after the lanes when there's none, before the settings",
    a2 === "---\n\nkanban-plugin: board\n\n---\n\n## A\n\n- [ ] one\n\n\n***\n\n## Archive\n\n- [x] two\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\"}\n```\n%%", a2)
  const a3 = k.archiveDone(SAMPLE, undefined, new Date(2026, 9, 6, 9, 5))
  check("archive done: ticked cards and the complete lane's", same(titles(a3), ["Backlog: o Draft the Lighthouse launch post @{2026-10-12} #writing | o Ask [[Alice Park]] about the beta list | o Order sample prints",
    "Doing: o Fix the onboarding copy #web", "Done: ", "Empty lane: "]) && k.parseBoard(a3).archive?.cards.length === 3, titles(a3))
  check("archive date: moment's tokens", k.formatDate(new Date(2026, 0, 2, 3, 4, 5), "YYYY-MM-DD HH:mm:ss [at] D/M") === "2026-01-02 03:04:05 at 2/1")

  const r1 = k.removeCard(SAMPLE, ref(SAMPLE, 0, 1))
  check("delete: the card's three lines", same(diff(SAMPLE, r1).removed, ["- [ ] Ask [[Alice Park]] about the beta list", "\tShe said maybe next week", "\t- [ ] a sub-task inside the card"]) && !diff(SAMPLE, r1).added.length, diff(SAMPLE, r1))

  const l1 = k.addLane(SAMPLE, "Review")
  const lb = k.parseBoard(l1)
  check("lane: added after the others, before the archive", same(lb.lanes.map((l) => l.title), ["Backlog", "Doing", "Done", "Empty lane", "Review"]) && lb.archive?.cards.length === 1 &&
    same(lb.settings["list-collapse"], [false, false, false, true, false]), lb.lanes.map((l) => l.title))
  const l2 = k.renameLane(SAMPLE, 1, "In progress")
  check("lane: renamed, its limit kept", same(diff(SAMPLE, l2), { removed: ["## Doing (2)"], added: ["## In progress (2)"] }), diff(SAMPLE, l2))
  const l3 = k.removeLane(SAMPLE, 0)
  check("lane: deleted with its cards; the collapsed flags follow", same(k.parseBoard(l3).lanes.map((l) => l.title), ["Doing", "Done", "Empty lane"]) &&
    same(k.parseBoard(l3).settings["list-collapse"], [false, false, true]), k.parseBoard(l3).settings)
  const l4 = k.moveLane(SAMPLE, 3, 0)
  check("lane: moved, with its cards and collapsed flag", same(titles(l4), ["Empty lane: ", ...titles(SAMPLE).slice(0, 3)]) && same(k.parseBoard(l4).settings["list-collapse"], [true, false, false, false]), titles(l4))
  const l5 = k.moveLane(SAMPLE, 0, 4)
  check("lane: moved to the end, the archive kept after it", same(titles(l5), [...titles(SAMPLE).slice(1), titles(SAMPLE)[0]]) && k.parseBoard(l5).archive?.cards.length === 1, titles(l5))
  const c1 = k.setCollapsed(SAMPLE, 0, true)
  check("collapse: only the settings line changes", diff(SAMPLE, c1).added.length === 1 && same(k.parseBoard(c1).settings["list-collapse"], [true, false, false, true]), diff(SAMPLE, c1))
  const fresh = k.newBoard()
  check("new board: Obsidian's shape (frontmatter, lanes, Done complete, settings)", k.isBoard(fresh) && same(titles(fresh), ["To do: ", "Doing: ", "Done: "]) && k.parseBoard(fresh).lanes[2].complete &&
    fresh.endsWith("%% kanban:settings\n```\n{\"kanban-plugin\":\"board\",\"list-collapse\":[false,false,false]}\n```\n%%"), fresh)
  const built = k.moveCard(k.addCard(k.addCard(fresh, 0, "a"), 0, "b"), { lane: 0, index: 0 }, 2, 0)
  check("new board: cards added and moved read back", same(titles(built), ["To do: o b", "Doing: ", "Done: x a"]), built)
  const spaces = "---\nkanban-plugin: board\n---\n## A\n- [ ] one\n    more\n"
  check("edit: a board indented with spaces keeps spaces", k.setCardText(spaces, { lane: 0, index: 0 }, "one\nmore\nagain").endsWith("- [ ] one\n    more\n    again\n"))
}

// ---------- on a server: the ops and the text agents read
const s = await serve(["kanban"])
try {
  s.write("Boards/Launch.md", SAMPLE)
  const listed = s.vau("kanban", "list")
  check("kanban.list: the vault's boards", listed.includes("Boards/Launch.md") && listed.includes("4 lanes"), listed)
  const read = s.vau("kanban", "read", "Boards/Launch.md")
  check("kanban.read: lanes numbered with their cards", read.includes("## 2. Doing (2) _limit 2_") && read.includes("1. [ ] Draft the Lighthouse launch post") && read.includes("1 archived"), read)
  const [st, added] = await s.api("POST", "ops/kanban.add", { path: "Boards/Launch.md", lane: "doing", text: "Write the FAQ" })
  check("kanban.add: a card at the end of a lane named in any case", st === 200 && s.read("Boards/Launch.md").includes("- [x] Update the pricing page\n- [ ] Write the FAQ\n"), added)
  const [st2, mv] = await s.api("POST", "ops/kanban.move", { path: "Boards/Launch.md", card: "faq", to: "Done" })
  check("kanban.move: by words of its text, into the complete lane (ticked)", st2 === 200 && s.read("Boards/Launch.md").includes("**Complete**\n- [x] Ship the beta to Bob Lee\n- [x] Write the FAQ\n"), mv)
  const [st3, mv3] = await s.api("POST", "ops/kanban.move", { path: "Boards/Launch.md", card: "2", from: "Backlog", to: "1", position: 1 })
  check("kanban.move: by number in a lane, to a place", st3 === 200 && titles(s.read("Boards/Launch.md"))[0].startsWith("Backlog: o Ask [[Alice Park]]"), mv3)
  const [st4, amb] = await s.api("POST", "ops/kanban.move", { path: "Boards/Launch.md", card: "the", to: "Done" })
  check("kanban.move: words several cards have are refused, naming them", st4 >= 400 && /cards say/.test(JSON.stringify(amb)), amb)
  const [st5] = await s.api("POST", "ops/kanban.done", { path: "Boards/Launch.md", card: "onboarding" })
  check("kanban.done: ticks a card", st5 === 200 && s.read("Boards/Launch.md").includes("- [x] Fix the onboarding copy #web"))
  const [st6] = await s.api("POST", "ops/kanban.archive", { path: "Boards/Launch.md", card: "onboarding" })
  check("kanban.archive: into the archive", st6 === 200 && k.parseBoard(s.read("Boards/Launch.md")).archive!.cards.some((c) => c.text.endsWith("Fix the onboarding copy #web")))
  const [st7, made] = await s.api("POST", "ops/kanban.new", { name: "Garden", lanes: ["Ideas", "Planted", "Done"] })
  check("kanban.new: a board where new notes go", st7 === 200 && k.isBoard(s.read(made.path)) && same(titles(s.read(made.path)), ["Ideas: ", "Planted: ", "Done: "]), made)
  const [, notBoard] = await s.api("POST", "ops/kanban.add", { path: "Start here.md", lane: "1", text: "x" })
  check("kanban.add: refuses a note that isn't a board", /isn't a board/.test(JSON.stringify(notBoard)), notBoard)
  const [, state] = await s.api("GET", "files")
  const row = state.files.find((f: { path: string }) => f.path === "Boards/Launch.md")
  check("its type is kanban (Obsidian's mark), for the app to draw it", row?.type === "kanban", row)
  const [, rendered] = await s.api("GET", "render?path=Boards/Launch.md")
  check("render: the board as Markdown, its settings left out", typeof rendered === "string" ? rendered.includes("## Backlog") && !rendered.includes("kanban:settings") : JSON.stringify(rendered).includes("## Backlog"), rendered)
  check("docs: vau docs kanban", s.vau("docs", "kanban").includes("kanban-plugin: board"))
} finally {
  s.stop()
}
done()
