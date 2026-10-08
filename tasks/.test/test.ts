// The task line parser, recurrence and the query language, on lines written the way Tasks users write them.
//   node tasks/test.ts
import assert from "node:assert/strict"
import { dayIn, spanOf } from "../dates.ts"
import { nextDate, parseRule } from "../recur.ts"
import { tasksIn } from "../scan.ts"
import { changeStatus, DEFAULT_PREFS, fullDescription, newTaskLine, parseTask, serialize, withField } from "../task.ts"
import { parseQuery, runQuery, urgency } from "../query.ts"

let failed = 0, passed = 0
function test(name: string, fn: () => void) {
  try { fn(); passed++ } catch (e) { failed++; console.error(`FAIL ${name}\n  ${(e as Error).message.split("\n").join("\n  ")}`) }
}
const TODAY = "2026-10-06" // a Tuesday

// ---------- parsing

test("emoji fields, Tasks' order", () => {
  const t = parseTask("- [ ] Take out the trash ⏫ 🔁 every week on Tuesday ➕ 2026-09-01 🛫 2026-10-01 ⏳ 2026-10-05 📅 2026-10-06")!
  assert.equal(t.description, "Take out the trash")
  assert.equal(t.priority, "high")
  assert.equal(t.recurrence, "every week on Tuesday")
  assert.deepEqual(t.dates, { created: "2026-09-01", start: "2026-10-01", scheduled: "2026-10-05", due: "2026-10-06" })
  assert.equal(t.format, "emoji")
})
test("fields in any order, and alternate emoji", () => {
  const t = parseTask("* [ ] Renew passport 📆 2026-11-30 🔽 ⌛ 2026-11-01")!
  assert.equal(t.description, "Renew passport")
  assert.equal(t.priority, "low")
  assert.equal(t.dates.due, "2026-11-30")
  assert.equal(t.dates.scheduled, "2026-11-01")
})
test("variation selectors after an emoji", () => {
  const t = parseTask("- [ ] Water plants 📅️ 2026-10-07 ⏳️ 2026-10-06")!
  assert.equal(t.dates.due, "2026-10-07")
  assert.equal(t.dates.scheduled, "2026-10-06")
})
test("tags among the fields stay put; trailing tags are the description's", () => {
  const t = parseTask("- [ ] Write the report #work 📅 2026-10-08 #q4")!
  assert.equal(t.description, "Write the report #work")
  assert.equal(fullDescription(t), "Write the report #work 📅 2026-10-08 #q4".replace(" 📅 2026-10-08", ""))
  assert.deepEqual(t.tags, ["#work", "#q4"])
  assert.equal(serialize(t), "- [ ] Write the report #work 📅 2026-10-08 #q4")
})
test("block link, numbered list, quote, indentation", () => {
  const t = parseTask("  > 1. [x] Ship it ✅ 2026-10-01 ^ship")!
  assert.equal(t.indent, "  > ")
  assert.equal(t.marker, "1.")
  assert.equal(t.status, "DONE")
  assert.equal(t.blockLink, " ^ship")
  assert.equal(t.dates.done, "2026-10-01")
  assert.equal(serialize(t), "  > 1. [x] Ship it ✅ 2026-10-01 ^ship")
})
test("statuses", () => {
  assert.equal(parseTask("- [/] Draft")!.status, "IN_PROGRESS")
  assert.equal(parseTask("- [-] Old idea ❌ 2026-09-01")!.status, "CANCELLED")
  assert.equal(parseTask("- [X] Done too")!.status, "DONE")
  assert.equal(parseTask("- [?] A question")!.status, "TODO")
  assert.equal(parseTask("- not a task"), null)
  assert.equal(parseTask("- [ ]")!.description, "") // an empty one parses
})
test("dependencies and ids", () => {
  const t = parseTask("- [ ] Book flights 🆔 flights ⛔ budget, dates 📅 2026-10-20")!
  assert.equal(t.id, "flights")
  assert.deepEqual(t.dependsOn, ["budget", "dates"])
})
test("Dataview fields", () => {
  const t = parseTask("- [ ] Call Alice Park  [priority:: high]  [repeat:: every month on the 1st]  [due:: 2026-10-08]")!
  assert.equal(t.description, "Call Alice Park")
  assert.equal(t.priority, "high")
  assert.equal(t.recurrence, "every month on the 1st")
  assert.equal(t.dates.due, "2026-10-08")
  assert.equal(t.format, "dataview")
  const u = parseTask("- [x] Paid rent (completion:: 2026-10-01)")!
  assert.equal(u.dates.done, "2026-10-01")
})
test("emoji in the middle of a description isn't a field", () => {
  const t = parseTask("- [ ] Buy 📅 calendar refills for the office")!
  assert.equal(t.description, "Buy 📅 calendar refills for the office")
  assert.equal(t.dates.due, undefined)
})

// ---------- edits

test("a field changed in place, added in Tasks' order, removed", () => {
  const line = "- [ ] Plan trip #travel ⏫ 📅 2026-10-08"
  let t = withField(parseTask(line)!, "due", "2026-10-09")
  assert.equal(serialize(t), "- [ ] Plan trip #travel ⏫ 📅 2026-10-09")
  t = withField(t, "scheduled", "2026-10-07")
  assert.equal(serialize(t), "- [ ] Plan trip #travel ⏫ ⏳ 2026-10-07 📅 2026-10-09")
  t = withField(t, "priority", "none")
  assert.equal(serialize(t), "- [ ] Plan trip #travel ⏳ 2026-10-07 📅 2026-10-09")
  t = withField(t, "done", "2026-10-06")
  assert.equal(serialize(t), "- [ ] Plan trip #travel ⏳ 2026-10-07 📅 2026-10-09 ✅ 2026-10-06")
})
test("a Dataview task gets Dataview fields", () => {
  const t = withField(parseTask("- [ ] Call Alice  [due:: 2026-10-08]")!, "scheduled", "2026-10-07")
  assert.equal(serialize(t), "- [ ] Call Alice  [scheduled:: 2026-10-07]  [due:: 2026-10-08]")
})
test("ticking writes the done date; unticking takes it off", () => {
  assert.deepEqual(changeStatus("- [ ] Pay rent 📅 2026-10-01", "x", TODAY), ["- [ ] Pay rent 📅 2026-10-01".replace("[ ]", "[x]") + " ✅ 2026-10-06"])
  assert.deepEqual(changeStatus("- [x] Pay rent 📅 2026-10-01 ✅ 2026-10-06", " ", TODAY), ["- [ ] Pay rent 📅 2026-10-01"])
  assert.deepEqual(changeStatus("- [ ] Old idea", "-", TODAY), ["- [-] Old idea ❌ 2026-10-06"])
  assert.deepEqual(changeStatus("- [ ] Pay rent", "x", TODAY, { ...DEFAULT_PREFS, doneDate: false }), ["- [x] Pay rent"])
  assert.deepEqual(changeStatus("- [ ] Pay rent ^rent", "x", TODAY), ["- [x] Pay rent ✅ 2026-10-06 ^rent"])
})
test("a recurring task adds its next one above, dates moved together", () => {
  const out = changeStatus("- [ ] Water plants 🔁 every week ⏳ 2026-10-04 📅 2026-10-06 ^w", "x", TODAY)
  assert.deepEqual(out, [
    "- [ ] Water plants 🔁 every week ⏳ 2026-10-11 📅 2026-10-13",
    "- [x] Water plants 🔁 every week ⏳ 2026-10-04 📅 2026-10-06 ✅ 2026-10-06 ^w",
  ])
  const below = changeStatus("    - [ ] Stretch 🔁 every day 📅 2026-10-06", "x", TODAY, { ...DEFAULT_PREFS, recurrenceBelow: true })
  assert.equal(below[1], "    - [ ] Stretch 🔁 every day 📅 2026-10-07")
})
test("when done counts from today; created date follows the setting", () => {
  const out = changeStatus("- [ ] Haircut 🔁 every 4 weeks when done ➕ 2026-08-01 📅 2026-09-01", "x", TODAY)
  assert.equal(out[0], "- [ ] Haircut 🔁 every 4 weeks when done 📅 2026-11-03")
  const made = changeStatus("- [ ] Haircut 🔁 every 4 weeks when done 📅 2026-09-01", "x", TODAY, { ...DEFAULT_PREFS, createdDate: true })
  assert.equal(made[0], "- [ ] Haircut 🔁 every 4 weeks when done ➕ 2026-10-06 📅 2026-11-03")
})
test("🏁 delete drops the done one", () => {
  assert.deepEqual(changeStatus("- [ ] Gym 🔁 every day 🏁 delete 📅 2026-10-06", "x", TODAY), ["- [ ] Gym 🔁 every day 🏁 delete 📅 2026-10-07"])
  assert.deepEqual(changeStatus("- [ ] Once 🏁 delete", "x", TODAY), [])
})
test("in progress, then done", () => {
  assert.deepEqual(changeStatus("- [/] Draft essay 📅 2026-10-10", "x", TODAY), ["- [x] Draft essay 📅 2026-10-10 ✅ 2026-10-06"])
})
test("a new line in each format", () => {
  assert.equal(newTaskLine("Call Alice", { due: "2026-10-08", priority: "high", recurrence: "every week" }, "emoji"), "- [ ] Call Alice ⏫ 🔁 every week 📅 2026-10-08")
  assert.equal(newTaskLine("Call Alice", { due: "2026-10-08", priority: "high" }, "dataview"), "- [ ] Call Alice  [priority:: high]  [due:: 2026-10-08]")
})

// ---------- recurrence

const next = (rule: string, from: string) => { const r = parseRule(rule); assert.ok(r, `"${rule}" should parse`); return nextDate(r!, from) }
test("recurrence rules", () => {
  assert.equal(next("every day", "2026-10-06"), "2026-10-07")
  assert.equal(next("every 3 days", "2026-10-30"), "2026-11-02")
  assert.equal(next("every week", "2026-10-06"), "2026-10-13")
  assert.equal(next("every 2 weeks", "2026-10-06"), "2026-10-20")
  assert.equal(next("every week on Monday", "2026-10-06"), "2026-10-12")
  assert.equal(next("every week on Tuesday, Friday", "2026-10-06"), "2026-10-09")
  assert.equal(next("every Monday and Thursday", "2026-10-09"), "2026-10-12")
  assert.equal(next("every weekday", "2026-10-09"), "2026-10-12") // Friday -> Monday
  assert.equal(next("every weekday", "2026-10-06"), "2026-10-07")
  assert.equal(next("every 2 weeks on Monday", "2026-10-06"), "2026-10-19")
  assert.equal(next("every month", "2026-01-31"), "2026-02-28")
  assert.equal(next("every month on the 1st", "2026-10-06"), "2026-11-01")
  assert.equal(next("every month on the 15th", "2026-10-06"), "2026-10-15")
  assert.equal(next("every month on the last", "2026-10-31"), "2026-11-30")
  assert.equal(next("every month on the last Friday", "2026-10-06"), "2026-10-30")
  assert.equal(next("every month on the 2nd Wednesday", "2026-10-15"), "2026-11-11")
  assert.equal(next("every 3 months on the 1st", "2026-10-01"), "2027-01-01")
  assert.equal(next("every year", "2028-02-29"), "2029-02-28")
  assert.equal(next("every January on the 15th", "2026-10-06"), "2027-01-15")
  assert.equal(next("every year on March 3rd", "2026-01-01"), "2026-03-03")
  assert.equal(next("every week when done", "2026-10-06"), "2026-10-13")
  assert.equal(parseRule("whenever I feel like it"), null)
  assert.equal(parseRule("every blue moon"), null)
})

// ---------- dates in queries

test("date phrases", () => {
  assert.equal(dayIn("tomorrow", TODAY), "2026-10-07")
  assert.equal(dayIn("in 2 weeks", TODAY), "2026-10-20")
  assert.equal(dayIn("3 days ago", TODAY), "2026-10-03")
  assert.equal(dayIn("next monday", TODAY), "2026-10-12")
  assert.equal(dayIn("last friday", TODAY), "2026-10-02")
  assert.equal(dayIn("friday", TODAY), "2026-10-09")
  assert.deepEqual(spanOf("this week", TODAY), { from: "2026-10-05", to: "2026-10-11" })
  assert.deepEqual(spanOf("next month", TODAY), { from: "2026-11-01", to: "2026-11-30" })
  assert.deepEqual(spanOf("last year", TODAY), { from: "2025-01-01", to: "2025-12-31" })
  assert.deepEqual(spanOf("2026-W41", TODAY), { from: "2026-10-05", to: "2026-10-11" })
  assert.deepEqual(spanOf("2026-10-01 2026-10-15", TODAY), { from: "2026-10-01", to: "2026-10-15" })
  assert.deepEqual(spanOf("2026-Q4", TODAY), { from: "2026-10-01", to: "2026-12-31" })
  assert.equal(spanOf("someday", TODAY), null)
})

// ---------- queries

const VAULT: Record<string, string> = {
  "Projects/Lighthouse.md": `---
type: project
---
# Lighthouse

## This week
- [ ] Order new lamp ⏫ 📅 2026-10-05 #shopping
- [ ] Paint the railing 🛫 2026-10-10 📅 2026-10-20
- [/] Write the keeper's log 📅 2026-10-06
- [x] Check the beam 📅 2026-10-01 ✅ 2026-10-02

## Later
- [ ] Repair the stairs 🔽 🆔 stairs
- [ ] Repaint after the stairs ⛔ stairs
- [-] Install a fog horn ❌ 2026-09-20

\`\`\`
- [ ] Not a task: in a code fence
\`\`\`
`,
  "Daily/2026-10-06.md": `- [ ] Call Alice Park ⏳ 2026-10-06 🔁 every week
- [ ] Buy groceries #shopping/food 📅 2026-10-06
- Plain bullet
- [ ] Read a chapter  [due:: 2026-10-07]  [priority:: medium]
`,
  "Notes/Ideas.md": `- [ ] Learn the cello 🔺
  - [ ] Find a teacher 📅 2026-11-01
`,
}
const ALL = Object.entries(VAULT).flatMap(([p, t]) => tasksIn(t, p))
const run = (q: string, file = "Notes/Query.md") => runQuery(parseQuery(q, TODAY, file), ALL, TODAY)
const ordered = (q: string) => { const r = run(q); assert.deepEqual(r.problems, []); return r.groups.flatMap((g) => g.tasks.map((t) => fullDescription(t))) }
/** What a filter matches, in any order. */
const names = (q: string) => ordered(q).sort()

test("scanning: frontmatter, headings, fences, lines", () => {
  assert.equal(ALL.length, 12)
  const lamp = ALL.find((t) => t.description.startsWith("Order"))!
  assert.equal(lamp.heading, "This week")
  assert.equal(lamp.line, 6)
  assert.ok(!ALL.some((t) => t.description.startsWith("Not a task")))
})
test("global filter", () => {
  assert.equal(tasksIn("- [ ] a #task\n- [ ] b", "x.md", "#task").length, 1)
})
test("done, not done, due filters", () => {
  assert.equal(names("not done").length, 10)
  assert.deepEqual(names("done"), ["Check the beam", "Install a fog horn"])
  assert.deepEqual(names("due before today"), ["Check the beam", "Order new lamp #shopping"])
  assert.deepEqual(names("not done\ndue today"), ["Buy groceries #shopping/food", "Write the keeper's log"])
  assert.deepEqual(names("due on 2026-10-07"), ["Read a chapter"])
  assert.deepEqual(names("not done\ndue after this week"), ["Find a teacher", "Paint the railing"])
  assert.deepEqual(names("due in 2026-10-01 2026-10-05"), ["Check the beam", "Order new lamp #shopping"])
})
test("starts: no start date matches; happens: any of three", () => {
  assert.ok(!names("not done\nstarts before 2026-10-08").includes("Paint the railing"))
  assert.ok(names("not done\nstarts before 2026-10-08").includes("Learn the cello"))
  assert.deepEqual(names("not done\nhappens today"), ["Buy groceries #shopping/food", "Call Alice Park", "Write the keeper's log"])
})
test("has and no dates, recurring", () => {
  assert.deepEqual(names("not done\nno due date\nis not recurring"), ["Learn the cello", "Repaint after the stairs", "Repair the stairs"])
  assert.deepEqual(names("has scheduled date"), ["Call Alice Park"])
  assert.deepEqual(names("is recurring"), ["Call Alice Park"])
})
test("text filters", () => {
  assert.deepEqual(names("path includes daily\ndescription includes ALICE"), ["Call Alice Park"])
  assert.deepEqual(names("tags include #shopping"), ["Buy groceries #shopping/food", "Order new lamp #shopping"])
  assert.deepEqual(names("tag includes food"), ["Buy groceries #shopping/food"])
  assert.equal(names("path does not include Projects\nnot done").length, 5)
  assert.deepEqual(names("description regex matches /^re(pair|paint)/i"), ["Repaint after the stairs", "Repair the stairs"])
  assert.deepEqual(names("heading includes later\nnot done"), ["Repaint after the stairs", "Repair the stairs"])
  assert.deepEqual(names("filename includes {{query.file.filename}}"), names("path includes Notes/Query"))
  assert.deepEqual(names("folder includes {{query.file.folder}}"), ["Find a teacher", "Learn the cello"])
})
test("priority, status, dependencies", () => {
  assert.deepEqual(names("priority is high"), ["Order new lamp #shopping"])
  assert.deepEqual(names("priority is above medium"), ["Learn the cello", "Order new lamp #shopping"])
  assert.deepEqual(names("priority is medium"), ["Read a chapter"])
  assert.deepEqual(names("status.type is IN_PROGRESS"), ["Write the keeper's log"])
  assert.deepEqual(names("is blocked"), ["Repaint after the stairs"])
  assert.deepEqual(names("is blocking"), ["Repair the stairs"])
  assert.deepEqual(names("exclude sub-items\npath includes Ideas"), ["Learn the cello"])
})
test("boolean combinations", () => {
  assert.deepEqual(names("(due today) OR (priority is highest)"), ["Buy groceries #shopping/food", "Learn the cello", "Write the keeper's log"])
  assert.deepEqual(names("not done\n(tags include #shopping) AND NOT (due before today)"), ["Buy groceries #shopping/food"])
  assert.deepEqual(names("NOT (done)\n[path includes Notes] XOR {has due date}").length, 6)
  assert.deepEqual(names("((due today) OR (due tomorrow)) AND (path includes Daily)"), ["Buy groceries #shopping/food", "Read a chapter"])
  assert.deepEqual(names('"description includes (draft)" OR (is recurring)'), ["Call Alice Park"])
  assert.ok(run("(due today) AND").problems.length)
  assert.ok(run("(due today) OR (dew today)").problems.length)
})
test("sort, group, limit", () => {
  assert.deepEqual(ordered("not done\nhas due date\nsort by due reverse\nlimit 2"), ["Find a teacher", "Paint the railing"])
  assert.deepEqual(ordered("not done\nsort by description\nlimit to 3 tasks"), ["Buy groceries #shopping/food", "Call Alice Park", "Find a teacher"])
  const g = run("not done\ngroup by filename\ngroup by heading")
  assert.deepEqual(g.groups.map((x) => x.names.join(" / ")), ["2026-10-06 / (No heading)", "Ideas / (No heading)", "Lighthouse / Later", "Lighthouse / This week"])
  const d = run("not done\ngroup by due\nlimit groups 1")
  assert.deepEqual(d.groups.map((x) => x.names[0]), ["2026-10-05 Monday", "2026-10-06 Tuesday", "2026-10-07 Wednesday", "2026-10-20 Tuesday", "2026-11-01 Sunday", "No due date"])
  assert.ok(d.groups.every((x) => x.tasks.length === 1))
  const t = run("group by tags\ntags include #shopping")
  assert.deepEqual(t.groups.map((x) => x.names[0]), ["#shopping", "#shopping/food"])
  assert.deepEqual(run("group by priority\nnot done").groups[0].names, ["Highest priority"])
})
test("default sort: not done first, then urgency", () => {
  const r = ordered("path includes Lighthouse")
  assert.equal(r[0], "Order new lamp #shopping") // overdue and high: the most urgent
  assert.deepEqual(r.slice(-2), ["Check the beam", "Install a fog horn"])
})
test("layout and explain", () => {
  const r = run("not done\nshort mode\nhide backlinks\nhide due date\nshow urgency\nexplain")
  assert.equal(r.layout.short, true)
  assert.deepEqual(r.layout.hide.sort(), ["backlink", "due date"])
  assert.match(r.explain!, /not done/)
  assert.match(run("due this week\nexplain").explain!, /due date is between 2026-10-05 and 2026-10-11 inclusive/)
  assert.ok(run("hide the kitchen sink").problems.length)
})
test("global query, comments, continuation lines", () => {
  const r = runQuery(parseQuery("# my tasks\npath includes \\\nDaily", TODAY, "", "not done"), ALL, TODAY)
  assert.equal(r.total, 3)
  assert.equal(runQuery(parseQuery("ignore global query\npath includes Daily", TODAY, "", "done"), ALL, TODAY).total, 3)
})
test("urgency", () => {
  const lamp = ALL.find((t) => t.description.startsWith("Order"))!
  assert.equal(urgency(lamp, TODAY), 15.26) // a day overdue (9.26) and high (6)
})

console.log(`${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
