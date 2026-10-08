// Notebook navigator: what it lists (folders and tags with counts, a place's notes, sorting, date groups), then its
// previews route on a throwaway server (first lines without code, blocks or the heading; the first image as a path).
//   node test.ts notebook-navigator
import { check, done, serve } from "../../testkit.ts"

const m = await import("../model.ts")
const DAY = 864e5, now = new Date(2026, 9, 6, 15, 0)
const at = (days: number) => now.getTime() - days * DAY
const notes = [
  { path: "Inbox.md", title: "Inbox", mtime: at(0.1), ctime: at(40) },
  { path: "Notes/Idea.md", title: "Idea", mtime: at(1), ctime: at(2), tags: ["work"] },
  { path: "Notes/Trips/Lisbon.md", title: "Lisbon", mtime: at(5), ctime: at(90), tags: ["Travel/europe"] },
  { path: "Notes/Trips/Kyoto.md", title: "Kyoto", mtime: at(20), ctime: at(1), tags: ["travel"] },
  { path: "Projects/Lighthouse.md", title: "Lighthouse", mtime: at(70), ctime: at(400), tags: ["work/lighthouse"] },
]
const flat = (ns: { key: string; count: number; kids: unknown[] }[]): string[] =>
  ns.flatMap((n) => [`${n.key} ${n.count}`, ...flat(n.kids as typeof ns)])

check("folders: a tree, counting the notes under each (deep)", JSON.stringify(flat(m.folderTree(["Notes", "Notes/Trips", "Projects", "Empty"], notes, true))) ===
  JSON.stringify(["Empty 0", "Notes 3", "Notes/Trips 2", "Projects 1"]), flat(m.folderTree(["Notes", "Notes/Trips", "Projects", "Empty"], notes, true)))
check("folders: or only the notes in each", JSON.stringify(flat(m.folderTree(["Notes", "Notes/Trips"], notes, false))) === JSON.stringify(["Notes 1", "Notes/Trips 2", "Projects 1"]),
  flat(m.folderTree(["Notes", "Notes/Trips"], notes, false)))
check("tags: nested, any case one tag (its first spelling), a note counted once", JSON.stringify(flat(m.tagTree(notes))) ===
  JSON.stringify(["Travel 2", "Travel/europe 1", "work 2", "work/lighthouse 1"]), flat(m.tagTree(notes)))
const names = (ns: { path: string }[]) => ns.map((n) => m.nameOf(n.path))
check("a folder lists its notes and its subfolders'", JSON.stringify(names(m.notesIn(notes, "folder:Notes", true, []))) === JSON.stringify(["Idea", "Lisbon", "Kyoto"]))
check("or only its own", JSON.stringify(names(m.notesIn(notes, "folder:Notes", false, []))) === JSON.stringify(["Idea"]))
check("every note at the top (the vault)", m.notesIn(notes, "folder:", false, []).length === 5)
check("a tag lists the notes with it or a tag under it, any case", JSON.stringify(names(m.notesIn(notes, "tag:travel", true, []))) === JSON.stringify(["Lisbon", "Kyoto"]))
check("recent: in the order opened, gone ones left out", JSON.stringify(names(m.notesIn(notes, "recent", true, ["Notes/Idea.md", "Gone.md", "Inbox.md"]))) === JSON.stringify(["Idea", "Inbox"]))
check("sorted by modified, created, title", JSON.stringify([names(m.sortNotes(notes, "modified")), names(m.sortNotes(notes, "created")), names(m.sortNotes(notes, "title"))]) ===
  JSON.stringify([["Inbox", "Idea", "Lisbon", "Kyoto", "Lighthouse"], ["Kyoto", "Idea", "Inbox", "Lisbon", "Lighthouse"], ["Idea", "Inbox", "Kyoto", "Lighthouse", "Lisbon"]]))
const month = (d: Date, year: boolean) => `${d.getMonth() + 1}${year ? `/${d.getFullYear()}` : ""}`
const groups = (sort: "modified" | "title" | null, pinned: string[] = []) =>
  m.groupNotes(m.sortNotes(notes, sort ?? "modified"), sort, new Set(pinned), now, month).map((g) => `${g.label}: ${names(g.notes).join(", ")}`)
check("grouped by date: Today, Yesterday, the last 7 and 30 days, then months", JSON.stringify(groups("modified")) ===
  JSON.stringify(["Today: Inbox", "Yesterday: Idea", "Previous 7 days: Lisbon", "Previous 30 days: Kyoto", "7: Lighthouse"]), groups("modified"))
check("pinned first, under Pinned; by title, the rest under Notes", JSON.stringify(groups("title", ["Projects/Lighthouse.md"])) ===
  JSON.stringify(["Pinned: Lighthouse", "Notes: Idea, Inbox, Kyoto, Lisbon"]), groups("title", ["Projects/Lighthouse.md"]))
check("by title without pins: one group without a heading", JSON.stringify(groups("title")) === JSON.stringify([": Idea, Inbox, Kyoto, Lighthouse, Lisbon"]))

// ---------- the previews route
const s = await serve(["notebook-navigator"])
try {
  s.write("Nn/Pics/cat.png", "x")
  s.write("Nn/Pics/cover.jpg", "x")
  s.write("Nn/Cat.md", "# Cat\n\nA cat sat.\n\n```block-calendar\nview: month\n```\n\n![[cat.png]]\n\n<!-- hidden -->Then it slept.\n")
  s.write("Nn/Cover.md", "---\nimage: Pics/cover.jpg\n---\n## Not the title\n\nText ![](Pics/cat.png)\n")
  s.write("Nn/Plain.md", "Just words, ![[missing.png]] and [[Cat]].\n")
  await s.api("GET", "state")
  const [st, r] = await s.api("POST", "notebook-navigator/previews", { paths: ["Nn/Cat.md", "Nn/Cover.md", "Nn/Plain.md", "Nn/None.md", 42] })
  check("previews: one per note there", st === 200 && JSON.stringify(Object.keys(r)) === JSON.stringify(["Nn/Cat.md", "Nn/Cover.md", "Nn/Plain.md"]), [st, r])
  check("previews: the text, without the title heading, code, blocks, embeds or comments", r["Nn/Cat.md"]?.[0].replace(/\s+/g, " ") === "A cat sat. Then it slept.", r["Nn/Cat.md"])
  check("previews: the first image, found by its name", r["Nn/Cat.md"]?.[1] === "Nn/Pics/cat.png", r["Nn/Cat.md"])
  check("previews: a cover in the frontmatter comes first; the opening heading stays out", r["Nn/Cover.md"]?.[1] === "Nn/Pics/cover.jpg" && r["Nn/Cover.md"]?.[0] === "Text", r["Nn/Cover.md"])
  check("previews: an image that isn't there is none", r["Nn/Plain.md"]?.[1] === "" && r["Nn/Plain.md"]?.[0].startsWith("Just words"), r["Nn/Plain.md"])
} finally { s.stop() }
done()
