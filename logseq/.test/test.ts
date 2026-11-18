// The Logseq plugin: its readers (dates, file names, config.edn, queries, a line's syntax) on their own, then made-up
// graphs imported on a throwaway server, checked against their source, imported again and exported back.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, done, serve } from "../../testkit.ts"

// (after testkit: these import the app's modules)
const { verify } = await import("./check.ts")
const { bigGraph, fixtures, IDS } = await import("./fixtures.ts")
const { readDate, writeDate } = await import("../dates.ts")
const { titleOfFile, fileOfTitle } = await import("../names.ts")
const { graphConfig } = await import("../edn.ts")
const { convertQuery } = await import("../query.ts")
const { repeater } = await import("../back.ts")
const { timestamp } = await import("../convert.ts")

// dates, file names, config
check("journal title read", readDate("Nov 2nd, 2026", "MMM do, yyyy") === "2026-11-02")
check("journal title read in any case", readDate("nov 22ND, 2026", "MMM do, yyyy") === "2026-11-22")
check("journal title written", writeDate("2026-11-01", "MMM do, yyyy") === "Nov 1st, 2026" && writeDate("2026-11-03", "EEEE, dd.MM.yyyy") === "Tuesday, 03.11.2026")
check("journal file name read", readDate("2026_11_02", "yyyy_MM_dd") === "2026-11-02" && readDate("2026_02_30", "yyyy_MM_dd") === null)
check("a format with words in it", readDate("2026-11-01 Sunday", "yyyy-MM-dd EEEE") === "2026-11-01" && readDate("2026年11月02日", "yyyy年MM月dd日") === "2026-11-02")
check("triple-lowbar names", titleOfFile("Projects___Lighthouse___Lamp", "triple-lowbar") === "Projects/Lighthouse/Lamp" && titleOfFile("What%3A now%3F", "triple-lowbar") === "What: now?")
check("legacy names", titleOfFile("projects.lamp", "legacy") === "projects/lamp" && titleOfFile("v1%2E2 notes", "legacy") === "v1.2 notes" && titleOfFile("a%2Fb", "legacy") === "a/b")
check("names written as Logseq writes them", fileOfTitle("Projects/Lamp") === "Projects___Lamp" && fileOfTitle("What: now?") === "What%3A now%3F")
const cfg = graphConfig('{:preferred-workflow :todo ;; c\n :file/name-format :triple-lowbar :journal/page-title-format "dd-MM-yyyy" :hidden ["a" "b/"] :macros {"x" "[[$1]]"} :f (fn [r] r) :g #{1 2}}')
check("config.edn read", cfg.workflow === "todo" && cfg.fileNameFormat === "triple-lowbar" && cfg.journalTitleFormat === "dd-MM-yyyy" && cfg.hidden.join() === "a,b" && cfg.macros.x === "[[$1]]", cfg)
check("config.edn defaults", graphConfig("{}").workflow === "now" && graphConfig("{}").fileNameFormat === "legacy" && graphConfig("{}").journalFileFormat === "yyyy_MM_dd")

// queries and timestamps
const page = (t: string) => `Logseq/${t}`
check("a task query", convertQuery("(task TODO DOING)", page)?.text === "(status.type is TODO) OR (status.type is IN_PROGRESS)")
check("a task query with a priority", convertQuery("(and (task todo) (priority a))", page)?.text === "status.type is TODO\n(priority is high)")
check("a page query", convertQuery("(page-property type [[Project]])", page)?.text === 'LIST\nWHERE contains(type, "Project")')
check("a ref query", convertQuery("[[Alice Park]]", page)?.text === "LIST\nFROM [[Logseq/Alice Park]]")
check("a query that can't mean the same is kept", convertQuery("(between -7d today)", page) === null && convertQuery("(and (task todo) (between -7d today))", page) === null)
check("a timestamp with a repeater", JSON.stringify(timestamp("<2026-11-04 Wed 08:00 .+1w>")) === JSON.stringify({ date: "2026-11-04", every: "every week when done", exact: false }))
check("repeaters back", repeater("every week when done") === ".+1w" && repeater("every 3 days") === "+3d" && repeater("every Monday") === null)

// made-up graphs, each through a throwaway server of its own
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-fixtures-"))
const graphs = { ...fixtures(tmp), big: bigGraph(path.join(tmp, "big"), { pages: 400, days: 60, assets: 20 }) }
type Server = Awaited<ReturnType<typeof serve>>
type Result = Exclude<Awaited<ReturnType<typeof verify>>, { error: string }>
async function through(name: keyof typeof graphs, then: (s: Server, r: Result) => Promise<void> = async () => {}, before: (s: Server) => string[] = () => []) {
  const s = await serve(["logseq"])
  try {
    const r = await verify(s, name, graphs[name], { merged: before(s) })
    if ("error" in r) { check(`${name}: imported`, false, r.error); return }
    check(`${name}: imported, links resolve, notes render, importing again changes nothing`, !r.fails.length, r.fails)
    check(`${name}: exported back equivalent`, r.trip.same === r.trip.compared, r.trip.differ)
    console.log(`     ${name}: ${r.source.pages} pages, ${r.source.journals} journals, ${r.source.blocks} blocks; import ${r.ms.import} ms, export ${r.ms.export} ms`)
    await then(s, r)
  } finally { s.stop() }
}

try {
  // (a day that has a daily note already: the journal's blocks go after what it has)
  await through("lighthouse", async (s, r) => {
    const note = s.read("Logseq/Lighthouse.md")
    check("page properties are frontmatter", /aliases: \[The Lighthouse, Beacon\]/.test(note) && /tags: \[project, coastal-work\]/.test(note) && /rating: 8/.test(note) && /started: '\[\[2025-03-02\|Mar 2nd, 2025\]\]'/.test(note), note.slice(0, 300))
    check("a block property stays a field, a block id a ^id", note.includes("speed:: 6 rpm") && note.includes(`^${IDS.beam}`))
    check("tasks in the Tasks plugin's format", note.includes("- [ ] Order a new lens #shopping ⏫ ⏳ 2026-11-05 📅 2026-11-09") && note.includes("- [/] Paint the railing") && note.includes("- [x] Check the beam") && note.includes("- [-] Old plan") && note.includes("- [ ] WAITING Delivery of oil") && note.includes("    - > [!note]"))
    check("a repeater and a time kept", note.includes("- [ ] Wind the clock 🔁 every week when done ⏳ 2026-11-04") && note.includes("%%SCHEDULED: <2026-11-04 Wed 08:00 .+1w>%%") && note.includes("🔁 every month 📅 2026-11-30"))
    check("block refs link to the block", note.includes(`[[Logseq/Lighthouse#^${IDS.beam}|The beam turns every 10 seconds.]]`) && note.includes(`[[Logseq/Lighthouse#^${IDS.beam}|the beam]]`), note.split("\n").filter((l) => l.includes(IDS.beam)))
    check("embeds", note.includes(`![[Logseq/Lighthouse#^${IDS.beam}]]`) && note.includes("![[Alice Park]]"), note.split("\n").filter((l) => l.includes("![[")))
    check("assets embedded where they were", note.includes("![[Attachments/beam_1730000000000_0.png|240]]") && note.includes("![[Attachments/sub/plan.png]]") && note.includes("![[Attachments/keeper-manual_1730000000000_0.pdf]]") && note.includes("![[Logseq/draws/2026-11-01-10-00-00.excalidraw]]"))
    check("callouts, highlights, macros", note.includes("> [!note]") && note.includes("> [!warning]") && note.includes("> [!quote]") && note.includes("==a highlight==") && note.includes("[Ticket 42](https://example.com/tickets/42)") && note.includes("{{mark hi}}") && note.includes("[Video](https://www.youtube.com/watch?v=abcdefghijk)"))
    check("queries made Tasks and Dataview queries, the others kept", note.includes("```tasks\n") && note.includes("```dataview\n") && note.includes("{{query (between -7d today)}}") && note.includes("Advanced Logseq query (not converted):"))
    check("numbered blocks and text that isn't a block", note.includes("    1. numbered one") && note.includes("      1. not a block"))
    check("a namespace is folders, its title an alias", /aliases: \[Projects\/Lighthouse\/Lamp\]/.test(s.read("Logseq/Projects/Lighthouse/Lamp.md")) && note.includes("[[Projects/Lighthouse/Lamp]]"))
    check("a title a file can't have", /aliases: \['What: now\?'\]/.test(s.read("Logseq/What - now.md")))
    check("journals are daily notes", /^---\ntype: day\next_id: logseq-/.test(s.read("Daily/2025-03-02.md")) && s.read("Daily/2025-03-03.md").includes("[[2025-03-02|Mar 2nd, 2025]]") && s.read("Daily/2025-03-03.md").includes("[[2025-03-01|Mar 1st, 2025]]"))
    check("flashcards as a cards note", /type: cards/.test(s.read("Logseq/Cards/Lighthouse.md")) && s.read("Logseq/Cards/Lighthouse.md").includes("## What lights the lamp?\nOil, then a wick.") && s.read("Logseq/Cards/Lighthouse.md").includes("## The beam turns every ==10 seconds==."))
    check("PDF highlights keep their places, an area its picture", s.read("Logseq/hls__keeper-manual_1730000000000_0.md").includes(`![[Attachments/keeper-manual_1730000000000_0/1_${IDS.area}_1730000001000.png]] ^${IDS.area}`))
    check("an Org page converted, one it can't say kept", s.read("Logseq/Changelog.md").includes("- [ ] Write the **release** notes for *the* lamp ⏳ 2026-11-06") && fs.existsSync(path.join(s.vault, "Logseq/Footnotes.org")))
    check("what Logseq hides isn't imported", !fs.existsSync(path.join(s.vault, "Logseq/secret.md")) && !fs.readdirSync(path.join(s.vault, "Logseq")).some((f) => /bak|recycle|Old/.test(f)))
    check("its config kept for the way back", fs.existsSync(path.join(s.vault, "Logseq/.logseq/config.edn")))
    const day = s.read("Daily/2025-03-03.md")
    check("a journal for a day with a daily note goes after what it has", day.startsWith("---\ntype: day\next_id: logseq-") && day.includes("My own line.\n\n- Followed up on"), day)
    const [js, job] = await s.api("POST", "ops/logseq.job", {})
    check("the job says what it did", js === 200 && job.state === "done" && job.whiteboards.includes("Plan.edn") && job.created === 0 && job.unchanged >= job.notes && r.job.queries === 4 && r.job.queriesKept === 2 && r.job.cards === 2, { job, first: r.job })
    const zip = await fetch(`${s.base}api/logseq/export?folder=Logseq`)
    check("the app's export is a zip", zip.status === 200 && /zip/.test(zip.headers.get("content-type") ?? "") && (await zip.arrayBuffer()).byteLength > 1000)
    const [bad] = await s.api("POST", "ops/logseq.import", { path: "/nowhere/graph" })
    check("a graph that isn't there", bad === 400)
  }, (s) => { s.write("Daily/2025-03-03.md", "---\ntype: day\n---\n\nMy own line.\n"); return ["2025-03-03"] })
  // (daily notes named another way: a folder for each month)
  await through("legacy", async (s) => {
    check("journals go where Daily notes' format puts them", fs.existsSync(path.join(s.vault, "Daily/2025/03/2025-03-02.md")) && s.read("Daily/2025/03/2025-03-02.md").includes("[[2025-03-01|2025-03-01 Saturday]]"), s.read("Daily/2025/03/2025-03-02.md"))
    const legacy = s.read("Logseq/projects/lamp.md")
    check("legacy names and spaces for indentation", legacy.includes("- A namespace written the old way") && legacy.includes("    - A child, indented with spaces.\n        - Its child."), legacy)
    check("LATER and NOW are tasks", s.read("Daily/2025/03/2025-03-02.md").includes("- [ ] Sweep the stairs") && s.read("Daily/2025/03/2025-03-02.md").includes("- [/] Polish the lens"))
  }, (s) => { s.write(".vaultite/plugins/daily-notes/data.json", '{"format": "YYYY/MM/YYYY-MM-DD"}'); return [] })
  await through("dbexport", async (s) => {
    check("the DB version's export: pages, a namespace, a journal by its title", s.read("Logseq/Lighthouse.md").includes("[[Alice Park]]") && fs.existsSync(path.join(s.vault, "Logseq/Projects/Lamp.md")) && s.read("Daily/2025-03-02.md").includes("#meeting"))
  })
  await through("big")
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
done()
