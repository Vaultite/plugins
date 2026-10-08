// Vault files as Obsidian's DataAdapter sees them: any path in the vault, hidden ones too, as bytes; .obsidian/ through
// the overlay (config.ts). The app's own folder (.vaultite/) is never written this way.
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.ts"
import { THEIRS, within } from "./config.ts"

export type Stat = { type: "file" | "folder"; size: number; mtime: number; ctime: number }

export class Files {
  root: string
  config: Config
  constructor(root: string, config: Config) { this.root = root; this.config = config }

  rel(p: unknown) {
    const r = String(p ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
    if (r.split("/").some((s) => s === "..")) throw new Error(`not a path in the vault: ${p}`)
    return r
  }
  private inConfig = (r: string) => r === THEIRS || r.startsWith(`${THEIRS}/`)
  /** Where a path is read from (overlay: ours, else theirs). */
  readPath(p: unknown) {
    const r = this.rel(p)
    return this.inConfig(r) ? this.config.readable(r) : path.join(this.root, r)
  }
  /** Where a path is written to; the app's folder refused. */
  writePath(p: unknown) {
    const r = this.rel(p)
    const abs = this.inConfig(r) ? this.config.where(r).ours : path.join(this.root, r)
    // (by where it really is: a symlink, or ".Vaultite" on a Mac's disk, is the same folder)
    if (!this.inConfig(r) && within(abs, path.join(this.root, ".vaultite"))) throw new Error(`${r} is the app's own folder`)
    if (this.config.isTheirs(abs)) throw new Error(`${r} is in ${THEIRS}/, which the app never writes`)
    if (!within(abs, this.root)) throw new Error(`${r} leads outside the vault`)
    return { r, abs }
  }
  stat(p: unknown): Stat | null {
    const f = this.readPath(p)
    try { const s = fs.statSync(f!); return { type: s.isDirectory() ? "folder" : "file", size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs } } catch { return null }
  }
  read(p: unknown) { const f = this.readPath(p); return f ? fs.readFileSync(f) : null }
  list(p: unknown) {
    const r = this.rel(p)
    if (this.inConfig(r)) { const l = this.config.list(r); return { files: l.files.map((n) => `${r}/${n}`), folders: l.folders.map((n) => `${r}/${n}`) } }
    const files: string[] = [], folders: string[] = []
    for (const e of fs.readdirSync(path.join(this.root, r), { withFileTypes: true })) (e.isDirectory() ? folders : files).push(r ? `${r}/${e.name}` : e.name)
    return { files, folders }
  }
  write(p: unknown, data: Buffer, append = false) {
    const { abs } = this.writePath(p)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (append) return fs.appendFileSync(abs, data)
    const tmp = `${abs}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, abs)
  }
  mkdir(p: unknown) { fs.mkdirSync(this.writePath(p).abs, { recursive: true }) }
  remove(p: unknown, recursive = false) {
    const { abs } = this.writePath(p)
    if (fs.statSync(abs).isDirectory()) fs.rmSync(abs, { recursive, force: false }); else fs.rmSync(abs)
  }
  rename(a: unknown, b: unknown) {
    const from = this.readPath(a), { abs } = this.writePath(b)
    if (!from || !fs.existsSync(from)) throw new Error(`no file ${a}`)
    if (fs.existsSync(abs)) throw new Error(`${b} already exists`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (this.inConfig(this.rel(a))) { fs.cpSync(from, abs, { recursive: true }); this.remove(a, true) } else fs.renameSync(from, abs)
  }
  copy(a: unknown, b: unknown) {
    const from = this.readPath(a), { abs } = this.writePath(b)
    if (!from || !fs.existsSync(from)) throw new Error(`no file ${a}`)
    if (fs.existsSync(abs)) throw new Error(`${b} already exists`)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.cpSync(from, abs, { recursive: true })
  }
}
