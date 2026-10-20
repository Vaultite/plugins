// Health's pictures, drawn as the Health app draws them: a night's stages over time, the sleep score's ring, the
// Activity rings and a trend line.
import type { ReactNode } from "react"
import { fmtMin } from "@vaultite"
import { runsOf, type Stage } from "./sleep"

// Health's own colours, not the theme's: what each stage and ring is, on any scheme.
export const STAGE: Record<Stage, { label: string; color: string }> = {
  A: { label: "Awake", color: "#ff7f6e" }, R: { label: "REM", color: "#3bc9f5" }, C: { label: "Core", color: "#1e7bf2" },
  D: { label: "Deep", color: "#5e35c7" }, S: { label: "Asleep", color: "#1e7bf2" }, "-": { label: "", color: "transparent" },
}
export const RING = { move: "#fa114f", exercise: "#7ed321", stand: "#00c7e6" }

const clockAt = (bed: string, after: number) => {
  const [h, m] = bed.split(":").map(Number)
  const t = (h * 60 + m + after) % 1440
  return { h: Math.floor(t / 60), m: t % 60 }
}

/** A night's stages, a row each (awake on top, deep at the bottom), from bedtime to waking. */
export function Hypnogram({ timeline, bed, wake }: { timeline: unknown; bed?: unknown; wake?: unknown }) {
  const runs = runsOf(timeline)
  const total = runs.reduce((n, r) => n + r.min, 0)
  if (!total) return null
  const rows: Stage[] = runs.some((r) => "RCD".includes(r.stage)) ? ["A", "R", "C", "D"] : ["A", "S"]
  const row = (s: Stage) => rows.indexOf(s === "S" && rows.length === 4 ? "C" : s)
  const H = 22, start = typeof bed === "string" ? bed : null
  // Hour marks after bedtime, every two hours on a long night.
  const marks: { at: number; text: string }[] = []
  if (start) {
    const first = 60 - clockAt(start, 0).m
    for (let at = first; at < total; at += 60) {
      const { h } = clockAt(start, at)
      if (h % (total > 360 ? 2 : 1) === 0 && at / total > 0.18 && at / total < 0.85) marks.push({ at, text: String(h).padStart(2, "0") })
    }
  }
  const asleep = runs.filter((r) => r.stage !== "-")
  return (
    <div className="mb-4 flex gap-2" aria-label="Sleep stages">
      <div className="flex shrink-0 flex-col text-[11px] text-muted-foreground">
        {rows.map((s) => <div key={s} className="flex items-center" style={{ height: H }}>{STAGE[s].label}</div>)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height: H * rows.length }}>
          {rows.map((s, i) => <div key={s} className="absolute inset-x-0 border-t border-foreground/[0.06]" style={{ top: i * H + H / 2 }} />)}
          {asleep.map((r, i) => {
            const next = asleep[i + 1]
            const y = row(r.stage) * H
            return (
              <div key={i}>
                <div className="absolute rounded-[3px]" title={`${STAGE[r.stage].label} ${fmtMin(r.min)}`}
                  style={{ left: `${(r.from / total) * 100}%`, width: `max(2px, ${(r.min / total) * 100}%)`, top: y + 4, height: H - 8, background: STAGE[r.stage].color }} />
                {next && next.from === r.from + r.min && row(next.stage) !== row(r.stage) && (
                  <div className="absolute w-px bg-foreground/20" style={{ left: `${((r.from + r.min) / total) * 100}%`,
                    top: Math.min(y, row(next.stage) * H) + H / 2, height: Math.abs(row(next.stage) * H - y) }} />
                )}
              </div>
            )
          })}
        </div>
        <div className="relative mt-1 h-4 text-[11px] text-muted-foreground tabular-nums">
          {start && <span className="absolute left-0">{start}</span>}
          {marks.map((m) => <span key={m.at} className="absolute -translate-x-1/2" style={{ left: `${(m.at / total) * 100}%` }}>{m.text}</span>)}
          {typeof wake === "string" && <span className="absolute right-0">{wake}</span>}
        </div>
      </div>
    </div>
  )
}

/** A score out of 100 as a ring, its number inside. */
export function ScoreRing({ value, label, color = "#3bc9f5", size = 72 }: { value: number; label: string; color?: string; size?: number }) {
  const r = size / 2 - 5, c = 2 * Math.PI * r
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={7} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={7} strokeLinecap="round"
            strokeDasharray={`${(c * Math.min(100, value)) / 100} ${c}`} className="transition-[stroke-dasharray] duration-500" />
        </svg>
        <div className="num absolute inset-0 flex items-center justify-center text-[22px] font-semibold">{value}</div>
      </div>
      <div className="text-[12px] text-muted-foreground">{label}</div>
    </div>
  )
}

export type RingValue = { label: string; value: number; goal: number; unit: string; color: string }

/** The Activity rings: Move outside, then Exercise, then Stand; a ring past its goal goes round again, as Apple's. */
export function Rings({ rings, size = 96 }: { rings: RingValue[]; size?: number }) {
  const w = size / 10
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      {rings.map((g, i) => {
        const r = size / 2 - w / 2 - i * (w + 2), c = 2 * Math.PI * r
        const f = g.goal > 0 ? g.value / g.goal : 0
        return (
          <g key={g.label}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={g.color} strokeOpacity={0.2} strokeWidth={w} />
            {f > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={g.color} strokeWidth={w} strokeLinecap="round"
              strokeDasharray={`${c * Math.min(f, 0.999)} ${c}`} className="transition-[stroke-dasharray] duration-500" />}
            {f > 1 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={g.color} strokeWidth={w} strokeLinecap="round"
              strokeDasharray={`${c * Math.min(f - 1, 0.999)} ${c}`} style={{ filter: "brightness(1.15)" }} />}
          </g>
        )
      })}
    </svg>
  )
}

/** A number and its last weeks as a thin line (oldest left), the range under it. */
export function Trend({ label, unit, values, color }: { label: string; unit: string; values: (number | null)[]; color: string }) {
  const got = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (!got.length) return <TrendBox label={label}>—</TrendBox>
  const lo = Math.min(...got.map((p) => p[1])), hi = Math.max(...got.map((p) => p[1]))
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * 100, y = (v: number) => hi === lo ? 12 : 22 - ((v - lo) / (hi - lo)) * 20
  const last = got[got.length - 1][1]
  return (
    <TrendBox label={label} value={<>{last}<span className="ml-0.5 text-[13px] font-semibold text-muted-foreground">{unit}</span></>}>
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="mt-1 h-6 w-full" aria-hidden>
        <polyline points={got.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="num text-[11px] text-muted-foreground">{lo === hi ? `${lo}` : `${lo}–${hi}`} {unit}</div>
    </TrendBox>
  )
}

function TrendBox({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      {value && <div className="num mt-0.5 text-[22px] leading-[28px] font-semibold">{value}</div>}
      {children}
    </div>
  )
}
