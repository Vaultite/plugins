// What `agy -p /usage --output-format json` answers, as the limits block's windows: each model group's 5-hour and weekly
// limits, how much is used and when each resets.
import { limitWindow } from "@vaultite/core/agents.ts"

const WINDOWS: Record<string, { label: string; minutes: number }> = { "5h": { label: "Current session", minutes: 300 },
  weekly: { label: "This week", minutes: 10080 } }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const list = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : [])
const str = (v: unknown) => (typeof v === "string" ? v : "")

/** "Claude and GPT models" -> "Claude and GPT". */
const groupName = (name: string) => name.replace(/\s+models$/i, "").trim()

/** Its groups' windows, 5-hour before weekly within a group, or null when it isn't a usage answer. A window not started
 *  (all of it left) has no reset: agy then says one a whole window from now. */
export function windowsOf(answer: unknown, now: number): ReturnType<typeof limitWindow>[] | null {
  const data = isObj(answer) && isObj(answer.command) && answer.command.name === "usage" ? answer.command.data : null
  if (!isObj(data)) return null
  return list(data.groups).flatMap((g) => {
    const group = groupName(str(g.name))
    return list(g.buckets).flatMap((b) => {
      const w = WINDOWS[str(b.window)], left = b.remaining_fraction
      if (!w || typeof left !== "number" || !group) return []
      const used = Math.min(Math.max((1 - left) * 100, 0), 100), at = Date.parse(str(b.reset_time))
      return [limitWindow(str(b.id) || `${group}-${str(b.window)}`, `${w.label}, ${group}`, w.minutes, used,
        used > 0 && Number.isFinite(at) ? at / 1000 : null, now / 1000)]
    }).sort((x, y) => x.minutes - y.minutes)
  })
}

/** The signed-in account, from the line agy logs as it signs in. */
export const accountOf = (log: string) => /applyAuthResult: email=([^,\s]+)/.exec(log)?.[1] ?? null
