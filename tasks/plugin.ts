// Tasks' server: every task in the vault (indexed by file, read again only when a file changes), ```tasks blocks run
// and drawn as text, and the ops agents manage tasks with. Writes change one line (and add one, for a recurrence).
import fs from "node:fs"
import { OpError, Plugin, type OpCtx } from "@vaultite/core/plugins.ts"
import { localToday } from "./dates.ts"
import { parseQuery, runQuery, urgency } from "./query.ts"
import { type Found, tasksIn } from "./scan.ts"
import { changeStatus, DEFAULT_PREFS, fullDescription, isDone, newTaskLine, parseTask, type Prefs, PRIORITIES, serialize, type Key, withField } from "./task.ts"
import { parseRule } from "./recur.ts"
import { isDay } from "./dates.ts"
import type { Answer, Shown } from "./types.ts"

export const plugin = new Plugin(import.meta.url)

type Settings = Prefs & { globalFilter: string; removeGlobalFilter: boolean; globalQuery: string }
function settings(): Settings {
  const s = plugin.settings()
  const b = (k: keyof Prefs | "removeGlobalFilter", d: boolean) => (typeof s[k] === "boolean" ? s[k] as boolean : d)
  return {
    format: s.format === "dataview" ? "dataview" : "emoji",
    doneDate: b("doneDate", DEFAULT_PREFS.doneDate), cancelledDate: b("cancelledDate", DEFAULT_PREFS.cancelledDate),
    createdDate: b("createdDate", DEFAULT_PREFS.createdDate), recurrenceBelow: b("recurrenceBelow", DEFAULT_PREFS.recurrenceBelow),
    globalFilter: typeof s.globalFilter === "string" ? s.globalFilter.trim() : "", removeGlobalFilter: b("removeGlobalFilter", false),
    globalQuery: typeof s.globalQuery === "string" ? s.globalQuery : "",
  }
}

// ---------- the index

const files = new Map<string, { ns: bigint; filter: string; tasks: Found[] }>()
let all: { version: number; filter: string; tasks: Found[] } | null = null

/** Every task in the vault's notes, outside the templates folder and dot folders. */
function allTasks(): Found[] {
  const v = plugin.vault, filter = settings().globalFilter
  if (all && all.version === v.version && all.filter === filter) return all.tasks
  const plain = v.plain().map((p) => `${p.replace(/\/$/, "")}/`)
  const out: Found[] = []
  const seen = new Set<string>()
  for (const [rel, e] of v.entries) {
    if (!rel.endsWith(".md") || rel.startsWith(".") || rel.includes("/.") || plain.some((p) => rel.startsWith(p))) continue
    seen.add(rel)
    let f = files.get(rel)
    if (!f || f.ns !== e.stat.ns || f.filter !== filter) {
      let text = ""
      try { text = fs.readFileSync(v.abs(rel), "utf8") } catch { /* gone, or not downloaded yet */ }
      f = { ns: e.stat.ns, filter, tasks: text.includes("[") ? tasksIn(text, rel, filter) : [] }
      files.set(rel, f)
    }
    out.push(...f.tasks)
  }
  for (const k of files.keys()) if (!seen.has(k)) files.delete(k)
  all = { version: v.version, filter, tasks: out }
  return out
}

/** A task as the app and agents get it. */
function shown(t: Found, today: string, s: Settings, blocked: boolean): Shown {
  let description = fullDescription(t)
  if (s.removeGlobalFilter && s.globalFilter) description = description.split(s.globalFilter).join("").replace(/\s{2,}/g, " ").trim()
  return {
    path: t.path, line: t.line + 1, text: t.text, heading: t.heading, symbol: t.symbol, status: t.status, description,
    priority: t.priority, dates: t.dates, recurrence: t.recurrence, recurrenceValid: !t.recurrence || !!parseRule(t.recurrence),
    onCompletion: t.onCompletion, id: t.id, dependsOn: t.dependsOn, tags: t.tags, urgency: urgency(t, today), blocked,
  }
}

/** A query's answer: its groups of tasks as the app draws them. */
function answer(q: string, path: string): Answer {
  const s = settings(), today = localToday(), tasks = allTasks()
  const r = runQuery(parseQuery(q, today, path, s.globalQuery), tasks, today)
  const ids = new Map<string, boolean>()
  for (const t of tasks) if (t.id && !isDone(t)) ids.set(t.id, true)
  return {
    ...r, today,
    groups: r.groups.map((g) => ({ names: g.names, tasks: g.tasks.map((t) => shown(t, today, s, !isDone(t) && t.dependsOn.some((d) => ids.has(d)))) })),
  }
}

plugin.route("GET", "tasks/query", (req) => answer(req.query.q ?? "", req.query.path ?? ""))

// ---------- as text: ```tasks blocks for /api/render, and the ops' answers

const link = (t: { path: string; heading: string }) => `[[${t.path.replace(/\.md$/, "")}${t.heading ? `#${t.heading}` : ""}]]`

function resultText(r: Answer, opts: { lines?: boolean } = {}): string {
  const out: string[] = []
  if (r.problems.length) out.push(...r.problems.map((p) => `_Tasks query: ${p}_`))
  if (r.explain) out.push("```", r.explain, "```", "")
  if (r.problems.length) return out.join("\n")
  let last: string[] = []
  for (const g of r.groups) {
    g.names.forEach((n, i) => { if (last.slice(0, i + 1).join("\0") !== g.names.slice(0, i + 1).join("\0")) out.push("", `${"#".repeat(Math.min(6, 4 + i))} ${n}`, "") })
    last = g.names
    for (const t of g.tasks) {
      const line = t.text.replace(/^[\s>]*/, "").replace(/^\d+[.)]/, "-")
      out.push(`${line}${r.layout.hide.includes("backlink") && !opts.lines ? "" : ` · ${link(t)}`}${opts.lines ? ` (line ${t.line})` : ""}`)
    }
  }
  if (!r.groups.length) out.push("_No tasks match._")
  if (!r.layout.hide.includes("task count")) out.push("", `_${r.shown === r.total ? r.total : `${r.shown} of ${r.total}`} task${r.total === 1 ? "" : "s"}_`)
  return out.join("\n").replace(/^\n+/, "")
}

plugin.provide("fence:tasks", (ctx: { path: string; text: string; host?: string }) => resultText(answer(ctx.text, ctx.host ?? ctx.path)))

// ---------- writing a task's line

const PATH = { type: "string" as const, format: "path", required: true, description: "the note the task is in (Projects/Lighthouse.md)" }
const LINE = { type: "integer" as const, minimum: 1, description: "its line in the note, from 1 (as tasks.list gives it)" }
const TASK = { type: "string" as const, description: "words of the task's text, when its line isn't known or may have moved" }
const EXPECT = { type: "string" as const, description: "the line as you last saw it: refused if the line changed since" }

async function fileText(ctx: OpCtx, path: string): Promise<string> {
  try { return String((await ctx.api("GET", `file?path=${encodeURIComponent(path)}`)).text ?? "") } catch { throw new OpError(`there's no note ${path}`, 404) }
}

/** The task's line number (0-based) in `text`: by line, checked against `expect`, or found by its words. */
function locate(text: string, path: string, p: { line?: number; task?: string; expect?: string }): number {
  const lines = text.split("\n")
  const tasks = tasksIn(text, path)
  if (p.expect !== undefined) {
    if (p.line && lines[p.line - 1] === p.expect) return p.line - 1
    const at = tasks.filter((t) => t.text === p.expect)
    if (at.length === 1) return at[0].line
    throw new OpError(`the task changed in ${path} since it was shown: read it again`, 409)
  }
  if (p.line) {
    if (!parseTask(lines[p.line - 1] ?? "")) throw new OpError(`line ${p.line} of ${path} isn't a task: tasks.list says where tasks are`)
    if (p.task && !lines[p.line - 1].toLowerCase().includes(p.task.toLowerCase())) throw new OpError(`line ${p.line} of ${path} doesn't say "${p.task}": it's "${lines[p.line - 1].trim()}"`, 409)
    return p.line - 1
  }
  if (!p.task) throw new OpError("say which task: its line, or words of its text (task)")
  const want = p.task.toLowerCase()
  const hits = tasks.filter((t) => t.text.toLowerCase().includes(want))
  const open = hits.filter((t) => !isDone(t))
  const pick = hits.length === 1 ? hits : open
  if (pick.length === 1) return pick[0].line
  if (!hits.length) throw new OpError(`no task in ${path} says "${p.task}"`, 404)
  throw new OpError(`${pick.length || hits.length} tasks in ${path} say "${p.task}": give its line (${(pick.length ? pick : hits).map((t) => t.line + 1).join(", ")})`)
}

/** Replace one line with `next` (none, one or several), written as a merge with what's on disk. */
async function writeLine(ctx: OpCtx, path: string, text: string, at: number, next: string[]) {
  const lines = text.split("\n")
  lines.splice(at, 1, ...next)
  await ctx.api("PUT", "file", { path, text: lines.join("\n"), base: text })
}

const STATUS: Record<string, string> = { done: "x", todo: " ", "in-progress": "/", cancelled: "-" }

plugin.op({
  id: "tasks.list",
  summary: "The tasks matching a Tasks query (not done, due before tomorrow, path includes, tags include, sort by, group by...), with their notes and lines.",
  help: `Runs a query in Tasks' language over every \`- [ ]\` task in the vault, as a \`\`\`tasks block does: one instruction a line,
"not done" when left out. Each task comes with its note and line, which tasks.complete and tasks.update take.

  vau tasks list "not done
  due before tomorrow"
  vau tasks list "tags include #work" --path Notes/Week.md     (--path: the note a query's {{query.file.path}} means)

The language: \`vau docs tasks\`.`,
  kind: "read",
  params: {
    query: { type: "string", default: "not done", description: "a Tasks query, one instruction a line (default: not done)" },
    path: { type: "string", format: "path", description: "the note the query is about, for {{query.file.path}} and the like" },
  },
  args: ["query"],
  cli: "tasks list",
  mcp: true,
  run: (p: { query?: string; path?: string }) => answer(p.query?.trim() ? p.query : "not done", p.path ?? ""),
  text: (r: Answer) => resultText(r, { lines: true }),
})

const FIELDS = {
  due: { type: "string" as const, description: "due date, YYYY-MM-DD (\"\" removes it)" },
  scheduled: { type: "string" as const, description: "scheduled date, YYYY-MM-DD (\"\" removes it)" },
  start: { type: "string" as const, description: "start date, YYYY-MM-DD (\"\" removes it)" },
  priority: { type: "string" as const, enum: PRIORITIES, description: "highest, high, medium, none, low or lowest" },
  recurrence: { type: "string" as const, description: "how it repeats: every day, every week on Monday, every month on the 1st, every weekday, every 2 weeks when done (\"\" removes it)" },
}
function checkFields(p: Record<string, string | undefined>) {
  for (const k of ["due", "scheduled", "start"]) if (p[k] && !isDay(p[k])) throw new OpError(`${k} is a date, YYYY-MM-DD`)
  if (p.recurrence && !parseRule(p.recurrence)) throw new OpError(`"${p.recurrence}" isn't a recurrence this understands: every day, every 2 weeks, every week on Monday, every month on the last Friday, every January on the 15th, every weekday, ... when done`)
}

plugin.op({
  id: "tasks.add",
  summary: "Add a task to a note (made if it's new): at the end, or under a heading; with due, scheduled, start, priority and recurrence.",
  help: `Writes \`- [ ] <description>\` with the fields in the vault's task format (Tasks' emoji, or Dataview's [due:: ...] when the
Tasks plugin's settings say so), as one new line: at the end of the note, or under \`heading\` after its last task.

  vau tasks add Daily/2026-10-06.md "Call Alice Park" --due 2026-10-08 --priority high
  vau tasks add Projects/Lighthouse.md "Order a new lamp" --heading "This week" --recurrence "every month on the 1st"`,
  kind: "write",
  params: {
    path: PATH,
    description: { type: "string", required: true, description: "what to do (#tags and [[links]] welcome)" },
    ...FIELDS,
    heading: { type: "string", description: "add it under this heading, after its last task (the heading is made at the end when there's none)" },
  },
  args: ["path", "description"],
  cli: "tasks add",
  mcp: true,
  run: async (p: { path: string; description: string; heading?: string } & Record<string, string | undefined>, ctx: OpCtx) => {
    checkFields(p)
    const s = settings()
    const desc = s.globalFilter && !p.description.includes(s.globalFilter) ? `${p.description.trim()} ${s.globalFilter}` : p.description
    const fields: Partial<Record<Key, string>> = { due: p.due, scheduled: p.scheduled, start: p.start, priority: p.priority, recurrence: p.recurrence }
    if (s.createdDate) fields.created = localToday()
    const line = newTaskLine(desc, fields, s.format)
    let text: string | null = null
    try { text = await fileText(ctx, p.path) } catch { /* a new note */ }
    if (text === null) {
      await ctx.api("PUT", "file", { path: p.path, text: `${p.heading ? `## ${p.heading}\n\n` : ""}${line}\n` })
      return { path: p.path, line: p.heading ? 3 : 1, text: line }
    }
    const lines = text.replace(/\n$/, "").split("\n")
    const last = () => lines[lines.length - 1] ?? ""
    let at: number
    if (p.heading) {
      const name = p.heading.replace(/^#+\s*/, "").trim()
      const h = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === name.toLowerCase())
      if (h < 0) {
        if (last().trim()) lines.push("")
        lines.push(`## ${name}`, "")
        at = lines.length
      } else {
        const level = /^#+/.exec(lines[h])![0].length
        at = lines.findIndex((l, i) => i > h && new RegExp(`^#{1,${level}}\\s`).test(l))
        if (at < 0) at = lines.length
        // after the section's last task, else at its end
        let last = -1
        for (let i = h + 1; i < at; i++) if (parseTask(lines[i])) last = i
        if (last >= 0) at = last + 1
        else while (at > h + 1 && !lines[at - 1].trim()) at--
      }
    } else {
      if (last().trim() && !parseTask(last())) lines.push("")
      at = lines.length
    }
    lines.splice(at, 0, line)
    await ctx.api("PUT", "file", { path: p.path, text: `${lines.join("\n")}\n`, base: text })
    return { path: p.path, line: at + 1, text: line }
  },
  text: (r: { path: string; line: number; text: string }) => `Added to ${r.path} (line ${r.line}): ${r.text}`,
})

plugin.op({
  id: "tasks.complete",
  summary: "Tick a task done (writes ✅ and the date; a recurring one gets its next occurrence), or set it to todo, in-progress or cancelled.",
  help: `Changes a task's status the way Tasks does when it's ticked: done writes ✅ <today> (cancelled ❌ <today>), a
recurring task gets its next occurrence on a new line above it (dates moved on by its rule), and \`🏁 delete\` removes
the done one. Say which task by its line (tasks.list gives it) or by words of it.

  vau tasks complete Daily/2026-10-06.md --task "Call Alice"
  vau tasks complete Projects/Lighthouse.md --line 7 --status cancelled`,
  kind: "write",
  params: {
    path: PATH, line: LINE, task: TASK, expect: EXPECT,
    status: { type: "string", enum: Object.keys(STATUS), default: "done", description: "done (default), todo, in-progress or cancelled" },
  },
  args: ["path"],
  cli: "tasks complete",
  mcp: true,
  run: async (p: { path: string; line?: number; task?: string; expect?: string; status?: string }, ctx: OpCtx) => {
    const text = await fileText(ctx, p.path)
    const at = locate(text, p.path, p)
    const was = text.split("\n")[at]
    const next = changeStatus(was, STATUS[p.status ?? "done"], localToday(), settings())
    await writeLine(ctx, p.path, text, at, next)
    return { path: p.path, line: at + 1, was, now: next }
  },
  text: (r: { path: string; was: string; now: string[] }) => `${r.path}: ${r.was.trim()}\n${r.now.length ? `is now:\n${r.now.map((l) => l.trim()).join("\n")}` : "was removed (🏁 delete)."}`,
})

plugin.op({
  id: "tasks.update",
  summary: "Change a task's description, dates, priority, recurrence or status in place (\"\" removes a field); the rest of its line stays as it is.",
  help: `Edits one task's line: only the fields given change, where they are (a new one goes where Tasks puts it). A status
change is a tick as tasks.complete makes it (done date, next recurrence).

  vau tasks update Projects/Lighthouse.md --task "railing" --due 2026-10-24 --priority high
  vau tasks update Daily/2026-10-06.md --line 3 --recurrence ""`,
  kind: "write",
  params: {
    path: PATH, line: LINE, task: TASK, expect: EXPECT,
    description: { type: "string", description: "its new text, #tags included (its fields are kept)" },
    ...FIELDS,
    status: { type: "string", enum: Object.keys(STATUS), description: "todo, in-progress, done or cancelled" },
  },
  args: ["path"],
  cli: "tasks update",
  mcp: true,
  run: async (p: { path: string; line?: number; task?: string; expect?: string; description?: string; status?: string } & Record<string, string | undefined>, ctx: OpCtx) => {
    checkFields(p)
    const text = await fileText(ctx, p.path)
    const at = locate(text, p.path, p)
    const was = text.split("\n")[at]
    let t = parseTask(was)!
    // The description given is the whole of it: tags left among the fields go, so they aren't there twice.
    if (p.description?.trim() && p.description.trim() !== fullDescription(t)) t = { ...t, description: p.description.trim(), tokens: t.tokens.filter((x) => x.key !== "tag") }
    for (const k of ["due", "scheduled", "start", "priority", "recurrence"] as Key[]) if (p[k] !== undefined) t = withField(t, k, p[k]!, settings().format)
    const want = p.status ? STATUS[p.status] : t.symbol
    const same = want === t.symbol || (want === "x" && t.status === "DONE")
    const now = same ? [serialize(t)] : changeStatus(serialize(t), want, localToday(), settings())
    if (now.join("\n") !== was) await writeLine(ctx, p.path, text, at, now)
    return { path: p.path, line: at + 1, was, now }
  },
  text: (r: { path: string; was: string; now: string[] }) => (r.now.join("\n") === r.was ? `${r.path}: unchanged.` : `${r.path}:\n${r.now.map((l) => l.trim()).join("\n") || "(removed: 🏁 delete)"}`),
})
