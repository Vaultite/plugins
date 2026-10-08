// A Hevy CSV export (Settings > Export data) into workout logs (`vau hevy import <workouts.csv>`), into the area
// asked else the one earlier imports used; keyed on start time + title, so reruns update in place.
import fs from "node:fs"
import { OpError, Plugin } from "@vaultite/core/plugins.ts"

export const plugin = new Plugin(import.meta.url)

/** The most common of some values, or null. */
function mode(xs: string[]) {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const LB = 0.45359237, MI = 1.609344
// Hevy writes times in the browser's zone, not the workout's: ext_ids keep them as exported (keep this machine's zone), and
// log dates use the op's `tz` (Area/City) when given.
const MAX_MIN = 300 // longer = workout left running; store no duration
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

type Row = Record<string, string>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>

/** RFC 4180 CSV -> rows keyed by the header. */
export function readCsv(text: string): Row[] {
  const rows: string[][] = []
  let row: string[] = [], field = "", quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") { row.push(field); field = "" }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field); rows.push(row); row = []; field = ""
    } else field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const [head, ...body] = rows
  return body.filter((r) => r.length > 1 || r[0]).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])))
}

const num = (s: string | undefined) => (s === "" || s === undefined ? null : Number(s))
const round = (x: number, d: number) => Number(x.toFixed(d))
/** Python's round(): halves go to the even number. */
const roundInt = (x: number) => (Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x))
const pad = (n: number) => String(n).padStart(2, "0")

/** Export times are rendered in the browser's zone (this machine's): the time as exported, and its date in TZ. */
function parseTime(s: string, tz: string | null): { at: Date; exported: string; date: string } {
  const m = /^(\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/.exec(s.trim())
  if (!m) throw new Error(`can't read the time '${s}'`)
  const h = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0)
  const at = new Date(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2]), h, Number(m[5]))
  const exported = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
  const date = tz ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
    : exported.slice(0, 10)
  return { at, exported, date }
}

export function toLogs(rows: Row[], area = "workouts", tz: string | null = null) {
  const workouts = new Map<string, Row[]>()
  for (const r of rows) {
    const k = JSON.stringify([r.start_time, r.title])
    workouts.set(k, [...(workouts.get(k) ?? []), r])
  }
  const logs: Item[] = []
  for (const [k, rs] of workouts) {
    const [start, title] = JSON.parse(k) as [string, string]
    const t0 = parseTime(start, tz), t1 = parseTime(rs[0].end_time, tz)
    const exercises = new Map<string, Item>()
    let volume = 0, sets = 0
    for (const r of rs) {
      const s: Item = { type: r.set_type }
      const w = num(r.weight_lbs), reps = num(r.reps), rpe = num(r.rpe), dist = num(r.distance_miles), dur = num(r.duration_seconds)
      if (w !== null) s.weight_kg = round(w * LB, 2)
      if (reps !== null) s.reps = Math.trunc(reps)
      if (rpe !== null) s.rpe = rpe
      if (dist !== null) s.distance_km = round(dist * MI, 3)
      if (dur) s.duration_s = Math.trunc(dur)
      const ex = exercises.get(r.exercise_title) ?? { name: r.exercise_title, sets: [] }
      exercises.set(r.exercise_title, ex)
      if (r.exercise_notes) ex.notes = r.exercise_notes
      ex.sets.push(s)
      if (r.set_type !== "warmup") { // working sets only
        sets++
        volume += (s.weight_kg ?? 0) * (s.reps ?? 0)
      }
    }
    const minutes = Math.round((+t1.at - +t0.at) / 60000)
    logs.push({
      area, date: t0.date,
      duration_min: minutes <= MAX_MIN ? minutes : null, // forgot to end it in Hevy
      title, notes: rs[0].description,
      data: { kind: "Strength", exercises: [...exercises.values()], volume_kg: roundInt(volume), sets },
      source: "hevy", ext_id: `${t0.exported} ${title}`,
    })
  }
  return logs
}

type State = { areas: { slug: string; fields: { key: string }[] }[]; logs: { area: string; source?: string }[] }

plugin.op({
  id: "hevy.import",
  summary: "Import workouts from a Hevy CSV export (Settings > Export data) into workout logs; reruns update in place.",
  kind: "write",
  lock: false,
  owner: "files on this machine",
  params: {
    file: { type: "string", required: true, description: "the export's path on the server's machine (workouts.csv)" },
    area: { type: "string", description: "the logs' area (default: the one earlier imports used, else one with exercises)" },
    tz: { type: "string", description: "the zone for log dates, Area/City (default: this machine's)" },
  },
  args: ["file"],
  cli: "hevy import",
  mcp: true,
  run: async (p: { file: string; area?: string; tz?: string }, ctx) => {
    let text: string
    try { text = fs.readFileSync(p.file, "utf8").replace(/^\uFEFF/, "") } catch { throw new OpError(`can't read ${p.file}: give the export's full path`) }
    const state = await ctx.api("GET", "state") as State
    const before = state.logs.filter((l) => l.source === "hevy").map((l) => l.area)
    const area = p.area || mode(before) || state.areas.find((a) => a.fields.some((f) => f.key === "exercises"))?.slug || "workouts"
    const logs = toLogs(readCsv(text), area, p.tz || null)
    const dates = logs.map((l) => l.date).sort()
    const { upserted } = logs.length ? await ctx.api("POST", "logs", logs) as { upserted: number } : { upserted: 0 }
    return { workouts: logs.length, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, area, upserted }
  },
  text: (r) => `${r.workouts} workouts${r.from ? ` ${r.from}..${r.to}` : ""} in ${r.area}; upserted ${r.upserted}`,
})
