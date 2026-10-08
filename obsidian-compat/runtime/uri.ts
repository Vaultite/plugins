// obsidian://<action> links: a plugin's registered handler gets them (as Obsidian passes them: action + query), and a
// plugin opening one (window.open) goes through the app's link handling rather than the system's.
import { takeSchemeLink } from "@vaultite"
import { registered } from "./state.ts"

/** Run `url` with the handler `plugin` registered for its action: whether it had one. */
export function runUri(url: string, plugin?: string) {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== "obsidian:") return false
  const action = u.hostname || u.pathname.replace(/^\/+/, "")
  const h = registered.protocols.get(action)
  if (!h || (plugin && h.plugin !== plugin)) return false
  const params: Record<string, string> = { action }
  for (const [k, v] of u.searchParams) params[k] = v
  try { void h.fn(params) } catch (e) { console.error(e) }
  return true
}

let patched = false
export function routeWindowOpen() {
  if (patched) return
  patched = true
  const open = window.open.bind(window)
  window.open = (url?: string | URL, ...rest: any[]) => {
    const s = String(url ?? "")
    if (/^obsidian:/i.test(s)) { takeSchemeLink(s); return null }
    return open(url, ...rest)
  }
}
