// Cursor in this process: chats from the made-up IDE and CLI files, usage from a fake of Cursor's API, its agent in a
// terminal, its page as text.   node cursor/.test/test.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, done, inProcess } from "../../testkit.ts"
import { cursorApi, cursorFixture } from "./fixture.ts"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-cursor-"))
const fake = await cursorApi()
const s = await inProcess(["cursor"], { env: { ...await cursorFixture(home), ...fake.env } })
const { api, write } = s, seen = fake.seen
try {
  const ide = "c0ffee00-1111-4222-8333-444455556666", cli = "5a5a5a5a-2222-4333-8444-555566667777"
  let [c, u] = await api("GET", "cursor?days=30")
  check("the account isn't read until the user allows it, chats are", c === 200 && !u.limits && seen.length === 0 && u.sessions.length === 2, [c, u?.limits, seen])
  write(".vaultite/plugins/cursor/data.json", JSON.stringify({ account: true }))
  ;[c, u] = await api("GET", "cursor?days=30")
  check("the plan and its allowances from Cursor's dashboard", c === 200 && u.plan?.name === "Pro" && u.plan.monthly === 20 &&
    u.limits?.windows.map((w: any) => `${w.id}:${w.used}`).join() === "month:46.5" && !!u.limits.windows[0].resets_at, [c, u?.plan, u?.limits])
  check("usage totals from the metered requests (a request with no tokens is worth what it charged)",
    u.total.cost === 0.5 && u.total.tokens === 17100 && u.total.unpriced === 0 && u.total.cache_hit === 0.727, u.total)
  const ses = Object.fromEntries(u.sessions.map((x: any) => [x.id, x]))
  check("the IDE's and the CLI's chats are sessions (no drafts, no empty chats), with their project from the folder",
    u.sessions.length === 2 && ses[ide]?.title === "Search box debounce" && ses[ide].project === "lighthouse" && ses[ide].cwd === "/Users/alice/lighthouse" &&
    ses[cli]?.title === "Flaky upload test" && ses[cli].project === "lighthouse", u.sessions)
  check("a chat gets its conversation's tokens, value, model and time working", ses[ide].cost === 0.2 && ses[ide].tokens === 13800 &&
    ses[ide].model === "Claude 4.5 Sonnet" && ses[ide].active_min === 2 && ses[cli].cost === 0.3 && ses[cli].model === "GPT-5", [ses[ide], ses[cli]])
  check("Grok Bot's requests are Grok Bot's plugin's, not Cursor's",
    u.projects.map((p: any) => `${p.name}:${p.sessions}`).join() === "lighthouse:2" && !u.sessions.some((x: any) => x.id.startsWith("9b9b")), u.projects)
  check("by model", u.models.map((m: any) => m.name).join() === "GPT-5,Claude 4.5 Sonnet", u.models)
  check("days end today and count its conversations", u.days.length === 30 && u.days.at(-1).sessions >= 1 && u.days.reduce((a: number, d: any) => a + d.tokens, 0) === 17100, u.days.at(-1))
  const posts = seen.filter((x) => x.path !== "/api/usage-summary")
  check("asks with the IDE's session as the dashboard's cookie, with an Origin on POSTs", seen.length >= 3 &&
    seen.every((x) => /^WorkosCursorSessionToken=user_ana%3A%3AeyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(x.cookie)) &&
    posts.every((x) => x.origin === new URL(fake.env.CURSOR_API_URL).origin), seen.map((x) => x.path))
  check("the token never reaches an answer", !JSON.stringify(u).includes("eyJ"))
  const asked = seen.length
  await api("GET", "cursor?days=7")
  check("the account is kept in memory, not asked again on every request", seen.length === asked, seen.length)

  let t: any
  ;[c, t] = await api("GET", `cursor/session/${ide}`)
  check("session: an IDE chat's conversation, a tool call as one line with its result", c === 200 && t.title === "Search box debounce" &&
    t.cwd === "/Users/alice/lighthouse" && t.project === "lighthouse" && t.model === "Claude 4.5 Sonnet" &&
    t.entries.map((e: any) => e.kind).join() === "user,tool,assistant" && t.entries[1].name === "read_file" && t.entries[1].summary === "src/search.ts" &&
    t.entries[1].result.includes("export function search") && t.entries[0].at === "2026-09-28T09:00:00.000Z", [c, t])
  ;[c, t] = await api("GET", `cursor/session/${cli}`)
  check("session: a CLI chat's conversation in the order it was written, the prompt without Cursor's context",
    c === 200 && t.title === "Flaky upload test" && t.model === "GPT-5" && t.entries.map((e: any) => e.kind).join() === "user,assistant,tool,assistant" &&
    t.entries[0].text === "Why does the upload test fail?" && t.entries[2].name === "Shell" && t.entries[2].summary === "npm test -- upload" &&
    t.entries[2].error === true && t.entries[2].result === "1 failing: upload retries", [c, t])
  ;[, t] = await api("GET", `cursor/session/${cli}?limit=2&before=3`)
  check("session: pages", t.start === 1 && t.entries.length === 2 && t.total === 4 && t.entries[0].kind === "assistant", t)
  ;[c] = await api("GET", "cursor/session/9b9b9b9b-3333-4444-8555-666677778888")
  check("session: a conversation that isn't on this machine is a 404", c === 404, c)
  ;[c] = await api("GET", "cursor/session/..%2F..%2Fetc")
  check("session: not a path", c === 404, c)

  const agent = s.service("agent:cursor") as (o: any) => Promise<any>
  const [fresh, back, fromIde] = await Promise.all([agent({ resume: null, context: "x", state: null }), agent({ resume: cli, context: "x", state: null }),
    agent({ resume: ide, context: "x", state: null })])
  const gone = await agent({ resume: "0000aaaa-1111-4222-8333-444455556666", context: "x", state: null })
  check("agent: a chat that isn't on this machine isn't resumed", gone.command.startsWith("printf") && !/(^|\s)agent(\s|$)/.test(gone.command.replace(/'.*'/, "")), gone)
  check("agent: `agent`, resumed in its chat's folder; an IDE chat gets a new CLI chat in its folder",
    fresh.command === "agent" && !fresh.cwd && back.command === `agent --resume '${cli}'` && back.cwd === "/Users/alice/lighthouse" &&
    fromIde.command === "agent" && fromIde.cwd === "/Users/alice/lighthouse", [fresh, back, fromIde])
  const [, page] = await api("GET", "render?path=Dashboards/Cursor.md")
  check("its page as text", typeof page === "string" && page.includes("Included usage: 46.5% used") && page.includes("Search box debounce") &&
    page.includes("## Cursor by project") && !page.includes("Grok Bot"), String(page).slice(0, 600))
} finally {
  s.stop()
  fake.server.close()
  fs.rmSync(home, { recursive: true, force: true })
}
done()
