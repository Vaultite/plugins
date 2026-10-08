// Sleep and workouts from an Apple Health export (iPhone: Health > profile > Export All Health Data), streamed:
// `vau apple-health import <export.zip|export.xml> --skip strength,walking`; reruns update in place.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import type { Readable } from "node:stream"
import sax from "sax"
import { OpError, Plugin } from "@vaultite/core/plugins.ts"

export const plugin = new Plugin(import.meta.url)

const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis"
const ASLEEP = "HKCategoryValueSleepAnalysisAsleep" // prefix: Asleep, AsleepCore/Deep/REM/Unspecified
const IN_BED = "HKCategoryValueSleepAnalysisInBed"
const GAP = 3 * 3600 * 1000
const UNIT_MIN: Record<string, number> = { min: 1, s: 1 / 60, hr: 60 }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>
/** A time as Health writes it ("2026-09-26 23:10:00 -0700"): the instant, and the local time where it happened. */
type Stamp = { ms: number; local: string; offset: string }
type Sample = [Stamp, Stamp, string]

function ts(s: string): Stamp {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([-+])(\d\d)(\d\d)$/.exec(s)
  if (!m) throw new Error(`can't read the time '${s}'`)
  return { ms: Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`), local: `${m[1]} ${m[2]}`, offset: `${m[3]}${m[4]}${m[5]}` }
}

/** The export's XML as a stream (from inside the zip, without unpacking it). */
function openXml(file: string): Readable {
  if (!file.endsWith(".zip")) return fs.createReadStream(file)
  const names = execFileSync("/usr/bin/unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")
  const name = names.find((n) => n.endsWith("/export.xml") || n === "export.xml")
  if (!name) throw new Error("no export.xml in the zip")
  return spawn("/usr/bin/unzip", ["-p", file, name], { stdio: ["ignore", "pipe", "inherit"] }).stdout
}

function unionMin(intervals: [Stamp, Stamp][]) {
  let total = 0, end: number | null = null
  for (const [a, b] of [...intervals].sort((x, y) => x[0].ms - y[0].ms || x[1].ms - y[1].ms)) {
    if (end === null || a.ms > end) { total += b.ms - a.ms; end = b.ms }
    else if (b.ms > end) { total += b.ms - end; end = b.ms }
  }
  return Math.round(total / 60000)
}

/** Sleep samples and workouts (with their metadata and statistics) from a streamed export. */
function parse(stream: Readable): Promise<{ sleep: Sample[]; workouts: Item[] }> {
  return new Promise((resolve, reject) => {
    const sleep: Sample[] = [], workouts: Item[] = []
    const p = sax.createStream(true, {})
    let depth = 0
    let w: Item | null = null
    p.on("opentag", (el) => {
      depth++
      const a = el.attributes as Record<string, string>
      if (depth === 2 && el.name === "Record" && a.type === SLEEP) sleep.push([ts(a.startDate), ts(a.endDate), a.value ?? ""])
      else if (depth === 2 && el.name === "Workout") w = { ...a, meta: {} as Record<string, string>, stats: [] as Item[] }
      else if (w && el.name === "MetadataEntry") w.meta[a.key] = a.value
      else if (w && el.name === "WorkoutStatistics") w.stats.push(a)
    })
    p.on("closetag", () => {
      if (depth === 2 && w) { workouts.push(w); w = null }
      depth--
    })
    p.on("error", reject)
    p.on("end", () => resolve({ sleep, workouts }))
    stream.pipe(p)
  })
}

/** Samples of every source clustered into sessions (gaps under 3 h), one log per wake date (the longest: naps lose to
 *  the night): asleep = the union of Asleep* intervals, in bed = InBed's, else first to last; times local to the phone. */
function sleepLogs(samples: Sample[]) {
  const sorted = [...samples].sort((x, y) => x[0].ms - y[0].ms || x[1].ms - y[1].ms || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0))
  const sessions: Sample[][] = []
  let cur: Sample[] = [], curEnd = 0
  for (const s of sorted) {
    if (cur.length && s[0].ms - curEnd > GAP) { sessions.push(cur); cur = [] }
    curEnd = cur.length ? Math.max(curEnd, s[1].ms) : s[1].ms
    cur.push(s)
  }
  if (cur.length) sessions.push(cur)
  const nights = new Map<string, Item>()
  for (const ss of sessions) {
    const asleep = unionMin(ss.filter(([, , v]) => v.startsWith(ASLEEP)).map(([a, b]) => [a, b]))
    if (!asleep) continue
    const bed = ss[0][0]
    const wake = ss.reduce((m, [, b]) => (b.ms > m.ms ? b : m), ss[0][1])
    const inBed = unionMin(ss.filter(([, , v]) => v === IN_BED).map(([a, b]) => [a, b])) || Math.round((wake.ms - bed.ms) / 60000)
    const day = wake.local.slice(0, 10)
    if (!nights.has(day) || asleep > nights.get(day)!.duration_min) {
      nights.set(day, { area: "sleep", date: day, duration_min: asleep, title: "Sleep", notes: "",
        data: { bed: bed.local.slice(11, 16), wake: wake.local.slice(11, 16), in_bed_min: inBed },
        source: "apple-health", ext_id: `sleep ${day}` })
    }
  }
  return [...nights.values()]
}

/** A workout type's words ("TraditionalStrengthTraining" -> "Traditional strength training") and its area's slug. */
function kindOf(type: string) {
  const name = type.replace(/^HKWorkoutActivityType/, "")
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  return { label: words[0].toUpperCase() + words.slice(1), slug: /strength/i.test(name) ? "strength" : words.replaceAll(" ", "-") }
}

function workoutLog(w: Item, area: string, kind: { label: string; slug: string }) {
  const start = ts(w.startDate), end = ts(w.endDate)
  const minutes = w.duration ? Number(w.duration) * (UNIT_MIN[w.durationUnit] ?? 1) : (end.ms - start.ms) / 60000
  const data: Item = { kind: kind.label }
  if ("HKIndoorWorkout" in w.meta) data.style = w.meta.HKIndoorWorkout === "1" ? "indoor" : "outdoor"
  for (const st of w.stats) {
    if (st.type === "HKQuantityTypeIdentifierActiveEnergyBurned" && st.sum) data.kcal = Math.round(Number(st.sum))
  }
  // (climbs keep the ext_id they had when they were the only kind imported)
  const id = `${kind.slug === "climbing" ? "climb" : `workout ${kind.slug}`} ${start.local.replace(" ", "T")}${start.offset}`
  return { area, date: start.local.slice(0, 10), duration_min: Math.round(minutes), title: kind.label, notes: "",
    data, source: "apple-health", ext_id: id }
}

plugin.op({
  id: "apple-health.import",
  summary: "Import sleep and workouts from an Apple Health export into logs; reruns update in place.",
  kind: "write",
  lock: false,
  owner: "files on this machine",
  params: {
    file: { type: "string", required: true, description: "the export's path on the server's machine (export.zip or export.xml)" },
    skip: { type: "array", items: { type: "string" }, description: "workout kinds to leave out (strength when Hevy brings those)" },
  },
  args: ["file"],
  cli: "apple-health import",
  mcp: true,
  run: async (p: { file: string; skip?: string[] }, ctx) => {
    if (!fs.existsSync(p.file)) throw new OpError(`no file ${p.file}: give the export's full path`)
    const skip = new Set(p.skip ?? [])
    const areas = new Set((await ctx.api("GET", "state") as { areas: { slug: string }[] }).areas.map((a) => a.slug))
    const { sleep, workouts } = await parse(openXml(p.file))
    const done: Item[] = [], skipped: Record<string, number> = {}
    for (const w of workouts) {
      const kind = kindOf(String(w.workoutActivityType ?? "Other"))
      const area = skip.has(kind.slug) ? null : areas.has(kind.slug) ? kind.slug : areas.has("workouts") ? "workouts" : null
      if (area) done.push(workoutLog(w, area, kind))
      else skipped[kind.slug] = (skipped[kind.slug] ?? 0) + 1
    }
    const logs = [...(areas.has("sleep") ? sleepLogs(sleep) : []), ...done]
    const span = (ls: Item[]) => { const d = ls.map((l) => l.date).sort(); return d.length ? `${d[0]}..${d[d.length - 1]}` : "" }
    const { upserted } = logs.length ? await ctx.api("POST", "logs", logs) as { upserted: number } : { upserted: 0 }
    return { sleep: logs.length - done.length, workouts: done.length, sleepSpan: span(logs.filter((l) => l.area === "sleep")), workoutSpan: span(done), skipped, upserted }
  },
  text: (r) => [`${r.sleep} sleep nights ${r.sleepSpan}`.trim(), `${r.workouts} workouts ${r.workoutSpan}`.trim(),
    ...(Object.keys(r.skipped).length ? [`skipped workouts: ${Object.entries(r.skipped).map(([k, n]) => `${k} ${n}`).join(", ")}`] : []), `upserted ${r.upserted}`].join("\n"),
})
