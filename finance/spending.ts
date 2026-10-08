/**
 * The numbers behind every Spending block, worked out from the transactions CSV (its columns: AGENTS.md). Pure: the
 * app's blocks (index.tsx) and their text for AIs (plugin.ts) both call it, so what's drawn and what's read agree.
 *
 * Signs: + money in, - money out. Transfers between the user's own accounts (`kind: transfer`) count as neither
 * spending nor income; refunds lower spending.
 */

/** The transactions file's name: the plugin finds it wherever the user keeps it (findCsv), unless its `csv` setting
 *  names one. */
export const CSV = "Transactions.csv"

/** The transactions CSV among the vault's files: the one in a Finance folder first, else the first by path; null when
 *  there's none. */
export function findCsv(paths: Iterable<string>): string | null {
  const all = [...paths].filter((p) => p === CSV || p.endsWith(`/${CSV}`)).sort()
  return all.find((p) => p.split("/").slice(-2)[0] === "Finance") ?? all[0] ?? null
}

/** What the plugin's route answers: the CSV's rows and the settings that read them. */
export type Answer = { path: string | null; rows: Record<string, string>[]; currency: string; bills: string[] }

export type Txn = {
  date: string; account: string; merchant: string; description: string
  amount: number; kind: string; category: string
}

export type Coverage = { account: string; spans: [string, string][] }
export type Recurring = { merchant: string; category: string; monthly: number; months: number; first: string; last: string }

export type Money = { whole: (n: number) => string; cents: (n: number) => string; short: (n: number) => string }

export type Data = {
  txns: Txn[]
  accounts: string[]
  first: string; last: string
  /** Spending categories, most spent first over all time: their colours follow this order, whatever the filter. */
  rank: string[]
  /** Income categories, most first over all time. */
  sources: string[]
  coverage: Coverage[]
  recurring: Recurring[]
  money: Money
}

export type Filter = { range: string; account: string }

const DAY = 86_400_000
const round2 = (x: number) => Math.round(x * 100) / 100
const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

/** What a transaction adds to spending: outflows, minus refunds; transfers never. */
export const spendOf = (t: Txn) => t.kind === "transfer" ? 0 : t.amount < 0 ? -t.amount : t.kind === "refund" ? -t.amount : 0
export const isIncome = (t: Txn) => t.amount > 0 && t.kind !== "transfer" && t.kind !== "refund"

/** Amounts in a currency (ISO 4217, "USD"), in this device's locale. */
export function moneyOf(currency: string): Money {
  const fmt = (o: Intl.NumberFormatOptions) => {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency, ...o }) } catch { return new Intl.NumberFormat(undefined, o) }
  }
  const whole = fmt({ maximumFractionDigits: 0, minimumFractionDigits: 0 }), cents = fmt({}), short = fmt({ notation: "compact", maximumFractionDigits: 1 })
  return { whole: (n) => whole.format(n), cents: (n) => cents.format(n), short: (n) => short.format(n) }
}

export function analyze(a: Pick<Answer, "rows" | "currency" | "bills">): Data {
  const txns: Txn[] = a.rows.map((r) => ({
    date: (r.date ?? "").trim(), account: r.account?.trim() || "Account",
    merchant: r.merchant?.trim() || (r.description ?? "").trim().slice(0, 30) || "Unknown", description: r.description ?? "",
    amount: Number(r.amount), kind: (r.kind ?? "").trim().toLowerCase(), category: r.category?.trim() || "Uncategorized",
  })).filter((t) => /^\d{4}-\d\d-\d\d$/.test(t.date) && Number.isFinite(t.amount))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
  const accounts = [...new Set(txns.map((t) => t.account))].sort()
  const spent = new Map<string, number>(), earned = new Map<string, number>()
  for (const t of txns) {
    spent.set(t.category, (spent.get(t.category) ?? 0) + spendOf(t))
    if (isIncome(t)) earned.set(t.category, (earned.get(t.category) ?? 0) + t.amount)
  }
  const ranked = (m: Map<string, number>) => [...m].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c)
  return {
    txns, accounts, rank: ranked(spent), sources: ranked(earned),
    first: txns[0]?.date ?? "", last: txns.at(-1)?.date ?? "",
    coverage: coverageOf(txns, accounts), recurring: recurringOf(txns, a.bills), money: moneyOf(a.currency || "USD"),
  }
}

const monthIndex = (ym: string) => +ym.slice(0, 4) * 12 + +ym.slice(5, 7) - 1
const endOfMonth = (ym: string) => isoDay(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0))

/** Each account's months with transactions, as spans (a quiet month inside one doesn't break it). */
function coverageOf(txns: Txn[], accounts: string[]): Coverage[] {
  return accounts.map((account) => {
    const months = [...new Set(txns.filter((t) => t.account === account).map((t) => t.date.slice(0, 7)))].sort()
    const spans: [string, string][] = []
    let start = months[0], prev = months[0]
    for (const m of months.slice(1)) {
      if (monthIndex(m) - monthIndex(prev) > 2) { spans.push([`${start}-01`, endOfMonth(prev)]); start = m }
      prev = m
    }
    spans.push([`${start}-01`, endOfMonth(prev)])
    return { account, spans }
  })
}

/** Bills: a merchant charged in 4+ months, monthly to quarterly, and either in one of `bills` (categories) or, with
 *  none set, for about the same amount each time. */
function recurringOf(txns: Txn[], bills: string[]): Recurring[] {
  const groups = new Map<string, Txn[]>()
  for (const t of txns) if (t.amount < 0 && t.kind !== "transfer") groups.set(t.merchant, [...groups.get(t.merchant) ?? [], t])
  const out: Recurring[] = []
  for (const [merchant, g] of groups) {
    const months = new Set(g.map((t) => t.date.slice(0, 7)))
    const category = mode(g.map((t) => t.category))
    if (months.size < 4) continue
    if (bills.length ? !bills.includes(category) : !steady(g.map((t) => -t.amount))) continue
    const ds = g.map((t) => day(t.date)).sort((a, b) => a - b)
    const gap = median(ds.slice(1).map((d, i) => (d - ds[i]) / DAY))
    if (gap < 20 || gap > 100) continue
    const span = monthIndex(isoDay(ds.at(-1)!)) - monthIndex(isoDay(ds[0])) + 1
    out.push({ merchant, category, monthly: round2(-g.reduce((s, t) => s + t.amount, 0) / span), months: months.size,
      first: isoDay(ds[0]), last: isoDay(ds.at(-1)!) })
  }
  return out.sort((a, b) => b.monthly - a.monthly)
}

/** Most amounts within 15% of the usual one: a subscription, not a shop. */
function steady(xs: number[]) {
  const m = median(xs)
  return m > 0 && xs.filter((x) => Math.abs(x - m) <= m * 0.15).length >= xs.length * 0.75
}

/** Still charging: seen within two months of the latest data. */
export const active = (r: Recurring, d: Data) => monthIndex(d.last) - monthIndex(r.last) <= 2

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}
function mode(xs: string[]) {
  const c = new Map<string, number>()
  let best = "", most = 0
  for (const x of xs) { const k = (c.get(x) ?? 0) + 1; c.set(x, k); if (k > most) { most = k; best = x } }
  return best
}

// --- ranges

/** The ranges the filter offers, shortest first: `label` on its button (the usual chart ranges, 3M to All), `phrase`
 *  in sentences ("last 12 months"; all and ytd say their dates). A custom one is `YYYY-MM:YYYY-MM`. */
export const RANGES = [
  { value: "3m", label: "3M", phrase: "last 3 months" },
  { value: "6m", label: "6M", phrase: "last 6 months" },
  { value: "ytd", label: "YTD", phrase: "" },
  { value: "12m", label: "1Y", phrase: "last 12 months" },
  { value: "24m", label: "2Y", phrase: "last 2 years" },
  { value: "all", label: "All", phrase: "" },
]
const CUSTOM = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/

/** [first day, last day] of a range, ending with the data's last day. */
export function bounds(data: Data, range: string): [string, string] {
  const c = CUSTOM.exec(range)
  if (c) { const [f, t] = c[1] <= c[2] ? [c[1], c[2]] : [c[2], c[1]]; return [f + "-01", t + "-31"] }
  if (range === "ytd") return [data.last.slice(0, 4) + "-01-01", data.last]
  const n = /^(\d+)m$/.exec(range)
  if (!n) return [data.first, data.last]
  return [addMonths(data.last.slice(0, 7), 1 - Number(n[1])) + "-01", data.last]
}

export function addMonths(ym: string, n: number) {
  const m = monthIndex(ym) + n
  return `${Math.floor(m / 12)}-${String(m % 12 + 1).padStart(2, "0")}`
}

/** Every month of a range that has data, oldest first (empty months included: a gap shows as one). */
export function monthsOf(data: Data, range: string) {
  const [s, e] = bounds(data, range)
  const end = e.slice(0, 7) < data.last.slice(0, 7) ? e.slice(0, 7) : data.last.slice(0, 7)
  const out: string[] = []
  for (let m = s.slice(0, 7) < data.first.slice(0, 7) ? data.first.slice(0, 7) : s.slice(0, 7); m <= end; m = addMonths(m, 1)) out.push(m)
  return out
}

/** A range in words, for sentences: "last 12 months", "2026 so far", "Sep 2022 to Jun 2026". */
export function rangeLabel(data: Data, range: string) {
  const phrase = RANGES.find((x) => x.value === range)?.phrase
  if (phrase) return phrase
  if (range === "ytd") return `${data.last.slice(0, 4)} so far`
  const [s, e] = bounds(data, range)
  return `${monthName((s < data.first ? data.first : s).slice(0, 7))} to ${monthName((e > data.last ? data.last : e).slice(0, 7))}`
}

export function filtered(data: Data, f: Filter) {
  const [s, e] = bounds(data, f.range)
  return data.txns.filter((t) => t.date >= s && t.date <= e && (f.account === "all" || t.account === f.account))
}

// --- what the blocks show

export type Month = { month: string; spend: number; income: number; byCategory: Record<string, number>; bySource: Record<string, number> }

export function monthly(data: Data, f: Filter): Month[] {
  const rows = filtered(data, f)
  const by = new Map(monthsOf(data, f.range).map((m) => [m, { month: m, spend: 0, income: 0, byCategory: {}, bySource: {} } as Month]))
  for (const t of rows) {
    const m = by.get(t.date.slice(0, 7))
    if (!m) continue
    if (isIncome(t)) {
      m.income += t.amount
      m.bySource[t.category] = (m.bySource[t.category] ?? 0) + t.amount
    } else {
      const s = spendOf(t)
      if (s) { m.spend += s; m.byCategory[t.category] = (m.byCategory[t.category] ?? 0) + s }
    }
  }
  for (const m of by.values()) {
    m.spend = Math.max(0, m.spend)
    for (const c in m.byCategory) if (m.byCategory[c] <= 0) delete m.byCategory[c]
  }
  return [...by.values()]
}

/** Totals over the filter: spending, income (all of it, and by category), net, the months with spending. */
export function totals(data: Data, f: Filter) {
  const rows = filtered(data, f)
  let spend = 0, income = 0
  const bySource: Record<string, number> = {}
  const months = new Set<string>()
  for (const t of rows) {
    if (isIncome(t)) { income += t.amount; bySource[t.category] = (bySource[t.category] ?? 0) + t.amount }
    const s = spendOf(t)
    if (s) { spend += s; if (s > 0) months.add(t.date.slice(0, 7)) }
  }
  return { spend, income, net: income - spend, bySource, months: Math.max(1, months.size), count: rows.length }
}

export function categories(data: Data, f: Filter) {
  const per = new Map<string, number>()
  for (const t of filtered(data, f)) { const s = spendOf(t); if (s) per.set(t.category, (per.get(t.category) ?? 0) + s) }
  return [...per].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([category, total]) => ({ category, total }))
}

export function merchants(data: Data, f: Filter) {
  const per = new Map<string, { merchant: string; category: string; count: number; total: number }>()
  for (const t of filtered(data, f)) {
    const s = spendOf(t)
    if (!s) continue
    const m = per.get(t.merchant) ?? { merchant: t.merchant, category: t.category, count: 0, total: 0 }
    if (s > 0) m.count++
    m.total += s
    per.set(t.merchant, m)
  }
  return [...per.values()].filter((m) => m.total > 0).sort((a, b) => b.total - a.total)
}

// --- words

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "Sep 2026". */
export const monthName = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`
/** A chart's month labels: month names, the year in January's place; quarters past a year of months, years past two. */
export function axisLabels(months: string[]) {
  const step = months.length <= 12 ? 1 : months.length <= 24 ? 3 : 12
  return months.map((ym) => {
    const m = +ym.slice(5, 7)
    return (m - 1) % step ? "" : m === 1 ? ym.slice(0, 4) : MONTHS[m - 1]
  })
}
