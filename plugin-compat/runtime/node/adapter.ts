// Obsidian's FileSystemAdapter, what the vault has on a computer: the same API as the phone's adapter (writes still
// go through the app), plus the vault's folder on the server's machine and Node's fs for it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { FileSystemAdapter as Base, normalizePath, type Vault } from "../vault.ts"
import { bridgedModules, serverProcess } from "./bridge.ts"
import { pureModules } from "./pure.ts"
import { envOf } from "./wire.ts"

type Any = any
let mods: ((spec: string) => Any) | null = null
const node = (spec: string) => {
  if (!mods) { const proc = serverProcess(""), pure = pureModules(proc, () => ({})), bridged = bridgedModules("", proc); mods = (s) => pure[s] ?? bridged(s) }
  return mods(spec)
}

export class FileSystemAdapter extends Base {
  constructor(vault: Vault) {
    super(vault)
    this.basePath = envOf("").vault
  }
  get fs() { return node("fs") }
  get fsPromises() { return node("fs").promises }
  get path() { return node("path") }
  get url() { return node("url") }
  getName() { return this.basePath.split("/").pop() ?? "" }
  getBasePath() { return this.basePath }
  getFullPath(p: string) { return `${this.basePath}/${normalizePath(p) === "/" ? "" : normalizePath(p)}`.replace(/\/$/, "") }
  getFullRealPath(p: string) { return this.getFullPath(p) }
  getRealPath(p: string) { return normalizePath(p) }
  getFilePath(p: string) { return `file://${encodeURI(this.getFullPath(p))}` }
  async trashSystem(p: string) {
    try { await node("electron").shell.trashItem(this.getFullPath(p)); return true } catch { return false }
  }
  static readLocalFile(p: string) { return node("fs").promises.readFile(p).then((b: Any) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
  static mkdir(p: string) { return node("fs").promises.mkdir(p, { recursive: true }) }
}
