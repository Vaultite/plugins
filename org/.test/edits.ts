// What a click in the drawing writes: boxes (parents and cookies following), keywords (CLOSED, repeaters), on the parser.
//   node org/.test/edits.ts
import { check, done } from "../../testkit.ts"
import { cycleTodo, nextKeyword, repeated, toggleCheckbox, todoSequences } from "../edit/edits.ts"
import { isText, parse, walk, type OrgNode } from "../parser/index.ts"

const find = (text: string, type: string, has: string) => {
  const doc = parse(text)
  for (const c of walk(doc)) if (!isText(c) && c.type === type && text.slice(c.begin, text.indexOf("\n", c.begin)).includes(has)) return { doc, n: c as OrgNode }
  throw new Error(`no ${type} with ${has}`)
}
const tick = (text: string, has: string) => { const { doc, n } = find(text, "item", has); return toggleCheckbox(text, doc, n) }
const cycle = (text: string, has: string, to: string | null = null, now = new Date(2026, 10, 13, 9, 30)) => cycleTodo(text, find(text, "headline", has).n, to, now)

// ---------- checkboxes
const list = "* Launch [1/3]\nBefore [1/3] [33%]:\n- [X] One\n- [ ] Two [0/2]\n  - [ ] a\n  - [ ] b\n- [ ] Three\n"
check("a box ticks", tick(list, "Three").includes("- [X] Three"))
check("the headline's and the paragraph's cookies count the top items", tick(list, "Three").startsWith("* Launch [2/3]\nBefore [2/3] [66%]:"), tick(list, "Three"))
const a = tick(list, "  - [ ] a")
check("a sub-item ticked: its parent is half done, its cookie counts", a.includes("- [-] Two [1/2]\n  - [X] a"), a)
check("both sub-items: the parent is done, and the headline counts it", tick(a, "  - [ ] b").includes("- [X] Two [2/2]") && tick(a, "  - [ ] b").startsWith("* Launch [2/3]"), tick(a, "  - [ ] b"))
check("a parent ticked: its sub-items follow", tick(list, "Two").includes("- [X] Two [2/2]\n  - [X] a\n  - [X] b"), tick(list, "Two"))
check("unticking", tick(list, "One").includes("- [ ] One") && tick(list, "One").startsWith("* Launch [0/3]"))
check("a counter before the box", tick("1. [@3] [ ] x\n", "x") === "1. [@3] [X] x\n")

// ---------- keywords
const seq = "#+TODO: TODO NEXT | DONE CANCELLED\n#+TODO: BUG | FIXED\n"
check("sequences from #+TODO lines", JSON.stringify(todoSequences(seq)) === JSON.stringify([{ todo: ["TODO", "NEXT"], done: ["DONE", "CANCELLED"] }, { todo: ["BUG"], done: ["FIXED"] }]))
check("default sequence", JSON.stringify(todoSequences("* x\n")) === JSON.stringify([{ todo: ["TODO"], done: ["DONE"] }]))
check("next keyword within its own sequence, then none; wrapping back", nextKeyword(seq, "NEXT") === "DONE" && nextKeyword(seq, "FIXED") === "" &&
  nextKeyword(seq, "FIXED", true) === "BUG" && nextKeyword(seq, null) === "TODO")
check("none to the first keyword", cycle("* Task :x:\n", "Task") === "* TODO Task :x:\n")
check("to the next", cycle("* TODO [#A] Task\n", "Task") === "* DONE [#A] Task\n")
check("done to none", cycle("* DONE Task\n", "Task") === "* Task\n")
check("a chosen keyword", cycle(`${seq}** NEXT Task\n`, "Task", "CANCELLED").endsWith("** CANCELLED Task\n"))
const logdone = "#+STARTUP: logdone\n"
check("logdone: CLOSED on its own line", cycle(`${logdone}* TODO Task\nText\n`, "Task") === `${logdone}* DONE Task\nCLOSED: [2026-11-13 Fri 09:30]\nText\n`, cycle(`${logdone}* TODO Task\nText\n`, "Task"))
check("logdone: CLOSED first in the planning line", cycle(`${logdone}* TODO Task\n  DEADLINE: <2026-11-20 Fri>\n`, "Task") === `${logdone}* DONE Task\n  CLOSED: [2026-11-13 Fri 09:30] DEADLINE: <2026-11-20 Fri>\n`)
check("leaving done: CLOSED goes, its line too when alone", cycle("* DONE Task\nCLOSED: [2026-11-10 Tue 16:02]\nText\n", "Task", "TODO") === "* TODO Task\nText\n" &&
  cycle("* DONE Task\nCLOSED: [2026-11-10 Tue 16:02] SCHEDULED: <2026-11-09 Mon>\n", "Task", "TODO") === "* TODO Task\nSCHEDULED: <2026-11-09 Mon>\n")
check("a repeating task moves to its next date and stays to do",
  cycle("* TODO Water plants\nSCHEDULED: <2026-11-13 Fri +1w>\n", "Water") === "* TODO Water plants\nSCHEDULED: <2026-11-20 Fri +1w>\n",
  cycle("* TODO Water plants\nSCHEDULED: <2026-11-13 Fri +1w>\n", "Water"))
const now = new Date(2026, 10, 13, 9, 30)
check("repeaters: +, ++ past today, .+ from today", repeated("<2026-11-01 Sun +1w>", now) === "<2026-11-08 Sun +1w>" &&
  repeated("<2026-11-01 Sun ++1w>", now) === "<2026-11-15 Sun ++1w>" && repeated("<2026-11-01 Sun 10:00 .+2d>", now) === "<2026-11-15 Sun 10:00 .+2d>",
  [repeated("<2026-11-01 Sun +1w>", now), repeated("<2026-11-01 Sun ++1w>", now), repeated("<2026-11-01 Sun 10:00 .+2d>", now)])
check("months", repeated("<2026-01-31 Sat +1m>", now) === "<2026-03-03 Tue +1m>" || repeated("<2026-01-31 Sat +1m>", now) === "<2026-02-28 Sat +1m>", repeated("<2026-01-31 Sat +1m>", now))

done()
