## Finance
The Spending page: spending, income and bills from one CSV of transactions, `Transactions.csv` wherever it is in the
vault (the one in a Finance folder first; the `csv` setting names another). Nothing else is stored: the blocks work
everything out from the CSV, read again when it changes.
- Columns (a header row; others are ignored): `date` (YYYY-MM-DD) and `amount` (+ money in, - money out, a plain
  number like `-12.50`), then optional `account`, `merchant` (what blocks group by; else the start of `description`),
  `description`, `category` and `kind`. `kind: transfer` (between the user's own accounts) is neither spending nor
  income; `kind: refund` lowers spending. Income is grouped by its `category`.
- Filling it from a bank's export or statements: one row per transaction, each merchant always spelled the same way.
- The `spending` block's range and account filter (kept per device) drives every block on the page; a block's own
  `range` (all, 24m, 12m, 6m, 3m, ytd or `YYYY-MM:YYYY-MM`) or `account` keeps it fixed. As text, a block without
  `range` covers the last 12 months, all accounts.
- To answer money questions: `vau render Spending` (or a block's text alone, with a `range`).
