/** Work: Work.md holds the focus card (focus, open questions, colleagues); the work log is logs in area `work`, which
 *  it brings to Logs. */
import { bullets, fmtMin, OpError, Plugin, section } from "@vaultite/core/plugins.ts"
import { isArchived, type Item, Kind, sortBy, str, truthy } from "@vaultite/core/vault.ts"

export const plugin = new Plugin(import.meta.url)

// The work log's area (Logs asks every plugin that's on for the areas it brings: core/logs/plugin.ts).
plugin.provide("log-areas", () => [
  { slug: "work", name: "Work", icon: "briefcase", tint: "work", fields: [
    { key: "kind", label: "Kind", type: "text" },
    { key: "person", label: "With", type: "text" },
    { key: "topic", label: "Topic", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "link", label: "Link", type: "text" }] },
])

plugin.kind(new Kind({
  type: "work", collection: "work", file: "Work.md",
  parse: (fm, body) => [{
    focus: truthy(fm.focus) ? str(fm.focus) : "",
    questions: (truthy(fm.questions) ? fm.questions : []).map(str),
    colleagues: (truthy(fm.colleagues) ? fm.colleagues : [])
      .filter((c: unknown) => c && typeof c === "object" && !Array.isArray(c))
      .map((c: Item) => ({ name: truthy(c.name) ? str(c.name) : "", role: truthy(c.role) ? str(c.role) : "" })),
    notes: body,
  }, []],
  render: (w) => [{ focus: w.focus, questions: w.questions || [], colleagues: w.colleagues || [] }, w.notes || ""],
}))

plugin.state(() => ({ work: plugin.vault.get("work", "Work") }))

// ---------- blocks as text (GET /api/render) ----------

const workLogs = () => (plugin.vault.has("logs") ? plugin.vault.items("logs").filter((l) => l.area === "work" && !isArchived(l)) : [])

plugin.op({
  id: "work.focus",
  summary: "Set the work focus card (Work.md): what the user is focused on at work now, and the open questions.",
  help: `Only what the user's ME.md allows about their employer. The work log itself is logs in area work (log.create).

  vau work.focus "Ship the importer" --questions "Who reviews it?,When does it freeze?"`,
  kind: "write",
  params: {
    focus: { type: "string", description: "the focus, one line" },
    questions: { type: "array", items: { type: "string" }, description: "the open questions (replaces the list)" },
  },
  args: ["focus"],
  run: async ({ focus, questions }, ctx) => {
    if (focus === undefined && questions === undefined) throw new OpError("say what changed: focus or questions")
    const r = await ctx.api("PUT", "work", { ...(focus !== undefined ? { focus } : {}), ...(questions !== undefined ? { questions } : {}) })
    return { path: `${r.id}.md`, focus: r.focus, questions: r.questions }
  },
  text: (r) => [`Work focus: ${r.focus || "(none)"}`, ...r.questions.map((q: string) => `- ${q}`)].join("\n"),
})

plugin.block("work-focus", (ctx) => {
  const w = plugin.vault.get("work", "Work") ?? {}
  ctx.source(w)
  return section("Focus", w.focus || "_Nothing set._", truthy(w.questions) ? "Open questions:\n" + bullets(w.questions) : "")
})

plugin.block("work-log", (ctx) => {
  const n = Number(ctx.options.limit || 20)
  const shown = workLogs().filter((l) => l.data.kind !== "idea").slice(0, n)
  ctx.source(shown)
  const rows = shown.map((l) => `${l.date}: ${l.title || l.data.kind || "Note"}` +
    [l.data.kind, l.data.person && `with ${l.data.person}`, l.duration_min ? fmtMin(l.duration_min) : ""]
      .filter(Boolean).map((x) => ` · ${x}`).join("") +
    (str(l.notes).trim() ? `: ${str(l.notes).trim()}` : ""))
  return section("Log", bullets(rows))
})

plugin.block("work-ideas", (ctx) => {
  const order = ["doing", "planned", "idea", "done", "dropped"]
  const ideas = sortBy(workLogs().filter((l) => l.data.kind === "idea"),
    (l) => (order.includes(l.data.status) ? order.indexOf(l.data.status) : 2))
  ctx.source(ideas)
  return section("Ideas and plans", bullets(ideas.map((l) => `${l.title} (${l.data.status || "idea"})`)))
})

plugin.block("work-colleagues", (ctx) => {
  const w = plugin.vault.get("work", "Work") ?? {}
  const logs = workLogs().filter((l) => l.data.kind !== "idea")
  ctx.source(w, logs.filter((l) => l.data.person))
  const colleagues = (w.colleagues || []) as Item[]
  const names = [...new Set([...colleagues.map((c) => c.name), ...logs.filter((l) => l.data.person).map((l) => l.data.person)])]
  const role = new Map(colleagues.map((c) => [c.name, c.role]))
  const last = (n: string) => logs.find((l) => l.data.person === n)?.date ?? ""
  return section("Colleagues", bullets(names.map((n) => `${n}${role.get(n) ? ", " + role.get(n) : ""}${last(n) ? ` (last ${last(n)})` : ""}`)))
})
