// Grok Bot in this process, with Cursor's plugin (it reads Cursor's account through it): its week and requests from a
// fake of Cursor's API, read once for both.   node grok-bot/.test/test.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, done, inProcess } from "../../testkit.ts"
import { cursorApi, cursorFixture } from "../../cursor/.test/fixture.ts"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-grok-bot-"))
const fake = await cursorApi()
const s = await inProcess(["cursor", "grok-bot"], { env: { ...await cursorFixture(home), ...fake.env } })
const { api, write } = s, seen = fake.seen
try {
  const conv = "9b9b9b9b-3333-4444-8555-666677778888"
  let [c, u] = await api("GET", "grok-bot?days=30")
  check("the account isn't read until the user allows it", c === 200 && !u.limits && !u.sessions.length && !u.total.tokens && seen.length === 0,
    [c, u?.limits, seen.length])
  write(".vaultite/plugins/cursor/data.json", JSON.stringify({ account: true }))
  await api("GET", "cursor?days=30")
  const before = seen.length
  write(".vaultite/plugins/grok-bot/data.json", JSON.stringify({ account: true }))
  ;[c, u] = await api("GET", "grok-bot?days=30")
  check("one read of the account serves Cursor's plugin and this one (nothing asked again)", c === 200 && before > 0 && seen.length === before,
    seen.slice(before).map((x) => x.path))
  check("its week from Cursor's dashboard, no plan of its own", u.plan === null &&
    u.limits?.windows.map((w: any) => `${w.id}:${w.used}:${w.minutes}`).join() === "week:12:10080" && !!u.limits.windows[0].resets_at, [u?.plan, u?.limits])
  check("only its own requests, its conversation a session", u.total.cost === 0.05 && u.total.tokens === 150 &&
    u.sessions.length === 1 && u.sessions[0].id === conv && u.sessions[0].title === "Conversation 9b9b9b9b" && u.sessions[0].model === "Grok Bot" &&
    u.sessions[0].active_min === 1 && !u.live.length, [u.total, u.sessions])
  check("by model", u.models.map((m: any) => m.name).join() === "Grok Bot,Grok Bot automation", u.models)
  let t: any
  ;[c, t] = await api("GET", `grok-bot/session/${conv}`)
  check("session: when and with which model, no conversation (it stays in Grok Bot)", c === 200 && t.title === "Conversation 9b9b9b9b" &&
    t.model === "Grok Bot" && !!t.first && t.entries.length === 0, [c, t])
  ;[c] = await api("GET", "grok-bot/session/c0ffee00-1111-4222-8333-444455556666")
  check("session: Cursor's own chats aren't Grok Bot's", c === 404, c)
  const [, page] = await api("GET", "render?path=Dashboards/Grok Bot.md")
  check("its page as text", typeof page === "string" && page.includes("This week: 12% used") && page.includes("Conversation 9b9b9b9b") &&
    page.includes("## Grok Bot by model") && !page.includes("### Now") && !page.includes("Claude"), String(page).slice(0, 800))
} finally {
  s.stop()
  fake.server.close()
  fs.rmSync(home, { recursive: true, force: true })
}
done()
