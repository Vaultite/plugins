// Finance on a throwaway server: made-up transactions; transfers are neither spending nor income, refunds lower
// spending, bills are steady.   node finance/.test/test.ts
import { check, done, serve } from "../../testkit.ts"
import { analyze, totals } from "../spending.ts"

const s = await serve(["finance"])
try {
  const rows = ["date,account,merchant,amount,category,kind"]
  for (const m of ["01", "02", "03", "04", "05"]) rows.push(`2026-${m}-01,Checking,Acme Corp,3000,Salary,`, `2026-${m}-03,Card,Streamly,-12.99,Subscriptions,`,
    `2026-${m}-05,Card,Corner Market,-${50 + +m * 20},Groceries,`, `2026-${m}-10,Checking,Card payment,-500,Transfer,transfer`)
  rows.push("2026-05-06,Card,Corner Market,20,Groceries,refund")
  s.write("Money/Transactions.csv", rows.join("\n") + "\n")
  const [, ans] = await s.api("GET", "finance/data")
  const d = analyze(ans), t = totals(d, { range: "all", account: "all" })
  check("finance: the CSV found, spending and income", ans.path === "Money/Transactions.csv" && t.income === 15000 &&
    Math.round(t.spend * 100) === Math.round((5 * 12.99 + 550 - 20) * 100), [ans.path, t])
  check("finance: a steady monthly charge is a bill, groceries aren't", d.recurring.map((r) => r.merchant).join() === "Streamly", d.recurring)
  const [, txt] = await s.api("GET", "render?path=Dashboards/Spending.md")
  check("finance: its page, copied in once it's on, as text", String(txt).includes("Income by category: Salary") && String(txt).includes("Streamly"), txt)
} finally {
  s.stop()
}
done()
