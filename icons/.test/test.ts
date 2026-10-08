// Icons: Iconize's names and colours read, then icons.set, the store's icons and moves on a throwaway server.
//   node icons/.test/test.ts
import { check, done, serve } from "../../testkit.ts"
const { iconize, nameOf, tintOf } = await import("../plugin.ts") // (after testkit: it finds @vaultite/core)

// ---------- Iconize's settings
check("Lucide's pack as Lucide's names", nameOf("LiRocket") === "rocket" && nameOf("LiFolderGit2") === "folder-git2" && nameOf("LiCircleHelp") === "circle-help")
check("emojis kept, other packs left out", nameOf("💡") === "💡" && nameOf("IbBell") === null && nameOf("FasHouse") === null && nameOf("") === null)
check("colours as the nearest of the app's", tintOf("#e5534b") === "red" && tintOf("#f0a020") === "orange" && tintOf("#2f81f7") === "blue"
  && tintOf("#3fb950") === "green" && tintOf("#a371f7") === "purple" && tintOf("#888") === "gray" && tintOf("teal") === "teal" && tintOf("nope") === undefined,
  ["#e5534b", "#f0a020", "#2f81f7", "#3fb950", "#a371f7", "#888"].map(tintOf))
const read = iconize({ settings: { iconColor: null }, Projects: "LiRocket", "Notes/Idea.md": { iconName: "💡", iconColor: "#e5534b" }, Odd: "IbBell" })
check("Iconize's data.json: strings and records, its settings and other packs left out",
  JSON.stringify(read) === JSON.stringify({ Projects: { icon: "rocket" }, "Notes/Idea.md": { icon: "💡", tint: "red" } }), read)

// ---------- on a server
const s = await serve(["icons"])
try {
  const state = async () => (await s.api("GET", "state"))[1].icons as Record<string, { icon?: string; tint?: string }>
  s.vau("icons", "set", "Projects", "--icon", "rocket", "--tint", "blue")
  check("a folder's icon in the settings and the store", JSON.stringify((await state()).Projects) === '{"icon":"rocket","tint":"blue"}', await state())
  s.vau("icons", "set", "Projects", "--tint", "")
  check("one left out stays, an empty one goes", JSON.stringify((await state()).Projects) === '{"icon":"rocket"}', await state())
  s.write("Notes/Plan.md", "---\ntype: note\n---\n\nText\n")
  s.vau("icons", "set", "Notes/Plan.md", "--icon", "map", "--tint", "green")
  check("a note's in its own properties", s.read("Notes/Plan.md").includes("\nicon: map\ntint: green\n---\n\nText\n"), s.read("Notes/Plan.md"))
  check("not in the settings", !(await state())["Notes/Plan.md"])
  s.vau("icons", "set", "Notes/Plan.md", "--icon", "", "--tint", "")
  check("a note's taken away", !/^(icon|tint):/m.test(s.read("Notes/Plan.md")), s.read("Notes/Plan.md"))
  s.write("Projects/Lighthouse/brief.pdf", "%PDF-1.4\n")
  s.vau("icons", "set", "Projects/Lighthouse/brief.pdf", "--icon", "file-text")
  s.vau("move", "Projects", "Work")
  const moved = await state()
  check("moves follow, what's inside too", moved.Work?.icon === "rocket" && moved["Work/Lighthouse/brief.pdf"]?.icon === "file-text" && !moved.Projects, moved)
  const [st] = await s.api("POST", "ops/icons.set", { path: "Nowhere" })
  check("a path that isn't there is refused", st === 400 || st === 404, st)

  s.write(".obsidian/plugins/obsidian-icon-folder/data.json", JSON.stringify({ settings: {}, Daily: "LiSun", Work: { iconName: "LiBriefcase", iconColor: "#2f81f7" } }))
  const both = await state()
  check("Iconize's icons, under its own", both.Daily?.icon === "sun" && both.Work?.icon === "rocket", both)
  s.vau("icons", "set", "Daily", "--icon", "")
  check("one taken away hides Iconize's", !(await state()).Daily, (await state()).Daily)
} finally { s.stop() }
done()
