// Page tabs on a throwaway server: the app's state has every group, render says which tab a page is; off, neither.
//   node page-tabs/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

const { stripOf, tabGroups } = await import("../tabs.ts")
const files = [{ path: "CLAUDE.md" }, { path: "Personal/Dashboards/Agents.md", tab: "Overview", tabs: ["Claude", "Codex"] }, { path: "Personal/Dashboards/Claude.md" },
  { path: "Personal/Dashboards/Codex.md", plugin: "codex" }]
const groups = tabGroups(files)
check("a name is found beside its head first (not the vault's CLAUDE.md)", groups[0].map((t) => t.path).join() ===
  "Personal/Dashboards/Agents.md,Personal/Dashboards/Claude.md,Personal/Dashboards/Codex.md", groups)
check("a tab whose plugin is off is left out", stripOf(groups, "Personal/Dashboards/Claude.md", (t) => t.plugin === "codex").length === 2)
check("fewer than two tabs: no strip", !stripOf(tabGroups([files[1], files[2]].map((f) => ({ ...f, tabs: f.tabs && ["Nowhere"] }))), files[1].path).length)

const s = await serve(["page-tabs"])
try {
  s.write("Notes/Tabs/Head.md", "---\ntab: List\ntabs: [Other, Vim keys]\n---\n\nThe head.\n")
  s.write("Notes/Tabs/Other.md", "---\ntab: Map\n---\n\nThe other.\n")
  s.write("Notes/Tabs/Vim keys.md", "---\nplugin: vim\n---\n\nVim's, off.\n")
  const [, st] = await s.api("GET", "state")
  const group = st.pageTabs?.find((g: { path: string }[]) => g[0].path === "Notes/Tabs/Head.md")
  check("the state has the group, head first", JSON.stringify(group) === JSON.stringify([{ path: "Notes/Tabs/Head.md", label: "List" },
    { path: "Notes/Tabs/Other.md", label: "Map" }, { path: "Notes/Tabs/Vim keys.md", label: "Vim keys", plugin: "vim" }]), st.pageTabs)
  check("the file index has no tab fields", !("tab" in st.files.files.find((f: { path: string }) => f.path === "Notes/Tabs/Head.md")))
  const [, txt] = await s.api("GET", "render?path=Notes/Tabs/Other.md")
  check("render names the tabs, this one in bold, an off plugin's left out (page-head)", txt.includes("# Other\n\nTabs: [[Head|List]] · **Map**\n"), txt.slice(0, 300))
  s.vau("plugin", "off", "page-tabs")
  const [, off] = await s.api("GET", "state"), [, plain] = await s.api("GET", "render?path=Notes/Tabs/Other.md")
  check("off: no groups, and render shows the page as it is", !("pageTabs" in off) && plain.includes("# Other\n\nThe other.") && !plain.includes("Tabs:"), plain.slice(0, 300))
} finally {
  s.stop()
}
done()
