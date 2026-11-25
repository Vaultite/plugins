// Gemini in this process: the Usage limits page's text parsed, and read through a stand-in for the desktop app's browser
// (opened, waited on, read, closed) only once the user allows it.   node gemini/.test/test.ts
import { check, done, inProcess } from "../../testkit.ts"

const { resetsAt, usageOf } = await import("../usage.ts")

// What the page reads as (browser read), as Gemini drew it in November 2026.
const PAGE = (session: string, week: string) => `Gemini (→ /)
New chat (→ /app)
Alice Park
Pro (→ accounts.google.com/SignOutOptions?continue=https%3A%2F%2Fgemini.google.com)
Usage limits
PRO

Your plan's limits determine how much you can use Gemini over time. Advanced models and features can take up more usage.

Updated just now

Current usage
info
${session}
Weekly limit
${week}
Get 5x more usage with AI Ultra
Usage settings
Extra usage
Off`

const NOW = new Date(2026, 10, 25, 10, 0).getTime()
const local = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` }
const at = (s: string) => { const t = resetsAt(s, NOW); return t === null ? null : local(t * 1000) }
check("resets: a time today, tomorrow's when it's past, a date, next year's past one", at("at 2:53 PM") === "11/25 14:53" && at("at 9:15 AM") === "11/26 9:15" &&
  at("tomorrow at 12:05 AM") === "11/26 0:05" && at("Dec 2 at 9:53 AM") === "12/2 9:53" && at("Jan 3 at 8:00 PM") === "1/3 20:00" &&
  new Date(resetsAt("Jan 3 at 8:00 PM", NOW)! * 1000).getFullYear() === 2027 && at("in a while") === null,
  [at("at 2:53 PM"), at("at 9:15 AM"), at("tomorrow at 12:05 AM"), at("Dec 2 at 9:53 AM"), at("Jan 3 at 8:00 PM")])

const used = usageOf(PAGE("37% used\nResets at 2:53 PM", "Resets Dec 2 at 9:53 AM\n61.5% used"), NOW)
check("the plan and both windows, how much of each is used and when it resets", used?.plan === "Google AI Pro" &&
  used.windows.map((w) => `${w.id}:${w.label}:${w.minutes}:${w.used}:${w.resets_at ? local(Date.parse(w.resets_at)) : ""}`).join() ===
  "session:Current session:300:37:11/25 14:53,week:This week:10080:61.5:12/2 9:53", used)
const fresh = usageOf(PAGE("0% used\nResets at 2:53 PM", "Resets Dec 2 at 9:53 AM\n0% used"), NOW)
check("a window not started has no reset (the page says one a whole window from now)", fresh?.windows.every((w) => w.used === 0 && w.resets_at === null), fresh)
check("not the usage page (a sign-in page): nothing", usageOf("Sign in\nto continue to Gemini\nEmail or phone", NOW) === null)
check("a plan without a badge: windows, no plan", usageOf(PAGE("5% used", "1% used").replace("\nPRO\n", "\n"), NOW)?.plan === null)

const s = await inProcess(["gemini"])
const { api, write } = s
const gemini = s.app.plugins.find((p: { id: string }) => p.id === "gemini")
const asked: string[] = []
let shown = PAGE("37% used\nResets at 2:53 PM", "Resets Dec 2 at 9:53 AM\n61.5% used")
gemini.desktop = async (name: string, ...args: unknown[]) => {
  asked.push(name === "agent:open" ? `${name} ${String(args[0])} ${String(args[1])}` : name)
  if (name === "agent:open") return { tab: 7, url: String(args[0]), title: "Usage" }
  if (name === "agent:wait") return { tab: 7 }
  if (name === "agent:read") return { tab: 7, url: "https://gemini.google.com/usage", title: "Usage", text: shown }
  if (name === "agent:close") return { tab: 7 }
  throw new Error("no such call")
}
gemini.desktopWaiting = (_ms: number, name: string, ...args: unknown[]) => gemini.desktop(name, ...args)
try {
  let [c, u] = await api("GET", "gemini/limits")
  check("nothing read until the user allows it", c === 200 && u.plan === null && u.limits === null && asked.length === 0, [c, u, asked])
  write("Agents.md", "```block-agent-limits\nagent: gemini\n```\n")
  let [, page] = await api("GET", "render?path=Agents.md")
  check("its block as text asks to allow it", String(page).includes("allow it in Gemini's settings"), page)

  write(".vaultite/plugins/gemini/data.json", JSON.stringify({ account: true }))
  ;[c, u] = await api("GET", "gemini/limits")
  check("allowed: the page opened in the agents' container, waited on, read and closed", c === 200 &&
    asked.join() === "agent:open https://gemini.google.com/usage null,agent:wait,agent:read,agent:close", asked)
  check("its plan and limits, from the Gemini app", u.plan?.name === "Google AI Pro" && u.limits?.source === "Gemini app" && !!u.limits.observed &&
    u.limits.windows.map((w: { id: string; used: number }) => `${w.id}:${w.used}`).join() === "session:37,week:61.5", u)
  ;[c, u] = await api("GET", "gemini/limits")
  check("read once in 10 minutes, not on every look", asked.length === 4, asked)
  ;[, page] = await api("GET", "render?path=Agents.md")
  check("as text: each window, the plan and where it's from", /Current session: 37% used, renews/.test(String(page)) && String(page).includes("This week: 61.5% used") &&
    String(page).includes("Google AI Pro, from the Gemini app"), page)

  shown = "Choose an account\nto continue to Gemini"
  write(".vaultite/plugins/gemini/data.json", JSON.stringify({ account: true, container: "personal" }))
  await api("POST", "gemini/refresh")
  ;[c, u] = await api("GET", "gemini/limits")
  check("another container's sign-in, read again after a refresh", asked.at(-4) === "agent:open https://gemini.google.com/usage personal", asked)
  check("signed out: no limits, and the op says why", c === 200 && u.limits === null, u)
  const [, said] = await api("POST", "ops/gemini.limits?as=text", {})
  check("the op as text says where they come from and why none", /Usage limits page.*signed in to Google/.test(String(said)), said)

  gemini.desktop = async () => { throw new Error("no desktop app serves this vault") }
  write(".vaultite/plugins/gemini/data.json", JSON.stringify({ account: true, container: "work" }))
  const [oc, o] = await api("POST", "ops/gemini.limits", {})
  check("no desktop app: no limits, no failure", oc === 200 && o.windows.length === 0 && /no desktop app/.test(o.why), [oc, o])
} finally {
  s.stop()
}
done()
