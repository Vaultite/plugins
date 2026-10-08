// Periodic notes on the server: where each period's note is (its folder, moment-style name and template: this plugin's
// settings, else Obsidian's Periodic Notes and Daily notes), the calendar's month, and the op that gets or
// makes a note (a template filled for the note's date, then the Templates plugin's way: frontmatter, Templater).
import fs from "node:fs"
import { formatDate, OpError, Plugin, type Request } from "@vaultite/core/plugins.ts"
import { addDays, PERIODS, shift, startOf, weekOf, type Period, type Weeks } from "./dates.ts"

export const plugin = new Plugin(import.meta.url)
const v = () => plugin.vault

/** Each period's settings word ("weekly": weeklyFolder...), and its name when nothing says. */
const NAMES: Record<Period, string> = { day: "daily", week: "weekly", month: "monthly", quarter: "quarterly", year: "yearly" }
const FORMATS: Record<Period, string> = { day: "YYYY-MM-DD", week: "gggg-[W]ww", month: "YYYY-MM", quarter: "YYYY-[Q]Q", year: "YYYY" }
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

type Spec = { on: boolean; folder: string; format: string; template: string }
type Config = { periods: Record<Period, Spec>; weeks: Weeks; confirm: boolean; weekNumbers: boolean; wordsPerDot: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>

const json = (p: string): Obj => { try { return JSON.parse(fs.readFileSync(v().abs(p), "utf8")) ?? {} } catch { return {} } }
const text = (...xs: unknown[]) => xs.find((x): x is string => typeof x === "string")
const filled = (...xs: unknown[]) => xs.find((x): x is string => typeof x === "string" && !!x.trim())?.trim()
const first = <T,>(type: string, ...xs: unknown[]) => xs.find((x) => typeof x === type) as T | undefined

/** Weeks starting on `start` (a day's name, else this machine's locale's), week 1 as moment's locales have it: ISO's
 *  where weeks start on Monday, else the week of January 1st. */
export function weeksOf(start: unknown): Weeks {
  const i = DAYS.indexOf(String(start).toLowerCase())
  // (getWeekInfo is Node's, not yet in TypeScript's lib)
  const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number } }
  const day = i >= 0 ? i : (locale.getWeekInfo?.().firstDay ?? 1) % 7
  return { start: day, jan: day === 1 ? 4 : 1 }
}

/** The settings in effect: this plugin's, else where an Obsidian vault keeps its notes (Periodic Notes 0.x or 1.x, Daily
 *  notes). Only where notes go falls back: a declared default can't (choosing it removes the key). */
export function config(own: Obj = plugin.settings({}), obsidian: (p: string) => Obj = json, dailyHome = home()): Config {
  const pn = obsidian(".obsidian/plugins/periodic-notes/data.json")
  const set: Obj = pn.calendarSets?.find((s: Obj) => s.id === pn.activeCalendarSet) ?? pn
  const theirs = (p: Period): Obj =>
    [set[p], set[NAMES[p]], p === "day" && { ...obsidian(".obsidian/daily-notes.json"), enabled: true }].find((x) => x?.enabled) ?? {}
  const periods = Object.fromEntries(PERIODS.map((p) => {
    const t = theirs(p), name = NAMES[p], at = (k: string) => own[`${name}${k}`]
    return [p, {
      on: p === "day" || (first<boolean>("boolean", own[name]) ?? !!t.enabled),
      folder: (text(at("Folder"), t.folder) ?? (p === "day" ? dailyHome : name[0].toUpperCase() + name.slice(1))).replace(/^\/+|\/+$/g, ""),
      format: filled(at("Format"), t.format) ?? FORMATS[p],
      template: filled(at("Template"), t.template ?? t.templatePath) ?? "",
    }]
  })) as Record<Period, Spec>
  return { periods, weeks: weeksOf(own.weekStart ?? "monday"), confirm: own.confirmCreate !== false, weekNumbers: own.weekNumbers === true,
    wordsPerDot: Math.max(1, first<number>("number", own.wordsPerDot) ?? 250) }
}

/** Where the vault's daily notes are (the Today plugin's `type: day`), else Daily. */
const home = () => (v().has("days") && v().home("days")) || "Daily"

/** The note of the period starting on `start`. */
export const pathOf = (s: Spec, start: Date, w: Weeks) => `${s.folder ? `${s.folder}/` : ""}${formatDate(start, s.format, w)}.md`

/** A template's {{title}}, {{date}}, {{time}}, {{yesterday}}, {{tomorrow}} and {{monday}}…{{sunday}} (that day of the
 *  note's week), each with an optional `:format`, filled for the note's date as Obsidian's Daily notes and Periodic
 *  Notes do: {{date}} and its neighbours in the note's own format, weekdays as YYYY-MM-DD, {{time}} as HH:mm (now). */
export function fillTemplate(text: string, date: Date, fmt: string, title: string, w: Weeks, now = new Date()) {
  return text.replace(/\{\{\s*(title|date|time|yesterday|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*(?::(.*?))?\s*\}\}/gi,
    (_m, name: string, f?: string) => {
      const n = name.toLowerCase(), day = DAYS.indexOf(n)
      if (n === "title") return title
      if (n === "time") return formatDate(now, f || "HH:mm", w)
      const d = day >= 0 ? addDays(weekOf(date, w), (day - w.start + 7) % 7) : addDays(date, n === "yesterday" ? -1 : n === "tomorrow" ? 1 : 0)
      return formatDate(d, f || (day >= 0 ? "YYYY-MM-DD" : fmt), w)
    })
}

const iso = (d: Date) => formatDate(d, "YYYY-MM-DD")
const day = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d || 1) }

plugin.route("GET", "periodic-notes", () => config())

/** A month as the calendar draws it: its weeks (with their notes), each day's note as dots (its length) and open tasks. */
plugin.route("GET", "periodic-notes/month", (req: Request) => {
  const c = config(), month = /^\d{4}-\d\d/.exec(req.query.month ?? "")?.[0] ?? iso(new Date()).slice(0, 7), start = day(month)
  const note = (p: Period, d: Date) => {
    if (!c.periods[p].on) return null
    const path = pathOf(c.periods[p], d, c.weeks)
    return { path, exists: v().entries.has(path) }
  }
  const weeks = []
  for (let w = weekOf(start, c.weeks); w.getMonth() === start.getMonth() || w < start; w = addDays(w, 7)) {
    weeks.push({
      n: Number(formatDate(w, "w", c.weeks)), date: iso(w), note: note("week", w),
      days: [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const d = addDays(w, i), n = note("day", d), body = n?.exists ? v().entries.get(n.path)?.body ?? "" : ""
        const words = body.match(/\S+/g)?.length ?? 0
        return { date: iso(d), note: n, words, dots: n?.exists ? Math.min(5, Math.max(1, Math.floor(words / c.wordsPerDot))) : 0,
          open: body.match(/^[ \t]*(?:[-*+]|\d+[.)]) \[ \]/gm)?.length ?? 0 }
      }),
    })
  }
  return { month, today: iso(new Date()), weekNumbers: c.weekNumbers, weeks,
    monthNote: note("month", start), quarterNote: note("quarter", startOf("quarter", start, c.weeks)), yearNote: note("year", startOf("year", start, c.weeks)) }
})

/** A template named as Obsidian or the settings do ("Templates/Daily", "Daily"): its path. */
async function templatePath(name: string) {
  const n = name.replace(/^\/+/, "").replace(/\.md$/i, ""), dir = await plugin.ask("templates:folder", "Templates")
  return [`${n}.md`, `${dir}/${n}.md`].find((p) => v().entries.has(p)) ?? null
}

/** The note of the period holding `date`, `offset` periods away; made from its template when `create` and it's new. */
async function periodNote(period: Period, date: Date, offset: number, create: boolean, api: (m: string, r: string, b: unknown) => Promise<Obj>) {
  const c = config(), s = c.periods[period], start = shift(period, startOf(period, date, c.weeks), offset)
  if (!s.on) throw new OpError(`${NAMES[period][0].toUpperCase()}${NAMES[period].slice(1)} notes are off: turn them on in the Periodic notes settings (${NAMES[period]})`)
  const path = pathOf(s, start, c.weeks), out = { path, period, date: iso(start), exists: v().entries.has(path), created: false }
  if (out.exists || !create) return out
  const title = path.slice(path.lastIndexOf("/") + 1, -3)
  // A daily note named by its date is the app's own (`type: day`: Today's routines tick in it).
  const own = period === "day" && /^\d{4}-\d\d-\d\d$/.test(title) ? "---\ntype: day\n---\n" : ""
  let note = own && `${own}\n`, at = path
  if (s.template) {
    const t = await templatePath(s.template)
    if (!t) throw new OpError(`There's no template ${s.template}: fix ${NAMES[period]}Template in the Periodic notes settings`)
    const body = fillTemplate(await fs.promises.readFile(v().abs(t), "utf8"), start, s.format, title, c.weeks)
    note = plugin.peer("templates")?.exports.fill?.(body, title, own) ?? own + body
    const r = await plugin.ask("template:expand", { text: note, path }, { text: note, template: t, path, mode: "new" })
    if (!r) throw new OpError("Cancelled: the template's questions weren't answered")
    note = r.text; at = r.path || path
  }
  try {
    await api("POST", "file", { path: at, text: note })
  } catch (e) {
    if (!(e instanceof OpError && e.status === 409)) throw e // (made meanwhile: it's there now)
  }
  return { ...out, path: at, exists: true, created: true }
}

plugin.op({
  id: "periodic-notes.note",
  cli: "calendar note",
  mcp: true,
  summary: "A periodic note's path (today's daily note, this week's...), made from its template when it isn't there yet.",
  help: `Gets the daily, weekly, monthly, quarterly or yearly note of a date (default today), or one \`offset\` periods away,
where the Periodic notes settings put it (its folder and name format), and makes it from its template if it doesn't
exist (\`create: false\` only says where it is and whether it exists). Answers its path: read or edit it with the file ops.

  vau calendar note today
  vau calendar note week --offset -1
  vau calendar note day --date 2026-10-12 --create false`,
  kind: "write",
  lock: false,
  params: {
    period: { type: "string", enum: ["today", ...PERIODS], description: "which note: today (today's daily note), day, week, month, quarter or year (default today)" },
    offset: { type: "integer", description: "periods away: -1 the one before (yesterday's, last week's), 1 the next" },
    date: { type: "string", format: "date", description: "a day in the period (default today)" },
    create: { type: "boolean", description: "make it when it isn't there (default true)" },
  },
  args: ["period"],
  run: async (p, ctx) => periodNote(p.period && p.period !== "today" ? p.period : "day", p.date ? day(p.date) : new Date(), p.offset ?? 0,
    p.create !== false, ctx.api),
  text: (r) => r.path + (r.created ? " (made)" : r.exists ? "" : " (not there yet)"),
})
