// Days as YYYY-MM-DD strings, worked out in UTC so no clock change shifts them; the date phrases queries take.
// Shared by the server and the app: no Node here.

export type Day = string
/** A span of days, both ends included; null ends are open. */
export type Span = { from: Day | null; to: Day | null }

const DAY = 86_400_000
const pad = (n: number) => String(n).padStart(2, "0")
export const ms = (d: Day) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)
export const isDay = (s: unknown): s is Day => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayOf(ms(s)) === s
export const plusDays = (d: Day, n: number) => dayOf(ms(d) + n * DAY)
export const daysBetween = (a: Day, b: Day) => Math.round((ms(b) - ms(a)) / DAY)
/** 0 is Sunday, as Date has it. */
export const weekdayOf = (d: Day) => new Date(ms(d)).getUTCDay()
export const monthLength = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
export const ymd = (y: number, m: number, d: number): Day => `${y}-${pad(m)}-${pad(d)}`
/** The month `n` months on, on the same day or the month's last when it's shorter. */
export function plusMonths(d: Day, n: number, day = +d.slice(8, 10)): Day {
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1 + n, 1))
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1
  return `${y}-${pad(m)}-${pad(Math.min(day, monthLength(y, m)))}`
}
/** Today on this machine's clock. */
export function localToday(now = new Date()): Day {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
/** Monday of the week `d` is in (weeks start on Monday, as Tasks' do). */
export const weekStartOf = (d: Day) => plusDays(d, -((weekdayOf(d) + 6) % 7))

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
/** "mon", "Monday", "tues" -> 1; -1 when it isn't a day of the week. */
export const weekdayNamed = (s: string) => {
  const w = s.toLowerCase()
  return w.length >= 2 ? WEEKDAYS.findIndex((x) => x.startsWith(w) && (w.length >= 3 || w === "tu" || w === "th" || w === "sa" || w === "su")) : -1
}
export const monthNamed = (s: string) => { const w = s.toLowerCase(); return w.length >= 3 ? MONTHS.findIndex((x) => x.startsWith(w)) : -1 }

function unitSpan(unit: string, d: Day): Span {
  const y = +d.slice(0, 4), m = +d.slice(5, 7)
  switch (unit) {
    case "week": { const s = weekStartOf(d); return { from: s, to: plusDays(s, 6) } }
    case "month": return { from: ymd(y, m, 1), to: ymd(y, m, monthLength(y, m)) }
    case "quarter": { const q = Math.floor((m - 1) / 3) * 3 + 1; return { from: ymd(y, q, 1), to: ymd(y, q + 2, monthLength(y, q + 2)) } }
    case "year": return { from: `${y}-01-01`, to: `${y}-12-31` }
    default: return { from: d, to: d }
  }
}
function shift(unit: string, d: Day, n: number): Day {
  if (unit === "day") return plusDays(d, n)
  if (unit === "week") return plusDays(d, 7 * n)
  return plusMonths(d, unit === "month" ? n : unit === "quarter" ? 3 * n : 12 * n, 1)
}

/** A date phrase as the days it means: `2026-10-08`, `today`, `next week`, `in 3 days`, `last friday`,
 *  `2026-W41`, `2026-10`, `2026-Q4`, `2026`, or two dates for a span. null when it isn't one. */
export function spanOf(text: string, today: Day): Span | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ")
  const two = /^(\S+) (\S+)$/.exec(s)
  if (two && isDay(two[1]) && isDay(two[2])) return two[1] <= two[2] ? { from: two[1], to: two[2] } : { from: two[2], to: two[1] }
  const one = dayIn(s, today)
  if (one) return { from: one, to: one }
  let m = /^(this|next|last|previous) (week|month|quarter|year)$/.exec(s)
  if (m) return unitSpan(m[2], shift(m[2], today, m[1] === "this" ? 0 : m[1] === "next" ? 1 : -1))
  if ((m = /^(\d{4})-w(\d{1,2})$/.exec(s))) {
    // ISO week: the one with the year's first Thursday is week 1.
    const jan4 = `${m[1]}-01-04`
    const start = plusDays(weekStartOf(jan4), (+m[2] - 1) * 7)
    return { from: start, to: plusDays(start, 6) }
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(s)) && +m[2] >= 1 && +m[2] <= 12) return unitSpan("month", `${m[1]}-${m[2]}-01`)
  if ((m = /^(\d{4})-q([1-4])$/.exec(s))) return unitSpan("quarter", ymd(+m[1], (+m[2] - 1) * 3 + 1, 1))
  if ((m = /^(\d{4})$/.exec(s))) return unitSpan("year", `${m[1]}-01-01`)
  return null
}

/** One day from a phrase: a date, today, tomorrow, yesterday, `in 2 weeks`, `3 days ago`, `next monday`, `friday`. */
export function dayIn(text: string, today: Day): Day | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ")
  if (isDay(s)) return s
  if (s === "today" || s === "now") return today
  if (s === "tomorrow") return plusDays(today, 1)
  if (s === "yesterday") return plusDays(today, -1)
  let m = /^in (an?|\d+) (day|week|month|quarter|year)s?$/.exec(s) ?? /^(an?|\d+) (day|week|month|quarter|year)s? (?:from now|later)$/.exec(s)
  if (m) return relative(today, m[2], m[1].startsWith("a") ? 1 : +m[1])
  if ((m = /^(an?|\d+) (day|week|month|quarter|year)s? ago$/.exec(s))) return relative(today, m[2], -(m[1].startsWith("a") ? 1 : +m[1]))
  if ((m = /^(?:(this|next|last|previous|coming) )?([a-z]+)$/.exec(s))) {
    const w = weekdayNamed(m[2])
    if (w < 0) return null
    const now = weekdayOf(today)
    if (m[1] === "last" || m[1] === "previous") return plusDays(today, -(((now - w + 6) % 7) + 1))
    if (m[1] === "this") return plusDays(weekStartOf(today), (w + 6) % 7)
    return plusDays(today, ((w - now + 6) % 7) + 1)
  }
  return null
}
function relative(d: Day, unit: string, n: number): Day {
  if (unit === "day") return plusDays(d, n)
  if (unit === "week") return plusDays(d, 7 * n)
  return plusMonths(d, unit === "month" ? n : unit === "quarter" ? 3 * n : 12 * n)
}
