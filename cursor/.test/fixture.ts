// Cursor's made-up state (fixtures/: `User` for Cursor.app's User folder, `config` for ~/.cursor), and a fake of its
// dashboard's API, for Cursor's tests and Grok Bot's.
import fs from "node:fs"
import http from "node:http"
import path from "node:path"

/** "Now" for made-up usage that's minutes old and must fall on today: never in the day's first two hours. */
export const fixtureNow = () => { const d = new Date(); d.setHours(2, 0, 0, 0); return Math.max(Date.now(), d.getTime()) }

/** The fixture's files under `dir`, each <name>.sql made the database <name>; the environment pointing at them. */
export async function cursorFixture(dir: string) {
  fs.cpSync(path.join(import.meta.dirname, "fixtures"), dir, { recursive: true })
  const { DatabaseSync } = await import("node:sqlite")
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (!f.endsWith(".sql")) continue
    const db = new DatabaseSync(path.join(dir, f.slice(0, -4)))
    db.exec(fs.readFileSync(path.join(dir, f), "utf8"))
    db.close()
  }
  return { CURSOR_USER_DIR: path.join(dir, "User"), CURSOR_CONFIG_DIR: path.join(dir, "config") }
}

/** A fake Cursor API (its account's usage), recording what it was asked; `env` points the plugins at it. */
export async function cursorApi() {
  const seen: { path: string; cookie: string; origin: string }[] = []
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", cookie: String(req.headers.cookie ?? ""), origin: String(req.headers.origin ?? "") })
    const now = fixtureNow(), min = 60_000
    const ev = (ago: number, conversationId: string, model: string, t: Record<string, number> | null, charged = 0) =>
      ({ timestamp: String(now - ago * min), model, conversationId, ...(t ? { tokenUsage: t } : {}), chargedCents: charged })
    const body = req.url === "/api/usage-summary" ? {
      billingCycleStart: new Date(now - 10 * 86400_000).toISOString(), billingCycleEnd: new Date(now + 20 * 86400_000).toISOString(), membershipType: "pro",
      individualUsage: { plan: { enabled: true, used: 930, limit: 2000, totalPercentUsed: 46.5 }, onDemand: { enabled: false } } }
      : req.url === "/api/dashboard/get-sand-usage-status" ? { currentPeriodStart: new Date(now - 4 * 86400_000).toISOString(),
        nextResetTimestampUtc: new Date(now + 3 * 86400_000).toISOString(), usagePercent: 12, hasNonZeroIncludedLimit: true }
      : req.url === "/api/dashboard/get-filtered-usage-events" ? { totalUsageEventsCount: 5, usageEventsDisplay: [
        ev(3, "c0ffee00-1111-4222-8333-444455556666", "claude-4.5-sonnet", { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, totalCents: 12 }, 12),
        ev(5, "c0ffee00-1111-4222-8333-444455556666", "claude-4.5-sonnet", { inputTokens: 500, outputTokens: 100, cacheReadTokens: 4000, totalCents: 8 }, 8),
        ev(20, "5a5a5a5a-2222-4333-8444-555566667777", "gpt-5", { inputTokens: 2000, outputTokens: 300, cacheWriteTokens: 1000, totalCents: 30 }, 30),
        ev(60, "9b9b9b9b-3333-4444-8555-666677778888", "grok-bot-default", { inputTokens: 100, outputTokens: 50, totalCents: 5 }, 5),
        ev(61, "9b9b9b9b-3333-4444-8555-666677778888", "grok-bot-automation", null) ] }
      : null
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(body ?? {}))
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { server, seen, env: { CURSOR_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` } }
}
