// Health's cards, also on Today: last night's sleep, today's activity and meals.
import { Activity, Apple, Moon } from "lucide-react"
import {
  addDays, Bars, dateText, detailPath, Empty, fmtDay, fmtMin, List, numberText, openDetail, Panel, parse, range, Row, snippet,
  Stat, today, type Store,
} from "@vaultite"
import { logsOf } from "@plugins/logs/types"
import { Hypnogram, RING, Rings, ScoreRing, STAGE, Trend, type RingValue } from "./charts"
import { scoreOf } from "./sleep"

export function SleepPanel({ store, nights = 7 }: { store: Store; nights?: number }) {
  const t = today()
  const logs = logsOf(store, "sleep")
  const i = logs.findIndex((l) => l.date >= addDays(t, -1))
  const last = i >= 0 ? logs[i] : undefined
  const days = range(addDays(t, -(nights - 1)), nights)
  const byDate = new Map(logs.map((l) => [l.date, l]))
  const recent = days.map((d) => byDate.get(d)).filter(Boolean)
  const avg = recent.length ? recent.reduce((n, l) => n + (l!.duration_min || 0), 0) / recent.length : 0
  const score = last ? scoreOf(last, logs.slice(i + 1)) : null
  const d = last?.data ?? {}
  return (
    <Panel title="Sleep" icon={Moon} tint="var(--indigo)">
      {!logs.length ? (
        <Empty>No sleep data yet. Turn on Apple Health in the iPhone app's Settings, or tell Claude how you slept.</Empty>
      ) : (
        <>
          <div className="mb-4 flex items-start gap-5">
            {score && <ScoreRing value={score.total} label={score.label} />}
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-4">
              <Stat label={last ? (last.date === t ? "Time asleep" : fmtDay(last.date)) : "Last night"}
                value={last ? fmtMin(last.duration_min || 0) : "—"}
                hint={d.bed && `${d.bed} → ${d.wake}${d.in_bed_min ? `, ${fmtMin(Number(d.in_bed_min))} in bed` : ""}`} />
              <Stat label={`${nights}-night average`} value={avg ? fmtMin(Math.round(avg)) : "—"}
                hint={`${recent.length} of ${nights} nights recorded`} />
            </div>
          </div>
          {last && <Hypnogram timeline={d.timeline} bed={d.bed} wake={d.wake} />}
          {last && <StageTotals data={d} />}
          {score && <p className="num mb-4 text-[12px] text-muted-foreground">
            Score: duration {score.duration} of 50, bedtime {score.bedtime} of 30, interruptions {score.interruptions} of 20
          </p>}
          <Bars color={STAGE.R.color} height={72} goal={8}
            format={(v) => (v ? fmtMin(Math.round(v * 60)) : "no data")}
            data={days.map((day) => ({
              label: dateText(parse(day), { weekday: "narrow" }),
              tip: fmtDay(day),
              value: (byDate.get(day)?.duration_min || 0) / 60,
            }))} />
        </>
      )}
    </Panel>
  )
}

/** Each stage's time and share of the night, as under Health's chart. */
function StageTotals({ data }: { data: Record<string, unknown> }) {
  const parts = ([["A", "awake_min"], ["R", "rem_min"], ["C", "core_min"], ["D", "deep_min"]] as const)
    .map(([s, k]) => ({ ...STAGE[s], min: Number(data[k]) || 0 })).filter((p) => p.min > 0)
  const total = parts.reduce((n, p) => n + p.min, 0)
  if (!total) return null
  return (
    <div className="mb-3 grid grid-cols-4 gap-2">
      {parts.map((p) => (
        <div key={p.label} className="min-w-0">
          <div className="flex items-center gap-1 text-[12px] text-muted-foreground"><span className="inline-block size-2 rounded-full" style={{ background: p.color }} />{p.label}</div>
          <div className="num text-[15px] font-semibold">{fmtMin(p.min)}</div>
          <div className="num text-[11px] text-muted-foreground">{Math.round((p.min / total) * 100)}%</div>
        </div>
      ))}
    </div>
  )
}

/** ```block-activity: today's rings and steps as the phone counted them, a week of steps, and resting heart rate, HRV
 *  and VO2 max over the last month. From the day logs Apple Health writes (area health). */
export function ActivityPanel({ store, days = 7 }: { store: Store; days?: number }) {
  const t = today()
  const logs = logsOf(store, "health").filter((l) => l.data?.steps != null || l.data?.active_kcal != null || l.data?.resting_hr != null)
  const byDate = new Map(logs.map((l) => [l.date, l]))
  const day = byDate.get(t)?.data ?? {}
  const shown = range(addDays(t, -(days - 1)), days)
  const month = range(addDays(t, -29), 30)
  const series = (k: string) => month.map((d) => { const v = byDate.get(d)?.data?.[k]; return typeof v === "number" ? v : null })
  // Without the day's goals (before the rings came in), Apple's defaults.
  const rings: RingValue[] = [
    { label: "Move", value: Number(day.active_kcal) || 0, goal: Number(day.move_goal) || 500, unit: "kcal", color: RING.move },
    { label: "Exercise", value: Number(day.exercise_min) || 0, goal: Number(day.exercise_goal) || 30, unit: "min", color: RING.exercise },
    { label: "Stand", value: Number(day.stand_h) || 0, goal: Number(day.stand_goal) || 12, unit: "h", color: RING.stand },
  ]
  return (
    <Panel title="Activity" icon={Activity} tint="var(--red)">
      {!logs.length ? (
        <Empty>No activity yet. Turn on Apple Health in the iPhone app's Settings.</Empty>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-5">
            <Rings rings={day.stand_h != null ? rings : rings.slice(0, 2)} />
            <div className="grid min-w-0 flex-1 gap-1.5">
              {(day.stand_h != null ? rings : rings.slice(0, 2)).map((r) => (
                <div key={r.label} className="num text-[15px]">
                  <span className="text-[13px]" style={{ color: r.color }}>{r.label}</span>{" "}
                  <span className="font-semibold">{numberText(Math.round(r.value))}</span>
                  <span className="text-muted-foreground">/{numberText(Math.round(r.goal))} {r.unit}</span>
                </div>
              ))}
              <div className="num text-[15px]"><span className="text-[13px] text-muted-foreground">Steps</span>{" "}
                <span className="font-semibold">{day.steps != null ? numberText(day.steps) : "—"}</span></div>
            </div>
          </div>
          <Bars color={RING.move} height={64} format={(v) => (v ? `${numberText(Math.round(v))} steps` : "no data")}
            data={shown.map((d) => ({ label: dateText(parse(d), { weekday: "narrow" }), tip: fmtDay(d), value: Number(byDate.get(d)?.data?.steps) || 0 }))} />
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Trend label="Resting HR" unit="bpm" values={series("resting_hr")} color="var(--red)" />
            <Trend label="HRV" unit="ms" values={series("hrv_ms")} color="var(--indigo)" />
            <Trend label="VO₂ max" unit="" values={series("vo2max")} color="var(--green)" />
          </div>
        </>
      )}
    </Panel>
  )
}

export function NutritionPanel({ store, date = today() }: { store: Store; date?: string }) {
  const meals = logsOf(store, "nutrition").filter((l) => l.date === date).reverse()
  const sum = (k: string) => meals.reduce((n, l) => n + (Number(l.data?.[k]) || 0), 0)
  return (
    <Panel title="Nutrition" icon={Apple} tint="var(--green)">
      {!meals.length ? (
        <Empty>Nothing logged today. Send Claude a photo of what you eat and it'll log calories and protein.</Empty>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-3 gap-4">
            <Stat label="Calories" value={Math.round(sum("kcal")) || "—"} unit="kcal" />
            <Stat label="Protein" value={Math.round(sum("protein")) || "—"} unit="g" />
            <Stat label="Meals" value={meals.length} />
          </div>
          <List>
            {meals.map((l) => (
              <Row key={l.id} title={l.title || l.data?.meal || "Meal"} meta={l.data?.meal && l.title ? l.data.meal : snippet(l.notes)}
                right={[l.data?.kcal && `${l.data.kcal} kcal`, l.data?.protein && `${l.data.protein} g`].filter(Boolean).join(" · ")}
                onOpen={() => openDetail(detailPath("log", l.id))} />
            ))}
          </List>
        </>
      )}
    </Panel>
  )
}

