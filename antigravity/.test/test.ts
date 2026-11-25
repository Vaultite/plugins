// Antigravity in this process, asking a stand-in for agy (AGY_BIN): /usage in print mode as JSON, its log in a file of
// ours, read at most every 3 minutes.   node antigravity/.test/test.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, done, inProcess } from "../../testkit.ts"

const { accountOf, windowsOf } = await import("../usage.ts")

const NOW = Date.parse("2026-11-25T17:00:00Z")
const bucket = (id: string, window: string, left: number, reset: string) => ({ id, name: `${window} limit remaining`, window, remaining_fraction: left, reset_time: reset })
const USAGE = { conversation_id: "", status: "SUCCESS", response: "...", num_turns: 0, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: [bucket("gemini-weekly", "weekly", 0.9456, "2026-12-02T15:33:07Z"), bucket("gemini-5h", "5h", 0.8626, "2026-11-25T20:33:07Z")] },
  { name: "Claude and GPT models", buckets: [bucket("3p-weekly", "weekly", 1, "2026-12-02T17:00:00Z"), bucket("3p-5h", "5h", 1, "2026-11-25T22:00:00Z"),
    bucket("3p-day", "daily", 0.5, "2026-11-26T00:00:00Z")] }] } } }

const w = windowsOf(USAGE, NOW)
check("each group's 5-hour then weekly window, how much is used, when it resets", w?.map((x) => `${x.id}|${x.label}|${x.minutes}|${x.used}|${x.resets_at}`).join("\n") === [
  "gemini-5h|Current session, Gemini|300|13.7|2026-11-25T20:33:07.000Z", "gemini-weekly|This week, Gemini|10080|5.4|2026-12-02T15:33:07.000Z",
  "3p-5h|Current session, Claude and GPT|300|0|null", "3p-weekly|This week, Claude and GPT|10080|0|null"].join("\n"), w)
check("another command's answer, or none: no windows", windowsOf({ command: { name: "credits", data: {} } }, NOW) === null && windowsOf("x", NOW) === null)
check("the account from agy's sign-in line", accountOf("I1125 server_oauth.go:221] applyAuthResult: email=alice@example.com, authMethod=consumer") === "alice@example.com" &&
  accountOf("nothing") === null)

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-agy-test-"))
const fake = path.join(home, "agy"), calls = path.join(home, "calls.txt"), answer = path.join(home, "usage.json")
fs.writeFileSync(answer, JSON.stringify(USAGE))
fs.writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${calls}"
while [ $# -gt 0 ]; do [ "$1" = "--log-file" ] && echo "I1125 applyAuthResult: email=alice@example.com, authMethod=consumer" > "$2"; shift; done
cat "${answer}"
`, { mode: 0o755 })
const s = await inProcess(["antigravity"], { env: { AGY_BIN: fake } })
const { api, write } = s
try {
  let [c, u] = await api("GET", "antigravity/limits")
  const asked = fs.readFileSync(calls, "utf8").trim().split("\n")
  check("agy asked for /usage in print mode as JSON, its log in a file of ours", asked.length === 1 &&
    /^-p \/usage --output-format json --print-timeout 60s --log-file \S+vaultite-agy-\S+\/agy\.log$/.test(asked[0]), asked)
  check("no file of ours left behind", !fs.readdirSync(os.tmpdir()).some((n) => n.startsWith("vaultite-agy-") && !home.endsWith(n)))
  check("its limits, no plan (agy doesn't say its tier), from the CLI as the account it's signed in as", c === 200 && u.plan === null &&
    u.limits?.source === "Antigravity CLI (alice@example.com)" && u.limits.windows.length === 4 && !!u.limits.observed, u)
  ;[c, u] = await api("GET", "antigravity/limits")
  check("asked once in 3 minutes, not on every look", fs.readFileSync(calls, "utf8").trim().split("\n").length === 1)
  write("Agents.md", "```block-agent-limits\nagent: antigravity\n```\n")
  const [, page] = await api("GET", "render?path=Agents.md")
  check("as text: each window and where it's from", /Current session, Gemini: 13\.7% used, renews/.test(String(page)) &&
    String(page).includes("This week, Claude and GPT: 0% used") && String(page).includes("From the Antigravity CLI (alice@example.com)"), page)

  fs.writeFileSync(answer, "Please sign in")
  await api("POST", "antigravity/refresh")
  ;[c, u] = await api("GET", "antigravity/limits")
  const [, said] = await api("POST", "ops/antigravity.limits?as=text", {})
  check("asked again after a refresh; no JSON (signed out): no limits, and why", c === 200 && u.limits === null &&
    fs.readFileSync(calls, "utf8").trim().split("\n").length === 2 && /agy's \/usage answered no JSON/.test(String(said)), [u, said])
} finally {
  s.stop()
  fs.rmSync(home, { recursive: true, force: true })
}
done()
