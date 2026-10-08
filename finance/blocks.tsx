// The Spending blocks. They share one reading of the CSV (asked again when it changes) and one filter, the range and
// account picked in the `spending` block, kept per device; a block with its own `range` or `account` option keeps those.
import { useState, useSyncExternalStore, type ReactNode } from "react"
import { CalendarRange, ChartColumnStacked, ChartPie, Receipt, Repeat, Scale, Store, Wallet, type LucideIcon } from "lucide-react"
import {
  type BlockCtx, cn, Empty, fmtDay, FilterField, List, Loading, Panel, Row, Segmented, Stat, useLive, useScopedState, useVaultChange,
} from "@vaultite"
import {
  active as stillCharging, addMonths, analyze, type Answer, categories, CSV, type Data, type Filter, filtered, merchants, monthly, monthName,
  axisLabels, isIncome, RANGES, rangeLabel, totals,
} from "./spending.ts"
import { type Column, Donut, Dot, Legend, Readout, StackedBars } from "./charts.tsx"

const TINT = "var(--finance)"
const PALETTE = ["var(--blue)", "var(--orange)", "var(--yellow)", "var(--green)", "var(--purple)", "var(--teal)", "var(--indigo)", "var(--red)"]
const INCOME = ["var(--green)", "var(--teal)", "var(--blue)", "var(--indigo)"]
const OTHER = "var(--gray)"
const SPEND = "var(--red)"

/** A category's colour: by its all-time rank, so it's the same in every block and range. */
const colorOf = (d: Data, c: string) => { const i = d.rank.indexOf(c); return i >= 0 && i < PALETTE.length ? PALETTE[i] : OTHER }
const stacked = (d: Data) => d.rank.slice(0, PALETTE.length)
const sourceColor = (d: Data, s: string) => { const i = d.sources.indexOf(s); return i >= 0 && i < INCOME.length ? INCOME[i] : OTHER }
/** Income per month: the biggest categories, the rest as Other. */
const sourcesOf = (d: Data, by: Record<string, number>) => {
  const top = d.sources.slice(0, INCOME.length)
  const rest = Object.entries(by).filter(([c]) => !top.includes(c)).reduce((a, [, v]) => a + v, 0)
  return [...top.map((s) => ({ key: s, value: by[s] ?? 0, color: sourceColor(d, s) })), { key: "Other", value: rest, color: OTHER }]
}

// --- the data: one answer for every block, asked again when the CSV changes (useLive only hears the plugin's folder)

let version = 0, queued = false
const subs = new Set<() => void>()
const bump = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; version++; subs.forEach((f) => f()) }) } }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const analyzed = new WeakMap<Answer, Data>()

function useSpending() {
  const v = useSyncExternalStore(subscribe, () => version)
  const { data: a, error } = useLive<Answer>("finance/data", v)
  useVaultChange(bump, (p) => p === CSV || p.endsWith(`/${CSV}`) || (!!a?.path && (a.path === p || a.path.startsWith(`${p}/`))))
  if (a && !analyzed.has(a)) analyzed.set(a, analyze(a))
  return { data: a ? analyzed.get(a) : undefined, error }
}

const DEFAULT: Filter = { range: "12m", account: "all" }
function useFilter(options: Record<string, unknown>) {
  const [saved, set] = useScopedState<Filter>("finance:filter", DEFAULT, "device")
  const fixed = { range: typeof options.range === "string" ? options.range : null, account: typeof options.account === "string" ? options.account : null }
  const f: Filter = { range: fixed.range ?? saved.range, account: fixed.account ?? saved.account }
  return { f, fixed: !!(fixed.range || fixed.account), set: (p: Partial<Filter>) => set({ ...saved, ...p }) }
}

/** A block's card, with "Loading…" (or why not) until the CSV is read. */
function block(title: string, icon: LucideIcon, Inner: (p: BlockCtx & { d: Data }) => ReactNode) {
  return function Block(ctx: BlockCtx) {
    const { data, error } = useSpending()
    if (!data?.txns.length) return (
      <Panel title={title} icon={icon} tint={TINT}>
        {data ? <Empty>No transactions yet: put a {CSV} in the vault.</Empty> : <Loading error={error && `Couldn't read ${CSV}.`} />}
      </Panel>
    )
    return <Inner {...ctx} d={data} />
  }
}

/** What a block with its own range or account shows instead of the filter. */
const scopeNote = (d: Data, f: Filter) =>
  <span className="text-[13px] font-normal text-muted-foreground">{rangeLabel(d, f.range)}{f.account !== "all" && ` · ${f.account}`}</span>

const field = "h-8 rounded-[8px] border-[0.5px] border-border bg-card px-2 text-[13px] outline-none focus:ring-2 focus:ring-primary/40"

// --- spending: the filter and the totals

function Filters({ d, f, set }: { d: Data; f: Filter; set: (p: Partial<Filter>) => void }) {
  const months: string[] = []
  for (let m = d.last.slice(0, 7); m >= d.first.slice(0, 7); m = addMonths(m, -1)) months.push(m)
  const custom = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(f.range)
  const pick = (from: string, to: string) => {
    if (!from && !to) return set({ range: "12m" })
    const [a, b] = [from || d.first.slice(0, 7), to || d.last.slice(0, 7)].sort()
    set({ range: `${a}:${b}` })
  }
  const monthSelect = (value: string, label: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={cn(field, "num")}>
      <option value="">{label}</option>
      {months.map((m) => <option key={m} value={m}>{monthName(m)}{m === d.last.slice(0, 7) ? " (partial)" : ""}</option>)}
    </select>
  )
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Segmented label="Range" value={custom ? "" : f.range} options={RANGES} onChange={(range) => set({ range })} className="w-full sm:w-auto" />
      <div className="flex items-center gap-1.5">
        {monthSelect(custom?.[1] ?? "", "From", (v) => pick(v, custom?.[2] ?? ""))}
        <span className="text-[13px] text-muted-foreground">to</span>
        {monthSelect(custom?.[2] ?? "", "To", (v) => pick(custom?.[1] ?? "", v))}
      </div>
      <select value={f.account} onChange={(e) => set({ account: e.target.value })} aria-label="Account" className={cn(field, "sm:ml-auto")}>
        <option value="all">All accounts</option>
        {d.accounts.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
    </div>
  )
}

export const SpendingBlock = block("Spending", Wallet, ({ d, options }) => {
  const { f, fixed, set } = useFilter(options)
  const t = totals(d, f)
  const top = categories(d, f)[0]
  const incomeMonths = new Set(filtered(d, f).filter(isIncome).map((x) => x.date.slice(0, 7))).size || 1
  return (
    <Panel title="Spending" icon={Wallet} tint={TINT} action={fixed && scopeNote(d, f)}>
      {!fixed && <Filters d={d} f={f} set={set} />}
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
        <Stat label="Spent" value={d.money.whole(t.spend)} hint={`${d.money.whole(t.spend / t.months)} a month`} />
        <Stat label="Income" value={d.money.whole(t.income)} hint={`${d.money.whole(t.income / incomeMonths)} a month`} />
        <Stat label="Net" value={<span style={{ color: t.net >= 0 ? "var(--green)" : "var(--red)" }}>{d.money.whole(t.net)}</span>}
          hint={t.net >= 0 ? "saved" : "drawn down"} />
        <Stat label="Top category" value={<span className="block truncate text-[22px]">{top?.category ?? "None"}</span>}
          hint={top && `${d.money.whole(top.total)}, ${Math.round((top.total / t.spend) * 100)}% of spending`} />
      </div>
      <p className="mt-4 text-[12px] text-muted-foreground">
        {d.txns.length.toLocaleString()} transactions from {d.accounts.length} {d.accounts.length === 1 ? "account" : "accounts"},{" "}
        {monthName(d.first.slice(0, 7))} to {monthName(d.last.slice(0, 7))} (the last month may be partial). Transfers between your own accounts are left out; refunds lower spending.
      </p>
    </Panel>
  )
})

// --- spending-months

export const MonthsBlock = block("Monthly spending", ChartColumnStacked, ({ d, options }) => {
  const { f, fixed } = useFilter(options)
  const [pick, setPick] = useState<number | null>(null)
  const months = monthly(d, f)
  const cats = stacked(d)
  const group = (m: (typeof months)[number]) => {
    const segs = cats.map((c) => ({ key: c, value: m.byCategory[c] ?? 0, color: colorOf(d, c) }))
    const rest = Object.entries(m.byCategory).filter(([c]) => !cats.includes(c)).reduce((a, [, v]) => a + v, 0)
    return [...segs, { key: "Other", value: rest, color: OTHER }]
  }
  const labels = axisLabels(months.map((m) => m.month))
  const columns: Column[] = months.map((m, i) => ({ label: labels[i], name: `${monthName(m.month)}: ${d.money.whole(m.spend)}`, stacks: [group(m)] }))
  const shown = months[pick ?? months.length - 1]
  const avg = months.length ? months.reduce((a, m) => a + m.spend, 0) / months.length : 0
  return (
    <Panel title="Monthly spending" icon={ChartColumnStacked} tint={TINT} action={fixed && scopeNote(d, f)}>
      {shown && (
        <Readout sub={group(shown).filter((s) => s.value > 0).sort((a, b) => b.value - a.value).slice(0, 5).map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5"><Dot color={s.color} />{s.key} <span className="num text-foreground">{d.money.whole(s.value)}</span></span>
        ))}>
          <span className="num text-[15px] font-semibold text-foreground">{d.money.whole(shown.spend)}</span> in {monthName(shown.month)}
          {pick === null && months.length > 1 && <> · {d.money.whole(avg)} a month on average</>}
        </Readout>
      )}
      <StackedBars columns={columns} active={pick} onPick={setPick} format={d.money.short} />
      <Legend items={[...cats.map((c) => ({ label: c, color: colorOf(d, c) })), { label: "Other", color: OTHER }]} />
    </Panel>
  )
})

// --- spending-income

export const IncomeBlock = block("Income and spending", Scale, ({ d, options }) => {
  const { f, fixed } = useFilter(options)
  const [pick, setPick] = useState<number | null>(null)
  const months = monthly(d, f)
  const labels = axisLabels(months.map((m) => m.month))
  const columns: Column[] = months.map((m, i) => ({
    label: labels[i], name: `${monthName(m.month)}: income ${d.money.whole(m.income)}, spending ${d.money.whole(m.spend)}`,
    stacks: [sourcesOf(d, m.bySource), [{ key: "spend", value: m.spend, color: SPEND }]],
  }))
  const shown = months[pick ?? months.length - 1]
  const net = shown ? shown.income - shown.spend : 0
  return (
    <Panel title="Income and spending" icon={Scale} tint={TINT} action={fixed && scopeNote(d, f)}>
      {shown && (
        <Readout sub={sourcesOf(d, shown.bySource).filter((s) => s.value > 0).map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5"><Dot color={s.color} />{s.key} <span className="num text-foreground">{d.money.whole(s.value)}</span></span>
        ))}>
          {monthName(shown.month)}: income <span className="num font-semibold text-foreground">{d.money.whole(shown.income)}</span>, spent{" "}
          <span className="num font-semibold text-foreground">{d.money.whole(shown.spend)}</span>, net{" "}
          <span className="num font-semibold" style={{ color: net >= 0 ? "var(--green)" : "var(--red)" }}>{net >= 0 ? "+" : ""}{d.money.whole(net)}</span>
        </Readout>
      )}
      <StackedBars columns={columns} active={pick} onPick={setPick} format={d.money.short} />
      <Legend items={[...d.sources.slice(0, INCOME.length).map((s) => ({ label: s, color: sourceColor(d, s) })),
        ...(d.sources.length > INCOME.length ? [{ label: "Other", color: OTHER }] : []), { label: "Spending", color: SPEND }]} />
    </Panel>
  )
})

// --- spending-categories

export const CategoriesBlock = block("Where it goes", ChartPie, ({ d, options }) => {
  const { f, fixed } = useFilter(options)
  const [per, setPer] = useState<"total" | "month">("total")
  const [pick, setPick] = useState<string | null>(null)
  const t = totals(d, f)
  const div = per === "month" ? t.months : 1
  const limit = Number(options.limit) || 10
  const cats = categories(d, f)
  const rows = cats.slice(0, limit).map((c) => ({ key: c.category, value: c.total / div, color: colorOf(d, c.category) }))
  const rest = cats.slice(limit).reduce((a, c) => a + c.total, 0) / div
  if (rest > 0) rows.push({ key: `${cats.length - limit} more`, value: rest, color: OTHER })
  const total = t.spend / div
  const hit = rows.find((r) => r.key === pick)
  return (
    <Panel title="Where it goes" icon={ChartPie} tint={TINT}
      action={<Segmented label="Total or monthly" value={per} onChange={setPer} className="whitespace-nowrap"
        options={[{ value: "total", label: "Total" }, { value: "month", label: "Monthly" }]} />}>
      {fixed && <div className="-mt-1 mb-2">{scopeNote(d, f)}</div>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <Donut slices={rows} active={pick} onPick={setPick} center={
          <div>
            <div className="num text-[20px] leading-6 font-semibold">{d.money.whole(hit?.value ?? total)}</div>
            <div className="max-w-[110px] truncate text-[12px] text-muted-foreground">
              {hit ? `${Math.round((hit.value / total) * 100)}% · ${hit.key}` : per === "month" ? `a month, over ${t.months}` : "spent"}
            </div>
          </div>
        } />
        <div className="min-w-[200px] flex-1" onMouseLeave={() => setPick(null)}>
          {rows.map((r) => (
            <div key={r.key} onMouseEnter={() => setPick(r.key)}
              className={cn("flex items-center gap-2 py-[3px] text-[13px] transition-opacity", pick && pick !== r.key && "opacity-45")}>
              <Dot color={r.color} />
              <span className="min-w-0 flex-1 truncate">{r.key}</span>
              <span className="num text-foreground">{d.money.whole(r.value)}</span>
              <span className="num w-9 text-right text-muted-foreground">{Math.round((r.value / total) * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
})

// --- spending-merchants

export const MerchantsBlock = block("Top merchants", Store, ({ d, options }) => {
  const { f, fixed } = useFilter(options)
  const rows = merchants(d, f).slice(0, Number(options.limit) || 12)
  const max = rows[0]?.total || 1
  return (
    <Panel title="Top merchants" icon={Store} tint={TINT} action={fixed && scopeNote(d, f)}>
      {!rows.length ? <Empty>No spending in this range.</Empty> : (
        <List>
          {rows.map((m) => (
            <Row key={m.merchant} title={m.merchant} lead={<Dot color={colorOf(d, m.category)} />}
              meta={<span className="flex items-center gap-2">
                <span className="truncate">{m.category} · {m.count} {m.count === 1 ? "charge" : "charges"}</span>
                <span className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full" style={{ width: `${(m.total / max) * 100}%`, background: colorOf(d, m.category) }} />
                </span>
              </span>}
              right={<span className="num text-foreground">{d.money.whole(m.total)}</span>} />
          ))}
        </List>
      )}
    </Panel>
  )
})

// --- spending-recurring

export const RecurringBlock = block("Recurring charges", Repeat, ({ d }) => {
  const now = d.recurring.filter((r) => stillCharging(r, d))
  const total = now.reduce((a, r) => a + r.monthly, 0)
  return (
    <Panel title="Recurring charges" icon={Repeat} tint={TINT}>
      {!d.recurring.length ? <Empty>None found.</Empty> : <>
        <p className="mb-1 text-[13px] text-muted-foreground">
          About <span className="num font-semibold text-foreground">{d.money.whole(total)}</span> a month in bills still charging.
        </p>
        <List>
          {d.recurring.map((r) => {
            const on = stillCharging(r, d)
            return (
              <Row key={r.merchant} title={r.merchant} lead={<Dot color={colorOf(d, r.category)} />} className={cn(!on && "opacity-55")}
                meta={`${r.category} · ${r.months} months since ${monthName(r.first.slice(0, 7))}${on ? "" : `, last ${monthName(r.last.slice(0, 7))}`}`}
                right={<span><span className="num text-foreground">{d.money.cents(r.monthly)}</span> a month</span>} />
            )
          })}
        </List>
      </>}
    </Panel>
  )
})

// --- spending-coverage

export const CoverageBlock = block("Coverage", CalendarRange, ({ d }) => {
  const t0 = Date.parse(d.coverage.reduce((a, c) => c.spans[0][0] < a ? c.spans[0][0] : a, d.first))
  const t1 = Date.parse(d.coverage.reduce((a, c) => c.spans.at(-1)![1] > a ? c.spans.at(-1)![1] : a, d.last))
  const x = (s: string) => ((Date.parse(s) - t0) / (t1 - t0)) * 100
  const years: number[] = []
  for (let y = new Date(t0).getUTCFullYear() + 1; y <= new Date(t1).getUTCFullYear(); y++) years.push(y)
  return (
    <Panel title="Coverage" icon={CalendarRange} tint={TINT}>
      <div className="grid grid-cols-[minmax(0,8.5rem)_1fr] items-center gap-x-3 gap-y-2.5">
        {d.coverage.map((c) => (
          <div key={c.account} className="contents">
            <span className="truncate text-[13px]">{c.account}</span>
            <div className="relative h-2.5 rounded-full bg-muted">
              {years.map((y) => <span key={y} className="absolute inset-y-0 w-px bg-border" style={{ left: `${x(`${y}-01-01`)}%` }} />)}
              {c.spans.map(([a, b]) => (
                <span key={a} title={`${monthName(a.slice(0, 7))} to ${monthName(b.slice(0, 7))}`}
                  className="absolute inset-y-0 rounded-full bg-[var(--finance)]" style={{ left: `${x(a)}%`, width: `max(4px, ${x(b) - x(a)}%)` }} />
              ))}
            </div>
          </div>
        ))}
        <span />
        <div className="relative h-4 text-[11px] text-muted-foreground">
          {years.map((y) => <span key={y} className="num absolute -translate-x-1/2" style={{ left: `${x(`${y}-01-01`)}%` }}>{y}</span>)}
        </div>
      </div>
    </Panel>
  )
})

// --- spending-transactions

export const TransactionsBlock = block("Transactions", Receipt, ({ d, options }) => {
  const { f, fixed } = useFilter(options)
  const [q, setQ] = useState("")
  const [more, setMore] = useState(0)
  const limit = (Number(options.limit) || 50) + more
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const rows = filtered(d, f).filter((t) => {
    if (!words.length) return true
    const hay = `${t.merchant} ${t.description} ${t.category} ${t.account} ${t.date} ${Math.abs(t.amount).toFixed(2)}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  }).reverse()
  const shown = rows.slice(0, limit)
  return (
    <Panel title="Transactions" icon={Receipt} tint={TINT} action={fixed && scopeNote(d, f)}>
      <div className="mb-1 flex items-center gap-3">
        <FilterField value={q} onChange={(v) => { setQ(v); setMore(0) }} placeholder="Search merchant, category, amount…" />
        <span className="num shrink-0 text-[13px] text-muted-foreground">{rows.length.toLocaleString()}</span>
      </div>
      {!rows.length ? <Empty>{q ? "Nothing matches." : "No transactions in this range."}</Empty> : (
        <List>
          {shown.map((t, i) => (
            <Row key={`${t.date}${t.description}${t.amount}${i}`} title={t.merchant} className={cn(t.kind === "transfer" && "opacity-55")}
              lead={<Dot color={t.kind === "transfer" ? OTHER : colorOf(d, t.category)} />}
              meta={`${fmtDay(t.date)} · ${t.category} · ${t.account}`} aria-label={t.description}
              right={<span className="num" style={{ color: t.amount > 0 ? "var(--green)" : "var(--foreground)" }}>{t.amount > 0 ? "+" : ""}{d.money.cents(t.amount)}</span>} />
          ))}
        </List>
      )}
      {rows.length > shown.length && (
        <button type="button" onClick={() => setMore(more + 100)} className="mt-2 cursor-pointer text-[13px] font-medium text-primary">
          Show {Math.min(100, rows.length - shown.length)} more
        </button>
      )}
    </Panel>
  )
})

