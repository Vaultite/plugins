// Timestamps: active <..> and inactive [..], date and time ranges, repeaters and warnings, diary sexps <%%(..)>.
import type { OrgNode } from "../ast.ts"
import { match, obj, type Lex } from "./lex.ts"

const STAMP = /[<[](\d{4})-(\d\d)-(\d\d)(?: [^\]>\n]*)?[\]>]/y
// The start time right after the date (and day name); a time range (stricter digits) anywhere, apart from it.
const TIME = /(?: +[^\]>\s\d+-]+)? +(\d{1,2}):(\d\d)/y
const TIME_RANGE = /([012]?\d):([0-5]\d)-([012]?\d):([0-5]\d)/g
const DIARY = /<%%(\([^>\n]+\))[^>\n]*>/y
const DIARY_TIME = /([012]?\d):([0-5]\d)/g
const DIARY_END = /-([012]?\d):([0-5]\d)/y
const REPEATER = /([.+]?\+)(\d+)([hdwmy])(?:\/(\d+)([hdwmy]))?/i
const WARNING = /(-)?-(\d+)([hdwmy])/i

// Units are matched in any case, but only lower-case ones are themselves: the rest count as years.
const UNITS: Record<string, string> = { h: "hour", d: "day", w: "week", m: "month" }
const unit = (u: string) => UNITS[u] ?? "year"
const REPEATS: Record<string, string> = { "+": "cumulate", "++": "catch-up", ".+": "restart" }

type Stamp = { end: number; y: number; mo: number; d: number; time: number[] | null; timeEnd: number[] | null }

/** One `<date ...>` or `[date ...]` (either bracket may close it) at `pos`. */
function stamp(s: string, pos: number, end: number): Stamp | null {
  const m = match(STAMP, s, pos, end)
  if (!m) return null
  const e = pos + m[0].length, t = match(TIME, s, pos + 11, e - 1), r = search(TIME_RANGE, s, pos, e)
  return { end: e, y: +m[1], mo: +m[2], d: +m[3], time: t ? [+t[1], +t[2]] : null, timeEnd: r ? [+r[3], +r[4]] : null }
}

/** The first match of a global regex in [from, to). */
function search(re: RegExp, s: string, from: number, to: number): RegExpExecArray | null {
  re.lastIndex = from
  const m = re.exec(s)
  return m && m.index + m[0].length <= to ? m : null
}

/** The timestamp at `pos` (s[pos] is `<` or `[`), ending before `end`; its postBlank is left at 0. */
export function timestamp(s: string, pos: number, end: number): OrgNode | null {
  if (s.startsWith("<%%", pos)) return diary(s, pos, end)
  const a = stamp(s, pos, end)
  if (!a) return null
  const b = s.startsWith("--", a.end) ? stamp(s, a.end + 2, end) : null
  const e = b ? b.end : a.end, raw = s.slice(pos, e), active = s[pos] === "<"
  const kind = (active ? "active" : "inactive") + (b || a.timeEnd ? "-range" : "")
  const timeEnd = b ? b.time ?? a.timeEnd ?? a.time : a.timeEnd ?? a.time
  const n = obj("timestamp", pos, e, { kind, rangeType: b ? "daterange" : a.timeEnd ? "timerange" : null, rawValue: raw,
    yearStart: a.y, monthStart: a.mo, dayStart: a.d, hourStart: a.time?.[0] ?? null, minuteStart: a.time?.[1] ?? null,
    yearEnd: b ? b.y : a.y, monthEnd: b ? b.mo : a.mo, dayEnd: b ? b.d : a.d, hourEnd: timeEnd?.[0] ?? null, minuteEnd: timeEnd?.[1] ?? null })
  const r = REPEATER.exec(raw)
  if (r) Object.assign(n, { repeaterType: REPEATS[r[1]], repeaterValue: +r[2], repeaterUnit: unit(r[3]),
    ...(r[4] ? { repeaterDeadlineValue: +r[4], repeaterDeadlineUnit: unit(r[5]) } : {}) })
  const w = WARNING.exec(raw)
  if (w) Object.assign(n, { warningType: w[1] ? "first" : "all", warningValue: +w[2], warningUnit: unit(w[3]) })
  return n
}

/** `<%%(sexp)>`, maybe with a time or time range after the sexp, maybe as the start of a range. The sexp is the
 * longest `(..)` before a `>`, and times are after it, but the timestamp ends at the first `]` or `>`. */
function diary(s: string, pos: number, end: number): OrgNode | null {
  const m = match(DIARY, s, pos, end)
  if (!m) return null
  let e = pos + 3
  while (s[e] !== "]" && s[e] !== ">") e++
  const from = pos + 3 + m[1].length, to = pos + m[0].length - 1, t = search(DIARY_TIME, s, from, to)
  const tEnd = t ? match(DIARY_END, s, t.index + t[0].length, to) : null, range = search(TIME_RANGE, s, from, to)
  const b = s.startsWith("--", ++e) ? stamp(s, e + 2, end) : null
  if (b) e = b.end
  return obj("timestamp", pos, e, { kind: "diary", rangeType: b ? "daterange" : range ? "timerange" : null, rawValue: s.slice(pos, e),
    diarySexp: m[1], hourStart: t ? +t[1] : null, minuteStart: t ? +t[2] : null, hourEnd: tEnd ? +tEnd[1] : null, minuteEnd: tEnd ? +tEnd[2] : null })
}

export const timestampObject = (L: Lex, pos: number) => timestamp(L.s, pos, L.end)
