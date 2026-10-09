// BrowserOS neo's agent sessions on this machine, from its local server (what its cockpit reads), and a tab of theirs
// brought in front through BrowserOS's AppleScript (its MCP and CDP can't focus a tab).
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HTTPError, Plugin, Text } from "@vaultite/core/plugins.ts"
import type { Session } from "./types.ts"

export const plugin = new Plugin(import.meta.url)

const CONFIG = path.join(os.homedir(), "Library/Application Support/BrowserClaw/.browseros/config.json")

/** Its server's address: the port it wrote in its config (9200 unless taken); BROWSEROS_NEO_API for tests. */
function base() {
  if (process.env.BROWSEROS_NEO_API) return process.env.BROWSEROS_NEO_API
  let port = 9200
  try { port = Number(JSON.parse(fs.readFileSync(CONFIG, "utf8")).ports?.server) || port } catch { /* not installed */ }
  return `http://127.0.0.1:${port}/api/v1`
}

type NeoTab = { browserTabId: number; url: string; title: string; lastActivityAt?: number; lastToolName?: string }
type NeoSession = { sessionId: string; label?: string; slug: string; name?: string; site?: string; startedAt: number
  live?: { state?: string; browserTabs?: NeoTab[]; helpRequest?: { requestedAt: number; url?: string; reason?: string } } }


const toSession = (s: NeoSession): Session => {
  const t = [...s.live?.browserTabs ?? []].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
  const help = s.live?.helpRequest
  return {
    id: s.sessionId, agent: s.label || s.slug, name: s.name ?? "", site: s.site ?? "", startedAt: s.startedAt,
    active: s.live?.state === "active", tab: t ? { id: t.browserTabId, url: t.url, title: t.title } : null,
    help: help ? { reason: help.reason ?? "", at: help.requestedAt } : null,
  }
}

plugin.route("GET", "browseros/sessions", async () => {
  try {
    const r = await fetch(`${base()}/sessions?status=live`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) return { running: true, sessions: [] }
    const { items } = await r.json() as { items: NeoSession[] }
    return { running: true, sessions: items.map(toSession) }
  } catch {
    return { running: false, sessions: [] }
  }
}, { lock: false })

// (a JPEG of the session's tab as it is now)
plugin.route("GET", "browseros/preview/*", async (req) => {
  const tab = /^\d+$/.test(req.query.tab ?? "") ? `?browserTabId=${req.query.tab}` : ""
  const r = await fetch(`${base()}/sessions/${encodeURIComponent(req.arg(0))}/preview${tab}`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (!r?.ok) throw new HTTPError(404, "no preview")
  return new Text(Buffer.from(await r.arrayBuffer()), r.headers.get("content-type") ?? "image/jpeg", { "Cache-Control": "no-store" })
}, { lock: false })

const SELECT = `on run argv
  set want to item 1 of argv
  tell application id "com.browseros.BrowserClaw"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if (id of t as text) is want then
          set active tab index of w to i
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "gone"
end run`

plugin.route("POST", "browseros/focus", async (req) => {
  if (process.platform !== "darwin") throw new HTTPError(400, "Showing a tab of BrowserOS works on a Mac")
  const why = req.http ? await plugin.refusal(req.http, "BrowserOS") : ""
  if (why) throw new HTTPError(403, why)
  const tab = Number(req.body.tab)
  if (!Number.isInteger(tab) || tab <= 0) throw new HTTPError(400, "tab: a BrowserOS tab id")
  const out = await new Promise<string>((resolve, reject) => execFile("osascript", ["-e", SELECT, String(tab)], { timeout: 5000 },
    (err, stdout) => (err ? reject(new HTTPError(500, String(err.message).split("\n")[0])) : resolve(stdout.trim()))))
  if (out !== "ok") throw new HTTPError(404, "That tab is closed")
  return { ok: true }
}, { lock: false })
