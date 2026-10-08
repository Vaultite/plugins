// Obsidian's config folder as plugins see it: .vaultite/obsidian/ over the vault's .obsidian/, so what Obsidian left
// there is read, and what's written here (settings, installs, caches) goes to ours: the app never writes .obsidian/.
import fs from "node:fs"
import path from "node:path"

export const THEIRS = ".obsidian"
export const OURS = ".vaultite/obsidian"

/** Where a path really is: symlinks followed as far as it exists, in the disk's own case. */
export function real(abs: string) {
  let p = path.resolve(abs)
  const rest: string[] = []
  while (!fs.existsSync(p) && path.dirname(p) !== p) { rest.unshift(path.basename(p)); p = path.dirname(p) }
  try { p = fs.realpathSync.native(p) } catch { /* as it is */ }
  return path.join(p, ...rest)
}
const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p)
/** `abs` is `dir` or in it, however it's spelled (symlinks, case on a Mac's disk). */
export const within = (abs: string, dir: string) => { const a = fold(real(abs)), d = fold(real(dir)); return a === d || a.startsWith(d + path.sep) }

export class Config {
  root: string
  constructor(vaultPath: string) { this.root = vaultPath }

  /** A path in .obsidian/ ("" for the folder itself) -> ours and theirs on disk; throws for one outside it. */
  where(rel: string) {
    const r = rel.replace(/^\/+|\/+$/g, "")
    const sub = r === THEIRS ? "" : r.startsWith(`${THEIRS}/`) ? r.slice(THEIRS.length + 1) : null
    if (sub === null || sub.split("/").some((s) => s === "..")) throw new Error(`not a path in ${THEIRS}/: ${rel}`)
    return { ours: path.join(this.root, OURS, sub), theirs: path.join(this.root, THEIRS, sub) }
  }
  /** The file to read: ours when there, else theirs (null: neither). */
  readable(rel: string) {
    const { ours, theirs } = this.where(rel)
    return fs.existsSync(ours) ? ours : fs.existsSync(theirs) ? theirs : null
  }
  read(rel: string): Buffer | null {
    const f = this.readable(rel)
    try { return f ? fs.readFileSync(f) : null } catch { return null }
  }
  json<T = unknown>(rel: string): T | null {
    try { return JSON.parse(this.read(rel)?.toString("utf8") ?? "null") } catch { return null }
  }
  /** A path on disk in Obsidian's own folder, which the app never writes. */
  isTheirs(abs: string) { return within(abs, path.join(this.root, THEIRS)) }
  write(rel: string, data: string | Buffer) {
    const { ours } = this.where(rel)
    if (this.isTheirs(ours)) throw new Error(`${rel} leads into ${THEIRS}/, which the app never writes`)
    fs.mkdirSync(path.dirname(ours), { recursive: true })
    const tmp = `${ours}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, ours)
  }
  /** Names in a folder, ours and theirs together. */
  list(rel: string) {
    const files = new Set<string>(), folders = new Set<string>()
    const { ours, theirs } = this.where(rel)
    for (const d of [ours, theirs]) {
      let names: fs.Dirent[] = []
      try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of names) if (!e.name.endsWith(".tmp")) (e.isDirectory() ? folders : files).add(e.name)
    }
    for (const f of folders) files.delete(f)
    return { files: [...files].sort(), folders: [...folders].sort() }
  }
  /** Removed from ours (theirs is Obsidian's: left as it is). */
  remove(rel: string) {
    const { ours } = this.where(rel)
    if (!this.isTheirs(ours)) fs.rmSync(ours, { recursive: true, force: true })
  }
}
