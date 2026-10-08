// A ```tasks block: the query run on the server, its tasks drawn as a checklist under their groups. Ticking one writes
// its note (tasks.complete: the done date, a recurrence's next); the pencil opens the form. Sizes that differ by screen
// are both variants (max-md: / md:): the app's plain classes sit above a plugin's.
import { useState } from "react"
import { Ban, CalendarDays, Check, ChevronDown, ChevronsDown, ChevronsUp, ChevronUp, CircleCheck, CirclePlus, CircleX, Gauge, Hourglass, ListChecks, Minus,
  Pencil, PlaneTakeoff, Repeat, type LucideIcon } from "lucide-react"
import { cn, dateText, Loading, Markdown, notifyError, op, openAt, Panel, parse, useLive, useVaultChange, type BlockCtx } from "@vaultite"
import { editTask } from "./target.ts"
import type { Answer, Shown } from "./types.ts"

const enc = encodeURIComponent
const DAY = { day: "numeric", month: "short" } as const, DAY_YEAR = { day: "numeric", month: "short", year: "numeric" } as const

/** A date as near ones are said: Today, Tomorrow, Yesterday, else "Oct 8". */
export function dayText(d: string, today: string) {
  const n = Math.round((parse(d).getTime() - parse(today).getTime()) / 864e5)
  if (n === 0) return "Today"
  if (n === 1) return "Tomorrow"
  if (n === -1) return "Yesterday"
  return dateText(parse(d), d.slice(0, 4) === today.slice(0, 4) ? DAY : DAY_YEAR)
}

export const PRIORITY: Record<string, { icon: LucideIcon; label: string; tint: string }> = {
  highest: { icon: ChevronsUp, label: "Highest priority", tint: "var(--red)" },
  high: { icon: ChevronUp, label: "High priority", tint: "var(--orange)" },
  medium: { icon: ChevronUp, label: "Medium priority", tint: "var(--yellow)" },
  low: { icon: ChevronDown, label: "Low priority", tint: "var(--blue)" },
  lowest: { icon: ChevronsDown, label: "Lowest priority", tint: "var(--muted-foreground)" },
}

/** The round box a task's status is drawn with, the app's checklist look. */
export function TaskBox({ symbol, onToggle, label }: { symbol: string; onToggle?: () => void; label: string }) {
  const done = symbol === "x" || symbol === "X", doing = symbol === "/", cancelled = symbol === "-"
  return (
    <button type="button" role="checkbox" aria-checked={done ? true : doing ? "mixed" : false} aria-label={label} disabled={!onToggle} onClick={onToggle}
      data-task-box={symbol}
      className="grid shrink-0 cursor-pointer place-items-center rounded-full disabled:cursor-default max-md:-m-3 max-md:size-11 md:-m-1 md:size-7">
      <span className={cn("grid size-5 place-items-center rounded-full border-[1.5px] md:size-[18px]",
        done ? "border-[var(--notes)] bg-[var(--notes)] text-white" : "border-[color-mix(in_srgb,var(--muted-foreground)_70%,transparent)]",
        doing && "border-[var(--notes)] bg-[linear-gradient(to_right,var(--notes)_50%,transparent_50%)]",
        cancelled && "text-muted-foreground")}>
        {done && <Check className="size-3" strokeWidth={3} />}
        {cancelled && <Minus className="size-3" strokeWidth={3} />}
      </span>
    </button>
  )
}

function Meta({ icon: Icon, text, tip, tint, short }: { icon: LucideIcon; text: string; tip: string; tint?: string; short: boolean }) {
  return (
    <span data-tip={short || text !== tip ? tip : undefined} className="inline-flex items-center gap-1 whitespace-nowrap" style={tint ? { color: tint } : undefined}>
      <Icon className="size-3.5 shrink-0" strokeWidth={2.25} />
      {!short && text}
    </span>
  )
}

const key = (t: Shown) => `${t.path}\0${t.line}\0${t.text}`

function TaskRow({ t, a, symbol, toggle }: { t: Shown; a: Answer; symbol: string; toggle: () => void }) {
  const { hide, short } = a.layout
  const shows = (what: string) => !hide.includes(what)
  const done = symbol === "x" || symbol === "X" || symbol === "-"
  const meta: React.ReactNode[] = []
  const p = PRIORITY[t.priority]
  if (p && shows("priority")) meta.push(<Meta key="p" icon={p.icon} text="" tip={p.label} tint={p.tint} short />)
  if (t.recurrence && shows("recurrence rule")) meta.push(<Meta key="r" icon={Repeat} text={t.recurrence} tip={t.recurrenceValid ? `Repeats ${t.recurrence}` : `Not understood: ${t.recurrence}`} tint={t.recurrenceValid ? undefined : "var(--red)"} short={short} />)
  const date = (k: keyof Shown["dates"], what: string, icon: LucideIcon, word: string, tint?: string) => {
    const d = t.dates[k]
    if (!d || !shows(what)) return
    const valid = /^\d{4}-\d\d-\d\d$/.test(d)
    meta.push(<Meta key={k} icon={icon} text={valid ? dayText(d, a.today) : d} tip={valid ? `${word} ${d}` : `Invalid ${what}: ${d}`} tint={valid ? tint : "var(--red)"} short={short} />)
  }
  date("created", "created date", CirclePlus, "Created")
  date("start", "start date", PlaneTakeoff, "Starts")
  date("scheduled", "scheduled date", Hourglass, "Scheduled", !done && t.dates.scheduled! <= a.today ? "var(--orange)" : undefined)
  const due = t.dates.due
  date("due", "due date", CalendarDays, "Due", done || !due ? undefined : due < a.today ? "var(--red)" : due === a.today ? "var(--orange)" : undefined)
  date("cancelled", "cancelled date", CircleX, "Cancelled")
  date("done", "done date", CircleCheck, "Done")
  if (t.blocked) meta.push(<Meta key="b" icon={Ban} text="Blocked" tip={`Waits for ${t.dependsOn.join(", ")}`} short={short} />)
  if (shows("urgency")) meta.push(<Meta key="u" icon={Gauge} text={t.urgency.toFixed(2)} tip={`Urgency ${t.urgency.toFixed(2)}`} short={false} />)
  const name = t.path.split("/").pop()!.replace(/\.md$/, "")
  const description = shows("tags") ? t.description : t.description.replace(/(^|\s)#[^\s#]+/g, "").trim()
  return (
    <li data-task-row={`${t.path}:${t.line}`} data-status={symbol} className="group flex items-start gap-2.5 max-md:py-1 md:py-0.5">
      <TaskBox symbol={symbol} onToggle={toggle} label={done ? `Mark "${t.description}" not done` : `Mark "${t.description}" done`} />
      <div className="min-w-0 flex-1 pt-0.5 text-[17px] leading-[24px] md:pt-0 md:text-[14px] md:leading-[20px]">
        <span className={cn("break-words", done && "text-muted-foreground line-through decoration-[color-mix(in_srgb,var(--muted-foreground)_60%,transparent)]")}>
          <Markdown inline text={description || " "} />
        </span>
        {(meta.length > 0 || shows("backlink")) && (
          <span className="ml-2 inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5 align-baseline text-[13px] text-muted-foreground md:text-[12px]">
            {meta}
            {shows("backlink") && (
              <button type="button" data-task-link onClick={() => openAt(t.path, t.heading)}
                className="cursor-pointer whitespace-nowrap text-muted-foreground hover:text-foreground hover:underline">
                {t.heading ? `${name} › ${t.heading}` : name}
              </button>
            )}
          </span>
        )}
      </div>
      {shows("edit button") && (
        <button type="button" aria-label="Edit task" data-tip="Edit task" data-task-edit onClick={() => editTask({ path: t.path, line: t.line, text: t.text })}
          className="grid shrink-0 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:-my-1.5 max-md:size-11 md:-my-0.5 md:size-6 md:opacity-[0] md:group-hover:opacity-100 md:focus-visible:opacity-100">
          <Pencil className="max-md:size-4 md:size-3.5" strokeWidth={2} />
        </button>
      )}
    </li>
  )
}

/** A query's result, without its card: what the block and the preview draw. */
export function TaskList({ a, onToggle, pending = {} }: { a: Answer; onToggle?: (t: Shown) => void; pending?: Record<string, string> }) {
  let last: string[] = []
  return (
    <div data-tasks-result className="min-w-0">
      {a.explain && <pre data-tasks-explain className="mb-3 overflow-x-auto rounded-[8px] bg-foreground/[0.04] p-3 text-[13px] leading-[18px] whitespace-pre-wrap text-muted-foreground">{a.explain}</pre>}
      {a.problems.length > 0 && (
        <div data-tasks-problems className="text-[15px] text-muted-foreground md:text-[13px]">
          {a.problems.map((p, i) => <p key={i}><span className="text-[var(--red)]">Tasks query:</span> {p}</p>)}
        </div>
      )}
      {!a.problems.length && !a.groups.length && <p className="text-[15px] text-muted-foreground md:text-[13px]">No tasks match.</p>}
      {a.groups.map((g, gi) => {
        const heads = g.names.map((n, i) => (last.slice(0, i + 1).join("\0") === g.names.slice(0, i + 1).join("\0") ? null : (
          <div key={`h${i}`} role="heading" aria-level={4 + i} data-tasks-group
            className={cn("pt-3 pb-1 text-[15px] font-semibold md:text-[13px]", i > 0 && "text-muted-foreground", gi === 0 && i === 0 && "pt-0")} style={{ paddingLeft: i * 12 }}>
            {n}
          </div>
        )))
        last = g.names
        return (
          <div key={gi}>
            {heads}
            <ul style={{ paddingLeft: Math.max(0, g.names.length - 1) * 12 }}>
              {g.tasks.map((t) => <TaskRow key={key(t)} t={t} a={a} symbol={pending[key(t)] ?? t.symbol} toggle={() => onToggle?.(t)} />)}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

export function countText(a: Answer) {
  return `${a.shown === a.total ? a.total : `${a.shown} of ${a.total}`} task${a.total === 1 ? "" : "s"}`
}

export function QueryFence(ctx: BlockCtx) {
  const path = ctx.host ?? ctx.path
  const [v, setV] = useState(0)
  // Any note can hold a task: ask again when one changes (or the plugin's settings do).
  useVaultChange(() => setV(Date.now()), (p) => p.endsWith(".md") || p === ".vaultite/plugins/tasks/data.json")
  const { data, error } = useLive<Answer>(`tasks/query?q=${enc(ctx.text)}&path=${enc(path)}`, v)
  const [pending, setPending] = useState<{ for: Answer | null; marks: Record<string, string> }>({ for: null, marks: {} })
  const marks = pending.for === data ? pending.marks : {}
  const toggle = (t: Shown) => {
    const was = marks[key(t)] ?? t.symbol
    const to = was === "x" || was === "X" || was === "-" ? " " : "x"
    setPending({ for: data, marks: { ...marks, [key(t)]: to } })
    op("tasks.complete", { path: t.path, line: t.line, expect: t.text, status: to === "x" ? "done" : "todo" })
      .catch((e) => { setPending((p) => { const m = { ...p.marks }; delete m[key(t)]; return { ...p, marks: m } }); notifyError(e, "Couldn't change the task") })
  }
  const count = data && !data.problems.length && !data.layout.hide.includes("task count")
    ? <span data-tasks-count className="text-[13px] text-muted-foreground tabular-nums">{countText(data)}</span> : undefined
  return (
    <Panel title="Tasks" icon={ListChecks} tint="var(--notes)" className="min-w-0" action={count}>
      {error ? <p className="text-[15px] text-muted-foreground">Tasks: {error.replace(/^Error: /, "")}</p>
        : !data ? <Loading />
        : <TaskList a={data} onToggle={toggle} pending={marks} />}
    </Panel>
  )
}
