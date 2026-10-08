// Finance: the Spending page's blocks as text, from the numbers the app draws (spending.ts), the last 12 months unless
// `range`. The CSV: the `csv` setting, else the vault's Transactions.csv wherever it is; GET /api/finance/data answers it.
import fs from "node:fs"
import { csvRecords, Plugin, section } from "@vaultite/core/plugins.ts"
import type { Item } from "@vaultite/core/vault.ts"
import {
  active, analyze, type Answer, categories, CSV, type Data, type Filter, filtered, findCsv, merchants, monthly, monthName, rangeLabel, totals,
} from "./spending.ts"

export const plugin = new Plugin(import.meta.url)

/** The transactions CSV's vault path: the `csv` setting, else the vault's Transactions.csv (findCsv), or null. */
function csvPath(): string | null {
  const set = plugin.settings().csv
  if (typeof set === "string" && set.trim()) return set.trim().replace(/^\/+/, "")
  return findCsv(plugin.vault.others.keys())
}

function settings() {
  const s = plugin.settings()
  return {
    currency: typeof s.currency === "string" && s.currency.trim() ? s.currency.trim().toUpperCase() : "USD",
    bills: Array.isArray(s.bills) ? s.bills.filter((x): x is string => typeof x === "string") : [],
  }
}

let cached: { path: string; mtime: number; rows: Record<string, string>[] } | null = null
function rows(rel: string | null) {
  if (!rel) return []
  let mtime: number
  try { mtime = fs.statSync(plugin.vault.abs(rel)).mtimeMs } catch { return [] }
  if (cached?.mtime !== mtime || cached.path !== rel) cached = { path: rel, mtime, rows: csvRecords(fs.readFileSync(plugin.vault.abs(rel), "utf8")) }
  return cached.rows
}

plugin.route("GET", "finance/data", (): Answer => { const path = csvPath(); return { path, rows: rows(path), ...settings() } })

let analyzed: { rows: Record<string, string>[]; key: string; data: Data } | null = null
function data(): Data | null {
  const r = rows(csvPath()), s = settings(), key = JSON.stringify(s)
  if (!r.length) return null
  if (analyzed?.rows !== r || analyzed.key !== key) analyzed = { rows: r, key, data: analyze({ rows: r, ...s }) }
  return analyzed.data
}

const filterOf = (o: Item): Filter => ({ range: typeof o.range === "string" ? o.range : "12m", account: typeof o.account === "string" ? o.account : "all" })
const scope = (d: Data, f: Filter) => {
  const s = `${rangeLabel(d, f.range)}, ${f.account === "all" ? "all accounts" : f.account}`
  return s[0].toUpperCase() + s.slice(1)
}
const MISSING = `_No transactions yet: put a ${CSV} in the vault (its columns: \`vau docs finance\`)._`
/** A Markdown table; the columns in `right` (amounts and counts) are right-aligned. */
const table = (head: string[], rows: string[][], right: number[]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map((_, i) => (right.includes(i) ? "---:" : "---")).join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n")

/** A block's text: its heading, then what fn says (the same "no data yet" for all). */
const text = (title: string, fn: (d: Data, o: Item) => string) => ({ options }: { options: Item }) => {
  const d = data()
  return section(title, d && d.txns.length ? fn(d, options) : MISSING)
}

plugin.block("spending", text("Spending", (d, o) => {
  const f = filterOf(o), t = totals(d, f), $ = d.money.whole
  const top = categories(d, f)[0]
  const sources = d.sources.map((s) => [s, t.bySource[s] ?? 0] as const).filter(([, v]) => v > 0)
  return [
    `${scope(d, f)}: spent **${$(t.spend)}** (${$(t.spend / t.months)} a month over ${t.months} months), ` +
    `income **${$(t.income)}**, net **${$(t.net)}** (${t.net >= 0 ? "saved" : "drawn down"}).` +
    (top ? ` Top category: ${top.category}, ${$(top.total)}.` : ""),
    sources.length ? `Income by category: ${sources.map(([l, v]) => `${l} ${$(v)}`).join(", ")}.` : "",
    `_${d.txns.length} transactions from ${d.accounts.join(", ")}, ${monthName(d.first.slice(0, 7))} to ${monthName(d.last.slice(0, 7))}; ` +
    `the last month may be partial. Transfers between own accounts are left out; refunds lower spending._`,
  ].filter(Boolean).join("\n\n")
}))

plugin.block("spending-months", text("Monthly spending", (d, o) => {
  const f = filterOf(o), $ = d.money.whole
  const rows = monthly(d, f).reverse().map((m) => [monthName(m.month), $(m.spend),
    Object.entries(m.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => `${c} ${$(v)}`).join(", ")])
  return `${scope(d, f)}, newest first.\n\n${table(["Month", "Spending", "Top categories"], rows, [1])}`
}))

plugin.block("spending-income", text("Income and spending", (d, o) => {
  const f = filterOf(o), $ = d.money.whole
  const rows = monthly(d, f).reverse().map((m) => [monthName(m.month), $(m.income), $(m.spend), $(m.income - m.spend),
    d.sources.filter((s) => m.bySource[s]).map((s) => `${s} ${$(m.bySource[s])}`).join(", ")])
  return `${scope(d, f)}, newest first.\n\n${table(["Month", "Income", "Spending", "Net", "Income by category"], rows, [1, 2, 3])}`
}))

plugin.block("spending-categories", text("Where it goes", (d, o) => {
  const f = filterOf(o), t = totals(d, f), cats = categories(d, f), $ = d.money.whole
  const limit = Number(o.limit) || 10
  const shown = cats.slice(0, limit), rest = cats.slice(limit).reduce((s, c) => s + c.total, 0)
  const rows = shown.map((c) => [c.category, $(c.total), $(c.total / t.months), `${((c.total / t.spend) * 100).toFixed(1)}%`])
  if (rest > 0) rows.push([`${cats.length - limit} more`, $(rest), $(rest / t.months), `${((rest / t.spend) * 100).toFixed(1)}%`])
  return `${scope(d, f)}: ${$(t.spend)} over ${t.months} months.\n\n${table(["Category", "Total", "Per month", "Share"], rows, [1, 2, 3])}`
}))

plugin.block("spending-merchants", text("Top merchants", (d, o) => {
  const f = filterOf(o)
  const rows = merchants(d, f).slice(0, Number(o.limit) || 12).map((m) => [m.merchant, m.category, String(m.count), d.money.whole(m.total)])
  return `${scope(d, f)}.\n\n${table(["Merchant", "Category", "Transactions", "Total"], rows, [2, 3])}`
}))

plugin.block("spending-recurring", text("Recurring charges", (d) => {
  if (!d.recurring.length) return "_None found._"
  const rows = d.recurring.map((r) => [r.merchant, r.category, d.money.cents(r.monthly), String(r.months), r.first, r.last])
  const total = d.recurring.filter((r) => active(r, d)).reduce((s, r) => s + r.monthly, 0)
  return `Merchants charged monthly to quarterly, over all history. The ones still charging ` +
    `(within 2 months of the latest data) come to about ${d.money.whole(total)} a month.\n\n` +
    table(["Merchant", "Category", "A month", "Months", "First", "Last"], rows, [2, 3])
}))

plugin.block("spending-coverage", text("Coverage", (d) =>
  d.coverage.map((c) => `- ${c.account}: ${c.spans.map(([a, b]) => `${monthName(a.slice(0, 7))} to ${monthName(b.slice(0, 7))}`).join(", ")}`).join("\n")))

plugin.block("spending-transactions", text("Transactions", (d, o) => {
  const f = filterOf(o)
  const rows = filtered(d, f)
  const shown = rows.slice(-(Number(o.limit) || 50)).reverse()
  return `${scope(d, f)}: the latest ${shown.length} of ${rows.length}.\n\n` +
    shown.map((t) => `- ${t.date} · ${t.merchant} · ${t.category} · ${t.account} · ${d.money.cents(t.amount)}` +
      (t.kind === "transfer" ? " (transfer)" : "")).join("\n")
}))
