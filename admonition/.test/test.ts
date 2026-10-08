// Admonitions: fences as callouts, then as agents read them on a throwaway server.   node admonition/.test/test.ts
import { check, done, serve } from "../../testkit.ts"
import { toCallout } from "../ad.ts"

const tip = toCallout("tip", "title: Pack light\ncollapse: open\nicon: luggage\n\nBring **one** bag.\n\n- shoes\n")
check("title, collapse and icon lines; the content quoted", tip.md === "> [!tip]+ Pack light\n> Bring **one** bag.\n>\n> - shoes" && tip.icon === "luggage", tip)
check("no lines: the type's own title", toCallout("note", "Just this.").md === "> [!note]\n> Just this.")
check("closed, an empty title, Obsidian's lucide- names", JSON.stringify(toCallout("quote", "collapse: closed\ntitle:\nicon: lucide-alarm-clock\nA closed one.\n"))
  === JSON.stringify({ md: "> [!quote]-\n> A closed one.", icon: "alarm-clock" }))
check("collapse: none is open for good; color: left out", toCallout("bug", "collapse: none\ncolor: 200, 10, 10\nOops").md === "> [!bug]\n> Oops")
check("only the first lines are options", toCallout("info", "Text\ntitle: not one").md === "> [!info]\n> Text\n> title: not one")
check("empty", toCallout("todo", "").md === "> [!todo]")

const s = await serve(["admonition"])
try {
  s.write("Notes/Ad.md", "# Ad\n\n```ad-warning\ntitle: Ferry\nIt leaves at 7.\n```\n\n```python\nprint(1)\n```\n")
  const [, r] = await s.api("POST", "ops/file.render", { path: "Notes/Ad.md" })
  const text = JSON.stringify(r)
  check("agents read it as a callout", text.includes("> [!warning] Ferry\\n> It leaves at 7.") && !text.includes("ad-warning"), r)
  check("other fences stay code", text.includes("```python"), r)
} finally { s.stop() }
done()
