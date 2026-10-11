// What the thread's parts share: a tool call in words and its icon, file links, diff lines and counts, durations.
import { useEffect, useState, type ReactNode } from "react"
import { Bot, Eye, FilePlus2, Globe, ListTodo, Search, SquarePen, SquareTerminal, Trash2, Wrench, type LucideIcon } from "lucide-react"
import { cn, openFile } from "@vaultite"
import type { Hunk } from "./types"

export const button = "grid size-6 shrink-0 cursor-pointer place-items-center rounded-[5px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground max-md:size-11"
export const pill = "inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:h-9 max-md:text-[15px]"
export const noteName = (p: string) => p.replace(/\.md$/i, "")
export const firstLine = (s: unknown) => (typeof s === "string" ? s.split("\n")[0] : "")
export const EDITS = /^(Edit|MultiEdit|Write|NotebookEdit)$/
export const tildeOf = (p: string) => p.replace(/^\/Users\/[^/]+/, "~")
/** A path as the thread shows it: inside its folder, relative to it. */
export const shortPath = (p: string, cwd: string) => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : tildeOf(p))

/** How long something took, as T3 Code says it: 4.2s, 12s, 1m 5s, 1h 2m 3s. */
export function took(ms: number) {
  const s = Math.max(0, ms) / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  const whole = Math.round(s), h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), r = whole % 60
  return h ? `${h}h ${m}m ${r}s` : m ? `${m}m ${r}s` : `${r}s`
}
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** Now, again every `ms` while `on`. */
export function useNow(on: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return now
}

// ---------- a tool call in words

export type Kind = "read" | "edit" | "add" | "delete" | "command" | "search" | "web" | "agent" | "todo" | "tool"
export const KIND_ICON: Record<Kind, LucideIcon> = {
  read: Eye, edit: SquarePen, add: FilePlus2, delete: Trash2, command: SquareTerminal, search: Search, web: Globe, agent: Bot, todo: ListTodo, tool: Wrench,
}

export function kindOf(name: string): Kind {
  if (name === "Read" || name === "WebFetch") return name === "Read" ? "read" : "web"
  if (name === "Write") return "add"
  if (EDITS.test(name)) return "edit"
  if (name === "Delete") return "delete"
  if (name === "Bash") return "command"
  if (name === "Glob" || name === "Grep") return "search"
  if (name === "WebSearch") return "web"
  if (name === "Task" || name === "Agent") return "agent"
  if (name === "TodoWrite") return "todo"
  return "tool"
}

/** A tool call in words: its verb and what it acted on (a vault file is a link). */
export function describe(name: string, input: Record<string, unknown>, cwd: string, file?: string, at?: string): { verb: string; what: string; file?: string } {
  const p = at ?? (typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "")
  const on = file ? noteName(file) : p ? shortPath(p, cwd) : ""
  switch (name) {
    case "Read": return { verb: "Read", what: on, file }
    case "Write": return { verb: "Wrote", what: on, file }
    case "Edit": case "MultiEdit": case "NotebookEdit": return { verb: "Edited", what: on, file }
    case "Delete": return { verb: "Deleted", what: on }
    case "Glob": case "Grep": return { verb: "Searched for", what: String(input.pattern ?? "") }
    case "Bash": return { verb: "Ran", what: firstLine(input.command) }
    case "WebFetch": return { verb: "Read", what: String(input.url ?? "") }
    case "WebSearch": return { verb: "Searched the web for", what: String(input.query ?? "") }
    case "Task": case "Agent": return { verb: "Asked an agent to", what: String(input.description ?? "").toLowerCase() }
    case "TodoWrite": return { verb: "Updated its to-do list", what: "" }
    case "AskUserQuestion": return { verb: "Asked you", what: ((input.questions ?? []) as { header?: string; question?: string }[]).map((q) => q.header || q.question).join(", ") }
    case "ExitPlanMode": return { verb: "Proposed a plan", what: "" }
    case "Skill": return { verb: "Used the skill", what: String(input.skill ?? input.command ?? "") }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? { verb: "Used", what: `${mcp[1]} ${mcp[2].replaceAll("_", " ")}` } : { verb: "Used", what: name }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** A group of tool calls in a phrase: its two biggest kinds of work, then how much else. */
export function summarize(tools: { name: string; key: string }[]) {
  const by = new Map<string, Set<string> | number>()
  const add = (k: string, key?: string) => {
    if (key) { const s = (by.get(k) as Set<string>) ?? new Set<string>(); s.add(key); by.set(k, s) } else by.set(k, ((by.get(k) as number) ?? 0) + 1)
  }
  for (const t of tools) {
    const k = kindOf(t.name)
    if (k === "edit" || k === "add" || k === "delete") add("changed", t.key)
    else if (k === "read" && t.name === "Read") add("read", t.key)
    else add(k)
  }
  const n = (k: string) => { const v = by.get(k); return v instanceof Set ? v.size : v ?? 0 }
  const phrases: [string, string][] = [
    ["changed", `changed ${plural(n("changed"), "file")}`], ["read", `read ${plural(n("read"), "file")}`], ["command", `ran ${plural(n("command"), "command")}`],
    ["search", `searched code ${n("search") === 1 ? "once" : `${n("search")} times`}`], ["web", `searched the web ${n("web") === 1 ? "once" : `${n("web")} times`}`],
    ["agent", `asked ${plural(n("agent"), "agent")}`], ["todo", "updated its to-dos"], ["tool", `used ${plural(n("tool"), "tool")}`],
  ]
  const have = phrases.filter(([k]) => n(k) > 0)
  const shown = have.slice(0, 2).map(([, p]) => p)
  const rest = have.slice(2).reduce((sum, [k]) => sum + n(k), 0)
  const text = rest ? `${shown.join(", ")} and ${plural(rest, "other action")}` : shown.join(" and ")
  const main = (have[0]?.[0] ?? "tool") as string
  return { text: text.charAt(0).toUpperCase() + text.slice(1), kind: (main === "changed" ? "edit" : main) as Kind }
}

export function FileLink({ file, children, className }: { file: string; children: ReactNode; className?: string }) {
  return (
    <a href="#" data-file={file} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openFile(file, { newTab: e.metaKey || e.ctrlKey }) }}
      className={cn("min-w-0 truncate text-primary hover:underline", className)}>{children}</a>
  )
}

// ---------- diffs

export type Line = { kind: "add" | "del" | "same"; text: string; old?: number; new?: number }
/** A diff's lines with their numbers: a patch's (what the edit did), else old against new (what it asks to do). */
export function diffLines(name: string, input: Record<string, unknown>, hunks?: Hunk[]): Line[] {
  if (hunks?.length) return hunkLines(hunks)
  const lines = (s: unknown) => (typeof s === "string" ? s.split("\n") : [])
  if (name === "Write") return lines(input.content).slice(0, 60).map((text) => ({ kind: "add", text }))
  if (name === "Edit") return [...lines(input.old_string).map((text) => ({ kind: "del" as const, text })), ...lines(input.new_string).map((text) => ({ kind: "add" as const, text }))]
  if (name === "MultiEdit" && Array.isArray(input.edits)) return (input.edits as Record<string, unknown>[]).flatMap((e) => diffLines("Edit", e))
  return []
}
export function hunkLines(hunks: Hunk[]): Line[] {
  return hunks.flatMap((h) => {
    let o = h.oldStart, n = h.newStart
    return h.lines.filter((l) => !l.startsWith("\\")).map((l): Line => {
      const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "same"
      const line: Line = { kind, text: l.slice(1), ...(kind !== "add" && o ? { old: o } : {}), ...(kind !== "del" && n ? { new: n } : {}) }
      if (kind !== "add") o++
      if (kind !== "del") n++
      return line
    })
  })
}

export function Counts({ lines, added, removed, className }: { lines?: Line[]; added?: number; removed?: number; className?: string }) {
  const a = added ?? lines?.filter((l) => l.kind === "add").length ?? 0
  const r = removed ?? lines?.filter((l) => l.kind === "del").length ?? 0
  return (
    <span className={cn("shrink-0 font-mono text-[11px] tabular-nums max-md:text-[13px]", className)} data-counts={`+${a} -${r}`}>
      <span className="text-[var(--green)]">+{a}</span> <span className="text-[var(--red)]">−{r}</span>
    </span>
  )
}

/** Lines of a diff, one under the other (no numbers: an edit's or a question's few lines). */
export function Diff({ lines, tall }: { lines: Line[]; tall?: boolean }) {
  if (!lines.length) return null
  return (
    <div className={cn("overflow-auto rounded-[8px] border-[0.5px] border-border bg-card py-1 font-mono text-[12px] leading-[18px]", tall ? "max-h-[28rem]" : "max-h-72")} data-diff-view>
      {lines.map((l, i) => (
        <div key={i} data-diff={l.kind} className={cn("flex min-w-max pr-3 whitespace-pre",
          l.kind === "add" && "bg-[color-mix(in_srgb,var(--green)_16%,transparent)]",
          l.kind === "del" && "bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-muted-foreground")}>
          <span aria-hidden className={cn("w-5 shrink-0 text-center select-none", l.kind === "add" ? "text-[var(--green)]" : l.kind === "del" ? "text-[var(--red)]" : "text-tertiary")}>
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
          </span>
          <span>{l.text || " "}</span>
        </div>
      ))}
    </div>
  )
}
