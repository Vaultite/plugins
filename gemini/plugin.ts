// Gemini: the Gemini app's plan limits (its 5-hour and weekly usage), read from its Usage limits page in the agents'
// browser with the Google sign-in there, once the user allows it. Nothing is kept but the last read, in memory.
import { ago, isoOf, type Limits, limitRows, when } from "@vaultite/core/agents.ts"
import { Plugin, section } from "@vaultite/core/plugins.ts"
import { type Usage, USAGE_PAGE, usageOf } from "./usage.ts"

export const plugin = new Plugin(import.meta.url)
const EVERY = 600 // s: how stale a read may get before a block showing it asks again
const BY = { name: "Gemini", session: "", task: "plan limits", summary: "Reading the Gemini app's usage limits", remote: false }
const SOURCE = "Gemini app"

/** Whether the user allowed reading their account (unset: not asked yet), and in which browser container. */
const allowed = () => plugin.settings().account === true
const containerOf = () => { const c = plugin.settings().container; return typeof c === "string" && c.trim() ? c.trim() : null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const tabOf = (v: unknown) => (isObj(v) && typeof v.tab === "number" ? v.tab : null)
const textOf = (v: unknown) => (isObj(v) && typeof v.text === "string" ? v.text : "")
const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Read = { at: number; usage: Usage | null; why: string | null }

/** The page opened in the background, read once it shows its windows, and closed. */
async function readPage(container: string | null): Promise<Read> {
  const at = Date.now()
  let tab: number | null = null
  try {
    tab = tabOf(await plugin.desktop("agent:open", USAGE_PAGE, container, BY, "none"))
    if (tab === null) return { at, usage: null, why: "the browser opened no tab" }
    await plugin.desktopWaiting(15_000, "agent:wait", tab, { text: "Weekly limit" }, 15_000).catch(() => null)
    const usage = usageOf(textOf(await plugin.desktop("agent:read", tab)), Date.now())
    return { at, usage, why: usage ? null : "the page shows no usage limits: is the agents' browser signed in to Google with the plan?" }
  } catch (e) {
    return { at, usage: null, why: why(e) }
  } finally {
    if (tab !== null) await plugin.desktop("agent:close", tab).catch(() => {})
  }
}

async function read(): Promise<Read | null> {
  if (!allowed()) return null
  return plugin.memoStale(EVERY, async function geminiUsage(container: string | null) { return readPage(container) }, containerOf())
}

async function planLimits(): Promise<{ plan: { name: string; monthly: null } | null; limits: Limits | null; why: string | null }> {
  const r = await read()
  if (!r) return { plan: null, limits: null, why: null }
  const u = r.usage
  return { plan: u?.plan ? { name: u.plan, monthly: null } : null, limits: u ? { source: SOURCE, observed: isoOf(r.at), windows: u.windows } : null, why: r.why }
}

plugin.route("GET", "gemini/limits", async () => {
  const { plan, limits } = await planLimits()
  return { plan, limits }
})
let forgot = 0
plugin.route("POST", "gemini/refresh", () => {
  if (Date.now() - forgot > 10_000) { forgot = Date.now(); plugin.forget() }
  return { ok: true }
})

const NOT_ALLOWED = "Gemini's usage isn't read: allow it in Gemini's settings (Read usage from your Google account)."
const NOTHING = (w: string | null) => `No limits read yet: they come from the Gemini app's Usage limits page, read in the agents' browser signed in to Google${w ? ` (${w})` : ""}.`

plugin.block("agent-limits", async () => {
  const { plan, limits, why: w } = await planLimits()
  if (!allowed()) return section("Gemini plan limits", `_${NOT_ALLOWED}_`)
  if (!limits) return section("Gemini plan limits", `_${NOTHING(w)}_`)
  return section("Gemini plan limits", limitRows(limits.windows), `_${plan ? `${plan.name}, from` : "From"} the ${limits.source}, ${ago(limits.observed)}._`)
})

plugin.op({
  id: "gemini.limits", cli: "gemini limits", mcp: "gemini_limits", owner: "Gemini", kind: "read", lock: false,
  summary: "The Gemini app's plan limits: how much of its 5-hour window and its week is used, and when each resets, as its Usage limits page says.",
  help: `Read from gemini.google.com/usage in the agents' browser, with the Google account signed in there (at most every
10 minutes; a read waits for the page). Only once the user allowed it in Gemini's settings.

  vau gemini limits`,
  params: {},
  run: async () => {
    const { plan, limits, why: w } = await planLimits()
    return { allowed: allowed(), plan: plan?.name ?? null, windows: limits?.windows ?? [], source: limits?.source ?? null, observed: limits?.observed ?? null,
      ...(w ? { why: w } : {}) }
  },
  text: (r) => (!r.allowed ? NOT_ALLOWED : !r.windows.length ? NOTHING(r.why ?? null)
    : [`${r.plan ?? "Gemini"}, from the ${r.source}, ${ago(r.observed)}:`, ...r.windows.map((w: { label: string; used: number; resets_at: string | null }) =>
      `${w.label}: ${w.used}% used${w.resets_at ? `, resets ${when(w.resets_at)}` : ""}`)].join("\n")),
})
