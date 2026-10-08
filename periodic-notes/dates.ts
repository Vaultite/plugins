// Periodic notes' periods and weeks, on both sides; their names are written and read with the plugin API's formatDate
// and parseDate (moment.js formats, weeks counted as `Weeks` says).

export type Period = "day" | "week" | "month" | "quarter" | "year"
export const PERIODS: Period[] = ["day", "week", "month", "quarter", "year"]
/** Weeks: their first day (0 Sunday … 6 Saturday) and the day of January week 1 holds (moment's `dow`, and its `doy`
 *  as a day: 4 for ISO's weeks, 1 where week 1 is the one with January 1st). */
export type Weeks = { start: number; jan: number }

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
/** The first day of d's week. */
export const weekOf = (d: Date, w: Weeks) => addDays(d, -((d.getDay() - w.start + 7) % 7))

/** The first day of the period holding d. */
export function startOf(p: Period, d: Date, w: Weeks): Date {
  const y = d.getFullYear(), m = d.getMonth()
  return p === "day" ? addDays(d, 0) : p === "week" ? weekOf(d, w) : p === "month" ? new Date(y, m, 1)
    : p === "quarter" ? new Date(y, m - (m % 3), 1) : new Date(y, 0, 1)
}

/** The period n periods away from the one starting on `start`: its first day. */
export function shift(p: Period, start: Date, n: number): Date {
  const y = start.getFullYear(), m = start.getMonth()
  return p === "day" ? addDays(start, n) : p === "week" ? addDays(start, 7 * n) : p === "month" ? new Date(y, m + n, 1)
    : p === "quarter" ? new Date(y, m + 3 * n, 1) : new Date(y + n, 0, 1)
}
