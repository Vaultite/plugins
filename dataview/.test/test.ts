// Unit tests for the DQL parser, the page index and the engine, over fixtures/vault (made-up notes written the way
// Dataview users write them). Plain Node: node dataview/test.ts
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { DqlError, parseExpr, parseQuery } from "../dql.ts"
import { evaluateInline, execute, type Context, type Result, type Row } from "../engine.ts"
import { index, type Note } from "../pages.ts"
import { markdown } from "../text.ts"
import { DvDate, Duration, Link, dateIso, durationText, formatDate, fromInline, parseDuration, toText, type Value } from "../values.ts"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "vault")
let failed = 0, passed = 0
function check(name: string, ok: unknown, got?: unknown) {
  if (ok) { passed++; return }
  failed++
  console.log(`FAIL ${name}${got !== undefined ? `\n     got: ${typeof got === "string" ? got : JSON.stringify(got, (_k, v) => (v instanceof Link ? v.markdown() : v instanceof DvDate ? dateIso(v) : v))}` : ""}`)
}

// ---------- the fixture vault as the server gives it
const notes: Note[] = []
const walk = (d: string) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) walk(p)
    else if (f.name.endsWith(".md")) {
      const raw = fs.readFileSync(p, "utf8")
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
      const rel = path.relative(ROOT, p)
      notes.push({ path: rel, fm: m ? parseYaml(m[1]) ?? {} : {}, body: (m ? m[2] : raw).replace(/^\n+/, ""), ctime: Date.UTC(2026, 8, 1), mtime: Date.UTC(2026, 9, 1, 12), size: raw.length })
    }
  }
}
walk(ROOT)
const resolve = (t: string) => {
  const k = t.trim().toLowerCase().replace(/\.md$/, "")
  const hit = notes.find((n) => n.path.toLowerCase().replace(/\.md$/, "") === k || n.path.replace(/^.*\//, "").replace(/\.md$/, "").toLowerCase() === k
    || (Array.isArray(n.fm.aliases) && n.fm.aliases.some((a) => String(a).toLowerCase() === k)))
  return hit?.path ?? null
}
const pages = index(notes, resolve)
const byPath = new Map(pages.map((p) => [String((p.file as Row).path), p]))
const now = new Date(2026, 9, 6, 9, 30)
const ctx = (self = "Reading dashboard.md"): Context => ({ pages, page: (p) => byPath.get(p) ?? null, resolve, self: byPath.get(self) ?? null, now })
const q = (src: string, self?: string): Result => execute(parseQuery(src), ctx(self))
const names = (r: Result) => r.type === "table" ? r.rows.map((x) => toText(x.cells[0] ?? null)) : r.type === "list" ? r.items.map((i) => toText((i.id ?? i.value) ?? null)) : []
const inline = (src: string, self = "Reading dashboard.md") => evaluateInline(parseExpr(src), ctx(self))
const throws = (f: () => unknown, re: RegExp) => { try { f(); return false } catch (e) { return e instanceof DqlError && re.test(e.message) } }

// ---------- parser
{
  const p = parseQuery(`TABLE WITHOUT ID file.link AS "Book", rating, default(finished, date(today)) - started AS Played\nFROM #book AND -"Archive" OR (outgoing([[Lighthouse]]) and [[Alice Park]])\nWHERE rating >= 8\nSORT rating DESC, file.name\nGROUP BY status AS state\nFLATTEN tags\nLIMIT 5`)
  check("parse: type and without id", p.type === "table" && p.withoutId)
  check("parse: column names", p.columns.map((c) => c.name).join("|") === "Book|rating|Played", p.columns.map((c) => c.name))
  check("parse: source tree", p.from.k === "or" && p.from.a.k === "and" && p.from.a.b.k === "not", p.from)
  check("parse: commands in order", p.commands.map((c) => c.k).join() === "where,sort,group,flatten,limit")
  const sort = p.commands[1]
  check("parse: sort keys", sort.k === "sort" && sort.by.length === 2 && sort.by[0].desc && !sort.by[1].desc)
  check("parse: group as", p.commands[2].k === "group" && p.commands[2].as === "state")
  check("parse: lowercase and comments", parseQuery("list // all of them\nfrom \"Books\"\n// done").from.k === "folder")
  check("parse: field names with dashes", JSON.stringify(parseExpr("due-date - dur(1 day)")).includes(`"name":"due-date"`))
  check("parse: date literal vs call", parseExpr("date(today)").k === "date" && parseExpr("date(due)").k === "call" && parseExpr("date(2026-10-01T09:00)").k === "date")
  check("parse: lambda", parseExpr("map(xs, (x) => x * 2)").k === "call")
  check("parse: error says what's wrong", throws(() => parseQuery("TABLE rating FORM #book"), /expected FROM, WHERE/))
  check("parse: error on an unknown type", throws(() => parseQuery("SELECT * FROM x"), /starts with LIST, TABLE, TASK or CALENDAR/))
  check("parse: calendar needs a date", throws(() => parseQuery("CALENDAR"), /CALENDAR needs a date/))
  check("parse: unclosed text", throws(() => parseQuery(`LIST WHERE x = "a`), /no closing/))
}

// ---------- values
{
  check("value: inline number", fromInline("9") === 9)
  check("value: inline date", fromInline("2026-10-01") instanceof DvDate)
  check("value: date with a space is text", fromInline("2026-10-01 18:00") === "2026-10-01 18:00")
  check("value: inline links list", Array.isArray(fromInline("[[A]], [[B]]")) && (fromInline("[[A]], [[B]]") as Value[]).length === 2)
  check("value: plain commas stay text", fromInline("red, green") === "red, green")
  check("value: duration", parseDuration("1h 30m")?.ms === 5400000 && parseDuration("3 days, 2 hours")!.ms === 3 * 864e5 + 2 * 36e5)
  check("value: duration text", durationText(Duration.of(9 * 864e5 + 36e5)) === "1 week, 2 days, 1 hour", durationText(Duration.of(9 * 864e5 + 36e5)))
  check("value: dateformat", formatDate(new DvDate(new Date(2026, 9, 6, 14, 5).getTime(), true), "yyyy-MM-dd EEE h:mm a 'at' MMMM") === "2026-10-06 Tue 2:05 PM at October")
}

// ---------- pages: fields, tasks, links, tags
{
  const dune = byPath.get("Books/Dune.md")!, f = dune.file as Row
  check("page: frontmatter link", dune.author instanceof Link && (dune.author as Link).path === "Frank Herbert" && !(dune.author as Link).exists)
  check("page: frontmatter date", dune.started instanceof DvDate && dateIso(dune.started as DvDate) === "2026-08-01")
  check("page: full-line field and its lower-case key", dune.Genre === "Science fiction" && dune.genre === "Science fiction")
  check("page: file fields", f.name === "Dune" && f.folder === "Books" && f.ext === "md" && (f.link as Link).path === "Books/Dune.md")
  check("page: tags with #", JSON.stringify(f.tags) === `["#book","#scifi"]`, f.tags)
  check("page: inlinks", (f.inlinks as Link[]).map((l) => l.path).sort().join() === "People/Alice Park.md,Projects/Lighthouse.md", (f.inlinks as Link[]).map((l) => l.path))
  const alice = byPath.get("People/Alice Park.md")!
  check("page: bold key", (alice["favourite-book"] as Link)?.path === "Books/Dune.md" && alice["Favourite book"] instanceof Link)
  check("page: nested tags", JSON.stringify((alice.file as Row).tags) === `["#people","#people/friend"]` && JSON.stringify((alice.file as Row).etags) === `["#people/friend"]`)
  const bob = byPath.get("People/Bob Lee.md")!
  check("page: bracket and paren fields", bob.phone === "555-0101" && bob.city === "Porto")
  const piranesi = byPath.get("Books/Piranesi.md")!
  check("page: inline number in a sentence", piranesi.pages === 272 && piranesi.mood === "dreamy")
  const day1 = byPath.get("Daily/2026-10-01.md")!, d1 = day1.file as Row
  check("page: file.day from the name", d1.day instanceof DvDate && dateIso(d1.day as DvDate) === "2026-10-01")
  check("page: file.day from yyyymmdd", dateIso((byPath.get("Daily/20261003.md")!.file as Row).day as DvDate) === "2026-10-03")
  check("page: list item field counts for the page", byPath.get("Daily/20261003.md")!.mood === 8)
  check("page: sleep duration", day1.sleep instanceof Duration && (day1.sleep as Duration).ms === 7.5 * 36e5)
  check("page: tasks and lists", (d1.tasks as Row[]).length === 2 && (d1.lists as Row[]).length === 3)
  const call = (d1.tasks as Row[])[0]
  check("page: task fields", call.status === " " && call.completed === false && call.due instanceof DvDate && (call.outlinks as Link[])[0].path === "People/Alice Park.md")
  check("page: emoji completion", dateIso((d1.tasks as Row[])[1].completion as DvDate) === "2026-10-01")
  check("page: alias resolves", ((d1.outlinks as Link[]).find((l) => l.path === "People/Carol Diaz.md")) !== undefined)
  const lh = byPath.get("Projects/Lighthouse.md")!.file as Row
  const draft = (lh.tasks as Row[])[0]
  check("page: subtasks", (draft.children as Row[]).length === 2 && draft.fullyCompleted === false && (lh.tasks as Row[]).length === 5)
  check("page: emoji due on subtask", dateIso(((draft.children as Row[])[1]).due as DvDate) === "2026-10-08")
  check("page: section", (draft.section as Link).subpath === "Tasks")
  check("page: block id link", ((lh.lists as Row[]).find((l) => l.blockId === "idea")?.link as Link)?.subpath === "^idea")
  check("page: custom status", ((byPath.get("Daily/20261003.md")!.file as Row).tasks as Row[])[0].status === "/")
}

// ---------- queries
{
  const books = q(`TABLE author, rating FROM #book SORT rating DESC`)
  check("table: rows sorted (nulls last when descending)", names(books).join("|") === "[[Books/Dune]]|[[Books/Piranesi]]|[[Books/The Hobbit]]", names(books))
  check("table: headers", books.type === "table" && books.headers.join() === "File,author,rating")
  check("table: markdown", markdown(books).startsWith("| File (3) | author | rating |\n| --- | --- | --- |\n| [[Books/Dune]] | [[Frank Herbert]] | 9 |"), markdown(books))
  check("from folder", names(q(`LIST FROM "People"`)).length === 3)
  check("from folder trailing name match only", names(q(`LIST FROM "Peo"`)).length === 0)
  check("from a file", names(q(`LIST FROM "Books/Dune"`)).join() === "[[Books/Dune]]")
  check("from tag includes subtags", names(q(`LIST FROM #people`)).length === 2)
  check("from negation", names(q(`LIST FROM #book AND -#scifi`)).length === 2)
  check("from links to", names(q(`LIST FROM [[Alice Park]]`)).sort().join() === "[[Books/Dune]],[[Daily/2026-10-01]],[[Projects/Lighthouse]]", names(q(`LIST FROM [[Alice Park]]`)))
  check("from outgoing", names(q(`LIST FROM outgoing([[Lighthouse]])`)).sort().join() === "[[Books/Dune]],[[People/Alice Park]],[[People/Bob Lee]]", names(q(`LIST FROM outgoing([[Lighthouse]])`)))
  check("from [[]] is this file", names(q(`LIST FROM [[]]`, "Books/Dune.md")).length === 2)
  check("where with date", names(q(`LIST FROM #book WHERE started >= date(2026-09-01)`)).join() === "[[Books/Piranesi]]")
  check("where contains", names(q(`LIST WHERE contains(file.tags, "#fantasy")`)).length === 2)
  check("where !", names(q(`LIST FROM #book WHERE !rating`)).join() === "[[Books/The Hobbit]]")
  check("where file.mtime", names(q(`LIST FROM "Books" WHERE file.mtime >= date(today) - dur(7 days)`)).length === 3)
  check("where this", names(q(`LIST FROM "People" WHERE city = this.city`, "People/Alice Park.md")).sort().join() === "[[People/Alice Park]],[[People/Carol Diaz]]")
  check("where link equality", names(q(`LIST WHERE owner = [[Alice Park]]`)).join() === "[[Projects/Lighthouse]]")
  check("list with a value", (() => { const r = q(`LIST author FROM #book SORT file.name`); return r.type === "list" && toText(r.items[1].value ?? null) === "Susanna Clarke" })())
  check("list without id", (() => { const r = q(`LIST WITHOUT ID file.name FROM "Books" SORT file.name DESC`); return markdown(r) === "- The Hobbit\n- Piranesi\n- Dune" })(), markdown(q(`LIST WITHOUT ID file.name FROM "Books" SORT file.name DESC`)))
  const grouped = q(`TABLE length(rows) AS Count, rows.file.link AS Books FROM #book GROUP BY status`)
  check("group by: one row per key, sorted", grouped.type === "table" && grouped.headers[0] === "Group" && names(grouped).join() === "read,reading,to-read", names(grouped))
  check("group by: swizzled rows", grouped.type === "table" && toText(grouped.rows[0].cells[2]) === "[[Books/Dune]]")
  check("group list", markdown(q(`LIST rows.file.name FROM "People" GROUP BY relation`)).includes("- colleague:\n  - Bob Lee"))
  check("group then sort by key", names(q(`LIST FROM #book GROUP BY status SORT key DESC`)).join() === "to-read,reading,read")
  const flat = q(`TABLE WITHOUT ID file.name, tags FROM #book FLATTEN tags`)
  check("flatten: a row per value", flat.type === "table" && flat.rows.length === 6, flat.type === "table" ? flat.rows.length : 0)
  const flatTasks = q(`TABLE WITHOUT ID T.text AS Task FROM "Projects" FLATTEN file.tasks AS T WHERE !T.completed`)
  check("flatten file.tasks AS T", flatTasks.type === "table" && flatTasks.rows.length === 4, flatTasks.type === "table" ? flatTasks.rows.map((r) => r.cells) : 0)
  check("limit", names(q(`LIST FROM #book LIMIT 2`)).length === 2)
  check("commands in order (limit then sort)", names(q(`LIST FROM #book SORT file.name LIMIT 2 SORT file.name DESC`)).join() === "[[Books/Piranesi]],[[Books/Dune]]")
  check("table of durations", (() => { const r = q(`TABLE WITHOUT ID finished - started AS Took FROM "Books/Dune"`); return r.type === "table" && toText(r.rows[0].cells[0]) === "2 weeks, 5 days" })(), markdown(q(`TABLE WITHOUT ID finished - started AS Took FROM "Books/Dune"`)))
  check("functions: default, choice, round, upper", (() => {
    const r = q(`TABLE WITHOUT ID default(rating, 0) AS R, choice(rating > 8, "great", "ok") AS C, round(rating / 3, 1) AS D, upper(status) AS U FROM #book SORT file.name`)
    return r.type === "table" && JSON.stringify(r.rows.map((x) => x.cells)) === `[[9,"great",3,"READ"],[8,"ok",2.7,"READING"],[0,"ok",null,"TO-READ"]]`
  })(), (() => { const r = q(`TABLE WITHOUT ID default(rating, 0) AS R, choice(rating > 8, "great", "ok") AS C, round(rating / 3, 1) AS D, upper(status) AS U FROM #book SORT file.name`); return r.type === "table" ? r.rows.map((x) => x.cells) : r })())
  check("average of a page field", (() => { const r = q(`TABLE WITHOUT ID average(rows.mood) AS M FROM "Daily" GROUP BY true`); return r.type === "table" && r.rows[0].cells[0] === 20 / 3 })())
  check("calendar", (() => { const r = q(`CALENDAR file.day FROM "Daily"`); return r.type === "calendar" && r.items.length === 3 })())
  check("unknown function", throws(() => q(`LIST WHERE frobnicate(x)`), /no function frobnicate/))
}

// ---------- tasks
{
  const all = q(`TASK FROM "Projects"`)
  check("task: grouped by file", all.type === "task" && all.groups.length === 2 && toText(all.groups[0].key ?? null) === "[[Projects/Garden]]")
  check("task: subtasks under their parent", all.type === "task" && all.groups[1].tasks.length === 3, all.type === "task" ? all.groups[1].tasks.map((t) => t.text) : 0)
  const open = q(`TASK WHERE !completed`)
  check("task: where !completed keeps children", open.type === "task" && markdown(open).includes("- [ ] Draft the plan [due:: 2026-10-10]\n  - [x] Ask [[Bob Lee]] about the budget"), markdown(open))
  check("task: a child alone when only it matches", (() => { const r = q(`TASK WHERE due = date(2026-10-08)`); return r.type === "task" && r.groups[0].tasks.length === 1 && r.groups[0].tasks[0].text === "Book the venue 📅 2026-10-08" })())
  check("task: page fields inherited", (() => { const r = q(`TASK WHERE owner = [[Alice Park]]`); return r.type === "task" && r.groups.length === 1 && r.groups[0].tasks.length === 3 })())
  check("task: due before", (() => { const r = q(`TASK WHERE due AND due <= date(today) + dur(1 week) AND !completed`); return r.type === "task" && r.groups.reduce((n, g) => n + g.tasks.length, 0) === 2 })(), markdown(q(`TASK WHERE due AND due <= date(today) + dur(1 week) AND !completed`)))
  check("task: group by file.link", (() => { const r = q(`TASK FROM "Daily" GROUP BY file.link`); return r.type === "task" && r.grouped && r.groups.length === 3 })())
  check("task: tags of a task", (() => { const r = q(`TASK WHERE contains(tags, "#writing")`); return r.type === "task" && r.groups[0].tasks[0].text === "Write the summary #writing" })())
}

// ---------- inline queries
{
  check("inline: this.file.name", inline("this.file.name") === "Reading dashboard")
  check("inline: a field of this page without this", inline("goal") === 12)
  check("inline: date(today)", dateIso(inline("date(today)") as DvDate) === "2026-10-06")
  check("inline: a link's field", inline("[[Dune]].rating") === 9)
  check("inline: lambda", inline(`length(filter([[Dune]].file.tags, (t) => t = "#book"))`) === 1)
  check("inline: date arithmetic", toText(inline("date(2026-10-10) - date(today)")) === "4 days", toText(inline("date(2026-10-10) - date(today)")))
  check("inline: dateformat", inline(`dateformat(date(today), "MMMM d, yyyy")`) === "October 6, 2026")
  check("inline: string concat with null", inline(`"x" + nothing`) === "x")
  check("inline: link() and meta()", (() => { const v = inline(`meta(link("Dune", "the book"))`) as Row; return v.path === "Books/Dune.md" && v.display === "the book" })())
  check("inline: sum and map", inline(`sum(map([1, 2, 3], (x) => x * 2))`) === 12)
  check("inline: regexreplace and split", JSON.stringify(inline(`split(regexreplace("a-b_c", "[-_]", " "), " ")`)) === `["a","b","c"]`)
  check("inline: contains on a link list", inline(`contains([[Dune]].file.inlinks, [[Alice Park]])`) === true)
  check("inline: object and index", inline(`{a: 1, b: [10, 20]}["b"][1]`) === 20)
  check("inline: vectorized lower", JSON.stringify(inline(`lower(["A", "B"])`)) === `["a","b"]`)
}

console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
