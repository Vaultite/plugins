import { definePlugin } from "@vaultite"
import {
  CategoriesBlock, CoverageBlock, IncomeBlock, MerchantsBlock, MonthsBlock, RecurringBlock, SpendingBlock, TransactionsBlock,
} from "./blocks.tsx"
import type { Answer } from "./spending.ts"

/** A made-up year of transactions for previews, ending this month: the same every time. */
function sample(): Answer {
  const rows: Record<string, string>[] = []
  const now = new Date(), add = (date: string, merchant: string, amount: number, category: string, account = "Checking", kind = "") =>
    rows.push({ date, account, merchant, description: merchant, amount: amount.toFixed(2), category, kind })
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const on = (day: number) => `${ym}-${String(Math.min(day, i ? 28 : now.getDate())).padStart(2, "0")}`
    add(on(1), "Acme Corp", 4200, "Salary")
    add(on(1), "Harbor Apartments", -1650, "Rent")
    add(on(3), "City Power", -60 - Math.round(rand() * 40), "Utilities")
    add(on(5), "Streamly", -12.99, "Subscriptions", "Card")
    add(on(8), "Pocket Mobile", -35, "Phone", "Card")
    add(on(10), "Card payment", -900, "Transfer", "Checking", "transfer")
    add(on(10), "Card payment", 900, "Transfer", "Card", "transfer")
    for (let w = 0; w < 4; w++) {
      add(on(2 + w * 7), "Corner Market", -(45 + Math.round(rand() * 50)), "Groceries", "Card")
      add(on(4 + w * 7), "Morning Cup", -(4 + Math.round(rand() * 6)), "Eating out", "Card")
    }
    add(on(14), "Noodle Bar", -(20 + Math.round(rand() * 25)), "Eating out", "Card")
    add(on(18), "Metro Transit", -40, "Transport", "Card")
    if (i % 3 === 0) add(on(20), "Book Nook", -(15 + Math.round(rand() * 30)), "Books", "Card")
    if (i % 4 === 1) add(on(22), "Side project sale", 150 + Math.round(rand() * 200), "Other income")
  }
  return { path: "Finance/Transactions.csv", rows, currency: "USD", bills: [] }
}

export default definePlugin({
  blocks: {
    spending: (ctx) => <SpendingBlock {...ctx} />,
    "spending-months": (ctx) => <MonthsBlock {...ctx} />,
    "spending-income": (ctx) => <IncomeBlock {...ctx} />,
    "spending-categories": (ctx) => <CategoriesBlock {...ctx} />,
    "spending-merchants": (ctx) => <MerchantsBlock {...ctx} />,
    "spending-recurring": (ctx) => <RecurringBlock {...ctx} />,
    "spending-coverage": (ctx) => <CoverageBlock {...ctx} />,
    "spending-transactions": (ctx) => <TransactionsBlock {...ctx} />,
  },
  mockLive: () => ({ "finance/data": sample() }),
})
