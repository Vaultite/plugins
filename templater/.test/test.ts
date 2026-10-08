// Templater's parser, its safe part of JavaScript, the date formatter and the tp API, over made-up templates written the
// way Templater users write them; then the op and folder templates on a throwaway server.   node templater/.test/test.ts
import { check, done, serve } from "../../testkit.ts"
import { parts, render } from "../engine.ts"
import type { Host } from "../tp.ts"
const { formatDate, parseDate } = await import("@vaultite/core/plugins.ts") // (after testkit: it finds @vaultite/core)
const { run, shift } = await import("../tp.ts")

// ---------- dates (Tuesday 6 October 2026, 09:05:07)
const d = new Date(2026, 9, 6, 9, 5, 7)
check("YYYY-MM-DD", formatDate(d) === "2026-10-06")
check("dddd, MMMM Do YYYY", formatDate(d, "dddd, MMMM Do YYYY") === "Tuesday, October 6th YYYY".replace("YYYY", "2026"), formatDate(d, "dddd, MMMM Do YYYY"))
check("ddd D MMM, h:mm A", formatDate(d, "ddd D MMM, h:mm A") === "Tue 6 Oct, 9:05 AM", formatDate(d, "ddd D MMM, h:mm A"))
check("[Week] ww of gggg", formatDate(d, "[Week] ww of gggg") === "Week 41 of 2026", formatDate(d, "[Week] ww of gggg"))
check("ISO week at the year's edge", formatDate(new Date(2027, 0, 1), "GGGG-[W]WW") === "2026-W53", formatDate(new Date(2027, 0, 1), "GGGG-[W]WW"))
check("HH:mm:ss, Q, DDDD", formatDate(d, "HH:mm:ss Q DDDD") === "09:05:07 4 279", formatDate(d, "HH:mm:ss Q DDDD"))
check("ordinals 11th 22nd 23rd", [11, 22, 23].map((n) => formatDate(new Date(2026, 0, n), "Do")).join() === "11th,22nd,23rd")
check("localized LL", formatDate(d, "LL") === "October 6, 2026")
check("parse YYYY-MM-DD", formatDate(parseDate("2026-02-28", "YYYY-MM-DD")) === "2026-02-28")
check("parse a title with words", formatDate(parseDate("Meeting 2026-03-01", "[Meeting] YYYY-MM-DD")) === "2026-03-01")
check("parse an ISO week (its Monday)", formatDate(parseDate("2026-W41", "GGGG-[W]WW")) === "2026-10-05")
check("parse D MMMM YYYY", formatDate(parseDate("6 October 2026", "D MMMM YYYY")) === "2026-10-06")
check("offset in days", formatDate(shift(d, -7)) === "2026-09-29")
check("offset P1M at a month's end", formatDate(shift(new Date(2026, 0, 31), "P1M")) === "2026-02-28")
check("offset P-1Y and -P1W", formatDate(shift(d, "P-1Y")) === "2025-10-06" && formatDate(shift(d, "-P1W")) === "2026-09-29")

// ---------- whitespace control
const texts = (src: string) => parts(src).map((p) => ("text" in p ? p.text : `{${p.run ? "*" : ""}${p.code.trim()}}`)).join("")
check("-%> eats one newline after", texts("a\n<%* x -%>\nb\n") === "a\n{*x}b\n", texts("a\n<%* x -%>\nb\n"))
check("<%- eats one newline before", texts("a\n<%- x %>b") === "a{x}b")
check("_%> eats all whitespace after", texts("<% x _%>\n\n  b") === "{x}b")
check("<%_ eats all whitespace before", texts("a \n\n<%_ x %>") === "a{x}")
check("%> inside a string isn't the end", texts(`<% "50%> sure" %>!`) === `{"50%> sure"}!`)

// ---------- a host of made-up notes
const FILES: Record<string, string> = {
  "Templates/Signature.md": "— Alice\n<% tp.file.title %>",
  "Templates/Parts.md": "# Intro\nHello\n\n# Agenda\n- Lighthouse review\n- Budget\n\n# End\nBye",
  "Notes/Lighthouse.md": "---\nstatus: active\nowner: Alice Park\ntags: [project]\n---\nThe Lighthouse project.",
}
function host(over: Partial<Host> = {}, answers: (string | null)[] = []): Host & { asked: string[] } {
  const asked: string[] = []
  return {
    template: "Templates/T.md", target: "Notes/Untitled.md", mode: "new", now: d, asked,
    abs: (p) => `/vault/${p}`,
    read: async (p) => FILES[p] ?? null,
    resolve: (l) => Object.keys(FILES).find((p) => p === `${l}.md` || p.endsWith(`/${l}.md`)) ?? null,
    file: (p) => (FILES[p] ? { fm: p === "Notes/Lighthouse.md" ? { status: "active", owner: "Alice Park", tags: ["project"] } : {}, tags: p === "Notes/Lighthouse.md" ? ["project"] : [], created: +new Date(2026, 8, 1, 8), modified: +new Date(2026, 9, 5, 18, 30) } : null),
    prompt: async (q) => { asked.push(q); return answers.shift() ?? null },
    suggest: async (labels, ph) => { asked.push(ph); const a = answers.shift(); return a == null ? null : labels.indexOf(a) },
    ...over,
  }
}
const out = async (src: string, h = host()) => (await run(src, h))?.text

// A daily note: dates around the note's title, a weekday, a quote of the day that needs the web (left as it is).
const daily = `---
created: <% tp.file.creation_date() %>
---
# <% tp.date.now("dddd, MMMM Do YYYY", 0, tp.file.title, "YYYY-MM-DD") %>

<< [[<% tp.date.now("YYYY-MM-DD", -1, tp.file.title, "YYYY-MM-DD") %>]] | [[<% tp.date.now("YYYY-MM-DD", 1, tp.file.title, "YYYY-MM-DD") %>]] >>
Week of <% tp.date.weekday("MMM D", 0, tp.file.title, "YYYY-MM-DD") %>

<% tp.web.daily_quote() %>
`
const dr = await run(daily, host({ target: "Daily/2026-02-28.md" }))
check("daily: title as a date", dr?.text.includes("# Saturday, February 28th 2026"), dr?.text)
check("daily: yesterday and tomorrow from the title", dr?.text.includes("<< [[2026-02-27]] | [[2026-03-01]] >>"), dr?.text)
check("daily: the week's Monday", dr?.text.includes("Week of Feb 23"), dr?.text)
check("daily: a new file's creation date is now", dr?.text.includes("created: 2026-10-06 09:05"), dr?.text)
check("daily: tp.web stays as written, said why", dr?.text.includes("<% tp.web.daily_quote() %>") && dr?.skipped.length === 1 && /daily_quote/.test(dr.skipped[0].why), dr?.skipped)

// A meeting: a prompt, a suggester, if/else, tR +=, rename and move, the cursor.
const meeting = `<%*
const topic = await tp.system.prompt("Topic")
const kind = await tp.system.suggester(["One to one", "Team sync"], ["1-1", "sync"], false, "Kind of meeting")
if (kind === "1-1") {
  tR += "Private\\n"
} else if (kind === "sync") { tR += \`Team: \${topic.toUpperCase()}\\n\` } else tR += "Unknown\\n"
await tp.file.rename(tp.date.now("YYYY-MM-DD") + " " + topic)
await tp.file.move("/Meetings/" + tp.file.title)
-%>
# <% tp.file.title %>
Kind: <% kind %>, <% topic.length > 6 ? "long" : "short" %> topic
<% tp.file.cursor() %>
`
const mh = host({}, ["Budget", "Team sync"])
const mr = await run(meeting, mh)
check("meeting: asked the prompt, then the suggester", mh.asked.join("|") === "Topic|Kind of meeting", mh.asked)
check("meeting: if/else and tR +=", mr?.text.startsWith("Team: BUDGET\n# 2026-10-06 Budget\n"), mr?.text)
check("meeting: renamed and moved", mr?.path === "Meetings/2026-10-06 Budget.md", mr?.path)
check("meeting: the suggester's item, a ternary", mr?.text.includes("Kind: sync, short topic"), mr?.text)
check("meeting: the cursor mark stays for the app", mr?.text.includes("<% tp.file.cursor() %>"), mr?.text)
check("meeting: cancelled with throw_on_cancel is null",
  (await run(`<%* const t = await tp.system.prompt("Topic", "", true) %>x`, host({}, [null]))) === null)
check("a dismissed prompt without throw_on_cancel is null", (await out(`[<% tp.system.prompt("Topic") ?? "none" %>]`)) === "[none]")

// A book: frontmatter of the note it's inserted into, tags, include of a template and of a section.
const book = `<%* let owner = tp.frontmatter.owner; let st = tp.frontmatter["status"] -%>
Owner: <% owner %> (<% st %>), tags <% tp.file.tags.join(", ") %>, in <% tp.file.folder() %> (<% tp.file.folder(true) %>)
Modified <% tp.file.last_modified_date("D MMM") %>, made <% tp.file.creation_date("YYYY") %>
<% tp.file.include("[[Signature]]") %>
<% tp.file.include("[[Parts#Agenda]]") %>
Run as <% tp.config.run_mode %> from <% tp.config.template_file.basename %> into <% tp.config.target_file.name %>`
const br = await out(book, host({ target: "Notes/Lighthouse.md", mode: "insert", template: "Templates/Book.md" }))
check("book: frontmatter and tags of the note", br?.startsWith("Owner: Alice Park (active), tags #project, in Notes (Notes)\n"), br)
check("book: file dates", br?.includes("Modified 5 Oct, made 2026"), br)
check("book: include runs the included template", br?.includes("— Alice\nLighthouse"), br)
check("book: include of a section", br?.includes("- Lighthouse review\n- Budget\nRun as"), br)
check("book: tp.config", br?.endsWith("Run as 1 from Book into Lighthouse.md"), br)
check("a new note's frontmatter is empty", (await out("[<% tp.frontmatter.owner %>]")) === "[]")

// What isn't run: JavaScript beyond the subset stays as written, and nothing after it is lost.
const js = async (src: string) => (await render(src, { tp: {} })).skipped.length
check("a loop isn't run", await js("<%* for (let i = 0; i < 3; i++) { tR += i } %>") === 1)
check("a function isn't run", await js("<%* const f = (x) => x %>") === 1)
check("app and moment aren't run", await js("<% app.vault.getName() %><% moment().format() %>") === 2)
check("no way to the constructor", await js(`<% "".constructor %><% tp.constructor %><% [].concat.constructor %>`) === 3)
check("a block that fails keeps the output before it", (await render("a<%* tR += 'b'; window.x %>c", {})).text === "a<%* tR += 'b'; window.x %>c")
check("a later statement of a failed command doesn't run", (await render("a<%* tR += 'b'; window.x; tR += 'c' %>d", {})).text === "a<%* tR += 'b'; window.x; tR += 'c' %>d")
const spans = `<%* if (tp.file.title.includes("Untitled")) { -%>
Name me
<%* } else if (tp.file.title === "Lighthouse") { -%>
The lighthouse
<%* } else { -%>
Other
<%* } -%>
end`
check("if/else across commands", (await out(spans)) === "Name me\nend" && (await out(spans, host({ target: "Notes/Lighthouse.md" }))) === "The lighthouse\nend"
  && (await out(spans, host({ target: "Notes/Alice.md" }))) === "Other\nend", await out(spans))
const mixed = await render(`<%* let n = 2 %><%* for (const x of []) {} %><%* if (n > 1) { %>many<%* } %>`, {})
check("a command that can't be read stays, the others run around it", mixed.text === "<%* for (const x of []) {} %>many" && mixed.skipped.length === 1, mixed)
check("string methods and lists", (await out(`<% "Alice Park".split(" ").slice(0, 1).join("") + "/" + "a-b".replace("-", "+") %>`)) === "Alice/a+b")
check("operators", (await out("<% 1 + 2 * 3 %> <% !true || null ?? 'x' %> <% typeof 'a' %> <% 7 % 4 === 3 %>")) === "7 x string true")
check("template literal", (await out("<%* let n = 'Alice' %><% `Hi ${n}, ${1 + 1}` %>")) === "Hi Alice, 2")

// ---------- on a server: the agents' op, the Templates plugin's hook, a folder template, Obsidian's settings
const srv = await serve(["templater"])
try {
  srv.write("Templates/Meeting.md", `---\ntype: note\nid: template-meeting\ntags: [meeting]\n---\n${meeting}`)
  srv.write("Templates/Book.md", "---\ntype: note\n---\n# <% tp.file.title %>\nAdded {{date:YYYY}} in <% tp.file.folder() %>\n")
  srv.write("Templates/Sig.md", "<%* tR += 'Alice' %>")
  await new Promise((r) => setTimeout(r, 500))
  const made = JSON.parse(srv.vau("templater", "new", "Meeting", "--folder", "Notes", "--answers", '{"Topic": "Roadmap", "Kind of meeting": "One to one"}', "--json"))
  const note = srv.read(made.path)
  check("op: renamed and moved by the template", made.path === `Meetings/${formatDate(new Date())} Roadmap.md`, made)
  check("op: answers by question and label, cursor mark gone", note.includes("Private\n# ") && note.includes("Kind: 1-1") && !note.includes("tp.file.cursor"), note)
  check("op: the template's frontmatter, not its id", /tags: \[meeting\]/.test(note) && !note.includes("template-meeting"), note)
  const plain = JSON.parse(srv.vau("templater", "new", "Book", "--title", "Dune", "--json"))
  check("op: {{date}} filled as the Templates plugin does", srv.read(plain.path).includes(`Added ${new Date().getFullYear()} in `), srv.read(plain.path))
  check("op: unanswered prompts listed", JSON.parse(srv.vau("templater", "new", "Meeting", "--title", "x", "--json")).unanswered.join() === "Topic,Kind of meeting")
  let [st, r] = await srv.api("POST", "templates/expand", { text: "<% tp.file.title %> <%* tR += 1 + 1 %><% tp.web.daily_quote() %>", template: "Templates/T.md", path: "Notes/Idea.md", mode: "new" })
  check("hook: expands, says what wasn't run", st === 200 && r.text === "Idea 2<% tp.web.daily_quote() %>" && /left a command/.test(r.notice), r)
  ;[st, r] = await srv.api("POST", "templates/expand", { text: "<%* await tp.file.move('Projects/' + tp.file.title) %>x", template: "Templates/T.md", path: "Notes/Idea.md", mode: "new" })
  check("hook: the new path", r.path === "Projects/Idea.md" && r.text === "x", r)
  srv.vau("settings", "set", "plugin/templater", '{"folderTemplates": {"Books": "Book"}}')
  ;[st, r] = await srv.api("POST", "file", { path: "Books/Untitled.md", text: "", unique: true })
  await new Promise((res) => setTimeout(res, 1500))
  check("folder template fills a new empty note", /# Untitled\nAdded \d{4} in Books/.test(srv.read(r.path)), srv.read(r.path))
  srv.write(".obsidian/plugins/templater-obsidian/data.json", JSON.stringify({ trigger_on_file_creation: true, folder_templates: [{ folder: "Reading", template: "Templates/Book.md" }] }))
  srv.vau("settings", "set", "plugin/templater", '{"folderTemplates": null}')
  ;[st, r] = await srv.api("POST", "file", { path: "Reading/Untitled.md", text: "", unique: true })
  await new Promise((res) => setTimeout(res, 1500))
  check("Obsidian's Templater's folder templates", srv.read(r.path).includes("Added"), srv.read(r.path))
  ;[st, r] = await srv.api("POST", "file", { path: "Reading/Signed.md", text: "By <% tp.file.include('[[Sig]]') %>", unique: true })
  await new Promise((res) => setTimeout(res, 1500))
  check("trigger on creation runs a new note's commands", srv.read(r.path).endsWith("By Alice"), srv.read(r.path))
} finally { srv.stop() }

done()
