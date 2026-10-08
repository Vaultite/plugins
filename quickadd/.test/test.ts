// Quick add: where a capture goes, QuickAdd's choices read, formats filled; then quickadd.run on a throwaway server,
// with Templater on so a template's <% %> runs too.   node quickadd/.test/test.ts
import { check, done, serve } from "../../testkit.ts"
import { asks, fillIn, fromQuickAdd, insert } from "../choices.ts"

// ---------- where a capture goes
const doc = "---\ntype: note\n---\n# Plan\n\n## Ideas\n- one\n\n### Small\n- tiny\n\n## Done\n- old\n\n"
check("at the end (its blank lines kept after)", insert(doc, "- new").endsWith("## Done\n- old\n- new\n\n"), insert(doc, "- new"))
check("at the top, after the frontmatter", insert(doc, "- new", "", true).startsWith("---\ntype: note\n---\n- new\n# Plan"))
check("at the end of a heading's section, its subsections too", insert(doc, "- new", "Ideas").includes("### Small\n- tiny\n- new\n\n## Done"), insert(doc, "- new", "Ideas"))
check("right under a heading", insert(doc, "- new", "## Ideas", true).includes("## Ideas\n- new\n- one"))
check("a heading that isn't there, made at the end", insert(doc, "- new", "Later").endsWith("- old\n\n## Later\n- new\n"), insert(doc, "- new", "Later"))
check("into an empty note", insert("", "- new") === "- new\n" && insert("", "- new", "Ideas") === "## Ideas\n- new\n")

// ---------- formats
check("what a format asks", JSON.stringify(asks("{{VALUE}} {{NAME}} {{VALUE:Topic}} {{value:a, b}} {{DATE}}")) === JSON.stringify(["", "Topic", "a, b"]))
check("filled in", fillIn("- {{VALUE}} on {{VALUE:Topic}} from {{LINKCURRENT}} ({{FILENAMECURRENT}}) {{DATE}}", { "": "Call", Topic: "Budget" }, "Notes/Lisbon trip.md")
  === "- Call on Budget from [[Lisbon trip]] (Lisbon trip) {{DATE}}")

// ---------- QuickAdd's data.json
const qa = fromQuickAdd([
  { id: "1", name: "Idea", type: "Capture", command: true, captureTo: "Inbox.md", format: { enabled: true, format: "- {{VALUE}}" }, task: true,
    insertAfter: { enabled: true, after: "## Ideas", insertAtEnd: true } },
  { id: "2", name: "Group", type: "Multi", choices: [
    { id: "3", name: "Meeting", type: "Template", templatePath: "Templates/Meeting.md", fileNameFormat: { enabled: true, format: "{{DATE}} {{VALUE}}" }, folder: { enabled: true, folders: ["Meetings"] } },
    { id: "4", name: "Here", type: "Capture", captureToActiveFile: true, prepend: true, format: { enabled: false } }] },
  { id: "5", name: "Macro", type: "Macro" },
])
check("QuickAdd's choices, a group's after it, macros left out", JSON.stringify(qa.map((c) => [c.name, c.type])) === JSON.stringify([["Idea", "capture"], ["Group", "multi"], ["Meeting", "template"], ["Here", "capture"]]), qa)
check("a capture: its file, a task, under its heading at the end", qa[0].file === "Inbox.md" && qa[0].format === "- [ ] - {{VALUE}}" && qa[0].heading === "## Ideas" && qa[0].prepend === false && qa[0].command === true, qa[0])
check("a group names its choices", JSON.stringify(qa[1].choices) === '["Meeting","Here"]')
check("a template: its folder and name format, opened", qa[2].template === "Templates/Meeting.md" && qa[2].folder === "Meetings" && qa[2].nameFormat === "{{DATE}} {{VALUE}}" && qa[2].open === true, qa[2])
check("to the open note, at the top, as typed", qa[3].file === "" && qa[3].prepend === true && qa[3].format === "{{VALUE}}", qa[3])

// ---------- on a server
const s = await serve(["quickadd", "templater"])
try {
  const run = (params: object) => s.api("POST", "ops/quickadd.run", params)
  const today = new Date().toLocaleDateString("sv")
  s.write("Templates/Meeting.md", "---\ntype: note\n---\n# {{title}}\n\nTopic: {{VALUE:Topic}} (from {{LINKCURRENT}}), year <% tp.date.now(\"YYYY\") %>\n")
  s.write(".obsidian/plugins/quickadd/data.json", JSON.stringify({ choices: [{ id: "q", name: "From QuickAdd", type: "Capture", captureTo: "Inbox.md", format: { enabled: true, format: "- {{VALUE}}" } }] }))
  let [st, r] = await run({ choice: "From QuickAdd", value: "read from Obsidian" })
  check("QuickAdd's choices run while it has none of its own", st === 200 && s.read("Inbox.md").includes("- read from Obsidian"), r)
  await s.api("PATCH", "config/plugin/quickadd", { choices: [
    { id: "idea", name: "Log idea", type: "capture", file: "Journal/{{DATE}}", format: "- {{TIME}} {{VALUE}} (from {{LINKCURRENT}})", heading: "Ideas" },
    { id: "here", name: "Here", type: "capture", prepend: true },
    { id: "meet", name: "Meeting", type: "template", template: "Meeting", nameFormat: "{{DATE}} {{VALUE:Topic}}", folder: "Meetings" },
    { id: "g", name: "Add", type: "multi", choices: ["Log idea", "Meeting"] },
  ] })
  ;[st, r] = await run({ choice: "From QuickAdd", value: "x" })
  check("its own choices then, QuickAdd's not", st >= 400, r)
  ;[st, r] = await run({ choice: "log idea", value: "Ask Alice Park", file: "Notes/Lisbon trip.md" })
  const journal = `Journal/${today}.md`
  check("a capture into a note named by the date, under its heading (made)", st === 200 && r.path === journal && /## Ideas\n- \d\d:\d\d Ask Alice Park \(from \[\[Lisbon trip\]\]\)\n$/.test(s.read(journal)), [r, s.read(journal)])
  ;[st, r] = await run({ choice: "idea", value: "Second" })
  check("again: after the first, by id", /Alice Park.*\n- \d\d:\d\d Second \(from \)\n$/.test(s.read(journal)), s.read(journal))
  s.write("Notes/Open.md", "---\ntype: note\n---\nBody\n")
  ;[st, r] = await run({ choice: "Here", value: "On top", file: "Notes/Open.md" })
  check("into the open note, at its top", s.read("Notes/Open.md").includes("---\nOn top\nBody\n"), s.read("Notes/Open.md"))
  ;[st, r] = await run({ choice: "Here", value: "x" })
  check("no open note: says to give one", st >= 400 && /open note/.test(JSON.stringify(r)), r)
  ;[st, r] = await run({ choice: "Meeting", values: { Topic: "Budget" }, file: "Notes/Open.md" })
  const made = `Meetings/${today} Budget.md`
  check("a template: named, in its folder, filled (Templates' {{title}}, ours, Templater's <% %>)", st === 200 && r.path === made && r.open === true
    && s.read(made).includes(`# ${today} Budget\n\nTopic: Budget (from [[Open]]), year ${today.slice(0, 4)}`), [r, st === 200 && s.read(made)])
  ;[st, r] = await run({ choice: "Meeting", values: { Topic: "Budget" } })
  check("the same name again: numbered", r.path === `Meetings/${today} Budget 1.md`, r)
  ;[st, r] = await run({ choice: "Meeting" })
  check("a named value missing: says which", st >= 400 && JSON.stringify(r).includes("Topic"), r)
  ;[st, r] = await run({ choice: "Add" })
  check("a group: says which to run", st >= 400 && JSON.stringify(r).includes("Log idea, Meeting"), r)
  check("vau quickadd list", /Log idea \(capture, to Journal\/\{\{DATE\}\}\): asks a value/.test(s.vau("quickadd", "list")), s.vau("quickadd", "list"))
  check("its choices in the store", (await s.api("GET", "state"))[1].quickadd?.choices?.length === 4)
} finally { s.stop() }
done()
