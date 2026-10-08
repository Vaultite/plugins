// This plugin runs Obsidian's plugins (its manifest: replaces obsidian "*"): the services the app's Obsidian settings
// use (obsidian:originals, obsidian:run), and Obsidian's community list for the Plugins page's Browse.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@vaultite/core/plugins.ts"
import { community, search, type Status } from "./directory.ts"
import type { Store } from "./store.ts"

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const statuses = (): Record<string, Status> => { try { return JSON.parse(fs.readFileSync(path.join(HERE, "compat.json"), "utf8")) } catch { return {} } }

export function wireRunner(plugin: Plugin, store: () => Store) {
  // Which are on and allowed, in /api/state: every window follows a change made elsewhere (an op, the Obsidian sheet).
  plugin.state(() => ({ obsidianCompat: store().list().map((p) => `${p.id}:${+p.enabled}${+p.allowed}`).join(",") }))
  plugin.provide("obsidian:originals", () => store().list().map((p) => ({ id: p.id, enabled: p.enabled, allowed: p.allowed })))
  // On (allowed here when `owner`: this machine's owner asked) or off; ids it hasn't the files of are left out.
  plugin.provide("obsidian:run", ({ ids, on, owner }: { ids: string[]; on: boolean; owner: boolean }) => {
    const done: string[] = []
    for (const id of ids) {
      const p = store().get(id)
      if (!p) continue
      if (on && owner && !p.allowed) store().allow(id)
      if (p.enabled !== on) store().setEnabled(id, on)
      done.push(id)
    }
    return { changed: done }
  })

  plugin.route("GET", "plugin-compat/directory", async (req) => {
    const c = await community(plugin)
    if (!c) return { available: false, entries: [], total: 0 }
    const { total, entries } = search(c, String(req.query.q ?? ""), String(req.query.sort ?? "downloads"))
    const have = new Map(store().list().map((p) => [p.id, p]))
    const natives = await plugin.ask<Record<string, { id: string; name: string; on: boolean; installed: boolean }[]>>("obsidian:stand-ins", {})
    const status = statuses()
    return {
      available: true, total, fetched: c.fetched,
      entries: entries.map((e) => ({ ...e, installed: have.has(e.id), desktopOnly: have.get(e.id)?.manifest.isDesktopOnly ?? null,
        status: status[e.id] ?? "untested", natives: [...natives[e.id] ?? []].sort((a, b) => +b.on - +a.on) })),
    }
  }, { lock: false })
}
