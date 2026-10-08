// The calendar (a sidebar panel, a tab): a month of daily notes as dots (their length; a ring: tasks left open), today
// marked, week numbers; a click opens a day's, week's, month's, quarter's or year's note, making it (asked first) when
// it isn't there. Commands open this period's note, or the next or previous one there is of the open one.
import { Fragment, useEffect, useState } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, Dot } from "lucide-react"
import {
  cn, confirmDialog, currentFile, dateText, definePlugin, formatDate, getStore, Loading, notify, notifyError, op, openFile, openView,
  parseDate, useFocusedFile, useLive, type SidebarCtx,
} from "@vaultite"
import { PERIODS, type Period, type Weeks } from "./dates"

type Note = { path: string; exists: boolean } | null
type Day = { date: string; note: Note; words: number; dots: number; open: number }
type Month = { month: string; today: string; weekNumbers: boolean; monthNote: Note; quarterNote: Note; yearNote: Note
  weeks: { n: number; date: string; note: Note; days: Day[] }[] }
type Config = { periods: Record<Period, { on: boolean; folder: string; format: string }>; weeks: Weeks; confirm: boolean }

const NAME: Record<Period, [string, string]> = { day: ["daily", "today's"], week: ["weekly", "this week's"], month: ["monthly", "this month's"],
  quarter: ["quarterly", "this quarter's"], year: ["yearly", "this year's"] }
let cfg: Config | null = null // (the server's settings in effect, for the commands: the background keeps it)
const iso = (d: Date) => formatDate(d, "YYYY-MM-DD")
const day = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d || 1) }

/** Open a period's note, making it when it isn't there (asked first, as the settings say). */
async function go(period: Period, date: string, note?: Note) {
  if (note === null) return
  if (note?.exists) return void openFile(note.path)
  if (note && cfg?.confirm !== false && !await confirmDialog({ title: `New ${NAME[period][0]} note`, body: `${note.path} isn't there yet. Make it?`, confirm: "Make it" })) return
  try { openFile((await op<{ path: string }>("periodic-notes.note", { period, date })).path) } catch (e) { notifyError(e, "Couldn't open the note") }
}

/** A file as a periodic note: its period and first day. */
function periodOf(path: string) {
  for (const p of cfg ? PERIODS : []) {
    const s = cfg!.periods[p], dir = s.folder ? `${s.folder}/` : ""
    const d = s.on && path.startsWith(dir) && path.endsWith(".md") ? parseDate(path.slice(dir.length, -3), s.format, cfg!.weeks) : null
    if (d) return { p, t: d.getTime() }
  }
  return null
}

/** The nearest note of the open one's period there is, later (1) or earlier (-1), as Periodic Notes' jumps. */
function jump(dir: 1 | -1) {
  const at = periodOf(currentFile())
  if (!at) return
  const near = (getStore()?.files.files ?? []).flatMap((f) => { const n = periodOf(f.path); return n?.p === at.p && (n.t - at.t) * dir > 0 ? [{ ...n, path: f.path }] : [] })
    .sort((a, b) => (a.t - b.t) * dir)[0]
  if (near) openFile(near.path)
  else notify(`No ${dir > 0 ? "later" : "earlier"} ${NAME[at.p][0]} note`)
}

/** A heading's part that opens its period's note when that period is on. */
function Head({ period, date, note, children }: { period: Period; date: string; note: Note; children: string }) {
  if (!note) return <span>{children}</span>
  return (
    <button type="button" onClick={() => void go(period, date, note)} data-tip={note.exists ? note.path : `Make ${note.path}`}
      className={cn("cursor-pointer rounded-[4px] px-0.5 hover:bg-foreground/[0.06]", note.exists && "underline decoration-dotted underline-offset-[3px]")}>
      {children}
    </button>
  )
}

const dots = (n: number, open: number) => (
  <span className="flex h-[4px] gap-[2px]" aria-hidden>
    {Array.from({ length: n }, (_, i) => <i key={i} className="size-[4px] rounded-full bg-[var(--periodic-notes)]" />)}
    {open > 0 && <i className="size-[4px] rounded-full border border-[var(--periodic-notes)]" />}
  </span>
)

function Calendar({ file }: { file: string }) {
  const [month, setMonth] = useState(() => iso(new Date()).slice(0, 7))
  const { data: m, error } = useLive<Month>(`periodic-notes/month?month=${month}`, undefined, true)
  if (!m) return <Loading error={error && "Couldn't read the calendar."} className="px-1.5 text-[13px]" />
  const first = day(m.month), move = (n: number) => setMonth(iso(new Date(first.getFullYear(), first.getMonth() + n, 1)).slice(0, 7))
  const nav = "flex size-6 cursor-pointer items-center justify-center rounded-[5px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
  return (
    <div className="pb-2 select-none" data-calendar={m.month}>
      <div className="flex h-7 items-center gap-0.5 pl-1 text-[13px] font-semibold">
        <Head period="month" date={`${m.month}-01`} note={m.monthNote}>{dateText(first, { month: "long" })}</Head>
        <Head period="year" date={`${m.month}-01`} note={m.yearNote}>{String(first.getFullYear())}</Head>
        {m.quarterNote && <Head period="quarter" date={`${m.month}-01`} note={m.quarterNote}>{`Q${Math.floor(first.getMonth() / 3) + 1}`}</Head>}
        <span className="flex-1" />
        <button type="button" className={nav} onClick={() => move(-1)} aria-label="Previous month"><ChevronLeft className="size-4" /></button>
        <button type="button" className={nav} onClick={() => setMonth(m.today.slice(0, 7))} aria-label="This month" data-tip="Today"><Dot className="size-4" strokeWidth={4} /></button>
        <button type="button" className={nav} onClick={() => move(1)} aria-label="Next month"><ChevronRight className="size-4" /></button>
      </div>
      <div role="grid" className={cn("grid text-center text-[12px] tabular-nums", m.weekNumbers ? "grid-cols-8" : "grid-cols-7")}>
        {m.weekNumbers && <span />}
        {m.weeks[0].days.map((d) => <span key={d.date} className="h-5 text-[11px] leading-5 text-tertiary">{dateText(day(d.date), { weekday: "short" })}</span>)}
        {m.weeks.map((w) => (
          <Fragment key={w.date}>
            {m.weekNumbers && (
              <button type="button" disabled={!w.note} onClick={() => void go("week", w.date, w.note)} data-week={w.n}
                className={cn("flex h-8 flex-col items-center justify-center gap-[3px] rounded-[5px] text-[11px] text-tertiary enabled:cursor-pointer enabled:hover:bg-foreground/[0.06]",
                  w.note?.path === file && "bg-foreground/[0.08]")}>
                {w.n}{dots(w.note?.exists ? 1 : 0, 0)}
              </button>
            )}
            {w.days.map((d) => {
              const out = !d.date.startsWith(m.month), today = d.date === m.today
              return (
                <button key={d.date} type="button" data-date={d.date} aria-current={today ? "date" : undefined}
                  onClick={() => void go("day", d.date, d.note)}
                  data-tip={d.note?.exists ? `${d.words} words${d.open ? `, ${d.open} open task${d.open > 1 ? "s" : ""}` : ""}` : undefined}
                  className={cn("flex h-8 cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[5px] hover:bg-foreground/[0.06]",
                    out && "text-tertiary", d.note?.path === file && "bg-foreground/[0.08]", today && "font-semibold text-[var(--periodic-notes)]")}>
                  {Number(d.date.slice(8))}{dots(d.dots, d.open)}
                </button>
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** The tab: the panel's calendar a size up, the focused file's day lit. */
function CalendarTab() {
  const { path } = useFocusedFile()
  return <div className="max-w-md pb-10"><div className="size-up-bleed"><div data-size-up><Calendar file={path} /></div></div></div>
}

/** Keeps the settings in effect for the commands. */
function Settings() {
  const { data } = useLive<Config>("periodic-notes")
  useEffect(() => { cfg = data }, [data])
  return null
}

export default definePlugin({
  sidebar: {
    calendar: { title: "Calendar", sort: 38, view: "periodic-notes", flyout: { icon: CalendarDays }, names: ["periodic notes", "daily notes"],
      render: ({ open, file }: SidebarCtx) => open && <Calendar file={file} /> },
  },
  views: {
    "periodic-notes": { icon: CalendarDays, title: () => "Calendar",
      render: () => <CalendarTab /> },
  },
  commands: [
    ...PERIODS.map((p) => ({ id: `periodic-notes:${p}`, name: `Open ${NAME[p][1]} note`, when: () => p === "day" || !!cfg?.periods[p].on,
      run: () => void go(p, iso(new Date())), icon: CalendarDays })),
    { id: "periodic-notes:next", name: "Open next periodic note", when: () => !!periodOf(currentFile()), run: () => jump(1) },
    { id: "periodic-notes:previous", name: "Open previous periodic note", when: () => !!periodOf(currentFile()), run: () => jump(-1) },
    { id: "periodic-notes:calendar", name: "Open calendar in a tab", run: () => openView("periodic-notes", { newTab: true }) },
  ],
  background: () => <Settings />,
})
