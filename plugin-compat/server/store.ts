// The Obsidian plugins this vault has: Obsidian's own (.obsidian/plugins/) and those installed here, which are on
// (community-plugins.json, as Obsidian keeps it), and whether this machine's owner allowed each one's code.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.ts"

export const ID = /^[a-z0-9][a-z0-9._-]*$/i
export type Manifest = { id: string; name: string; version: string; minAppVersion?: string; isDesktopOnly?: boolean; description?: string; author?: string; authorUrl?: string; fundingUrl?: unknown }
export type Disclosures = { network?: string[]; shell?: boolean; outsideVault?: boolean; clipboard?: boolean }
export type Installed = { id: string; manifest: Manifest; enabled: boolean; styles: boolean; hash: string; allowed: boolean; here: boolean; disclosures: Disclosures
  /** Allowed here once, at another version of its code. */
  changed: boolean }
/** This machine's yes to code by its hash (the plugin's allows/allow), and a folder of its own on this machine. */
export type Trust = { allows: (what: string) => boolean; allow: (what: string) => void; local: () => string }

const reaches = new Map<string, Disclosures>()
/** What its code can reach beyond the vault, read from main.js (Node's modules, the network, the clipboard). */
function scan(hash: string, read: () => string): Disclosures {
  const hit = reaches.get(hash)
  if (hit) return hit
  const main = read()
  const req = (m: string) => new RegExp(`require\\(["'](node:)?${m}["']\\)`).test(main)
  const d: Disclosures = {}
  if (/requestUrl|fetch\(|XMLHttpRequest|WebSocket/.test(main)) d.network = ["*"]
  if (req("child_process")) d.shell = true
  if (req("fs") || req("fs/promises") || req("original-fs")) d.outsideVault = true
  if (/navigator\.clipboard\.read|clipboard\.readText/.test(main)) d.clipboard = true
  reaches.set(hash, d)
  return d
}

const hashes = new Map<string, { sig: string; hash: string }>()
const CODE = ["manifest.json", "main.js", "styles.css"]

export class Store {
  config: Config
  trust: Trust
  constructor(config: Config, trust: Trust) { this.config = config; this.trust = trust }

  // The hash each was last allowed at, so one whose code changed says so (kept on this machine, like the yes itself).
  private lastFile = () => path.join(this.trust.local(), "allowed.json")
  private last(): Record<string, string> { try { return JSON.parse(fs.readFileSync(this.lastFile(), "utf8")) } catch { return {} } }
  /** Let its code run on this machine as it is now. */
  allow(id: string) {
    const hash = this.hashOf(id)
    this.trust.allow(this.trustKey(id, hash))
    fs.writeFileSync(this.lastFile(), JSON.stringify({ ...this.last(), [id]: hash }))
  }

  enabledIds(): string[] {
    const l = this.config.json<unknown>(".obsidian/community-plugins.json")
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string" && ID.test(x)) : []
  }
  setEnabled(id: string, on: boolean) {
    const ids = this.enabledIds().filter((x) => x !== id)
    this.config.write(".obsidian/community-plugins.json", JSON.stringify(on ? [...ids, id] : ids, null, 2))
  }
  /** Its code's hash (manifest, main.js, styles.css): what this machine's owner allows. */
  hashOf(id: string) {
    const files = CODE.map((f) => this.config.readable(`.obsidian/plugins/${id}/${f}`))
    // (ctime and inode too: a synced file can arrive with the same size and modified time, never the same ctime)
    const sig = files.map((f) => { try { const s = f ? fs.statSync(f) : null; return s ? `${f}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` : "" } catch { return "" } }).join("\n")
    const hit = hashes.get(id)
    if (hit?.sig === sig) return hit.hash
    const h = crypto.createHash("sha256")
    CODE.forEach((f, i) => { h.update(`\0${f}\0`); try { if (files[i]) h.update(fs.readFileSync(files[i]!)) } catch { /* gone */ } })
    const hash = h.digest("hex").slice(0, 16)
    hashes.set(id, { sig, hash })
    return hash
  }
  trustKey = (id: string, hash = this.hashOf(id)) => `obsidian:${id}:${hash}`

  list(): Installed[] {
    const on = new Set(this.enabledIds())
    return this.config.list(".obsidian/plugins").folders.flatMap((id) => this.one(id, on))
  }
  private one(id: string, on: Set<string>): Installed[] {
    if (!ID.test(id)) return []
    const manifest = this.config.json<Manifest>(`.obsidian/plugins/${id}/manifest.json`)
    if (!manifest?.id || !this.config.readable(`.obsidian/plugins/${id}/main.js`)) return []
    const hash = this.hashOf(id)
    const { ours } = this.config.where(`.obsidian/plugins/${id}/main.js`)
    return [{ id, manifest, enabled: on.has(id), styles: !!this.config.readable(`.obsidian/plugins/${id}/styles.css`), hash,
      allowed: this.trust.allows(this.trustKey(id, hash)), changed: !!this.last()[id] && this.last()[id] !== hash, here: this.config.readable(`.obsidian/plugins/${id}/main.js`) === ours,
      disclosures: scan(hash, () => this.config.read(`.obsidian/plugins/${id}/main.js`)?.toString("utf8") ?? "") }]
  }
  get(id: string) { return this.one(id, new Set(this.enabledIds()))[0] ?? null }
}
