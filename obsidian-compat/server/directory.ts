// Obsidian's community plugins (obsidianmd/obsidian-releases: the list and its download counts), fetched once a day and
// kept in this plugin's cache for when GitHub can't be reached, searched for the Plugins page's Browse.
import type { Plugin } from "@vaultite/core/plugins.ts"

const RAW = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master"
export type Listing = { id: string; name: string; author: string; description: string; repo: string }
type Stats = Record<string, { downloads?: number; updated?: number }>
export type Community = { plugins: Listing[]; stats: Stats; fetched: string }
// (unneeded: what it does, Vaultite does itself: Obsidian's look, images in the editor)
export type Status = "works" | "partly" | "no" | "unneeded" | "untested"
export type Entry = Listing & { downloads: number; updated: number | null }

const str = (v: unknown) => (typeof v === "string" ? v : "")

async function fetchCommunity(): Promise<Community> {
  const get = async (f: string) => { const r = await fetch(`${RAW}/${f}`); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json() }
  const [list, stats] = await Promise.all([get("community-plugins.json"), get("community-plugin-stats.json")])
  const plugins = (Array.isArray(list) ? list : []).flatMap((e): Listing[] => (e && typeof e === "object" && str(e.id) && str(e.repo)
    ? [{ id: str(e.id), name: str(e.name) || str(e.id), author: str(e.author), description: str(e.description), repo: str(e.repo) }] : []))
  const counts: Stats = {}
  for (const [id, s] of Object.entries((stats ?? {}) as Record<string, Record<string, unknown>>)) counts[id] = { downloads: Number(s?.downloads) || 0, updated: Number(s?.updated) || undefined }
  return { plugins, stats: counts, fetched: new Date().toISOString() }
}

/** The list, a day old at most; the last one fetched when it can't be (null: never fetched). */
export async function community(plugin: Plugin): Promise<Community | null> {
  try {
    const c = await plugin.memo(24 * 3600, fetchCommunity)
    if ((plugin.readCache() as Community | null)?.fetched !== c.fetched) plugin.writeCache(c)
    return c
  } catch {
    const c = plugin.readCache() as Community | null
    return c?.plugins ? c : null
  }
}

/** The first `limit` matching `q` (name, author, description, id), by downloads, newest update or name. */
export function search(c: Community, q: string, sort: string, limit = 100) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const all: Entry[] = c.plugins.map((p) => ({ ...p, downloads: c.stats[p.id]?.downloads ?? 0, updated: c.stats[p.id]?.updated ?? null }))
  const hit = words.length ? all.filter((p) => { const t = `${p.name} ${p.author} ${p.description} ${p.id}`.toLowerCase(); return words.every((w) => t.includes(w)) }) : all
  const named = (p: Entry) => (words.length && p.name.toLowerCase().includes(words.join(" ")) ? 1 : 0)
  hit.sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name) : sort === "updated" ? (a, b) => (b.updated ?? 0) - (a.updated ?? 0)
    : (a, b) => named(b) - named(a) || b.downloads - a.downloads)
  return { total: hit.length, entries: hit.slice(0, limit) }
}
