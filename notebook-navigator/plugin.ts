// The list's previews: each note's first lines and first image, from the vault's index (no disk reads), kept per read
// of the file (the index makes a new entry when it changes).
import { Plugin } from "@vaultite/core/plugins.ts"

export const plugin = new Plugin(import.meta.url)

type Entry = { rel: string; fm: Record<string, unknown>; body: string }
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|heic)$/i
const seen = new WeakMap<Entry, [string, string]>()

/** An image a note names (`![[pic.png]]`, `![](a/pic.png)`, `image: pic.png`) as a vault path, or "". */
function imageAt(name: string, from: string): string {
  let t = name.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim().replace(/^\.?\//, "")
  try { t = decodeURI(t) } catch { /* (as written) */ }
  if (!IMAGE.test(t)) return ""
  const others = plugin.vault.others, near = from.includes("/") ? `${from.slice(0, from.lastIndexOf("/"))}/${t}` : t
  if (others.has(t)) return t
  if (others.has(near)) return near
  for (const p of others.keys()) if (p.endsWith(`/${t}`)) return p
  return ""
}

function preview(e: Entry): [string, string] {
  const hit = seen.get(e)
  if (hit) return hit
  // Code and blocks (views, not text), comments and the opening heading (most often the title) are left out.
  const body = e.body.replace(/^(```|~~~)[^]*?^\1[^\n]*$/gm, "").replace(/<!--[^]*?-->|%%[^]*?%%/g, "")
  const cover = ["image", "cover", "banner"].map((k) => e.fm[k]).find((v) => typeof v === "string") as string | undefined
  let image = cover ? imageAt(cover, e.rel) : ""
  for (const m of body.matchAll(/!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)\s]+)/g)) if (!image) image = imageAt(m[1] ?? m[2], e.rel)
  const text = body.replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, "").trimStart().replace(/^#{1,6} .*\n?/, "").trim().slice(0, 400)
  const out: [string, string] = [text, image]
  seen.set(e, out)
  return out
}

plugin.route("POST", "notebook-navigator/previews", (req) => {
  const out: Record<string, [string, string]> = {}
  for (const p of Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 2000) : []) {
    const e = typeof p === "string" ? plugin.vault.entries.get(p) : undefined
    if (e) out[p] = preview(e as unknown as Entry)
  }
  return out
}, { lock: false })
