// The charts the blocks draw: stacked bars per month and a donut. Drawn with the app's colours (CSS variables), so they
// follow its scheme and light or dark; hovering (or tapping) a bar or slice picks it, and the block shows its numbers.
import type { ReactNode } from "react"
import { cn } from "@vaultite"

export type Seg = { key: string; value: number; color: string }
export type Column = { label: string; name: string; stacks: Seg[][] }

/** A round step for the axis: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

/** Columns of one or more stacks each (income beside spending), on an axis of amounts (`format`: "$1.2K"); a column's
 *  label shows as given ("" for none). `active` is the column picked. */
export function StackedBars({ columns, active, onPick, format, height = 168 }: {
  columns: Column[]; active: number | null; onPick: (i: number | null) => void; format: (n: number) => string; height?: number
}) {
  const max = Math.max(1, ...columns.flatMap((c) => c.stacks.map((s) => s.reduce((a, x) => a + Math.max(0, x.value), 0))))
  const step = niceStep(max / 3)
  const top = Math.ceil(max / step) * step
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  const y = (v: number) => (v / top) * height
  return (
    <div className="flex gap-2">
      <div className="num relative w-9 shrink-0 text-right text-[11px] text-muted-foreground" style={{ height }} aria-hidden>
        {ticks.map((v) => <span key={v} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: y(v) }}>{format(v)}</span>)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => onPick(null)}>
          {ticks.map((v) => (
            <div key={v} className={cn("pointer-events-none absolute inset-x-0 border-t", v ? "border-border/50 border-dashed" : "border-border")}
              style={{ bottom: y(v) }} />
          ))}
          {columns.map((c, i) => (
            <button key={c.name} type="button" aria-label={c.name}
              className="relative flex h-full min-w-0 flex-1 cursor-default items-end gap-px transition-opacity"
              style={{ opacity: active === null || active === i ? 1 : 0.4 }}
              onMouseEnter={() => onPick(i)} onFocus={() => onPick(i)} onClick={() => onPick(i)}>
              {c.stacks.map((segs, j) => (
                <span key={j} className="flex min-w-0 flex-1 flex-col-reverse gap-px">
                  {segs.filter((s) => s.value > 0).map((s) => (
                    <span key={s.key} className="w-full shrink-0 last:rounded-t-[3px]" style={{ height: y(s.value), background: s.color }} />
                  ))}
                </span>
              ))}
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex gap-[3px] text-[11px] text-muted-foreground">
          {columns.map((c, i) => (
            <span key={c.name} className={cn("min-w-0 flex-1 overflow-visible text-center whitespace-nowrap", active === i && "text-foreground")}>
              {c.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The line above a chart: the picked column's numbers (the latest when none is). Always the same height. */
export function Readout({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-3 min-h-[38px]">
      <div className="truncate text-[13px] text-muted-foreground">{children}</div>
      <div className="mt-0.5 flex h-[18px] flex-wrap gap-x-3 overflow-hidden text-[12px] text-muted-foreground">{sub}</div>
    </div>
  )
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ background: color }} />
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-muted-foreground">
      {items.map((it) => <span key={it.label} className="inline-flex items-center gap-1.5"><Dot color={it.color} />{it.label}</span>)}
    </div>
  )
}

/** A ring of slices; `active` is the one picked (the others fade), `center` what's in the hole. */
export function Donut({ slices, active, onPick, center, size = 176 }: {
  slices: { key: string; value: number; color: string }[]; active: string | null; onPick: (key: string | null) => void
  center: ReactNode; size?: number
}) {
  const stroke = 22, r = size / 2 - stroke / 2 - 3, c = 2 * Math.PI * r
  const total = slices.reduce((a, s) => a + s.value, 0) || 1
  let at = 0
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} onMouseLeave={() => onPick(null)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        {slices.map((s) => {
          const len = (s.value / total) * c, gap = len > 4 ? 2 : 0
          const el = (
            <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color}
              strokeWidth={active === s.key ? stroke + 6 : stroke} strokeDasharray={`${Math.max(0, len - gap)} ${c}`} strokeDashoffset={-at}
              className="cursor-default transition-[stroke-width,opacity] duration-150"
              style={{ opacity: active === null || active === s.key ? 1 : 0.35 }}
              onMouseEnter={() => onPick(s.key)} onClick={() => onPick(s.key)} />
          )
          at += len
          return el
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">{center}</div>
    </div>
  )
}
