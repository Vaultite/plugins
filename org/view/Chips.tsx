// The small things drawn in a line: TODO keywords, priorities, tags, dates (planning and inline), statistics cookies.
import { CalendarClock, CalendarDays, CircleCheck, Flag, Repeat, Timer } from "lucide-react"
import { cn, openTag } from "@vaultite"
import type { OrgNode } from "../parser/index.ts"
import { planningState, relative, daysFrom, whenOf, whenText } from "./dates.ts"
import { str } from "./tree.ts"

const QUIET = new Set(["CANCELLED", "CANCELED", "CANCEL", "KILL", "KILLED", "ABANDONED", "DROPPED", "WONTFIX"])
const WAIT = new Set(["WAITING", "WAIT", "HOLD", "ONHOLD", "BLOCKED", "PAUSED", "SOMEDAY", "MAYBE", "DELEGATED"])
const DOING = new Set(["NEXT", "STARTED", "DOING", "ACTIVE", "INPROGRESS", "IN-PROGRESS", "WIP", "PROG", "REVIEW"])

/** A keyword's colour: done green (cancelled grey), waiting yellow, under way blue, the rest orange. */
export function keywordTint(kw: string, done: boolean) {
  const k = kw.toUpperCase()
  if (done) return QUIET.has(k) ? "var(--gray)" : "var(--green)"
  return WAIT.has(k) ? "var(--yellow)" : DOING.has(k) ? "var(--blue)" : "var(--orange)"
}
export const isCancelled = (kw: string) => QUIET.has(kw.toUpperCase())

/** A keyword; with `onClick`, a button (the live preview's: it moves the keyword on). */
export function Keyword({ kw, done, onClick }: { kw: string; done: boolean; onClick?: () => void }) {
  const style = { "--t": keywordTint(kw, done) } as React.CSSProperties
  if (!onClick) return <span className={cn("org-kw", done && "is-done")} style={style}>{kw}</span>
  return (
    <button type="button" className={cn("org-kw", done && "is-done")} style={style} onClick={(e) => { e.stopPropagation(); onClick() }}
      data-tip="Next state" aria-label={`${kw}: next state`}>{kw}</button>
  )
}

const PRIORITY_TINT = ["var(--red)", "var(--orange)", "var(--gray)"]
export function Priority({ code, highest, lowest }: { code: number; highest: number; lowest: number }) {
  const span = Math.max(1, lowest - highest), at = (code - highest) / span
  const tint = PRIORITY_TINT[at <= 0 ? 0 : at >= 1 ? 2 : 1]
  const p = code < 65 ? String(code) : String.fromCharCode(code)
  return <span className="org-prio" style={{ "--t": tint } as React.CSSProperties} data-tip={`Priority ${p}`}>{p}</span>
}

export function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null
  return (
    <span className="org-tags">
      {tags.map((t) => (
        <a key={t} className="tag" role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); openTag(t) }}>{t}</a>
      ))}
    </span>
  )
}

const PLAN = { scheduled: { Icon: CalendarClock, word: "Scheduled" }, deadline: { Icon: Flag, word: "Deadline" }, closed: { Icon: CircleCheck, word: "Closed" } }

/** A planning line's date: what it is, when, and how that stands today. */
export function PlanChip({ kind, ts, done }: { kind: "scheduled" | "deadline" | "closed"; ts: OrgNode; done: boolean }) {
  const w = whenOf(ts)
  const { Icon, word } = PLAN[kind]
  if (!w) return <span className="org-chip is-quiet"><Icon size={13} />{word} {str(ts, "rawValue")}</span>
  const { urgency, note } = planningState(kind, w, done)
  return (
    <span className={cn("org-chip", `is-${urgency}`)} data-tip={str(ts, "rawValue") ?? undefined}>
      <Icon size={13} aria-hidden /><span className="org-chip-word">{word}</span>{whenText(w)}
      {w.repeat && <Repeat size={12} aria-label={w.repeat} className="org-chip-repeat" />}
      {kind !== "closed" && <span className="org-chip-note">{note}</span>}
    </span>
  )
}

/** A timestamp in running text: active ones (appointments) tinted, inactive ones (records) quiet. */
export function TimeChip({ ts }: { ts: OrgNode }) {
  const w = whenOf(ts)
  if (!w) return <span className="org-time is-quiet">{str(ts, "rawValue")}</span>
  const days = daysFrom(w.start)
  return (
    <span className={cn("org-time", !w.active && "is-quiet")} data-tip={`${relative(days)[0].toUpperCase()}${relative(days).slice(1)}${w.repeat ? ` · ${w.repeat.toLowerCase()}` : ""}`}>
      <CalendarDays size={13} aria-hidden />{whenText(w)}{w.repeat && <Repeat size={12} aria-hidden className="org-chip-repeat" />}
    </span>
  )
}

/** A clock line: when it ran and for how long. */
export function ClockRow({ n }: { n: OrgNode }) {
  const ts = n.value && typeof n.value === "object" ? (n.value as OrgNode) : null
  const w = ts ? whenOf(ts) : null
  return (
    <div className="org-clock">
      <Timer size={13} aria-hidden />
      <span>{w ? whenText(w) : str(ts ?? n, "rawValue")}</span>
      {str(n, "duration") ? <span className="org-clock-for">{str(n, "duration")}</span> : str(n, "status") === "running" && <span className="org-clock-for">running</span>}
    </div>
  )
}

/** [2/4] or [50%] as a small bar and its number. */
export function Cookie({ value }: { value: string }) {
  const frac = /\[(\d+)\/(\d+)\]/.exec(value), pct = /\[(\d+)%\]/.exec(value)
  const ratio = frac ? (Number(frac[2]) ? Number(frac[1]) / Number(frac[2]) : 0) : pct ? Number(pct[1]) / 100 : null
  if (ratio === null) return <span className="org-cookie">{value}</span>
  const full = ratio >= 1
  return (
    <span className={cn("org-cookie", full && "is-full")} role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span className="org-cookie-bar"><span style={{ width: `${Math.min(100, ratio * 100)}%` }} /></span>
      {frac ? `${frac[1]}/${frac[2]}` : `${pct![1]}%`}
    </span>
  )
}
