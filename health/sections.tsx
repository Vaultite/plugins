// Health's cards, also on Today: last night's sleep, today's activity and meals.
import { Activity, Apple, Moon } from "lucide-react"
import {
  addDays, Bars, dateText, detailPath, Empty, fmtDay, fmtMin, List, numberText, openDetail, Panel, parse, range, Row, snippet,
  Stat, today, type Store,
} from "@vaultite"
import { logsOf } from "@plugins/logs/types"

export function SleepPanel({ store, nights = 7 }: { store: Store; nights?: number }) {
  const t = today()
  const logs = logsOf(store, "sleep")
  const last = logs.find((l) => l.date >= addDays(t, -1))
  const days = range(addDays(t, -(nights - 1)), nights)
  const byDate = new Map(logs.map((l) => [l.date, l]))
  const recent = days.map((d) => byDate.get(d)).filter(Boolean)
  const avg = recent.length ? recent.reduce((n, l) => n + (l!.duration_min || 0), 0) / recent.length : 0
  return (
    <Panel title="Sleep" icon={Moon} tint="var(--indigo)">
      {!logs.length ? (
        <Empty>No sleep data yet. Turn on Apple Health in the iPhone app's Settings, or tell Claude how you slept.</Empty>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4">
            <Stat label={last ? (last.date === t ? "Last night" : fmtDay(last.date)) : "Last night"}
              value={last ? fmtMin(last.duration_min || 0) : "—"}
              hint={last?.data?.bed && `${last.data.bed} → ${last.data.wake}`} />
            <Stat label={`${nights}-night average`} value={avg ? fmtMin(Math.round(avg)) : "—"}
              hint={`${recent.length} of ${nights} nights recorded`} />
          </div>
          {last && <Stages data={last.data ?? {}} />}
          <Bars color="var(--indigo)" height={72} goal={8}
            format={(v) => (v ? fmtMin(Math.round(v * 60)) : "no data")}
            data={days.map((d) => ({
              label: dateText(parse(d), { weekday: "narrow" }),
              tip: fmtDay(d),
              value: (byDate.get(d)?.duration_min || 0) / 60,
            }))} />
        </>
      )}
    </Panel>
  )
}

// A night's stages as the Watch measured them, in the order of a night's chart.
const STAGES = [["deep_min", "Deep", "var(--indigo)"], ["core_min", "Core", "var(--blue)"], ["rem_min", "REM", "var(--teal)"], ["awake_min", "Awake", "var(--orange)"]] as const

function Stages({ data }: { data: Record<string, unknown> }) {
  const parts = STAGES.map(([k, label, color]) => ({ label, color, min: Number(data[k]) || 0 })).filter((p) => p.min > 0)
  const total = parts.reduce((n, p) => n + p.min, 0)
  if (!total) return null
  return (
    <div className="mb-4">
      <div className="flex h-2 overflow-hidden rounded-full">
        {parts.map((p) => <div key={p.label} style={{ width: `${(p.min / total) * 100}%`, background: p.color }} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[13px] text-muted-foreground">
        {parts.map((p) => <span key={p.label} className="num"><span className="mr-1 inline-block size-2 rounded-full" style={{ background: p.color }} />{p.label} {fmtMin(p.min)}</span>)}
      </div>
    </div>
  )
}

/** ```block-activity: today's steps, energy and exercise as the phone counted them, the latest heart numbers, a week of
 *  steps. From the day logs Apple Health writes (area health). */
export function ActivityPanel({ store, days = 7 }: { store: Store; days?: number }) {
  const t = today()
  const logs = logsOf(store, "health").filter((l) => l.data?.steps != null || l.data?.active_kcal != null || l.data?.resting_hr != null)
  const byDate = new Map(logs.map((l) => [l.date, l]))
  const day = byDate.get(t)?.data ?? {}
  const latest = (k: string) => logs.find((l) => l.data?.[k] != null)?.data?.[k] as number | undefined
  const shown = range(addDays(t, -(days - 1)), days)
  return (
    <Panel title="Activity" icon={Activity} tint="var(--red)">
      {!logs.length ? (
        <Empty>No activity yet. Turn on Apple Health in the iPhone app's Settings.</Empty>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-4">
            <Stat label="Steps" value={day.steps != null ? numberText(day.steps) : "—"} />
            <Stat label="Move" value={day.active_kcal ?? "—"} unit={day.active_kcal != null ? "kcal" : undefined} />
            <Stat label="Exercise" value={day.exercise_min ?? "—"} unit={day.exercise_min != null ? "min" : undefined} />
          </div>
          <Bars color="var(--red)" height={64} format={(v) => (v ? `${numberText(Math.round(v))} steps` : "no data")}
            data={shown.map((d) => ({ label: dateText(parse(d), { weekday: "narrow" }), tip: fmtDay(d), value: Number(byDate.get(d)?.data?.steps) || 0 }))} />
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Stat label="Resting" value={latest("resting_hr") ?? "—"} unit={latest("resting_hr") ? "bpm" : undefined} />
            <Stat label="HRV" value={latest("hrv_ms") ?? "—"} unit={latest("hrv_ms") ? "ms" : undefined} />
            <Stat label="VO₂ max" value={latest("vo2max") ?? "—"} hint={latest("weight_kg") ? `${latest("weight_kg")} kg` : undefined} />
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

