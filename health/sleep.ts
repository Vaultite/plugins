// A night read from its sleep log: its stages in order (`timeline`, Apple Health writes it) and a score out of 100 made
// the way Apple's is: duration up to 50, bedtime against your usual up to 30, interruptions up to 20. No Node: both sides.

export type Stage = "A" | "R" | "C" | "D" | "S" | "-"
/** A run of one stage: `from` minutes after bedtime, `min` long. */
export type Run = { stage: Stage; from: number; min: number }
type Night = { duration_min?: number | null; data?: Record<string, unknown> | null }

export function runsOf(timeline: unknown): Run[] {
  if (typeof timeline !== "string") return []
  const out: Run[] = []
  let at = 0
  for (const tok of timeline.trim().split(/\s+/)) {
    const m = /^([ARCDS-])(\d+)$/.exec(tok)
    if (!m) continue
    out.push({ stage: m[1] as Stage, from: at, min: Number(m[2]) })
    at += Number(m[2])
  }
  return out
}

/** "23:40" -> minutes after noon, so a bedtime either side of midnight compares (22:30 < 00:15). */
export const afterNoon = (hhmm: unknown) => {
  const m = typeof hhmm === "string" ? /^(\d\d):(\d\d)$/.exec(hhmm) : null
  return m ? ((Number(m[1]) + 12) % 24) * 60 + Number(m[2]) : null
}

/** Times awake between sleep (3 min or more), and minutes awake in all. */
export function interruptions(n: Night) {
  const runs = runsOf(n.data?.timeline)
  const asleep = runs.map((r, i) => (r.stage !== "A" && r.stage !== "-" ? i : -1)).filter((i) => i >= 0)
  const inside = asleep.length ? runs.slice(asleep[0], asleep[asleep.length - 1] + 1) : []
  return { wakes: inside.filter((r) => r.stage === "A" && r.min >= 3).length, awake: Number(n.data?.awake_min) || inside.filter((r) => r.stage === "A").reduce((s, r) => s + r.min, 0) }
}

export type Score = { total: number; duration: number; bedtime: number; interruptions: number; label: string }

/** The night's score, `before` the nights before it (newest first) for its usual bedtime; null without time asleep. */
export function scoreOf(n: Night, before: Night[]): Score | null {
  const asleep = Number(n.duration_min) || 0
  if (!asleep) return null
  const clamp = (x: number) => Math.max(0, Math.min(1, x))
  const duration = 50 * clamp(asleep / 480)
  const bed = afterNoon(n.data?.bed)
  const usual = before.slice(0, 14).map((b) => afterNoon(b.data?.bed)).filter((x): x is number => x !== null).sort((a, b) => a - b)
  const median = usual.length ? usual[Math.floor(usual.length / 2)] : bed
  const bedtime = bed === null || median === null ? 15 : 30 * clamp(1 - (Math.abs(bed - median) - 30) / 90)
  const { wakes, awake } = interruptions(n)
  const inter = 20 * clamp(1 - awake / 120 - wakes / 30)
  const total = Math.round(duration + bedtime + inter)
  const label = total >= 96 ? "Excellent" : total >= 81 ? "High" : total >= 61 ? "OK" : total >= 41 ? "Low" : "Very low"
  return { total, duration: Math.round(duration), bedtime: Math.round(bedtime), interruptions: Math.round(inter), label }
}
