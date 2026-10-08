// A ```dataview fence drawn as the app draws its database views: a card with a table, a list, tasks to tick or a month,
// asked of the server (plugin.ts) again whenever a note changes.
import { memo, useEffect, useMemo, useState, type ReactNode } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, CircleCheck, Code, List, Table2 } from "lucide-react"
import {
  addDays, cn, dateText, dow, Empty, Loading, Markdown, notifyError, numberText, openFile, Panel, parse, post, range, today, useLive, useVaultChange,
  weekStart, type BlockCtx,
} from "@vaultite"
import type { Wire } from "./values"

export const TINT = "var(--dataview, var(--indigo))"

type Task = { text: string; status: string | null; path: string; line: number; raw: string; children: Task[] }
type Answer =
  | { type: "table"; headers: string[]; id: boolean; rows: { cells: Wire[]; path?: string }[] }
  | { type: "list"; id: boolean; items: { id?: Wire; value?: Wire; has: boolean }[] }
  | { type: "task"; grouped: boolean; groups: { key: Wire; tasks: Task[] }[] }
  | { type: "calendar"; items: { date: string; link: Wire }[] }
type Reply = { result: Answer; title?: string } | { error: string }

const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/

/** "2026-09-27" -> "27 Sep" (the year when it isn't this one); with a time, the time too. */
function fmtDate(s: string) {
  const m = DAY.exec(s)
  if (!m) return s
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0))
  const date = dateText(d, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
  return m[4] ? `${date}, ${dateText(d, { hour: "numeric", minute: "2-digit" })}` : date
}

const isLink = (v: Wire): v is Extract<Wire, { $: "link" }> => !!v && typeof v === "object" && !Array.isArray(v) && v.$ === "link"
const linkName = (l: Extract<Wire, { $: "link" }>) => l.display ?? (l.sub && !l.sub.startsWith("^") ? `${l.path.replace(/^.*\//, "").replace(/\.md$/i, "")} > ${l.sub}` : l.path.replace(/^.*\//, "").replace(/\.md$/i, ""))
// (text worth drawing as Markdown: a link, a tag, emphasis, code; the rest is drawn as it is, which is cheaper)
const RICH = /\[\[|\]\(|\*\*|__|`|~~|==|(^|\s)#[\p{L}\p{N}_/-]|(^|\s)_\S/u

/** Plain words for a value, for a tooltip or an empty check. */
export function plain(v: Wire): string {
  if (v === null || v === undefined) return ""
  if (typeof v !== "object") return String(v)
  if (Array.isArray(v)) return v.map(plain).join(", ")
  switch (v.$) {
    case "link": return linkName(v)
    case "date": return v.iso
    case "dur": return v.text
    case "item": return v.text
    case "obj": return Object.entries(v.v).map(([k, x]) => `${k}: ${plain(x)}`).join(", ")
    default: return ""
  }
}

/** A value drawn the app's way: a link to open, a date, a list as chips, yes and no, Markdown text. */
export function Value({ v, from }: { v: Wire; from: string }): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-tertiary">–</span>
  if (typeof v === "boolean") return <span className={v ? "" : "text-muted-foreground"}>{v ? "Yes" : "No"}</span>
  if (typeof v === "number") return <span className="tabular-nums">{numberText(v)}</span>
  if (typeof v === "string") return RICH.test(v) ? <Markdown text={v} inline from={from} /> : <>{v}</>
  if (Array.isArray(v)) {
    return (
      <span className="inline-flex flex-wrap gap-1">
        {v.map((x, i) => (
          <span key={i} className="rounded-[5px] bg-foreground/[0.06] px-1.5 text-[12px] leading-[20px] whitespace-nowrap"><Value v={x} from={from} /></span>
        ))}
      </span>
    )
  }
  switch (v.$) {
    case "link":
      return v.exists ? (
        <button type="button" className="cursor-pointer text-primary hover:underline" data-dv-link={v.path}
          onClick={(e) => { e.stopPropagation(); openFile(v.path, { newTab: e.metaKey || e.ctrlKey }) }}>{linkName(v)}</button>
      ) : <span className="text-muted-foreground">{linkName(v)}</span>
    case "date": return <span className="tabular-nums">{fmtDate(v.iso)}</span>
    case "dur": return <>{v.text}</>
    case "item": return <Markdown text={v.text} inline from={from} />
    case "obj": return <span className="text-muted-foreground">{plain(v)}</span>
    default: return <span className="text-muted-foreground">function</span>
  }
}

/** The answer, live: asked again whenever a note changes (hidden files aren't the data). */
function useAnswer(url: string) {
  const [v, setV] = useState(() => Date.now())
  useVaultChange(() => setV(Date.now()), (p) => !p.startsWith("."))
  return useLive<Reply>(url, v)
}

const ICONS = { table: Table2, list: List, task: CircleCheck, calendar: CalendarDays }
const TITLES = { table: "Table", list: "List", task: "Tasks", calendar: "Calendar" }

function count(r: Answer) {
  const n = r.type === "table" ? r.rows.length : r.type === "list" ? r.items.length : r.type === "task" ? r.groups.reduce((s, g) => s + g.tasks.length, 0) : r.items.length
  const what = r.type === "task" ? (n === 1 ? "task" : "tasks") : n === 1 ? "result" : "results"
  return `${n} ${what}`
}

/** A ```dataview fence: the query run in its note (`this`). */
export function DataviewFence({ text, path }: BlockCtx) {
  const { data, error } = useAnswer(`dataview/query?q=${encodeURIComponent(text)}&path=${encodeURIComponent(path)}`)
  const res = data && "result" in data ? data.result : null
  const problem = data && "error" in data ? data.error : error && !data ? error.replace(/^Error: /, "") : null
  const type = res?.type ?? (/^\s*(table|list|task|calendar)\b/i.exec(text)?.[1].toLowerCase() as Answer["type"] | undefined) ?? "table"
  return (
    <Panel title={(data && "title" in data && data.title) || TITLES[type]} icon={ICONS[type]} tint={TINT} className="min-w-0"
      action={res && <span className="text-[13px] text-muted-foreground tabular-nums" data-dv-count>{count(res)}</span>}>
      <div data-dataview={type} className="min-w-0 [contain:inline-size]">
        {problem ? <p className="text-[15px] text-muted-foreground" data-dv-error>Dataview: {problem}</p>
          : !res ? <Loading />
          : <Body res={res} from={path} />}
      </div>
    </Panel>
  )
}

/** A ```dataviewjs fence: JavaScript the app doesn't run, said calmly, its code left in the note. */
export function DataviewJsFence() {
  return (
    <Panel title="DataviewJS" icon={Code} tint={TINT} className="min-w-0">
      <p className="text-[15px] leading-[20px] text-muted-foreground" data-dv-js>
        This block runs JavaScript, which this app doesn't run. Its code is still in the note; switch to
        source to see it, or write it as a Dataview query.
      </p>
    </Panel>
  )
}

function Body({ res, from }: { res: Answer; from: string }) {
  if (res.type === "table") return res.rows.length ? <Table res={res} from={from} /> : <Empty>No results.</Empty>
  if (res.type === "list") return res.items.length ? <Lines res={res} from={from} /> : <Empty>No results.</Empty>
  if (res.type === "task") return res.groups.some((g) => g.tasks.length) ? <Tasks res={res} from={from} /> : <Empty>No tasks.</Empty>
  return <Calendar res={res} />
}

const GroupHead = ({ children, n }: { children: ReactNode; n: number }) => (
  <div className="mb-1 flex items-baseline gap-1.5 text-[13px] font-semibold text-muted-foreground" data-dv-group>
    <span className="min-w-0 truncate">{children}</span><span className="font-normal tabular-nums">{n}</span>
  </div>
)

const Table = memo(function Table({ res, from }: { res: Extract<Answer, { type: "table" }>; from: string }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4" data-dv-scroll data-no-edit>
      <table className="w-full min-w-max border-collapse text-[14px]">
        <thead>
          <tr className="border-b-[0.5px] border-border">
            {res.headers.map((h, i) => (
              <th key={i} className="py-1.5 pr-4 text-left text-[13px] font-semibold text-muted-foreground last:pr-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {res.rows.map((r, ri) => (
            <tr key={`${r.path ?? ""}:${ri}`} data-keyrow data-dv-row={r.path ?? ""} tabIndex={-1}
              onClick={r.path ? (e) => openFile(r.path!, { newTab: e.metaKey || e.ctrlKey }) : undefined}
              className={cn("border-b-[0.5px] border-border last:border-0", r.path && "cursor-pointer hover:bg-foreground/[0.03]")}>
              {r.cells.map((c, ci) => (
                <td key={ci} className="h-9 max-w-[280px] truncate py-1 pr-4 align-middle last:pr-0">
                  {ci === 0 && res.id && isLink(c) && c.path === r.path ? <span className="font-medium">{linkName(c)}</span>
                    : ci === 0 && res.id && !r.path ? <span className="font-medium"><Value v={c} from={from} /></span>
                    : <Value v={c} from={from} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

/** A list: each item a row, its file's name (opening it) and its value under it; a value that's a list under its key. */
const Lines = memo(function Lines({ res, from }: { res: Extract<Answer, { type: "list" }>; from: string }) {
  const row = "relative isolate flex min-h-11 w-full min-w-0 flex-col justify-center py-2 text-left before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-[8px]"
  const one = (title: ReactNode, sub: ReactNode, path: string | null, key: string | number) => (
    path ? (
      <button type="button" key={key} data-keyrow data-dv-item={path} onClick={(e) => openFile(path, { newTab: e.metaKey || e.ctrlKey })}
        className={cn(row, "cursor-pointer hover:before:bg-foreground/[0.04]")}>
        <span className="truncate text-[15px] leading-[20px]">{title}</span>
        {sub !== null && <span className="min-w-0 truncate text-[13px] text-muted-foreground">{sub}</span>}
      </button>
    ) : (
      <div key={key} data-dv-item="" className={row}>
        <span className="truncate text-[15px] leading-[20px]">{title}</span>
        {sub !== null && <span className="min-w-0 truncate text-[13px] text-muted-foreground">{sub}</span>}
      </div>
    )
  )
  const fileOf = (v: Wire | undefined) => (v !== undefined && isLink(v) && v.exists ? v.path : null)
  return (
    <div className="space-y-3">
      {chunks(res.items).map((chunk, ci) => (
        Array.isArray(chunk) ? (
          <div key={ci} className="hairline">
            {chunk.map((it, i) => {
              const title = it.id !== undefined ? (isLink(it.id) ? linkName(it.id) : <Value v={it.id} from={from} />) : <Value v={it.value ?? null} from={from} />
              const sub = it.id !== undefined && it.has ? <Value v={it.value ?? null} from={from} /> : null
              return one(title, sub, fileOf(it.id) ?? (it.id === undefined ? fileOf(it.value) : null), i)
            })}
          </div>
        ) : (
          <div key={ci}>
            <GroupHead n={(chunk.value as Wire[]).length}><Value v={chunk.id ?? null} from={from} /></GroupHead>
            <div className="hairline">
              {(chunk.value as Wire[]).map((x, i) => one(isLink(x) ? linkName(x) : <Value v={x} from={from} />, null, fileOf(x), i))}
            </div>
          </div>
        )
      ))}
    </div>
  )
})

type Item = Extract<Answer, { type: "list" }>["items"][number]
/** Runs of plain items, and each item whose value is a list on its own (a group: its key, then its values). */
function chunks(items: Item[]): (Item[] | Item)[] {
  const out: (Item[] | Item)[] = []
  for (const it of items) {
    if (it.id !== undefined && Array.isArray(it.value)) out.push(it)
    else if (Array.isArray(out[out.length - 1])) (out[out.length - 1] as Item[]).push(it)
    else out.push([it])
  }
  return out
}

// ---------- tasks

/** Tasks under their file (or group), ticked here as a small edit of that line in the note. */
function Tasks({ res, from }: { res: Extract<Answer, { type: "task" }>; from: string }) {
  // (a box ticked shows at once, until the note says the same)
  const [ticked, setTicked] = useState<Record<string, string>>({})
  useEffect(() => setTicked({}), [res])
  const tick = async (t: Task) => {
    const k = `${t.path}:${t.line}`
    const to = (ticked[k] ?? t.status) === " " ? "x" : " "
    setTicked((x) => ({ ...x, [k]: to }))
    try {
      await post("dataview/task", { path: t.path, line: t.line, raw: t.raw, status: to })
    } catch (e) {
      setTicked((x) => { const { [k]: _, ...rest } = x; return rest })
      notifyError(e, "Couldn't change the task")
    }
  }
  return (
    <div className="space-y-4">
      {res.groups.filter((g) => g.tasks.length).map((g, gi) => (
        <div key={gi} data-dv-tasks>
          <GroupHead n={g.tasks.length}><Value v={g.key} from={from} /></GroupHead>
          <ul className="space-y-0.5">{g.tasks.map((t) => <TaskRow key={`${t.path}:${t.line}`} t={t} ticked={ticked} tick={tick} from={from} />)}</ul>
        </div>
      ))}
    </div>
  )
}

const FIELD = /\[([^[\]():]+)::\s*([^\]]*)\]|\(([^()[\]:]+)::\s*([^)]*)\)/g

/** A task's text: Markdown, its [key:: value] fields as small chips ((key:: value) shows only its value, as Dataview). */
function TaskText({ text, from }: { text: string; from: string }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(FIELD)) {
    if (m.index > at) parts.push(<Markdown key={at} text={text.slice(at, m.index)} inline from={from} />)
    const key = m[1] ?? m[3], value = (m[2] ?? m[4]).trim()
    parts.push(
      <span key={`f${m.index}`} className="mx-0.5 rounded-[5px] bg-foreground/[0.06] px-1.5 text-[13px] whitespace-nowrap" data-dv-field={key.trim()}>
        {m[1] !== undefined && <span className="text-muted-foreground">{key.trim()} </span>}{DAY.test(value) ? fmtDate(value) : value}
      </span>,
    )
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push(<Markdown key={at} text={text.slice(at)} inline from={from} />)
  return <>{parts}</>
}

function TaskRow({ t, ticked, tick, from }: { t: Task; ticked: Record<string, string>; tick: (t: Task) => void; from: string }) {
  const status = ticked[`${t.path}:${t.line}`] ?? t.status
  // (a status other than x, like Obsidian's [/] or [-], is ticked but not done)
  const checked = status !== null && status !== " ", done = status === "x" || status === "X"
  return (
    <li data-dv-task={`${t.path}:${t.line}`} data-status={status ?? ""}>
      <div className="flex min-h-7 items-start gap-2 py-0.5 pointer-coarse:min-h-11 pointer-coarse:items-center">
        {status !== null ? (
          <input type="checkbox" checked={checked} onChange={() => tick(t)} aria-label={checked ? "Mark as not done" : "Mark as done"} data-status={status}
            className={cn("mt-[3px] size-[18px] shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-muted-foreground/70 pointer-coarse:mt-0", checked && !done && "opacity-60",
              "checked:border-[var(--notes)] checked:bg-[var(--notes)] checked:bg-center checked:bg-no-repeat checked:bg-[length:11px]",
              "checked:bg-[url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2012%2012'%3E%3Cpath%20d='M2.5%206.2l2.3%202.3%204.7-5'%20fill='none'%20stroke='white'%20stroke-width='1.8'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E\")]")} />
        ) : <span className="mt-[9px] size-[5px] shrink-0 rounded-full bg-muted-foreground/70" />}
        <span className={cn("min-w-0 flex-1 text-[15px] leading-[22px]", done && "text-muted-foreground line-through decoration-muted-foreground/60")}>
          <TaskText text={t.text} from={from} />
        </span>
      </div>
      {t.children.length > 0 && <ul className="pl-[26px]">{t.children.map((c) => <TaskRow key={`${c.path}:${c.line}`} t={c} ticked={ticked} tick={tick} from={from} />)}</ul>}
    </li>
  )
}

// ---------- calendar

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const monthName = (m: string) => dateText(parse(`${m}-01`), { month: "long", year: "numeric" })
const dayLabel = (d: string) => dateText(parse(d), { weekday: "short", day: "numeric", month: "short" })

/** A month with each file on its day (a grid; a phone's narrow card lists the days that have some). */
function Calendar({ res }: { res: Extract<Answer, { type: "calendar" }> }) {
  const now = today()
  const latest = useMemo(() => res.items.map((i) => i.date).sort().pop(), [res])
  // (the month of the newest item when none is this month, so a calendar of last year's notes isn't empty)
  const [month, setMonth] = useState(() => (res.items.some((i) => i.date.startsWith(now.slice(0, 7))) || !latest ? now.slice(0, 7) : latest.slice(0, 7)))
  const byDay = useMemo(() => {
    const m = new Map<string, Extract<Wire, { $: "link" }>[]>()
    for (const i of res.items) if (i.date.startsWith(`${month}-`) && isLink(i.link)) m.set(i.date, [...(m.get(i.date) ?? []), i.link])
    return m
  }, [res, month])
  const first = `${month}-01`
  const next = addDays(first, 32).slice(0, 7), prev = addDays(first, -1).slice(0, 7)
  const last = addDays(`${next}-01`, -1)
  const days = range(weekStart(first), 7 * Math.ceil((dow(first) + Number(last.slice(8))) / 7))
  const chip = (l: Extract<Wire, { $: "link" }>) => (
    <button type="button" key={l.path} data-dv-item={l.path} onClick={(e) => openFile(l.path, { newTab: e.metaKey || e.ctrlKey })} data-tip={linkName(l)} data-tip-trunc
      className="block w-full min-w-0 cursor-pointer truncate rounded-[4px] px-1 text-left text-[12px] leading-[18px] hover:brightness-95"
      style={{ background: `color-mix(in srgb, ${TINT} 14%, transparent)` }}>{linkName(l)}</button>
  )
  const nav = "grid size-7 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground pointer-coarse:size-9"
  const agenda = [...byDay].sort(([a], [b]) => a.localeCompare(b))
  return (
    <div className="@container" data-dv-calendar={month} data-no-edit>
      <div className="mb-2 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{monthName(month)}</span>
        {month !== now.slice(0, 7) && (
          <button type="button" onClick={() => setMonth(now.slice(0, 7))}
            className="h-7 cursor-pointer rounded-[6px] px-2 text-[13px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground pointer-coarse:h-9">Today</button>
        )}
        <button type="button" aria-label="Previous month" onClick={() => setMonth(prev)} className={nav}><ChevronLeft className="size-4" strokeWidth={2} /></button>
        <button type="button" aria-label="Next month" onClick={() => setMonth(next)} className={nav}><ChevronRight className="size-4" strokeWidth={2} /></button>
      </div>
      <div className="hidden @md:block">
        <div className="grid grid-cols-7 text-[11px] font-semibold text-muted-foreground">{WEEKDAYS.map((w) => <div key={w} className="px-1 pb-1">{w}</div>)}</div>
        <div className="grid grid-cols-7 overflow-hidden rounded-[8px] border-[0.5px] border-border">
          {days.map((d, i) => {
            const out = !d.startsWith(`${month}-`)
            return (
              <div key={d} className={cn("min-h-[76px] min-w-0 border-border p-1", i % 7 && "border-l-[0.5px]", i >= 7 && "border-t-[0.5px]", out && "bg-foreground/[0.025]")}>
                <div className="mb-0.5 flex">
                  <span className={cn("grid h-5 min-w-5 place-items-center rounded-full px-1 text-[12px] tabular-nums",
                    d === now ? "bg-primary font-semibold text-primary-foreground" : out ? "text-tertiary" : "text-muted-foreground")}>{Number(d.slice(8))}</span>
                </div>
                <div className="space-y-0.5">{(byDay.get(d) ?? []).map(chip)}</div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="@md:hidden">
        {!agenda.length ? <Empty>Nothing this month.</Empty> : agenda.map(([d, ls]) => (
          <div key={d} className="mb-3 last:mb-0">
            <div className={cn("mb-0.5 text-[13px] font-semibold", d === now ? "text-primary" : "text-muted-foreground")}>{d === now ? `Today, ${dayLabel(d)}` : dayLabel(d)}</div>
            <div className="hairline">
              {ls.map((l) => (
                <button type="button" key={l.path} data-dv-item={l.path} onClick={(e) => openFile(l.path, { newTab: e.metaKey || e.ctrlKey })}
                  className="relative isolate flex min-h-11 w-full min-w-0 cursor-pointer items-center py-2 text-left text-[15px] before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-[8px] hover:before:bg-foreground/[0.04]">
                  <span className="truncate">{linkName(l)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
