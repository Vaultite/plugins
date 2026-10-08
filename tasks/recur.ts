// Recurrence rules as Tasks users write them after 🔁 ("every week on Monday", "every month on the last Friday",
// "every weekday", "every 2 weeks when done"), and the next date one gives.
import { type Day, daysBetween, monthLength, monthNamed, plusDays, plusMonths, weekdayNamed, weekdayOf, weekStartOf, ymd } from "./dates.ts"

export type Rule = {
  unit: "day" | "week" | "month" | "year"
  every: number
  /** Days of the week (0 Sunday), for a weekly rule. */
  weekdays?: number[]
  /** Day of the month; -1 the last. */
  monthDay?: number
  /** The nth weekday of the month (n -1: the last). */
  nth?: { n: number; weekday: number }
  /** A yearly rule's month (1-12). */
  month?: number
  /** Counted from the day it's done, not from its dates. */
  whenDone: boolean
}

const ORD = /^(\d+)(?:st|nd|rd|th)?$/
const ordinal = (s: string) => {
  if (s === "last") return -1
  const m = ORD.exec(s)
  return m ? +m[1] : null
}
/** "monday, wednesday and friday" -> [1, 3, 5]; null when a word isn't a day. */
function weekdaysIn(s: string): number[] | null {
  const words = s.split(/\s*(?:,|\band\b|&)\s*|\s+/).filter(Boolean)
  if (!words.length) return null
  const out: number[] = []
  for (const w of words) {
    if (w === "weekday" || w === "weekdays") { out.push(1, 2, 3, 4, 5); continue }
    if (w === "weekend" || w === "weekends") { out.push(6, 0); continue }
    const d = weekdayNamed(w) >= 0 ? weekdayNamed(w) : weekdayNamed(w.replace(/s$/, ""))
    if (d < 0) return null
    out.push(d)
  }
  return [...new Set(out)]
}

/** A rule from its text, or null when it isn't one this understands. */
export function parseRule(text: string): Rule | null {
  let s = text.trim().toLowerCase().replace(/\s+/g, " ")
  const whenDone = / when done$/.test(s)
  if (whenDone) s = s.slice(0, -" when done".length)
  const m0 = /^every (.+)$/.exec(s)
  if (!m0) return null
  s = m0[1]
  let every = 1
  const n = /^(\d+) (.+)$/.exec(s)
  if (n) { every = +n[1]; s = n[2] }
  if (every < 1) return null
  let m = /^(day|week|month|year)s?(?: on (.+))?$/.exec(s)
  if (m) {
    const unit = m[1] as Rule["unit"], on = m[2]?.replace(/^the /, "")
    if (!on) return { unit, every, whenDone }
    if (unit === "week") { const w = weekdaysIn(on); return w ? { unit, every, weekdays: w, whenDone } : null }
    if (unit === "month") return monthly(on, every, whenDone)
    if (unit === "year") {
      // "on January 15th", "on the 15th of January"
      const a = /^([a-z]+) (\S+)$/.exec(on), b = /^(\S+) of ([a-z]+)$/.exec(on)
      const month = monthNamed(a?.[1] ?? b?.[2] ?? ""), day = ordinal(a?.[2] ?? b?.[1] ?? "")
      return month >= 0 && day && day > 0 && day <= 31 ? { unit, every, month: month + 1, monthDay: day, whenDone } : null
    }
    return null
  }
  // "every January on the 15th", "every January"
  if ((m = /^([a-z]+)(?: on (?:the )?(\S+))?$/.exec(s)) && monthNamed(m[1]) >= 0 && every === 1) {
    const day = m[2] ? ordinal(m[2]) : 1
    return day && day > 0 && day <= 31 ? { unit: "year", every: 1, month: monthNamed(m[1]) + 1, monthDay: day, whenDone } : null
  }
  // "every weekday", "every monday and thursday"
  const w = weekdaysIn(s)
  return w ? { unit: "week", every, weekdays: w, whenDone } : null
}

function monthly(on: string, every: number, whenDone: boolean): Rule | null {
  const parts = on.split(" ")
  const d = ordinal(parts[0])
  if (d === null) return null
  if (parts.length === 1) return d === -1 || (d >= 1 && d <= 31) ? { unit: "month", every, monthDay: d, whenDone } : null
  const wd = parts.length === 2 ? weekdayNamed(parts[1]) : -1
  return wd >= 0 && (d === -1 || (d >= 1 && d <= 5)) ? { unit: "month", every, nth: { n: d, weekday: wd }, whenDone } : null
}

/** The nth weekday of a month (n -1: the last), or null when that month hasn't one. */
function nthWeekday(y: number, m: number, n: number, weekday: number): Day | null {
  const len = monthLength(y, m)
  if (n === -1) {
    const last = ymd(y, m, len)
    return plusDays(last, -((weekdayOf(last) - weekday + 7) % 7))
  }
  const first = ymd(y, m, 1)
  const d = 1 + ((weekday - weekdayOf(first) + 7) % 7) + (n - 1) * 7
  return d <= len ? ymd(y, m, d) : null
}

/** The first date after `base` the rule gives. */
export function nextDate(rule: Rule, base: Day): Day {
  const y = +base.slice(0, 4), mo = +base.slice(5, 7)
  switch (rule.unit) {
    case "day": return plusDays(base, rule.every)
    case "week": {
      if (!rule.weekdays?.length) return plusDays(base, 7 * rule.every)
      const order = (d: number) => (d + 6) % 7
      const days = [...rule.weekdays].sort((a, b) => order(a) - order(b))
      const start = weekStartOf(base), at = daysBetween(start, base)
      const later = days.find((d) => order(d) > at)
      return later !== undefined ? plusDays(start, order(later)) : plusDays(start, 7 * rule.every + order(days[0]))
    }
    case "month": {
      if (rule.monthDay === undefined && !rule.nth) return plusMonths(base, rule.every)
      for (let i = 0; i < 400; i += rule.every) {
        const first = plusMonths(ymd(y, mo, 1), i, 1), yy = +first.slice(0, 4), mm = +first.slice(5, 7)
        let d: Day | null
        if (rule.nth) d = nthWeekday(yy, mm, rule.nth.n, rule.nth.weekday)
        else d = rule.monthDay === -1 ? ymd(yy, mm, monthLength(yy, mm)) : rule.monthDay! <= monthLength(yy, mm) ? ymd(yy, mm, rule.monthDay!) : null
        if (d && d > base) return d
      }
      return plusMonths(base, rule.every)
    }
    case "year": {
      const month = rule.month ?? mo, day = rule.monthDay ?? +base.slice(8, 10)
      for (let i = 0; i < 40; i += rule.every) {
        const yy = y + i
        const d = ymd(yy, month, Math.min(day, monthLength(yy, month)))
        if (d > base) return d
      }
      return plusMonths(base, 12 * rule.every)
    }
  }
}
