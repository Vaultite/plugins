// Icons on the server: every folder's and file's icon in the store (its settings over Obsidian's Iconize's), `icons.set`
// for the app and agents (a note's in its own icon: and tint:), and the settings' paths following moves.
import fs from "node:fs"
import { OpError, Plugin } from "@vaultite/core/plugins.ts"
import { setPropertyText } from "@vaultite/core/vault.ts"

export const plugin = new Plugin(import.meta.url)

type Icon = { icon?: string; tint?: string }
export const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink", "gray"]
const HUES: [number, string][] = [[15, "red"], [40, "orange"], [70, "yellow"], [160, "green"], [195, "teal"], [230, "blue"], [260, "indigo"], [295, "purple"], [340, "pink"], [360, "red"]]

/** A colour as the nearest of the app's (`#e5534b`: red), by hue; greys are gray. */
export function tintOf(c: unknown): string | undefined {
  if (typeof c !== "string") return undefined
  if (TINTS.includes(c)) return c
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return undefined
  const hex = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  if (d < 0.12) return "gray"
  const hue = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
  return HUES.find(([h]) => hue < h)![1]
}

/** Iconize's icon name as the app's: Lucide's pack ("LiFolderGit2": folder-git2) and emojis; other packs aren't here. */
export function nameOf(n: unknown): string | null {
  if (typeof n !== "string" || !n) return null
  if (/^Li[A-Z0-9]/.test(n)) return n.slice(2).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
  return /[^\x00-\x7f]/.test(n) ? n : null
}

/** Obsidian's Iconize settings (paths to "LiRocket", or {iconName, iconColor}) as icons by path. */
export function iconize(data: Record<string, unknown>): Record<string, Icon> {
  const out: Record<string, Icon> = {}
  for (const [path, v] of Object.entries(data)) {
    const o = (typeof v === "string" ? { iconName: v } : v ?? {}) as { iconName?: unknown; iconColor?: unknown }
    const icon = path !== "settings" && nameOf(o.iconName)
    if (icon) out[path] = { icon, tint: tintOf(o.iconColor) }
  }
  return out
}
const theirs = () => {
  try { return iconize(JSON.parse(fs.readFileSync(plugin.vault.abs(".obsidian/plugins/obsidian-icon-folder/data.json"), "utf8"))) } catch { return {} }
}
const mine = (s: Record<string, unknown> | null = plugin.settings({})) =>
  (s?.icons && typeof s.icons === "object" ? s.icons : {}) as Record<string, Icon>

/** Its own icons over Iconize's; one taken away (no icon, no colour) hides Iconize's. */
plugin.state(() => ({
  icons: Object.fromEntries(Object.entries({ ...theirs(), ...mine() }).filter(([, i]) => i.icon || i.tint)),
}))

plugin.op({
  id: "icons.set",
  cli: "icons set",
  mcp: true,
  summary: "Give a folder or file an icon and a colour, or take them away.",
  help: `A note's go in its own icon: and tint: properties; a folder's or another file's in the Icons settings. Leave one
out to keep it; an empty one takes it away.

  vau icons set Projects --icon rocket --tint blue
  vau icons set "Notes/Ideas.md" --icon 💡
  vau icons set Attachments --icon "" --tint ""`,
  kind: "write",
  lock: false,
  params: {
    path: { type: "string", format: "path", required: true, description: "the folder or file" },
    icon: { type: "string", description: "a Lucide icon's name (rocket, folder-git-2) or an emoji; empty: none" },
    tint: { type: "string", enum: ["", ...TINTS], description: "its colour; empty: none" },
  },
  args: ["path"],
  run: async (p, ctx) => {
    const path = String(p.path).replace(/^\/+|\/+$/g, ""), abs = plugin.vault.abs(path)
    if (!path || !fs.existsSync(abs)) throw new OpError(`There's no ${path || "path"} in the vault`)
    const change: Icon = Object.fromEntries((["icon", "tint"] as const).filter((k) => p[k] !== undefined).map((k) => [k, String(p[k]).trim()]))
    if (/\.md$/i.test(path)) {
      const base = await fs.promises.readFile(abs, "utf8")
      let text: string | null = base
      for (const [k, v] of Object.entries(change)) text = text && setPropertyText(text, k, v || undefined)
      if (text === null) throw new OpError(`${path}'s frontmatter can't be changed line by line: set icon: by hand`)
      if (text !== base) await ctx.op("file.write", { path, text, base })
      return { path, ...change }
    }
    const s = plugin.readSettings() ?? {}, all = { ...mine(s) }
    const now = Object.fromEntries(Object.entries({ ...all[path], ...change }).filter(([, v]) => v)) as Icon
    if (now.icon || now.tint || theirs()[path]) all[path] = now
    else delete all[path]
    await plugin.saveSettings({ ...s, icons: all })
    return { path, ...now }
  },
  text: (r) => `${r.path}: ${r.icon || "no icon"}${r.tint ? `, ${r.tint}` : ""}`,
})

// A folder or file moved (or trashed): its icon, and those of what's in it, follow.
plugin.onMove(async (from, to) => {
  let s: Record<string, unknown> | null
  try { s = plugin.readSettings() } catch { return }
  const all = mine(s), under = (p: string) => p === from || p.startsWith(`${from}/`)
  if (!Object.keys(all).some(under)) return
  await plugin.saveSettings({ ...s, icons: Object.fromEntries(Object.entries(all).flatMap(([p, i]) =>
    !under(p) ? [[p, i]] : to ? [[to + p.slice(from.length), i]] : [])) })
})
