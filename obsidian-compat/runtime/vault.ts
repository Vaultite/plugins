// Obsidian's Vault, its files and folders, the adapter, the metadata cache and the file manager, over the app's API.
// The server sends every file and each note's metadata (plugin.ts /vault); a change in the vault sends what changed.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { get, post, put, del, rawUrl } from "@vaultite"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { Events, fromB64 } from "./core.ts"
import { metadataOf } from "../server/meta.ts"

export const normalizePath = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").replace(/[  ]/g, " ").normalize("NFC") || "/"

export class TAbstractFile {
  vault!: Vault
  path = ""
  name = ""
  parent: TFolder | null = null
}
export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 }
  basename = ""
  extension = ""
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = []
  isRoot() { return this.path === "/" }
}

type Listing = { name: string; files: { path: string; size: number; mtime: number; ctime: number }[]; folders: string[]; cache: Record<string, any>; texts: Record<string, string>; partial?: boolean }

const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }
const unb64 = (s: string) => fromB64(s)
const toBytes = (d: string | ArrayBuffer | ArrayBufferView) => (typeof d === "string" ? new TextEncoder().encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
const hidden = (p: string) => p.split("/").some((s) => s.startsWith("."))
const q = (p: string) => `path=${encodeURIComponent(p)}`

// Reads asked for in the same moment go to the server together (a plugin indexing 10,000 notes asks for each).
type Batched = { op: "stat" | "read" | "text"; path: string; ok: (v: any) => void; no: (e: unknown) => void }
let queue: Batched[] = [], queued = false
function batched<T>(op: Batched["op"], path: string) {
  return new Promise<T>((ok, no) => {
    queue.push({ op, path, ok, no })
    if (!queued) { queued = true; setTimeout(sendBatch) }
  })
}
function sendBatch() {
  queued = false
  const all = queue
  queue = []
  for (let i = 0; i < all.length; i += 400) {
    const part = all.slice(i, i + 400)
    post<{ results: any[] }>("obsidian-compat/fs/batch", { ops: part.map(({ op, path }) => ({ op, path })) })
      .then((r) => part.forEach((x, j) => x.ok(r.results[j] ?? null)), (e) => part.forEach((x) => x.no(e)))
  }
}
const absent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: "ENOENT" })

/** The server's view of any vault file as bytes (plugin.ts fs/*), hidden ones and .obsidian/ (the overlay) too. */
export const raw = {
  stat: (p: string) => batched<{ type: "file" | "folder"; size: number; mtime: number; ctime: number } | null>("stat", p).catch(() => null),
  read: async (p: string) => { const r = await batched<{ base64: string } | null>("read", p); if (!r) throw absent(p); return unb64(r.base64) },
  text: async (p: string) => { const r = await batched<{ text: string } | null>("text", p); if (!r) throw absent(p); return r.text },
  list: (p: string) => get<{ files: string[]; folders: string[] }>(`obsidian-compat/fs/list?${q(p)}`),
  write: (p: string, d: string | ArrayBuffer | ArrayBufferView, append = false) => post("obsidian-compat/fs/write", { path: p, base64: b64(toBytes(d)), append }),
  mkdir: (p: string) => post("obsidian-compat/fs/mkdir", { path: p }),
  remove: (p: string, recursive = false) => post("obsidian-compat/fs/remove", { path: p, recursive }),
  rename: (from: string, to: string) => post("obsidian-compat/fs/rename", { from, to }),
  copy: (from: string, to: string) => post("obsidian-compat/fs/copy", { from, to }),
}

/** The app's settings Obsidian plugins read (`vault.getConfig`): .obsidian/app.json over Obsidian's defaults. */
const CONFIG: Record<string, unknown> = { useMarkdownLinks: false, newLinkFormat: "shortest", attachmentFolderPath: "/", tabSize: 4, useTab: true,
  vimMode: false, readableLineLength: true, showLineNumber: false, foldHeading: true, foldIndent: true, alwaysUpdateLinks: true, newFileLocation: "root",
  newFileFolderPath: "/", userIgnoreFilters: [], strictLineBreaks: false, spellcheck: true, livePreview: true, defaultViewMode: "source",
  propertiesInDocument: "visible", smartIndentList: true, autoPairBrackets: true, autoPairMarkdown: true, showFrontmatter: false, trashOption: "local",
  promptDelete: true, showUnsupportedFiles: false, rightToLeft: false, autoConvertHtml: true, showInlineTitle: true, showViewHeader: true,
  // (appearance.json's, which Obsidian reads through the same getConfig; no Obsidian theme is on here)
  cssTheme: "", baseFontSize: 16, accentColor: "", enabledCssSnippets: [], interfaceFontFamily: "", textFontFamily: "", monospaceFontFamily: "",
  translucency: false, nativeMenus: false, showRibbon: true }

export class Vault extends Events {
  configDir = ".obsidian"
  files = new Map<string, TAbstractFile>()
  root: TFolder
  text = new Map<string, string>() // what was read, for cachedRead
  meta: MetadataCache
  name = "Vault"
  config: Record<string, unknown> = { ...CONFIG }
  adapter: DataAdapter
  /** What's read before the first listing counts as done (app.ts: hotkeys, core plugins' options...). */
  loading: Promise<unknown>[] = []
  private loaded = false

  constructor() {
    super()
    this.root = this.folder("/")
    this.meta = new MetadataCache(this)
    this.adapter = new DataAdapter(this)
  }

  private folder(path: string) {
    const f = new TFolder()
    Object.assign(f, { vault: this, path, name: path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1) })
    return f
  }
  private parentOf(path: string) {
    const i = path.lastIndexOf("/")
    return i < 0 ? this.root : (this.files.get(path.slice(0, i)) as TFolder | undefined) ?? this.root
  }
  private place(f: TAbstractFile, path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1), dot = name.lastIndexOf(".")
    f.path = path
    f.name = name
    if (f instanceof TFile) { f.basename = dot > 0 ? name.slice(0, dot) : name; f.extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "" }
  }
  /** A file or folder moved to `to`: the same object, its path and its children's changed, as Obsidian keeps them. */
  private moveInPlace(f: TAbstractFile, to: string) {
    const from = f.path
    const kids = f instanceof TFolder ? [...this.files.values()].filter((x) => x.path.startsWith(`${from}/`)) : []
    f.parent?.children.splice(f.parent.children.indexOf(f), 1)
    this.files.delete(from)
    this.place(f, to)
    this.files.set(to, f)
    f.parent = this.parentOf(to)
    f.parent.children.push(f)
    for (const k of kids) { this.files.delete(k.path); k.path = to + k.path.slice(from.length); this.files.set(k.path, k) }
    for (const x of [f, ...kids]) {
      const was = from + x.path.slice(to.length)
      if (this.text.has(was)) { this.text.set(x.path, this.text.get(was)!); this.text.delete(was) }
      this.meta.moved(was, x.path)
    }
    this.trigger("rename", f, from)
    for (const k of kids) this.trigger("rename", k, from + k.path.slice(to.length))
  }

  private async loadConfig() {
    try {
      const { base64 } = await get<{ base64: string }>(`obsidian-compat/config/read?${q(".obsidian/app.json")}`)
      Object.assign(this.config, JSON.parse(new TextDecoder().decode(unb64(base64))))
    } catch { /* no app.json: Obsidian's defaults */ }
  }

  /** Everything, the first time; then only `changed` (null: everything again). Says what was made, changed, moved, removed. */
  async refresh(changed: string[] | null = null): Promise<void> {
    const first = !this.loaded
    if (first) await Promise.allSettled([...this.loading, this.loadConfig()])
    const want = changed && changed.length < 200 ? changed.map(normalizePath) : null
    const l = await get<Listing>(`obsidian-compat/vault${want ? `?paths=${encodeURIComponent(want.join("\n"))}` : ""}`)
    this.name = l.name ?? this.name
    const seen = new Set<string>()
    const made: TAbstractFile[] = [], modified: TFile[] = []
    for (const d of [...l.folders].sort((a, b) => a.length - b.length)) {
      seen.add(d)
      if (this.files.has(d)) continue
      const f = this.folder(d)
      this.files.set(d, f)
      f.parent = this.parentOf(d)
      f.parent.children.push(f)
      made.push(f)
    }
    // (a note this listing changed without its text and metadata, asked for another: left to a refresh of its own, so its
    // events carry what it holds now, never the old)
    const only = want ? new Set(want) : null, later: string[] = []
    for (const x of l.files) {
      seen.add(x.path)
      let f = this.files.get(x.path) as TFile | undefined
      if (only && !only.has(x.path) && x.path.endsWith(".md") && (!f || f.stat.mtime !== x.mtime || f.stat.size !== x.size)) { later.push(x.path); continue }
      if (!f) {
        f = new TFile()
        f.vault = this
        this.place(f, x.path)
        f.parent = this.parentOf(x.path)
        f.parent.children.push(f)
        this.files.set(x.path, f)
        f.stat = { ctime: x.ctime, mtime: x.mtime, size: x.size }
        made.push(f)
        continue
      }
      if (f.stat.mtime !== x.mtime || f.stat.size !== x.size) { modified.push(f); if (!(x.path in (l.texts ?? {}))) this.text.delete(f.path) }
      f.stat = { ctime: x.ctime, mtime: x.mtime, size: x.size }
    }
    // (a partial answer has only the paths asked about: the rest stay; a folder gone needs the whole picture again)
    const partial = !!(want && l.partial)
    if (partial && [...this.files.values()].some((f) => f instanceof TFolder && !seen.has(f.path))) return this.refresh(null)
    let gone = partial ? want!.filter((p) => !seen.has(p)).map((p) => this.files.get(p)).filter((f): f is TFile => f instanceof TFile)
      : [...this.files.values()].filter((f) => !seen.has(f.path))
    // A file gone and one made with its size and time: moved elsewhere (the app's rename), the same object at its new path.
    const moves: [TAbstractFile, string][] = []
    if (!first) {
      for (const g of gone) {
        if (!(g instanceof TFile)) continue
        const m = made.find((n) => n instanceof TFile && n.extension === g.extension && n.stat.size === g.stat.size && n.stat.mtime === g.stat.mtime && !moves.some(([, p]) => p === n.path))
        if (m) moves.push([g, m.path])
      }
    }
    for (const [, to] of moves) {
      const fresh = this.files.get(to)!
      fresh.parent?.children.splice(fresh.parent.children.indexOf(fresh), 1)
      this.files.delete(to)
      made.splice(made.indexOf(fresh), 1)
    }
    gone = gone.filter((g) => !moves.some(([m]) => m === g))
    for (const f of gone) {
      this.files.delete(f.path)
      this.text.delete(f.path)
      if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f)
    }
    for (const [p, t] of Object.entries(l.texts ?? {})) this.text.set(p, t)
    const prev = new Map(gone.map((f) => [f.path, this.meta.cache.get(f.path)]))
    for (const f of gone) this.meta.cache.delete(f.path)
    for (const [f, to] of moves) this.moveInPlace(f, to)
    for (const [p, c] of Object.entries(l.cache)) this.meta.cache.set(p, c)
    if (first) { this.loaded = true; this.meta.resolve(); return }
    // (names came or went: every link may resolve differently; else only the changed notes' own links)
    if (made.length || gone.length || moves.length || !partial) this.meta.resolve()
    else this.meta.resolve(modified.map((f) => f.path))
    for (const f of made) this.trigger("create", f)
    for (const f of modified) this.trigger("modify", f)
    for (const f of gone) this.trigger("delete", f)
    const notes = [...made, ...modified].filter((f): f is TFile => f instanceof TFile && f.extension === "md")
    for (const f of notes) this.meta.trigger("changed", f, this.text.get(f.path) ?? "", this.meta.getFileCache(f))
    for (const f of gone) if (f instanceof TFile) this.meta.trigger("deleted", f, prev.get(f.path) ?? null)
    for (const f of notes) this.meta.trigger("resolve", f)
    if (notes.length || gone.length || moves.length) this.meta.trigger("resolved")
    if (later.length) void this.refresh(later)
  }

  /** Obsidian's private map of every file and folder by path. */
  get fileMap() { return Object.fromEntries([["/", this.root], ...this.files]) }
  getName() { return this.name }
  getRoot() { return this.root }
  getAbstractFileByPath(p: string) { const n = normalizePath(p); return n === "/" ? this.root : this.files.get(n) ?? null }
  getAbstractFileByPathInsensitive(p: string) { const l = normalizePath(p).toLowerCase(); return [...this.files.values()].find((f) => f.path.toLowerCase() === l) ?? null }
  getFileByPath(p: string) { const f = this.getAbstractFileByPath(p); return f instanceof TFile ? f : null }
  getFolderByPath(p: string) { const f = this.getAbstractFileByPath(p); return f instanceof TFolder ? f : null }
  getFiles() { return [...this.files.values()].filter((f): f is TFile => f instanceof TFile) }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.extension === "md") }
  getAllLoadedFiles() { return [this.root, ...this.files.values()] }
  getAllFolders(root = false) { return [...(root ? [this.root] : []), ...[...this.files.values()].filter((f): f is TFolder => f instanceof TFolder)] }
  getConfig(k: string) { return k === "theme" && !("theme" in this.config) ? (document.body.classList.contains("theme-dark") ? "obsidian" : "moonstone") : this.config[k] }
  setConfig(k: string, v: unknown) {
    if (v === undefined) delete this.config[k]; else this.config[k] = v
    const own = Object.fromEntries(Object.entries(this.config).filter(([key, val]) => JSON.stringify(CONFIG[key]) !== JSON.stringify(val)))
    void raw.write(".obsidian/app.json", JSON.stringify(own, null, 2))
    this.trigger("config-changed", k)
  }
  getResourcePath(f: TFile) { return new URL(rawUrl(f.path, { v: f.stat.mtime }), document.baseURI).href }
  getAvailablePath(base: string, ext: string) {
    for (let i = 0; ; i++) { const p = normalizePath(`${base}${i ? ` ${i}` : ""}${ext ? `.${ext}` : ""}`); if (!this.files.has(p)) return p }
  }
  checkPath(p: string) { if (/[\\:*?"<>|]/.test(p.split("/").pop() ?? "")) throw new Error("File name cannot contain any of the following characters: * \" \\ / < > : | ?") }

  async read(f: TFile) {
    const t = await raw.text(f.path)
    this.text.set(f.path, t)
    return t
  }
  async cachedRead(f: TFile) { return this.text.get(f.path) ?? this.read(f) }
  async readBinary(f: TFile) { const b = await raw.read(f.path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
  /** Writes a note through the app (its merge and history); any other file as it is. */
  private async put(p: string, data: string, make: boolean) {
    if (p.endsWith(".md") && !hidden(p)) {
      if (make) await post("file", { path: p, text: data }); else await put("file", { path: p, text: data })
    } else await raw.write(p, data)
    this.text.set(p, data)
    await this.refresh([p])
  }
  async modify(f: TFile, data: string, _o?: unknown) { await this.put(f.path, data, false) }
  async modifyBinary(f: TFile, data: ArrayBuffer, _o?: unknown) { await raw.write(f.path, data); this.text.delete(f.path); await this.refresh([f.path]) }
  async append(f: TFile, data: string, _o?: unknown) { await this.modify(f, (await this.read(f)) + data) }
  async appendBinary(f: TFile, data: ArrayBuffer, _o?: unknown) { await raw.write(f.path, data, true); this.text.delete(f.path); await this.refresh([f.path]) }
  async process(f: TFile, fn: (s: string) => string, _o?: unknown) { const t = fn(await this.read(f)); await this.modify(f, t); return t }
  async create(p: string, data = "", _o?: unknown) {
    p = normalizePath(p)
    this.checkPath(p)
    if (this.files.has(p) || (await raw.stat(p))) throw new Error("File already exists.")
    await this.mkdirsFor(p)
    await this.put(p, data, true)
    return this.getFileByPath(p) ?? this.detached(p)
  }
  /** A file the vault doesn't list (hidden, like .obsidian/'s): an object for it all the same, as Obsidian answers. */
  private detached(p: string) {
    const f = new TFile()
    f.vault = this
    this.place(f, p)
    f.parent = this.parentOf(p)
    return f
  }
  async createBinary(p: string, data: ArrayBuffer, _o?: unknown) {
    p = normalizePath(p)
    if (this.files.has(p)) throw new Error("File already exists.")
    await raw.write(p, data)
    await this.refresh([p])
    return this.getFileByPath(p) ?? this.detached(p)
  }
  private async mkdirsFor(p: string) { const d = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; if (d && !this.files.has(d) && !hidden(d)) await this.createFolder(d).catch(() => {}) }
  async createFolder(p: string) {
    p = normalizePath(p)
    if (this.files.has(p)) throw new Error("Folder already exists.")
    await post("folder", { path: p }).catch(() => raw.mkdir(p))
    await this.refresh()
    return this.getFolderByPath(p)!
  }
  async delete(f: TAbstractFile, _force?: boolean) { await del(`file?${q(f.path)}`); await this.refresh(f instanceof TFile ? [f.path] : null) }
  async trash(f: TAbstractFile, _system?: boolean) { await this.delete(f) }
  async rename(f: TAbstractFile, to: string) {
    to = normalizePath(to)
    if (to === f.path) return
    if (this.files.has(to)) throw new Error("Destination file already exists!")
    if (hidden(f.path) || hidden(to)) await raw.rename(f.path, to); else await post("file/move", { from: f.path, to })
    this.moveInPlace(f, to)
    await this.refresh()
  }
  async copy<T extends TAbstractFile>(f: T, to: string): Promise<T> {
    to = normalizePath(to)
    if (this.files.has(to)) throw new Error("File already exists.")
    await raw.copy(f.path, to)
    await this.refresh()
    return this.getAbstractFileByPath(to) as T
  }
  static recurseChildren(root: TFolder, cb: (f: TAbstractFile) => any) {
    const walk = (f: TAbstractFile) => { cb(f); if (f instanceof TFolder) f.children.forEach(walk) }
    walk(root)
  }
}

/** Obsidian's DataAdapter (the mobile one: no basePath, no Node), on vault paths, any file as bytes. */
export class DataAdapter {
  vault: Vault
  constructor(v: Vault) { this.vault = v }
  getName() { return this.vault.name }
  private async after(p: string) { if (!hidden(p)) { this.vault.text.delete(p); await this.vault.refresh([p]) } }
  async exists(p: string, sensitive?: boolean) {
    p = normalizePath(p)
    if (this.vault.files.has(p)) return true
    if (!(await raw.stat(p))) return false
    if (!sensitive) return true
    const l = await raw.list(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "").catch(() => null)
    return !!l && [...l.files, ...l.folders].includes(p)
  }
  async stat(p: string) {
    p = normalizePath(p)
    // (a file the vault lists: its picture answers, the server isn't asked)
    const f = this.vault.files.get(p)
    if (f instanceof TFile) return { type: "file" as const, ...f.stat }
    return raw.stat(p)
  }
  async list(p: string) { const n = normalizePath(p); return raw.list(n === "/" ? "" : n) }
  async read(p: string) { return new TextDecoder().decode(await raw.read(normalizePath(p))) }
  async readBinary(p: string) { const b = await raw.read(normalizePath(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
  async write(p: string, data: string, _o?: unknown) { p = normalizePath(p); await raw.write(p, data); await this.after(p) }
  async writeBinary(p: string, data: ArrayBuffer, _o?: unknown) { p = normalizePath(p); await raw.write(p, data); await this.after(p) }
  async append(p: string, data: string, _o?: unknown) { p = normalizePath(p); await raw.write(p, data, true); await this.after(p) }
  async appendBinary(p: string, data: ArrayBuffer, _o?: unknown) { p = normalizePath(p); await raw.write(p, data, true); await this.after(p) }
  async process(p: string, fn: (s: string) => string, _o?: unknown) { const t = fn(await this.read(p)); await this.write(p, t); return t }
  getResourcePath(p: string) { return new URL(rawUrl(normalizePath(p)), document.baseURI).href }
  async mkdir(p: string) { p = normalizePath(p); await raw.mkdir(p); await this.after(p) }
  async trashSystem(p: string) { await this.trashLocal(p); return true }
  async trashLocal(p: string) { p = normalizePath(p); if (hidden(p)) await raw.remove(p, true); else { await del(`file?${q(p)}`); await this.after(p) } }
  async rmdir(p: string, recursive: boolean) { p = normalizePath(p); await raw.remove(p, recursive); await this.after(p) }
  async remove(p: string) { p = normalizePath(p); await raw.remove(p); await this.after(p) }
  async rename(a: string, b: string) { a = normalizePath(a); b = normalizePath(b); await raw.rename(a, b); if (!hidden(a) || !hidden(b)) await this.vault.refresh() }
  async copy(a: string, b: string) { a = normalizePath(a); b = normalizePath(b); await raw.copy(a, b); await this.after(b) }
}
/** The desktop adapter's class (`instanceof FileSystemAdapter` picks a plugin's desktop path). */
export class FileSystemAdapter extends DataAdapter {
  basePath = ""
  getBasePath() { return this.basePath }
  getFilePath(p: string) { return `file://${this.getFullPath(p)}` }
  getFullPath(p: string) { return `${this.basePath}/${normalizePath(p)}` }
  getFullRealPath(p: string) { return this.getFullPath(p) }
  static readLocalFile(p: string): Promise<ArrayBuffer> { return fetch(p).then((r) => r.arrayBuffer()) }
  static mkdir(_p: string): Promise<void> { return Promise.reject(new Error("FileSystemAdapter.mkdir needs Node")) }
}
export class CapacitorAdapter extends DataAdapter {
  getFullPath(p: string) { return normalizePath(p) }
}

type Ref = { link: string; original: string; displayText?: string; position?: any; key?: string }
/** Obsidian's CustomArrayDict: keys to lists. */
class ArrayDict<T> {
  data = new Map<string, T[]>()
  add(k: string, v: T) { const l = this.data.get(k); if (l) l.push(v); else this.data.set(k, [v]) }
  remove(k: string, v: T) { const l = this.data.get(k); if (!l) return; const i = l.indexOf(v); if (i >= 0) l.splice(i, 1); if (!l.length) this.data.delete(k) }
  get(k: string) { return this.data.get(k) ?? null }
  keys() { return [...this.data.keys()] }
  clear(k: string) { this.data.delete(k) }
  clearAll() { this.data.clear() }
  contains(k: string, v: T) { return !!this.data.get(k)?.includes(v) }
  count() { let n = 0; for (const l of this.data.values()) n += l.length; return n }
}

export class MetadataCache extends Events {
  vault: Vault
  cache = new Map<string, any>()
  resolvedLinks: Record<string, Record<string, number>> = {}
  unresolvedLinks: Record<string, Record<string, number>> = {}
  resolved = false
  initialized = false
  /** Files by lower-cased name, and Markdown ones by basename too (Obsidian's uniqueFileLookup). */
  uniqueFileLookup = new ArrayDict<TFile>()
  constructor(v: Vault) { super(); this.vault = v }

  getFileCache(f: TFile | null) { return f ? this.getCache(f.path) : null }
  getCache(p: string) { return this.cache.get(p) ?? (this.vault.files.has(p) && p.endsWith(".md") ? {} : null) }
  getCachedFiles() { return [...this.cache.keys()] }
  /** Obsidian's private per-file records (mtime, size, hash) and caches by hash: the hash here is the path. */
  get fileCache() { return Object.fromEntries(this.vault.getMarkdownFiles().map((f) => [f.path, { mtime: f.stat.mtime, size: f.stat.size, hash: f.path }])) }
  get metadataCache() { return Object.fromEntries(this.cache) }
  moved(from: string, to: string) { const c = this.cache.get(from); if (c) { this.cache.delete(from); this.cache.set(to, c) } }

  /** Every file a link could mean, nearest first: a path (relative to the note too), else a name the path ends with. */
  getLinkpathDest(link: string, from: string): TFile[] {
    let path = link.split(/[#^|]/)[0].trim()
    try { path = decodeURIComponent(path) } catch { /* as written */ }
    if (!path) { const f = this.vault.getFileByPath(from); return f ? [f] : [] }
    const v = this.vault, dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ""
    if (path.startsWith("./") || path.startsWith("../")) {
      const parts = dir ? dir.split("/") : []
      for (const s of path.split("/")) { if (s === "..") parts.pop(); else if (s !== ".") parts.push(s) }
      path = parts.join("/")
    }
    const exact = v.getFileByPath(path) ?? v.getFileByPath(`${path}.md`)
    if (exact) return [exact]
    const tail = path.toLowerCase(), name = tail.slice(tail.lastIndexOf("/") + 1)
    const hits = (this.uniqueFileLookup.get(name) ?? []).filter((f) => {
      const p = f.path.toLowerCase()
      return p === tail || p === `${tail}.md` || p.endsWith(`/${tail}`) || p.endsWith(`/${tail}.md`)
    })
    const near = (f: TFile) => (f.parent?.path === (dir || "/") ? 0 : 1)
    return [...new Set(hits)].sort((a, b) => near(a) - near(b) || a.path.length - b.path.length || a.path.localeCompare(b.path))
  }
  getFirstLinkpathDest(link: string, from: string): TFile | null { return this.getLinkpathDest(link, from)[0] ?? null }
  /** How a link to `f` is written from `from`, as the vault's newLinkFormat says. */
  fileToLinktext(f: TFile, from: string, omitMd = true) {
    const bare = omitMd && f.extension === "md" ? f.path.slice(0, -3) : f.path
    const name = omitMd && f.extension === "md" ? f.basename : f.name
    const format = this.vault.getConfig("newLinkFormat")
    if (format === "absolute") return bare
    if (format === "relative") {
      const a = (from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "").split("/").filter(Boolean), b = bare.split("/")
      let i = 0
      while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
      return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/")
    }
    return this.getFirstLinkpathDest(name, from) === f ? name : bare
  }
  getBacklinksForFile(f: TFile) {
    const out = new ArrayDict<Ref>()
    for (const [src, links] of Object.entries(this.resolvedLinks)) {
      if (!links[f.path]) continue
      const c = this.cache.get(src)
      for (const l of [...(c?.links ?? []), ...(c?.embeds ?? []), ...(c?.frontmatterLinks ?? [])]) if (this.getFirstLinkpathDest(l.link, src) === f) out.add(src, l)
    }
    return out
  }
  getTags() {
    const out: Record<string, number> = {}
    for (const c of this.cache.values()) for (const t of getAllTags(c) ?? []) out[t] = (out[t] ?? 0) + 1
    return out
  }
  getLinks() { return Object.fromEntries([...this.cache].map(([p, c]) => [p, c.links ?? []])) }
  getLinkSuggestions() {
    const out: { file: TFile | null; path: string; alias?: string }[] = []
    for (const file of this.vault.getFiles()) {
      out.push({ file, path: file.path })
      for (const alias of aliasesOf(this.cache.get(file.path)?.frontmatter)) out.push({ file, path: file.path, alias })
    }
    const seen = new Set<string>()
    for (const links of Object.values(this.unresolvedLinks)) for (const k of Object.keys(links)) if (!seen.has(k)) { seen.add(k); out.push({ file: null, path: k }) }
    return out
  }
  getFrontmatterPropertyValuesForKey(key: string) {
    const out = new Set<string>()
    for (const c of this.cache.values()) { const v = c.frontmatter?.[key]; for (const x of Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]) if (typeof x !== "object") out.add(String(x)) }
    return [...out]
  }
  isUserIgnored(p: string) {
    const filters = (this.vault.getConfig("userIgnoreFilters") as string[] | undefined) ?? []
    return filters.some((f) => (f.startsWith("/") && f.endsWith("/") && f.length > 2 ? new RegExp(f.slice(1, -1)).test(p) : p.startsWith(f)))
  }
  resolveLinks(_path?: string) { this.resolve() }
  async computeFileMetadataAsync(data: ArrayBuffer | string) { return metadataOf(typeof data === "string" ? data : new TextDecoder().decode(data)) }
  async computeMetadataAsync(data: ArrayBuffer | string) { return this.computeFileMetadataAsync(data) }
  /** Links resolved again, every note's (a new or renamed file can resolve links elsewhere). */
  resolve(only?: string[]) {
    if (!only) {
      this.uniqueFileLookup.clearAll()
      for (const f of this.vault.getFiles()) {
        this.uniqueFileLookup.add(f.name.toLowerCase(), f)
        if (f.extension === "md") this.uniqueFileLookup.add(f.basename.toLowerCase(), f)
      }
    }
    const res: typeof this.resolvedLinks = only ? this.resolvedLinks : {}, un: typeof this.unresolvedLinks = only ? this.unresolvedLinks : {}
    for (const [p, c] of only ? only.flatMap((x) => { const c = this.cache.get(x); return c ? [[x, c] as const] : [] }) : this.cache) {
      const r: Record<string, number> = {}, u: Record<string, number> = {}
      for (const l of [...(c.links ?? []), ...(c.embeds ?? []), ...(c.frontmatterLinks ?? [])]) {
        if (/^[a-z][\w+.-]*:/i.test(l.link)) continue
        const f = this.getFirstLinkpathDest(l.link, p)
        if (f) r[f.path] = (r[f.path] ?? 0) + 1
        else { const k = l.link.split(/[#^|]/)[0]; if (k) u[k] = (u[k] ?? 0) + 1 }
      }
      res[p] = r; un[p] = u
    }
    this.resolvedLinks = res; this.unresolvedLinks = un
    this.resolved = this.initialized = true
  }
}

const aliasesOf = (fm: any): string[] => { const a = fm?.aliases ?? fm?.alias; return (Array.isArray(a) ? a : typeof a === "string" ? a.split(",") : []).map((x: any) => String(x).trim()).filter(Boolean) }
const fmTags = (fm: any): string[] => {
  const k = fm ? Object.keys(fm).find((x) => x.toLowerCase() === "tags" || x.toLowerCase() === "tag") : undefined
  const t = k ? fm[k] : null
  return (Array.isArray(t) ? t : typeof t === "string" ? t.split(/[,\s]+/) : []).filter((x: any) => x !== null && x !== "").map((x: any) => `#${String(x).replace(/^#/, "")}`)
}
export const getAllTags = (c: any) => (c ? [...fmTags(c.frontmatter), ...(c.tags ?? []).map((t: any) => t.tag)] : null)

export function getFrontMatterInfo(content: string) {
  const m = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/.exec(content)
  if (!m) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 }
  const from = content.indexOf("\n") + 1
  return { exists: true, frontmatter: m[1] ?? "", from, to: from + (m[1] ?? "").length, contentStart: m[0].length }
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")

export class FileManager {
  vault: Vault
  constructor(v: Vault) { this.vault = v }
  /** The note's frontmatter as an object for `fn` to change, written back (gone when left empty). */
  async processFrontMatter(f: TFile, fn: (fm: any) => void, _o?: unknown) {
    await this.vault.process(f, (text) => {
      const info = getFrontMatterInfo(text)
      const fm = (info.exists ? parseYaml(info.frontmatter) : null) ?? {}
      fn(fm)
      const eol = text.includes("\r\n") ? "\r\n" : "\n"
      const yaml = Object.keys(fm).length ? `---${eol}${stringifyYaml(fm, { lineWidth: 0 }).replace(/\n/g, eol)}---${eol}` : ""
      return yaml + text.slice(info.contentStart)
    })
  }
  generateMarkdownLink(f: TFile, from: string, subpath = "", alias = "") {
    const v = this.vault
    if (v.getConfig("useMarkdownLinks")) {
      const format = v.getConfig("newLinkFormat")
      let target = f.path
      if (format === "relative") target = v.meta.fileToLinktext(f, from, false)
      else if (format !== "absolute" && v.meta.fileToLinktext(f, from, false) === f.name) target = f.name
      return `[${alias || (f.extension === "md" ? f.basename : f.name)}](${encodeURI(target).replace(/[()]/g, (c) => encodeURIComponent(c))}${subpath})`
    }
    const link = v.meta.fileToLinktext(f, from)
    return `[[${link}${subpath}${alias ? `|${alias}` : ""}]]`
  }
  async renameFile(f: TAbstractFile, to: string) { await this.vault.rename(f, to) }
  async trashFile(f: TAbstractFile) { await this.vault.trash(f, true) }
  async promptForDeletion(f: TAbstractFile) { if (confirm(`Delete ${f.name}?`)) { await this.trashFile(f); return true } return false }
  /** Where a new note goes, as the vault's newFileLocation says. */
  getNewFileParent(from = "", _newPath?: string) {
    const v = this.vault, loc = v.getConfig("newFileLocation")
    if (loc === "current") return v.getFileByPath(from)?.parent ?? v.getFolderByPath(dirOf(from)) ?? v.root
    if (loc === "folder") return v.getFolderByPath(normalizePath(String(v.getConfig("newFileFolderPath") ?? "/"))) ?? v.root
    return v.root
  }
  /** Where an attachment goes, as the vault's attachmentFolderPath says ("./" beside the note). */
  async getAvailablePathForAttachment(name: string, from = "") {
    const set = String(this.vault.getConfig("attachmentFolderPath") ?? "/")
    const folder = set === "/" || set === "" ? "" : set.startsWith("./") ? normalizePath(`${dirOf(from)}/${set.slice(2)}`) : set === "." ? dirOf(from) : normalizePath(set)
    const dot = name.lastIndexOf(".")
    const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot + 1) : ""
    return this.vault.getAvailablePath(folder && folder !== "/" ? `${folder}/${base}` : base, ext)
  }
  async createNewFile(folder: TFolder | null, name = "Untitled", ext = "md", data = "") {
    const parent = folder ?? this.getNewFileParent()
    return this.vault.create(this.vault.getAvailablePath(parent.isRoot() ? name : `${parent.path}/${name}`, ext), data)
  }
  async createNewMarkdownFile(folder: TFolder | null, name = "Untitled", data = "") { return this.createNewFile(folder, name, "md", data) }
  async createNewMarkdownFileFromLinktext(linktext: string, from: string) {
    const path = linktext.split(/[#^|]/)[0]
    const parent = path.includes("/") ? null : this.getNewFileParent(from)
    return this.vault.create(normalizePath(parent && !parent.isRoot() ? `${parent.path}/${path}.md` : `${path}.md`), "")
  }
  iterateAllRefs(cb: (path: string, ref: Ref) => any) {
    for (const [p, c] of this.vault.meta.cache) for (const r of [...(c.links ?? []), ...(c.embeds ?? []), ...(c.frontmatterLinks ?? [])]) cb(p, r)
  }
  getAllLinkResolutions() { return [] }
}
