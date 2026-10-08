// A query's result as Markdown, what an agent reads (GET /api/render, vau render): a table, a list, tasks with their
// boxes, a calendar's days. Values as text: [[links]], ISO dates, lists with commas.
import type { Result, Row } from "./engine.ts"
import { DvDate, dateIso, Link, toText, type Value } from "./values.ts"

const cell = (v: Value) => (v === undefined ? "-" : toText(v)).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|")

/** A list's value: a list of values as sub-bullets, else after the item's name. */
function bullet(id: Value | undefined, value: Value | undefined, depth = 0): string {
  const pad = "  ".repeat(depth)
  if (value === undefined) return `${pad}- ${cell(id ?? null)}`
  if (Array.isArray(value) && id !== undefined) return [`${pad}- ${cell(id)}:`, ...value.map((x) => `${pad}  - ${cell(x)}`)].join("\n")
  return `${pad}- ${id !== undefined ? `${cell(id)}: ` : ""}${cell(value)}`
}

function task(t: Row, depth: number): string[] {
  const box = t.task ? `[${t.status ?? " "}] ` : ""
  return [`${"  ".repeat(depth)}- ${box}${String(t.text ?? "")}`, ...((t.children as Row[]) ?? []).flatMap((c) => task(c, depth + 1))]
}

export function markdown(r: Result): string {
  if (r.type === "table") {
    if (!r.rows.length) return "_Dataview: no results._"
    const head = r.headers.map((h, i) => (i === 0 ? `${h} (${r.rows.length})` : h))
    return [`| ${head.map((h) => cell(h)).join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...r.rows.map((row) => `| ${row.cells.map(cell).join(" | ")} |`)].join("\n")
  }
  if (r.type === "list") return r.items.length ? r.items.map((i) => bullet(i.id, i.value)).join("\n") : "_Dataview: no results._"
  if (r.type === "task") {
    const total = r.groups.reduce((n, g) => n + g.tasks.length, 0)
    if (!total) return "_Dataview: no tasks._"
    return r.groups.map((g) => [`**${cell(g.key ?? null)}** (${g.tasks.length})`, ...g.tasks.flatMap((t) => task(t, 0))].join("\n")).join("\n\n")
  }
  if (!r.items.length) return "_Dataview: nothing to show on a calendar._"
  const days = new Map<string, Link[]>()
  for (const i of r.items) { const d = dateIso(new DvDate(i.date.t, false)); days.set(d, [...(days.get(d) ?? []), i.link]) }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, ls]) => `- ${d} · ${ls.map((l) => l.markdown()).join(", ")}`).join("\n")
}

/** An inline query's value as text. */
export const inlineText = (v: Value) => (v instanceof Link ? v.markdown() : toText(v))
