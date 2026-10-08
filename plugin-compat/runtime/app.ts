// The app Obsidian plugins see (`app`): its vault, workspace, commands, plugins and the internals plugins reach for
// (hotkeys, core plugins and their options, property types, embeds, views), read from .obsidian/ through the overlay.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { commandList, get, notify, offeredCommand, openView, post, runCommandById } from "@vaultite"
import { Component, Events, fromB64 } from "./core.ts"
import { cm5 } from "./cm5.ts"
import { createEl } from "./dom.ts"
import { loadPlugin, unloadPlugin } from "./host.ts"
import { Platform, registered, tell, type Manifest, type ObsCommand } from "./state.ts"
import * as editor from "./editor.ts"
import * as ui from "./ui.ts"
import * as vault from "./vault.ts"
import * as ws from "./workspace.ts"
import { FileExplorerView } from "./explorer.ts"

const phone = Platform.isPhone

/** A file in .obsidian/ (ours over Obsidian's): its JSON, or null. */
export async function readConfig<T = any>(rel: string): Promise<T | null> {
  try {
    const { base64 } = await get<{ base64: string }>(`plugin-compat/config/read?path=${encodeURIComponent(`.obsidian/${rel}`)}`)
    return JSON.parse(new TextDecoder().decode(fromB64(base64)))
  } catch { return null }
}
export async function writeConfig(rel: string, data: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2))
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  await post("plugin-compat/config/write", { path: `.obsidian/${rel}`, base64: btoa(s) })
}
const debounced = new Map<string, ReturnType<typeof setTimeout>>()
const saveLater = (rel: string, data: () => unknown) => {
  clearTimeout(debounced.get(rel))
  debounced.set(rel, setTimeout(() => { void writeConfig(rel, data()) }, 300))
}

// Obsidian's core commands by id, as this app names them (most editor ones are the same).
const CORE: Record<string, string> = {
  "command-palette:open": "palette:open", "app:go-back": "nav:back", "app:go-forward": "nav:forward", "workspace:close": "tab:close",
  "workspace:close-others": "tab:close-others", "workspace:new-tab": "tab:new", "workspace:next-tab": "tab:next", "workspace:previous-tab": "tab:previous",
  "workspace:undo-close-pane": "tab:reopen", "workspace:toggle-pin": "tab:toggle-pin", "workspace:split-vertical": "split:right",
  "workspace:split-horizontal": "split:down", "workspace:move-to-new-window": "tab:move-to-window", "workspace:open-in-new-window": "tab:open-in-window",
  "workspace:edit-file-title": "file:rename", "workspace:copy-path": "file:copy-path", "file-explorer:new-file": "file:new", "app:delete-file": "file:delete",
  "file-explorer:move-file": "file:move", "file-explorer:reveal-active-file": "file:reveal", "file-explorer:open": "files:open",
  "file-explorer:duplicate-file": "file:duplicate", "open-with-default-app:show": "file:reveal-finder", "open-with-default-app:open": "file:open-outside",
  "global-search:open": "search:search", "editor:open-search": "find:open", "editor:open-search-replace": "find:replace", "markdown:toggle-preview": "view:toggle",
  "editor:toggle-source": "view:toggle", "graph:open-local": "graph:local", "backlink:open": "backlinks:open-tab", "outline:open": "outline:open-tab",
  "tag-pane:open": "tags:open-tab", "file-recovery:open": "history:open", "daily-notes": "today:daily-note", "insert-template": "templates:insert",
  "insert-current-date": "templates:insert-current-date", "insert-current-time": "templates:insert-current-time", "note-composer:split-file": "note-composer:extract",
  "random-note": "random-note:open", "zk-prefixer": "unique-note:new", "canvas:new-file": "canvas:new", "editor:fold-all": "folding:fold-all",
  "editor:unfold-all": "folding:unfold-all", "editor:toggle-fold": "folding:toggle", "bookmarks:bookmark-current-view": "file:pin", "app:toggle-left-sidebar": "sidebar:focus-left",
}
const coreId = (id: string) => CORE[id] ?? id
const OBSIDIAN_ID = Object.fromEntries(Object.entries(CORE).map(([o, a]) => [a, o]))
const NOOP = new Set(["editor:save-file", "app:reload"])

class Commands {
  app: App
  constructor(app: App) { this.app = app }
  /** Every command, as Obsidian's: the app's own (by Obsidian's id where it has one) and plugins'. */
  private cache: { list: unknown; mine: unknown[]; all: Record<string, any> } | null = null
  get commands(): Record<string, any> {
    const list = commandList(), mine = [...registered.commands.values()]
    if (this.cache?.list === list && this.cache.mine.length === mine.length && this.cache.mine.every((c, i) => c === mine[i])) return this.cache.all
    const own: Record<string, any> = {}
    for (const c of commandList()) {
      if (c.id.startsWith("obsidian.")) continue
      const id = OBSIDIAN_ID[c.id] ?? c.id
      own[id] = { id, name: c.name, icon: typeof c.icon === "string" ? c.icon : undefined, checkCallback: (checking: boolean) => (checking ? !!offeredCommand(c.id) : (runCommandById(c.id), true)) }
    }
    const all = { ...own, ...Object.fromEntries([...registered.commands].map(([id, c]) => [id, c.cmd])) }
    this.cache = { list, mine, all }
    return all
  }
  get editorCommands() { return Object.fromEntries(Object.entries(this.commands).filter(([, c]) => c.editorCallback || c.editorCheckCallback)) }
  listCommands() { return Object.values(this.commands) }
  findCommand(id: string) { return this.commands[id] ?? (offeredCommand(coreId(id)) ? { id, name: offeredCommand(coreId(id))!.name } : undefined) }
  addCommand(c: ObsCommand) { registered.commands.set(c.id, { plugin: c.id.split(":")[0], cmd: c }); tell() }
  removeCommand(id: string) { if (registered.commands.delete(id)) tell() }
  executeCommandById(id: string) {
    if (registered.commands.has(id)) return runObsidian(this.app, id)
    if (id.startsWith("obsidian.")) return runCommandById(id)
    if (id === "app:reload") { location.reload(); return true }
    if (NOOP.has(id)) return true
    return runCommandById(coreId(id))
  }
  executeCommand(c: { id: string }) { return this.executeCommandById(c.id) }
}

type Hotkey = { modifiers: string[]; key: string }
/** Hotkeys: plugins' defaults and the user's own (.obsidian/hotkeys.json), which win. */
class HotkeyManager extends Events {
  customKeys: Record<string, Hotkey[]> = {}
  defaultKeys: Record<string, Hotkey[]> = {}
  bakedHotkeys: { modifiers: string; key: string }[] = []
  bakedIds: string[] = []
  async load() { this.customKeys = (await readConfig<Record<string, Hotkey[]>>("hotkeys.json")) ?? {}; this.bake() }
  save() { saveLater("hotkeys.json", () => this.customKeys) }
  getHotkeys(id: string) { return this.customKeys[id] }
  getDefaultHotkeys(id: string) { return this.defaultKeys[id] ?? registered.commands.get(id)?.cmd.hotkeys }
  addDefaultHotkeys(id: string, keys: Hotkey[]) { this.defaultKeys[id] = keys; this.bake() }
  removeDefaultHotkeys(id: string) { delete this.defaultKeys[id]; this.bake() }
  setHotkeys(id: string, keys: Hotkey[]) { this.customKeys[id] = keys; this.bake(); this.save() }
  removeHotkeys(id: string) { delete this.customKeys[id]; this.bake(); this.save() }
  /** The keys in effect for a command: the user's, else its default. */
  keysOf(id: string) { return this.getHotkeys(id) ?? this.getDefaultHotkeys(id) ?? [] }
  printHotkeyForCommand(id: string) {
    const k = this.keysOf(id)[0]
    const mac = Platform.isMacOS
    return k ? [...k.modifiers.map((m) => (m === "Mod" ? (mac ? "⌘" : "Ctrl") : m === "Shift" ? (mac ? "⇧" : "Shift") : m === "Alt" ? (mac ? "⌥" : "Alt") : m)), k.key.length === 1 ? k.key.toUpperCase() : k.key].join(mac ? "" : "+") : ""
  }
  bake() {
    this.bakedHotkeys = []; this.bakedIds = []
    for (const id of new Set([...Object.keys(this.defaultKeys), ...registered.commands.keys(), ...Object.keys(this.customKeys)])) {
      for (const k of this.keysOf(id)) { this.bakedHotkeys.push({ modifiers: k.modifiers.join(","), key: k.key }); this.bakedIds.push(id) }
    }
    this.trigger("changed")
  }
}

// Obsidian's core plugins, by id, with their option files in .obsidian/ and what's on by default there.
const CORE_PLUGINS: Record<string, { name: string; options?: string; on?: boolean }> = {
  "file-explorer": { name: "Files", on: true }, "global-search": { name: "Search", on: true }, switcher: { name: "Quick switcher", on: true },
  graph: { name: "Graph view", on: true }, backlink: { name: "Backlinks", on: true }, canvas: { name: "Canvas", on: true }, "outgoing-link": { name: "Outgoing links", on: true },
  "tag-pane": { name: "Tags view", on: true }, properties: { name: "Properties view", on: true }, "page-preview": { name: "Page preview", options: "page-preview.json", on: true },
  "daily-notes": { name: "Daily notes", options: "daily-notes.json", on: true }, templates: { name: "Templates", options: "templates.json", on: true },
  "note-composer": { name: "Note composer", options: "note-composer.json", on: true }, "command-palette": { name: "Command palette", options: "command-palette.json", on: true },
  "editor-status": { name: "Editing toolbar", on: true }, bookmarks: { name: "Bookmarks", options: "bookmarks.json", on: true }, outline: { name: "Outline", on: true },
  "word-count": { name: "Word count", on: true }, "file-recovery": { name: "File recovery", on: true }, bases: { name: "Bases", on: true },
  "zk-prefixer": { name: "Unique note creator", options: "zk-prefixer.json" }, "random-note": { name: "Random note" }, slides: { name: "Slides" },
  "audio-recorder": { name: "Audio recorder" }, workspaces: { name: "Workspaces", options: "workspaces.json" }, "markdown-importer": { name: "Format converter" },
  publish: { name: "Publish" }, sync: { name: "Sync" }, footnotes: { name: "Footnotes view" }, webviewer: { name: "Web viewer" },
}
const DEFAULT_OPTIONS: Record<string, any> = {
  "daily-notes": { format: "YYYY-MM-DD", folder: "", template: "", autorun: false }, templates: { folder: "", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" },
  "zk-prefixer": { format: "YYYYMMDDHHmm", folder: "", template: "" }, bookmarks: { items: [] }, "command-palette": { pinned: [] }, "page-preview": {},
}

class InternalPlugin extends Component {
  id: string; name: string; enabled = false; instance: any; manager: InternalPlugins
  /** Its views' makers by type, and Bases' view kinds (plugins patch them). */
  views: Record<string, (leaf: any) => any> = {}
  constructor(manager: InternalPlugins, id: string, instance: any) {
    super()
    this.manager = manager; this.id = id; this.name = CORE_PLUGINS[id]?.name ?? id; this.instance = instance
    // (as Obsidian's: an instance knows its plugin)
    if (instance && typeof instance === "object" && !instance.plugin) instance.plugin = this
    // (the app draws these itself: a maker gives a stand-in, which plugins read their prototypes from to patch)
    const none = (type: string) => (leaf: any) => standIn(type, leaf)
    if (id === "graph") this.views = { graph: none("graph"), localgraph: none("localgraph") }
    if (id === "file-explorer") this.views = { "file-explorer": () => manager.app.workspace.internal.find((l: any) => l.view instanceof FileExplorerView)?.view }
    else if (id === "backlink" || id === "outgoing-link" || id === "outline" || id === "tag-pane" || id === "global-search" || id === "bookmarks") this.views = { [id === "global-search" ? "search" : id]: none(id) }
    if (id === "canvas") this.views = { canvas: (leaf: any) => ({ ...standIn("canvas", leaf), canvas: new CanvasStandIn(leaf?.app ?? manager.app) }) }
  }
  async enable() { this.enabled = true; this._loaded = true; this.manager.save(); this.manager.trigger("change", this); return true }
  async disable() { this.enabled = false; this.manager.save(); this.manager.trigger("change", this); return true }
}
const statusBarEl = document.createElement("div")

/** Obsidian's quick switcher (core switcher's QuickSwitcherModal, which plugins extend and patch): notes by name. */
class QuickSwitcherModal extends ui.SuggestModal<{ type: "file"; file: vault.TFile; match: any }> {
  constructor(app: any) { super(app); this.setPlaceholder("Find or create a note...") }
  getSuggestions(q: string) {
    const files = (this.app.vault as vault.Vault).getFiles().filter((f) => f.extension === "md" || f.extension === "canvas" || f.extension === "base")
    if (!q.trim()) return files.slice(0, this.limit).map((file) => ({ type: "file" as const, file, match: { score: 0, matches: [] } }))
    const fuzzy = ui.prepareFuzzySearch(q)
    return files.flatMap((file) => { const match = fuzzy(file.path); return match ? [{ type: "file" as const, file, match }] : [] }).sort((a, b) => b.match.score - a.match.score)
  }
  renderSuggestion(v: { file: vault.TFile; match: any }, el: HTMLElement) { ui.renderResults(el.createDiv({ cls: "suggestion-title" }), v.file.path, v.match) }
  onChooseSuggestion(v: { file: vault.TFile }) { void this.app.workspace.openLinkText(v.file.path, "") }
}

class GraphEngine { onNodeHover() {} onNodeUnhover() {} render() {} }
/** A core view the app draws itself, as an object: its type, its leaf, and a graph's engine. */
/** Obsidian's canvas, as far as plugins borrow it to draw a note somewhere of theirs (Excalidraw's embedded notes):
 *  file nodes that draw the note (embedRegistry's "md") and edit it. The app's own canvas isn't Obsidian's. */
class CanvasStandIn {
  app: any
  constructor(app: any) { this.app = app }
  createFileNode(o: { file: any; subpath?: string }) { return new CanvasFileNode(this.app, o.file, o.subpath ?? "") }
  removeNode(n: CanvasFileNode) { n.child?.unload() }
}
class CanvasFileNode {
  app: any; file: any; subpath: string; child: any = null; isEditing = false
  containerEl = createEl("div", { cls: "canvas-node" })
  contentEl = this.containerEl.createDiv({ cls: "canvas-node-container" })
  constructor(app: any, file: any, subpath: string) { this.app = app; this.file = file; this.subpath = subpath }
  setFilePath(path: string, subpath = "") { this.file = this.app.vault.getFileByPath(path) ?? this.file; this.subpath = subpath }
  render() {
    this.child?.unload()
    this.contentEl.empty()
    this.child = this.app.embedRegistry.embedByExtension.md?.({ app: this.app, containerEl: this.contentEl }, this.file, this.subpath)
    this.child?.load()
  }
  startEditing() { this.isEditing = true; this.child?.showEditor?.() }
  blur() { this.isEditing = false; this.child?.showPreview?.() }
}

function standIn(type: string, leaf: any) {
  const containerEl = document.createElement("div")
  // (a class of its own: plugins patch view.constructor.prototype)
  return Object.assign(new (class StandInView {})(), { leaf, app: leaf?.app, containerEl, contentEl: containerEl.createDiv({ cls: "view-content" }), engine: new GraphEngine(), renderer: null, navigation: false,
    getViewType: () => type, getDisplayText: () => type, getIcon: () => "lucide-file", getState: () => ({}), setState: async () => {}, onOpen: async () => {}, onClose: async () => {}, load() {}, unload() {} })
}
class InternalPlugins extends Events {
  app: App
  plugins: Record<string, InternalPlugin> = {}
  config: Record<string, boolean> = {}
  constructor(app: App) {
    super()
    this.app = app
    for (const [id, p] of Object.entries(CORE_PLUGINS)) this.plugins[id] = new InternalPlugin(this, id, this.instanceFor(id, p.name))
  }
  private instanceFor(id: string, name: string) {
    const app = this.app
    // (each of its own class, as Obsidian's: plugins patch instance.constructor.prototype, which mustn't be Object's)
    const inst: any = Object.assign(new (class InternalPluginInstance {})(), { id, name, app, plugin: null, options: structuredClone(DEFAULT_OPTIONS[id] ?? {}),
      saveData: async (o: any) => { inst.options = o ?? inst.options; await writeConfig(CORE_PLUGINS[id].options!, inst.options) } })
    if (id === "switcher") inst.QuickSwitcherModal = QuickSwitcherModal
    if (id === "global-search") {
      // (the app's search page, in a tab: view:search/<query>)
      let query = ""
      inst.openGlobalSearch = (q: string) => { query = String(q ?? ""); if (query) openView(`search/${query}`); else runCommandById("search:search") }
      inst.getGlobalSearchQuery = () => query
    }
    if (id === "file-explorer") inst.revealInFolder = (f: any) => { if (f?.path) void app.workspace.openLinkText?.(f.path, ""); runCommandById("file:reveal") }
    if (id === "bookmarks") {
      Object.defineProperty(inst, "items", { get: () => inst.options.items ?? [] })
      inst.getBookmarks = () => flat(inst.options.items ?? [])
      inst.addItem = async (item: any) => { (inst.options.items ??= []).push(item); await inst.saveData(); inst.trigger?.("changed") }
      inst.removeItem = async (item: any) => { inst.options.items = (inst.options.items ?? []).filter((x: any) => x !== item); await inst.saveData() }
      inst.on = () => ({}); inst.off = () => {}; inst.offref = () => {}
    }
    if (id === "page-preview") inst.onLinkHover = (parent: any, targetEl: HTMLElement, linktext: string, sourcePath: string, state?: any) =>
      app.workspace.trigger("hover-link", { event: null, source: "preview", hoverParent: parent, targetEl, linktext, sourcePath, state })
    if (id === "bases") inst.registrations = Object.fromEntries(["table", "cards", "list", "map"].map((t) => [t, { name: t, icon: "lucide-table", factory: () => null }]))
    // (Obsidian Sync never runs here: the vault syncs by itself, so it reads as idle and fully synced)
    if (id === "sync") Object.assign(inst, { syncing: false, syncStatus: "Fully synced", getStatus: () => "synced", pause: async () => {}, resume: async () => {} })
    if (id === "templates") inst.insertTemplate = async (f: any) => { void f; runCommandById("templates:insert") }
    return inst
  }
  async load() {
    const on = await readConfig<string[] | Record<string, boolean>>("core-plugins.json")
    const enabled = Array.isArray(on) ? Object.fromEntries(on.map((id) => [id, true])) : on ?? {}
    for (const [id, p] of Object.entries(this.plugins)) {
      p.enabled = id in enabled ? !!enabled[id] : !!CORE_PLUGINS[id].on
      p._loaded = p.enabled
      this.config[id] = p.enabled
      const file = CORE_PLUGINS[id].options
      if (file) { const o = await readConfig(file); if (o) Object.assign(p.instance.options, o) }
    }
  }
  save() { for (const [id, p] of Object.entries(this.plugins)) this.config[id] = p.enabled; saveLater("core-plugins.json", () => this.config) }
  getPluginById(id: string) { return this.plugins[id] ?? null }
  getEnabledPluginById(id: string) { return this.plugins[id]?.enabled ? this.plugins[id].instance : null }
  getEnabledPlugins() { return Object.values(this.plugins).filter((p) => p.enabled) }
}
const flat = (items: any[]): any[] => items.flatMap((i) => (i.type === "group" ? flat(i.items ?? []) : [i]))

type Installed = { id: string; manifest: Manifest; enabled: boolean; allowed: boolean }
/** Community plugins: installed (manifests), on (enabledPlugins) and loaded (plugins). */
class Plugins extends Events {
  plugins: Record<string, any> = {}
  manifests: Record<string, Manifest> = {}
  enabledPlugins = new Set<string>()
  updates: Record<string, unknown> = {}
  async loadManifests() {
    const list = await get<Installed[]>("plugin-compat/plugins").catch(() => [] as Installed[])
    for (const p of list) { this.manifests[p.id] = { ...p.manifest, dir: `.obsidian/plugins/${p.id}` }; if (p.enabled) this.enabledPlugins.add(p.id) }
  }
  getPlugin(id: string) { return this.plugins[id] ?? null }
  getPluginFolder() { return ".obsidian/plugins" }
  isEnabled() { return true }
  async enablePlugin(id: string) {
    if (this.plugins[id]) return true
    const m = this.manifests[id]
    if (!m) return false
    const r = await loadPlugin(id, m)
    if (r.state === "ok") this.enabledPlugins.add(id)
    return r.state === "ok"
  }
  async disablePlugin(id: string) { unloadPlugin(id); this.enabledPlugins.delete(id); return true }
  async enablePluginAndSave(id: string) { const r = await post<Installed>("plugin-compat/enable", { id, on: true }).catch(() => null); return r?.allowed ? this.enablePlugin(id) : false }
  async disablePluginAndSave(id: string) { await post("plugin-compat/enable", { id, on: false }).catch(() => {}); return this.disablePlugin(id) }
  async loadPlugin(id: string) { return this.enablePlugin(id) }
  async unloadPlugin(id: string) { return this.disablePlugin(id) }
  async checkForUpdates() { return {} }
  requestSaveConfig() {}
  saveConfig() {}
}

/** Property types: Obsidian's types.json, and the widgets plugins look up by type. */
class MetadataTypeManager extends Events {
  app: App
  properties: Record<string, { name: string; type: string; count: number }> = {}
  types: Record<string, { name: string; type: string }> = {}
  registeredTypeWidgets: Record<string, any> = {}
  constructor(app: App) {
    super()
    this.app = app
    for (const type of ["text", "multitext", "number", "checkbox", "date", "datetime", "aliases", "tags"]) {
      this.registeredTypeWidgets[type] = { type, name: () => type, icon: type === "checkbox" ? "lucide-check-square" : type === "number" ? "lucide-binary" : type.startsWith("date") ? "lucide-calendar" : "lucide-text",
        default: () => (type === "checkbox" ? false : type === "multitext" || type === "tags" || type === "aliases" ? [] : ""),
        validate: (v: unknown) => (type === "number" ? typeof v === "number" : type === "checkbox" ? typeof v === "boolean" : true), render: (el: HTMLElement, data: any) => { el.setText(String(data?.value ?? "")); return { focus() {} } } }
    }
  }
  async load() {
    const t = await readConfig<{ types?: Record<string, string> }>("types.json")
    this.types = Object.fromEntries(Object.entries(t?.types ?? {}).map(([k, v]) => [k.toLowerCase(), { name: k, type: v }]))
  }
  save() { saveLater("types.json", () => ({ types: Object.fromEntries(Object.values(this.types).map((t) => [t.name, t.type])) })) }
  getAllProperties() { return this.properties }
  getPropertyInfo(k: string) { return this.properties[String(k).toLowerCase()] ?? null }
  getAssignedType(k: string) { return this.types[String(k).toLowerCase()]?.type ?? null }
  getAssignedWidget(k: string) { return this.getAssignedType(k) }
  getWidget(type: string) { return this.registeredTypeWidgets[type] ?? this.registeredTypeWidgets.text }
  getTypeInfo(p: string | { key?: string; name?: string; value?: unknown }, value?: unknown) {
    const key = typeof p === "string" ? p : p?.key ?? p?.name ?? ""
    const v = typeof p === "string" ? value : p?.value
    const assigned = this.getAssignedType(key)
    const inferredType = Array.isArray(v) ? "multitext" : typeof v === "number" ? "number" : typeof v === "boolean" ? "checkbox" : typeof v === "string" && /^\d{4}-\d\d-\d\d(T|$)/.test(v) ? (v.includes("T") ? "datetime" : "date") : "text"
    const expected = this.getWidget(assigned ?? inferredType), inferred = this.getWidget(inferredType)
    return { expected, inferred }
  }
  setType(k: string, type: string) { this.types[k.toLowerCase()] = { name: k, type }; this.save(); this.trigger("changed", k) }
  unsetType(k: string) { delete this.types[k.toLowerCase()]; this.save(); this.trigger("changed", k) }
  savePropertyInfo() { this.save() }
}

/** Embeds by extension (![[x]]): a note's renders its text and can switch to an editor; others show the file. */
class EmbedRegistry extends Events {
  embedByExtension: Record<string, (ctx: any, file: any, subpath: string) => any> = {}
  constructor() {
    super()
    this.registerExtension("md", (ctx, file, subpath) => new editor.MarkdownEmbed(ctx, file, subpath))
    for (const ext of ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"]) this.registerExtension(ext, (ctx, file) => new FileEmbed(ctx, file, "img"))
    for (const ext of ["mp3", "wav", "m4a", "ogg", "3gp", "flac", "webm"]) this.registerExtension(ext, (ctx, file) => new FileEmbed(ctx, file, ext === "webm" ? "video" : "audio"))
    for (const ext of ["mp4", "mov", "ogv", "mkv"]) this.registerExtension(ext, (ctx, file) => new FileEmbed(ctx, file, "video"))
    this.registerExtension("pdf", (ctx, file) => new FileEmbed(ctx, file, "iframe"))
  }
  registerExtension(ext: string, fn: (ctx: any, file: any, subpath: string) => any) { this.embedByExtension[ext] = fn }
  registerExtensions(exts: string[], fn: (ctx: any, file: any, subpath: string) => any) { for (const e of exts) this.registerExtension(e, fn) }
  unregisterExtension(ext: string) { delete this.embedByExtension[ext] }
  unregisterExtensions(exts: string[]) { for (const e of exts) this.unregisterExtension(e) }
  isExtensionRegistered(ext: string) { return ext in this.embedByExtension }
  getEmbedCreator(file: any) { return this.embedByExtension[file?.extension] ?? null }
}
class FileEmbed extends Component {
  containerEl: HTMLElement; file: any; tag: string
  constructor(ctx: any, file: any, tag: string) { super(); this.containerEl = ctx.containerEl; this.file = file; this.tag = tag }
  loadFile() {
    if (!this.file) return
    const el = this.containerEl.createEl(this.tag as any, { attr: { src: this.file.vault.getResourcePath(this.file), ...(this.tag === "img" ? { alt: this.file.name } : { controls: true }) } })
    if (this.tag === "iframe") el.style.cssText = "width:100%;height:600px;border:0"
  }
  onload() { this.loadFile() }
}

/** Views by type and the file extensions they open (registerView, registerExtensions). */
class ViewRegistry extends Events {
  app: App
  typeByExtension: Record<string, string> = {}
  constructor(app: App) { super(); this.app = app }
  get viewByType(): Record<string, any> { return Object.fromEntries(this.app.workspace.factories) }
  registerView(type: string, fn: any) { this.app.workspace.factories.set(type, fn); this.trigger("view-registered", type) }
  unregisterView(type: string) { this.app.workspace.factories.delete(type); this.trigger("view-unregistered", type) }
  getViewCreatorByType(type: string) { return this.app.workspace.factories.get(type) }
  isExtensionRegistered(ext: string) { return ext in this.typeByExtension }
  registerExtensions(exts: string[], type: string) { for (const e of exts) this.typeByExtension[e] = type; this.trigger("extensions-updated") }
  unregisterExtensions(exts: string[]) { for (const e of exts) delete this.typeByExtension[e]; this.trigger("extensions-updated") }
  getTypeByExtension(ext: string) { return this.typeByExtension[ext] }
}

/** Themes and CSS snippets as Obsidian keeps them: listed from .obsidian/, never applied (the app has its own themes). */
class CustomCss extends Events {
  app: App
  theme = ""
  themes: Record<string, any> = {}
  oldThemes: string[] = []
  snippets: string[] = []
  enabledSnippets = new Set<string>()
  csscache = new Map<string, string>()
  extraStyleEls: HTMLElement[] = []
  styleEl = document.createElement("style")
  constructor(app: App) { super(); this.app = app }
  async load() {
    const a = await readConfig<{ cssTheme?: string; enabledCssSnippets?: string[] }>("appearance.json")
    this.theme = a?.cssTheme ?? ""
    this.enabledSnippets = new Set(a?.enabledCssSnippets ?? [])
  }
  getSnippetsFolder() { return ".obsidian/snippets" }
  getThemeFolder() { return ".obsidian/themes" }
  getSnippetPath(name?: string) { return name ? `.obsidian/snippets/${name}.css` : ".obsidian/snippets" }
  getThemePath(name: string) { return `.obsidian/themes/${name}` }
  readSnippets() {}
  readThemes() {}
  requestLoadSnippets() {}
  requestLoadTheme() {}
  loadSnippets() {}
  setCssEnabledStatus(name: string, on: boolean) { if (on) this.enabledSnippets.add(name); else this.enabledSnippets.delete(name); this.trigger("css-change") }
  setTheme(name: string) { this.theme = name; this.trigger("css-change") }
  isThemeInstalled(name: string) { return name in this.themes }
  hasUpdates() { return false }
}

export class App {
  vault: vault.Vault
  metadataCache: vault.MetadataCache
  fileManager: vault.FileManager
  workspace: ws.Workspace
  keymap = new ui.Keymap()
  scope = new ui.Scope()
  lastEvent: any = null
  isMobile = phone
  appId = "vaultite"
  title = "Vaultite"
  commands: Commands
  plugins = new Plugins()
  internalPlugins: InternalPlugins
  hotkeyManager = new HotkeyManager()
  metadataTypeManager: MetadataTypeManager
  embedRegistry = new EmbedRegistry()
  viewRegistry: ViewRegistry
  customCss: CustomCss
  setting: any
  dom = { appContainerEl: document.body, workspaceEl: document.body, get statusBarEl() { return statusBarEl } }
  dragManager = { dragFile: (_e: any, file: any) => ({ type: "file", file, icon: "lucide-file", title: file?.basename }), dragFiles: (_e: any, files: any[]) => ({ type: "files", files, title: `${files.length} files` }),
    dragFolder: (_e: any, file: any) => ({ type: "folder", file, title: file?.name }), dragLink: (_e: any, linktext: string) => ({ type: "link", linktext }), onDragStart() {}, handleDrop() {}, updateSource() {}, draggable: null, setAction() {} }
  foldManager = {
    load: async (f: any) => this.loadLocalStorage(`fold:${f?.path ?? f}`), save: async (f: any, folds: unknown) => this.saveLocalStorage(`fold:${f?.path ?? f}`, folds),
  }
  statusBar = { containerEl: statusBarEl }
  secretStorage = new ui.SecretStorage()
  mobileToolbar = { update() {}, containerEl: document.createElement("div") }
  mobileNavbar = { containerEl: document.createElement("div"), isVisible: false, show() {}, hide() {} }
  account = { email: "", name: "", company: "" }
  loadProgress = { show() {}, hide() {}, setMessage() {}, setProgress() {} }
  renderContext = {}
  constructor() {
    this.vault = new vault.Vault()
    this.metadataCache = this.vault.meta
    this.fileManager = new vault.FileManager(this.vault)
    this.workspace = new ws.Workspace(this, this.vault)
    this.workspace.addInternal((l) => new FileExplorerView(l, this.vault))
    this.commands = new Commands(this)
    this.internalPlugins = new InternalPlugins(this)
    this.metadataTypeManager = new MetadataTypeManager(this)
    this.viewRegistry = new ViewRegistry(this)
    this.customCss = new CustomCss(this)
    this.setting = { open: () => openSettings(null), openTabById: (id: string) => openSettings(id), close() {}, get pluginTabs() { return [...registered.settingTabs.values()] },
      get activeTab() { return shownTab() }, settingTabs: [], addSettingTab() {}, removeSettingTab() {}, containerEl: document.createElement("div"), tabContentContainer: document.createElement("div"),
      openPage: (page: ui.SettingPage) => openPage(this, page), closePage: () => shownTab()?.closePage(), navigateToSearchResult() {},
      updatePageTitle() { const t = shownTab(), top = t?.pages[t.pages.length - 1]; if (top?.page) top.el.querySelector(".setting-page-title")?.replaceChildren(top.page.title) } }
    // (the root of key scopes: a plugin's app.scope.register keys fire unless a modal's scope is on top)
    this.keymap.pushScope(this.scope)
    // (read before plugins load: vault.refresh waits for these the first time)
    this.vault.loading.push(this.plugins.loadManifests(), this.hotkeyManager.load(), this.internalPlugins.load(), this.metadataTypeManager.load(), this.customCss.load())
  }
  loadLocalStorage(k: string) { try { const v = localStorage.getItem(`obsidian-compat:${k}`); return v === null ? null : JSON.parse(v) } catch { return null } }
  saveLocalStorage(k: string, v: unknown) { try { if (v === null || v === undefined) localStorage.removeItem(`obsidian-compat:${k}`); else localStorage.setItem(`obsidian-compat:${k}`, JSON.stringify(v)) } catch { /* private mode */ } }
  isDarkMode() { return document.documentElement.classList.contains("dark") }
  getTheme() { return this.isDarkMode() ? "obsidian" : "moonstone" }
  getAccentColor() { return getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() }
  changeTheme(_t: string) {}
  emulateMobile(_on: boolean) {}
  openWithDefaultApp(path: string) { runCommandById("file:open-outside"); void path }
  showInFolder(path: string) { runCommandById("file:reveal-finder"); void path }
  openVaultChooser() {}
  showReleaseNotes() {}
  async runOpeningBehavior() {}
  getObsidianUrl(f: any) { return `obsidian://open?vault=${encodeURIComponent(this.vault.getName())}&file=${encodeURIComponent(f?.path ?? "")}` }
  nextFrame(fn: () => any) { requestAnimationFrame(fn) }
  getAppTitle(name?: string) { return name ? `${name} - Vaultite` : "Vaultite" }
  updateTitle() {}
  getSpellcheckLanguages() { return [navigator.language] }
}

export let openSettings: (id: string | null) => void = () => {}
export const setSettingsOpener = (fn: typeof openSettings) => { openSettings = fn }

/** Run one of the Obsidian commands: its editor's version when it has one and a note is in front. */
export function runObsidian(app: App, id: string, checking = false): boolean {
  const c = registered.commands.get(id)?.cmd
  if (!c) return false
  try {
    const view = app.workspace.getActiveViewOfType(ws.MarkdownView) as ws.MarkdownView | null
    if (c.editorCheckCallback) return view ? !!c.editorCheckCallback(checking, view.editor, view) : false
    if (c.editorCallback) { if (!view) return false; if (!checking) void c.editorCallback(view.editor, view); return true }
    if (c.checkCallback) return !!c.checkCallback(checking)
    if (c.callback) { if (!checking) void c.callback(); return true }
  } catch (e) { console.error(e); if (!checking) notify(`${id}: ${(e as Error).message}`) }
  return false
}

/** i18next as Obsidian has it: plugins bring their own resources, so their keys translate (English when it lacks one). */
// Obsidian's own words that plugins borrow through i18next (in English, sentence case as the app writes them).
const OBSIDIAN_EN = {
  dialogue: { "button-continue": "Continue", "button-cancel": "Cancel" },
  commands: { "zoom-in": "Zoom in", "zoom-out": "Zoom out", "reset-zoom": "Reset zoom" },
  editor: { search: { "placeholder-find": "Find", "label-previous": "Previous", "label-next": "Next", "label-find-all": "Find all", "label-exit-search": "Exit search" } },
  interface: { "sidebar-expand": "Expand", "sidebar-collapse": "Collapse", "copied_generic": "Copied to your clipboard", "embed-open-in-default-app-tooltip": "Open in default app",
    menu: { find: "Find" }, "drag-and-drop": { "insert-link-here": "Insert link here" } },
  plugins: { "file-explorer": { "action-reveal-file": "Reveal file in navigation", "menu-opt-rename": "Rename", "menu-opt-delete": "Delete" } },
  setting: { hotkeys: { name: "Hotkeys" }, "third-party-plugin": { "option-browse-community-plugins-description": "Browse community plugins" } },
}

function i18n(lang: string): any {
  const res: Record<string, Record<string, any>> = { en: { translation: structuredClone(OBSIDIAN_EN) } }
  const lookup = (l: string, ns: string, key: string) => key.split(".").reduce((o: any, k) => o?.[k], res[l]?.[ns])
  const inst: any = {
    language: lang, languages: [lang, "en"], options: { fallbackLng: "en", defaultNS: "translation" }, isInitialized: true,
    t(key: string | string[], o?: any) {
      const ns = o?.ns ?? inst.options.defaultNS ?? "translation"
      for (const k of Array.isArray(key) ? key : [key]) {
        const v = lookup(inst.language, ns, k) ?? lookup("en", ns, k)
        if (typeof v === "string") return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (m: string, n: string) => (o && n in o ? String(o[n]) : m))
      }
      return o?.defaultValue ?? (Array.isArray(key) ? key[0] : key)
    },
    exists: (k: string, o?: any) => lookup(inst.language, o?.ns ?? "translation", k) !== undefined,
    init(o?: any, cb?: any) { Object.assign(inst.options, o ?? {}); for (const [l, nss] of Object.entries(o?.resources ?? {})) for (const [ns, r] of Object.entries(nss as any)) inst.addResourceBundle(l, ns, r); if (o?.lng) inst.language = o.lng; cb?.(null, inst.t); return Promise.resolve(inst.t) },
    use() { return inst }, on() {}, off() {}, changeLanguage: async (l?: string) => { if (l) inst.language = l; return inst.t }, getFixedT: () => inst.t,
    addResourceBundle(l: string, ns: string, r: any, deep?: boolean, overwrite?: boolean) { void deep; void overwrite; ((res[l] ??= {})[ns] = { ...(res[l]?.[ns] ?? {}), ...r }); return inst },
    addResources(l: string, ns: string, r: any) { return inst.addResourceBundle(l, ns, r) }, hasResourceBundle: (l: string, ns: string) => !!res[l]?.[ns],
    getResourceBundle: (l: string, ns: string) => res[l]?.[ns], loadNamespaces: async () => {}, loadLanguages: async () => {}, dir: () => "ltr",
    createInstance: (o?: any) => { const n = i18n(lang); if (o) void n.init(o); return n }, cloneInstance: () => inst,
  }
  return inst
}

/** Obsidian's own globals that aren't the DOM's: i18next, and CodeMirror 5's (its modes, runtime/cm5.ts). */
export function installGlobals() {
  const w = window as any
  const lang = (localStorage.getItem("language") || navigator.language || "en").split("-")[0]
  w.i18next ??= i18n(lang)
  w.CodeMirror ??= cm5()
  w.CodeMirrorAdapter ??= { commands: {}, Vim: null }
  vim ??= import("@replit/codemirror-vim").then((m) => { w.CodeMirrorAdapter.Vim ??= m.Vim; w.CodeMirror.Vim ??= m.Vim }, () => {})
}
let vim: Promise<void> | null = null
/** Obsidian's globals that load: CodeMirror's Vim (always there in Obsidian, whether Vim mode is on or not). */
export const globalsReady = () => vim ?? Promise.resolve()

/** The plugin settings tab on screen (in its plugin's sheet), if any. */
const shownTab = () => [...registered.settingTabs.values()].find((t) => t.containerEl.isConnected) ?? null

// Obsidian 1.13's settings pages (app.setting.openPage): in the tab on screen, with Back; else in a dialog of their own.
function openPage(app: App, page: ui.SettingPage) {
  const tab = shownTab()
  if (tab) return tab.openPage(page.title, (el) => { el.append(page.rootEl); page.display() }, () => page.hide(), page)
  const m = new ui.Modal(app)
  m.setTitle(page.title)
  m.onOpen = () => { m.contentEl.append(page.rootEl); page.display() }
  m.onClose = () => page.hide()
  m.open()
}
