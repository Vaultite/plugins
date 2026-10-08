// Create or edit task: a task's description, status, priority, dates and recurrence as a form, written back as one
// changed line (with a recurrence's next one when it's ticked here).
import { useEffect, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import { ListChecks, X } from "lucide-react"
import { backDetail, cn, Empty, notifyError, op, SheetHead, today, useSheetGuard } from "@vaultite"
import { prefs } from "./prefs.ts"
import { dayText, PRIORITY } from "./QueryView"
import { nextDate, parseRule } from "./recur.ts"
import { targetOf, type Target } from "./target.ts"
import { changeStatus, fullDescription, type Key, parseTask, type Priority, serialize, statusOf, type Task, withField } from "./task.ts"

const field = "h-11 w-full min-w-0 rounded-[8px] border-[0.5px] border-border bg-card px-2.5 text-[16px] outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40 md:h-7.5 md:text-[13px]"
const label = "mb-1 block text-[13px] font-medium text-muted-foreground"

/** The line as a task: itself, or a plain line or list item made one (its indentation and marker kept). */
function asTask(text: string): { t: Task; isNew: boolean } {
  const t = parseTask(text)
  if (t) return { t, isNew: false }
  const m = /^([\s>]*)(?:([-*+]|\d+[.)])\s+)?(.*)$/.exec(text)!
  return { t: parseTask(`${m[1]}${m[2] ?? "-"} [ ] ${m[3]}`)!, isNew: true }
}

const STATUSES: [string, string][] = [[" ", "Todo"], ["/", "In progress"], ["x", "Done"], ["-", "Cancelled"]]
const PRIOS: [Priority, string][] = [["highest", "Highest"], ["high", "High"], ["medium", "Medium"], ["none", "Normal"], ["low", "Low"], ["lowest", "Lowest"]]

function Chips<T extends string>({ name, value, options, set }: { name: string; value: T; options: [T, string][]; set: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-1.5" data-task-field={name.toLowerCase()}>
      {options.map(([v, text]) => {
        const on = v === value, p = PRIORITY[v]
        return (
          <button key={v} type="button" role="radio" aria-checked={on} onClick={() => set(v)}
            className={cn("flex min-h-11 cursor-pointer items-center gap-1 rounded-full px-3 text-[15px] md:min-h-7 md:px-2.5 md:text-[13px]",
              on ? "bg-card font-semibold shadow-[0_1px_3px_rgb(0_0_0/0.12)]" : "text-foreground/80 hover:bg-foreground/[0.06]")}>
            {p && <p.icon className="size-3.5 shrink-0" strokeWidth={2.5} style={{ color: p.tint }} />}
            {text}
          </button>
        )
      })}
    </div>
  )
}

function DateField({ name, value, set }: { name: string; value: string; set: (v: string) => void }) {
  return (
    <label className="block min-w-0">
      <span className={label}>{name}</span>
      <span className="flex items-center gap-1">
        <input type="date" value={value} onChange={(e) => set(e.target.value)} aria-label={name} className={field} data-task-field={name.toLowerCase()} />
        {value && (
          <button type="button" aria-label={`Clear ${name.toLowerCase()}`} data-tip="Clear" onClick={() => set("")}
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] md:size-7">
            <X className="size-4" strokeWidth={2} />
          </button>
        )}
      </span>
    </label>
  )
}

export function TaskForm({ id }: { id: string }) {
  const target = targetOf(id)
  if (!target) return <Empty>This task's form was closed. Open it again from the task.</Empty>
  return <Form target={target} />
}

function Form({ target }: { target: Target }) {
  const [{ t, isNew }] = useState(() => asTask(target.text))
  const [description, setDescription] = useState(() => fullDescription(t))
  const [status, setStatus] = useState(statusOf(t.symbol) === "DONE" ? "x" : t.symbol === "/" || t.symbol === "-" ? t.symbol : " ")
  const [priority, setPriority] = useState<Priority>(t.priority)
  const [recurrence, setRecurrence] = useState(t.recurrence)
  const [dates, setDates] = useState({ due: t.dates.due ?? "", scheduled: t.dates.scheduled ?? "", start: t.dates.start ?? "" })
  const [busy, setBusy] = useState(false)
  const rule = recurrence.trim() ? parseRule(recurrence) : null
  const base = dates.due || dates.scheduled || dates.start
  const ready = !!description.trim() && (!recurrence.trim() || !!rule) && !busy
  const date = (k: keyof typeof dates) => (v: string) => setDates((d) => ({ ...d, [k]: v }))
  const changed = () => {
    const was = asTask(target.text).t
    return description.trim() !== fullDescription(was).trim() || priority !== was.priority || recurrence.trim() !== was.recurrence
      || dates.due !== (was.dates.due ?? "") || dates.scheduled !== (was.dates.scheduled ?? "") || dates.start !== (was.dates.start ?? "")
  }
  useSheetGuard(() => (!busy && changed() ? [description.trim() || "A task"] : []))
  const bar = useSheetBar()

  /** The lines the task becomes. */
  function lines(): string[] {
    let n: Task = { ...t, description: description.trim(), tokens: t.tokens.filter((x) => x.key !== "tag") }
    const fields: Partial<Record<Key, string>> = { ...dates, priority, recurrence: recurrence.trim() }
    for (const k of ["priority", "recurrence", "start", "scheduled", "due"] as Key[]) {
      const was = k === "priority" ? t.priority : k === "recurrence" ? t.recurrence : t.dates[k as "due"] ?? ""
      if (fields[k] !== was) n = withField(n, k, fields[k]!, prefs.format)
    }
    if (isNew && prefs.createdDate) n = withField(n, "created", today(), prefs.format)
    const sym = statusOf(t.symbol) === "DONE" && status === "x" ? t.symbol : status
    return sym === n.symbol ? [serialize(n)] : changeStatus(serialize(n), sym, today(), prefs)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    const out = lines()
    setBusy(true)
    try {
      if (target.view) {
        const doc = target.view.state.doc
        let at = target.line <= doc.lines && doc.line(target.line).text === target.text ? target.line : 0
        if (!at) {
          const same: number[] = []
          for (let i = 1; i <= doc.lines; i++) if (doc.line(i).text === target.text) same.push(i)
          if (same.length !== 1) throw new Error("the line changed meanwhile")
          at = same[0]
        }
        const l = doc.line(at)
        target.view.dispatch({ changes: { from: l.from, to: out.length ? l.to : Math.min(l.to + 1, doc.length), insert: out.join("\n") }, userEvent: "input.tasks" })
      } else {
        await op("tasks.update", {
          path: target.path, line: target.line, expect: target.text, description: description.trim(), priority, recurrence: recurrence.trim(), ...dates,
          status: { " ": "todo", "/": "in-progress", x: "done", "-": "cancelled" }[status],
        })
      }
      backDetail()
    } catch (err) { notifyError(err, "Couldn't save the task") } finally { setBusy(false) }
  }

  const where = target.path?.split("/").pop()?.replace(/\.md$/, "")
  return (
    <>
      <SheetHead icon={ListChecks} tint="var(--notes)" kicker="Task" title={isNew ? "New task" : "Edit task"} sub={where} />
      <form id="task-form" data-task-form onSubmit={save} className="flex flex-col gap-4">
        <label className="block">
          <span className={label}>Description</span>
          <input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} spellCheck placeholder="What to do"
            aria-label="Description" data-task-field="description" className={field} />
        </label>
        <div>
          <span className={label}>Status</span>
          <Chips name="Status" value={status} options={STATUSES} set={setStatus} />
        </div>
        <div>
          <span className={label}>Priority</span>
          <Chips name="Priority" value={priority} options={PRIOS} set={setPriority} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <DateField name="Due" value={dates.due} set={date("due")} />
          <DateField name="Scheduled" value={dates.scheduled} set={date("scheduled")} />
          <DateField name="Start" value={dates.start} set={date("start")} />
        </div>
        <label className="block">
          <span className={label}>Repeats</span>
          <input value={recurrence} onChange={(e) => setRecurrence(e.target.value)} placeholder="every week on Monday"
            aria-label="Repeats" aria-invalid={!!recurrence.trim() && !rule} data-task-field="recurrence"
            className={cn(field, recurrence.trim() && !rule && "border-[var(--red)]")} />
          <span className={cn("mt-1 block text-[13px]", recurrence.trim() && !rule ? "text-[var(--red)]" : "text-muted-foreground")}>
            {!recurrence.trim() ? "every day, every 2 weeks, every month on the 1st, every weekday... add when done to count from the day it's done"
              : !rule ? "Not a rule this understands"
              : rule.whenDone ? "The next one is counted from the day this one is done"
              : base ? `When this one is done, the next is ${dayText(nextDate(rule, base), today())}` : "Give it a date to repeat from"}
          </span>
        </label>
        <div className={cn("justify-end gap-2", bar ? "hidden md:flex" : "flex")}>
          <button type="button" onClick={() => backDetail()} className="min-h-11 cursor-pointer rounded-[8px] px-3 text-[15px] hover:bg-foreground/[0.06] md:min-h-7 md:text-[13px]">Cancel</button>
          <button type="submit" disabled={!ready} data-task-save
            className="min-h-11 cursor-pointer rounded-[8px] bg-primary px-4 text-[15px] font-semibold text-primary-foreground disabled:cursor-default disabled:opacity-50 md:min-h-7 md:text-[13px]">
            {isNew ? "Add task" : "Save"}
          </button>
        </div>
      </form>
      {bar && createPortal(
        <button type="submit" form="task-form" disabled={!ready} data-task-save-bar
          className="h-11 cursor-pointer rounded-[8px] px-3 text-[17px] font-semibold text-primary disabled:cursor-default disabled:opacity-50">
          {isNew ? "Add task" : "Save"}
        </button>, bar)}
    </>
  )
}

/** The sheet's bottom bar, where its own buttons go on phones (on desktop it's hidden, and the form's are shown). */
function useSheetBar() {
  const [bar, setBar] = useState<HTMLElement | null>(null)
  useEffect(() => setBar(document.getElementById("sheet-bar")), [])
  return bar
}
