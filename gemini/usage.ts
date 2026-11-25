// The Gemini app's Usage limits page (gemini.google.com/usage) read as text: its plan's badge, its 5-hour and weekly
// windows, how much of each is used and when each resets (said in the browser's clock, the server machine's here).
import { limitWindow } from "@vaultite/core/agents.ts"

export const USAGE_PAGE = "https://gemini.google.com/usage"

const PLANS: Record<string, string> = { PLUS: "Google AI Plus", PRO: "Google AI Pro", ULTRA: "Google AI Ultra" }
const WINDOWS = [{ said: "Current usage", id: "session", label: "Current session", minutes: 300 },
  { said: "Weekly limit", id: "week", label: "This week", minutes: 10080 }]
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

export type Usage = { plan: string | null; windows: ReturnType<typeof limitWindow>[] }

/** "at 2:53 PM", "tomorrow at 9:05 AM", "Dec 2 at 9:53 AM" -> epoch s: the next such time after `now` (epoch ms). */
export function resetsAt(said: string, now: number): number | null {
  const m = /^(?:(today|tomorrow)\s+|([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\s+)?at\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(said.trim())
  if (!m) return null
  const [, rel, mon, day, year, h, min, ap] = m
  const hour = (Number(h) % 12) + (ap.toLowerCase() === "p" ? 12 : 0), d = new Date(now)
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase())
    if (month < 0) return null
    let t = new Date(Number(year) || d.getFullYear(), month, Number(day), hour, Number(min))
    if (!year && t.getTime() < now - 86400_000) t = new Date(d.getFullYear() + 1, month, Number(day), hour, Number(min))
    return t.getTime() / 1000
  }
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (rel?.toLowerCase() === "tomorrow" ? 1 : 0), hour, Number(min))
  if (!rel && t.getTime() < now - 60_000) t.setDate(t.getDate() + 1)
  return t.getTime() / 1000
}

/** The page's text -> its plan and windows, or null when it isn't the usage page (signed out, another page). A window
 *  not started (0% used) has no reset: the page then says one a whole window from now. */
export function usageOf(text: string, now: number): Usage | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  const head = lines.indexOf("Usage limits")
  if (head < 0) return null
  const badge = lines[head + 1] ?? ""
  const starts = WINDOWS.map((w) => lines.indexOf(w.said))
  const windows = WINDOWS.flatMap((w, i) => {
    if (starts[i] < 0) return []
    const next = Math.min(...starts.filter((s) => s > starts[i]), starts[i] + 6)
    const part = lines.slice(starts[i] + 1, next)
    const used = part.map((l) => /^(\d+(?:\.\d+)?)\s*% used$/i.exec(l)).find(Boolean)
    if (!used) return []
    const pct = Math.min(Number(used[1]), 100), said = part.map((l) => /^Resets\s+(.+)$/i.exec(l)?.[1]).find(Boolean)
    return [limitWindow(w.id, w.label, w.minutes, pct, pct > 0 && said ? resetsAt(said, now) : null, now / 1000)]
  })
  return windows.length ? { plan: PLANS[badge.toUpperCase()] ?? null, windows } : null
}
