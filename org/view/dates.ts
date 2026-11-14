// Timestamps as people read them: a date, its time, how far away it is, and how a planning date stands (overdue, soon).
import type { OrgNode } from "../parser/index.ts"
import { num, str } from "./tree.ts"

export type When = { start: Date; end: Date | null; time: boolean; endTime: boolean; active: boolean; repeat: string | null }

const at = (y: number | null, m: number | null, d: number | null, h: number | null, min: number | null) =>
  y === null || m === null || d === null ? null : new Date(y, m - 1, d, h ?? 0, min ?? 0)

/** A timestamp node's dates; null for a diary sexp. */
export function whenOf(t: OrgNode): When | null {
  const kind = str(t, "kind") ?? ""
  if (kind === "diary") return null
  const start = at(num(t, "yearStart"), num(t, "monthStart"), num(t, "dayStart"), num(t, "hourStart"), num(t, "minuteStart"))
  if (!start) return null
  const e = at(num(t, "yearEnd"), num(t, "monthEnd"), num(t, "dayEnd"), num(t, "hourEnd"), num(t, "minuteEnd"))
  const end = e && e.getTime() !== start.getTime() ? e : null
  const unit = str(t, "repeaterUnit"), value = num(t, "repeaterValue")
  return { start, end, time: num(t, "hourStart") !== null, endTime: num(t, "hourEnd") !== null, active: kind.startsWith("active"),
    repeat: unit && value ? repeatText(value, unit) : null }
}

const UNITS: Record<string, string> = { hour: "hour", day: "day", week: "week", month: "month", year: "year" }
const repeatText = (n: number, unit: string) => `Every ${n === 1 ? "" : `${n} `}${UNITS[unit] ?? unit}${n === 1 ? "" : "s"}`

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
/** Whole days from today to `d` (negative: past). */
export const daysFrom = (d: Date, now = new Date()) => Math.round((midnight(d).getTime() - midnight(now).getTime()) / 864e5)

const sameDay = (a: Date, b: Date) => midnight(a).getTime() === midnight(b).getTime()
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

/** "Mon 16 Nov", the year when it isn't this one's. */
export function dayText(d: Date, now = new Date()) {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })
}

/** The whole timestamp in words: "Tue 17 Nov, 10:00–10:30", "Mon 16 – Fri 20 Nov". */
export function whenText(w: When, now = new Date()) {
  const s = dayText(w.start, now) + (w.time ? `, ${time(w.start)}` : "")
  if (!w.end) return s
  if (sameDay(w.start, w.end)) return `${s}–${time(w.end)}`
  return `${s} – ${dayText(w.end, now)}${w.endTime ? `, ${time(w.end)}` : ""}`
}

/** How far away a day is: "today", "tomorrow", "in 3 days", "2 days ago". */
export function relative(days: number) {
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  if (days === -1) return "yesterday"
  const n = Math.abs(days), unit = n >= 14 && n < 60 ? [Math.round(n / 7), "week"] as const : n >= 60 ? [Math.round(n / 30), "month"] as const : [n, "day"] as const
  const words = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`
  return days > 0 ? `in ${words}` : `${words} ago`
}

export type Urgency = "overdue" | "soon" | "later" | "quiet"

/** A planning date's standing: a deadline past is overdue, one within a week soon; scheduled past or today is due. */
export function planningState(kind: "deadline" | "scheduled" | "closed", w: When, done: boolean, now = new Date()): { urgency: Urgency; note: string } {
  const days = daysFrom(w.start, now)
  if (kind === "closed" || done) return { urgency: "quiet", note: relative(days) }
  if (kind === "deadline") {
    if (days < 0) return { urgency: "overdue", note: `${-days} day${days === -1 ? "" : "s"} overdue` }
    return { urgency: days <= 7 ? "soon" : "later", note: days === 0 ? "due today" : `due ${relative(days)}` }
  }
  if (days < 0) return { urgency: "soon", note: relative(days) }
  return { urgency: days === 0 ? "soon" : "later", note: relative(days) }
}
