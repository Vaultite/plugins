// Antigravity: Google's coding agent CLI (agy). Its plan's limits, each model group's 5-hour and weekly windows, asked
// from agy on this machine (`/usage` in print mode, which runs no turn); nothing kept but the last answer, in memory.
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { ago, findBin, isoOf, type Limits, limitRows, when } from "@vaultite/core/agents.ts"
import { Plugin, section } from "@vaultite/core/plugins.ts"
import { accountOf, windowsOf } from "./usage.ts"

export const plugin = new Plugin(import.meta.url)
const run = promisify(execFile)
const EVERY = 180 // s: how stale an answer may get before a block showing it asks again
const SOURCE = "Antigravity CLI"
// AGY_BIN: the tests' stand-in for agy.
const agy = () => process.env.AGY_BIN || findBin("agy")

type Read = { at: number; limits: Limits | null; why: string | null }

/** Its own log goes to a file of ours (agy's log folder and its cli.log link stay the running sessions'): the account. */
async function ask(bin: string): Promise<Read> {
  const at = Date.now(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-agy-")), log = path.join(dir, "agy.log")
  try {
    const { stdout } = await run(bin, ["-p", "/usage", "--output-format", "json", "--print-timeout", "60s", "--log-file", log],
      { cwd: dir, timeout: 75_000, maxBuffer: 4 << 20, env: process.env })
    let answer: unknown = null
    try { answer = JSON.parse(stdout) } catch { return { at, limits: null, why: "agy's /usage answered no JSON" } }
    const windows = windowsOf(answer, Date.now())
    if (!windows?.length) return { at, limits: null, why: "agy's /usage listed no limits: is it signed in (run agy once)?" }
    let account: string | null = null
    try { account = accountOf(fs.readFileSync(log, "utf8")) } catch { /* no log: no account said */ }
    return { at, limits: { source: account ? `${SOURCE} (${account})` : SOURCE, observed: isoOf(at), windows }, why: null }
  } catch (e) {
    return { at, limits: null, why: `agy couldn't say its usage: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function read(): Promise<Read> {
  const bin = agy()
  if (!bin) return { at: Date.now(), limits: null, why: "agy isn't installed on this machine" }
  return plugin.memoStale(EVERY, async function agyUsage(b: string) { return ask(b) }, bin)
}

plugin.route("GET", "antigravity/limits", async () => ({ plan: null, limits: (await read()).limits }))
let forgot = 0
plugin.route("POST", "antigravity/refresh", () => {
  if (Date.now() - forgot > 10_000) { forgot = Date.now(); plugin.forget() }
  return { ok: true }
})

const NOTHING = (why: string | null) => `No limits read yet: they come from Antigravity's CLI (agy) on this machine${why ? ` (${why})` : ""}.`

plugin.block("agent-limits", async () => {
  const { limits, why } = await read()
  if (!limits) return section("Antigravity plan limits", `_${NOTHING(why)}_`)
  return section("Antigravity plan limits", limitRows(limits.windows), `_From the ${limits.source}, ${ago(limits.observed)}._`)
})

plugin.op({
  id: "antigravity.limits", cli: "antigravity limits", mcp: "antigravity_limits", owner: "Antigravity on this machine", kind: "read", lock: false,
  summary: "Antigravity's plan limits on this machine: for each model group (Gemini; Claude and GPT), how much of its 5-hour window and its week is used, and when each resets.",
  help: `Asked from agy (Antigravity's CLI, signed in) on the machine the server runs on, at most every 3 minutes; that
machine's server answers for another (vau --url <its server>).

  vau antigravity limits`,
  params: {},
  run: async () => {
    const { limits, why } = await read()
    return { windows: limits?.windows ?? [], source: limits?.source ?? null, observed: limits?.observed ?? null, ...(why ? { why } : {}) }
  },
  text: (r) => (!r.windows.length ? NOTHING(r.why ?? null)
    : [`From the ${r.source}, ${ago(r.observed)}:`, ...r.windows.map((w: { label: string; used: number; resets_at: string | null }) =>
      `${w.label}: ${w.used}% used${w.resets_at ? `, resets ${when(w.resets_at)}` : ""}`)].join("\n")),
})
