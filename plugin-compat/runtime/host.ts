// Obsidian plugins' Plugin class, what they register, and loading each one's main.js as Obsidian does (CommonJS, its
// default export a Plugin subclass).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { get, getStore, post } from "@vaultite"
import moment from "../lib/moment.js"
import { Component, miss, missedBy, watched } from "./core.ts"
import { installDom } from "./dom.ts"
import { App } from "./app.ts"
import { moduleFor } from "./module.ts"
import { scopeFor, SCOPE_NAMES } from "./require.ts"
import { FileSystemAdapter } from "./node/adapter.ts"
import * as editor from "./editor.ts"
import * as ui from "./ui.ts"
import * as ws from "./workspace.ts"

export { App, runObsidian, setSettingsOpener } from "./app.ts"
import { globalsReady, installGlobals } from "./app.ts"
export * from "./state.ts"
import { Platform, registered, tell, type Manifest, type ObsCommand } from "./state.ts"

// --- Plugin

export class Plugin extends Component {
  app: App
  manifest: Manifest
  constructor(app: App, manifest: Manifest) { super(); this.app = app; this.manifest = manifest }
  addCommand(c: ObsCommand) {
    const id = `${this.manifest.id}:${c.id}`
    const cmd = { ...c, id, name: `${this.manifest.name}: ${c.name}` }
    registered.commands.set(id, { plugin: this.manifest.id, cmd })
    this.register(() => { registered.commands.delete(id); tell() })
    tell()
    return cmd
  }
  removeCommand(id: string) { registered.commands.delete(`${this.manifest.id}:${id}`); tell() }
  addRibbonIcon(icon: string, title: string, run: (e: MouseEvent) => any) {
    const el = this.app.workspace.leftRibbon.addRibbonItemButton(`${this.manifest.id}:${title}`, icon, title, run)
    this.register(() => el.remove())
    return el
  }
  addStatusBarItem() {
    const el = document.createElement("div")
    el.className = "status-bar-item"
    const item = { plugin: this.manifest.id, el }
    registered.statusBar.push(item)
    this.register(() => { registered.statusBar = registered.statusBar.filter((x) => x !== item); tell() })
    tell()
    return el
  }
  addSettingTab(tab: ui.PluginSettingTab) { registered.settingTabs.set(this.manifest.id, tab); this.register(() => { registered.settingTabs.delete(this.manifest.id); tell() }); tell() }
  registerView(type: string, make: (leaf: ws.WorkspaceLeaf) => ws.View) {
    this.app.workspace.factories.set(type, make)
    registered.views.set(type, this.manifest.id)
    this.register(() => { this.app.workspace.detachLeavesOfType(type); this.app.workspace.factories.delete(type); registered.views.delete(type); tell() })
    tell()
  }
  registerMarkdownCodeBlockProcessor(lang: string, fn: (source: string, el: HTMLElement, ctx: any) => any) {
    registered.fences.set(lang, { plugin: this.manifest.id, fn })
    this.register(() => { registered.fences.delete(lang); tell() })
    tell()
    return Object.assign((el: HTMLElement, ctx: unknown) => { void el; void ctx }, { sortOrder: 0 })
  }
  registerMarkdownPostProcessor(fn: (el: HTMLElement, ctx: any) => any) {
    const p = { plugin: this.manifest.id, fn }
    registered.postProcessors.push(p)
    this.register(() => { registered.postProcessors = registered.postProcessors.filter((x) => x !== p) })
    return fn
  }
  registerEditorExtension(ext: any) { this.register(editor.addEditorExtension(ext)) }
  registerEditorSuggest(s: editor.EditorSuggest<any>) { owners.set(s, this.manifest.id); registered.suggests.push(s); this.register(() => { registered.suggests = registered.suggests.filter((x) => x !== s) }) }
  // (CodeMirror 5's editors, which Obsidian no longer has: never called, as there)
  registerCodeMirror(_fn: (cm: any) => any) {}
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }) { this.app.workspace.registerHoverLinkSource(id, info); this.register(() => this.app.workspace.unregisterHoverLinkSource(id)) }
  registerExtensions(exts: string[], type: string) {
    this.app.viewRegistry.registerExtensions(exts, type)
    for (const e of exts) { registered.extensions.set(e.toLowerCase(), { plugin: this.manifest.id, type }); this.app.workspace.extensions.set(e.toLowerCase(), type) }
    this.register(() => { this.app.viewRegistry.unregisterExtensions(exts); for (const e of exts) { registered.extensions.delete(e.toLowerCase()); this.app.workspace.extensions.delete(e.toLowerCase()) } tell() })
    tell()
  }
  registerObsidianProtocolHandler(action: string, fn: (params: Record<string, string>) => any) {
    registered.protocols.set(action, { plugin: this.manifest.id, fn })
    this.register(() => { if (registered.protocols.get(action)?.fn === fn) registered.protocols.delete(action); tell() })
    tell()
  }
  registerBasesView(type: string) { miss(this.manifest.id, `registerBasesView(${type})`); return false }
  registerCliHandler() { miss(this.manifest.id, "registerCliHandler") }
  onUserEnable() {}
  onExternalSettingsChange() {}
  async loadData() { return datas.get(this.manifest.id) ?? null }
  async saveData(d: unknown) { datas.set(this.manifest.id, d); await post(`plugin-compat/data/${this.manifest.id}`, { data: JSON.parse(JSON.stringify(d ?? null)) }) }
}
const datas = new Map<string, unknown>()
const owners = new WeakMap<object, string>()

// --- loading

export type Result = { id: string; name: string; version: string; state: "ok" | "failed" | "skipped"; error?: string; ms: number
  commands: number; views: string[]; fences: string[]; settings: boolean; ribbon: number; statusBar: number; postProcessors: number; editorExtensions: boolean; suggests: number; missed: Record<string, number>; thrown?: string[] }
export const results = new Map<string, Result>()
export const loaded = new Map<string, Plugin>()

// An error thrown from a plugin's code later (a handler, a promise nobody awaited), or the runtime working for one, is
// its own, as in Obsidian: in the console under its name and its result; the app leaves an event preventDefault()ed.
const thrownBy = (e: unknown) => { const s = String((e as Error)?.stack ?? ""); return /obsidian-plugin:([^/\s)]+)\/main\.js/.exec(s)?.[1] ?? (s.includes("/api/plugins/plugin-compat/") ? "(runtime)" : null) }
function own(ev: Event, e: unknown) {
  const id = thrownBy(e)
  if (!id) return
  ev.preventDefault()
  console.warn(`Obsidian plugin ${id}:`, e)
  const r = results.get(id)
  if (r) r.thrown = [...(r.thrown ?? []), String((e as Error)?.message ?? e).slice(0, 300)].slice(-5)
}
addEventListener("error", (ev) => own(ev, ev.error))
addEventListener("unhandledrejection", (ev) => own(ev, ev.reason))

/** Not run, and why (its result says so where it's listed). */
export function skipped(id: string, manifest: Manifest, why: string) {
  if (results.get(id)?.error === why) return
  results.set(id, { id, name: manifest.name, version: manifest.version, state: "skipped", error: why, ms: 0, commands: 0, views: [], fences: [], settings: false, ribbon: 0, statusBar: 0, postProcessors: 0, editorExtensions: false, suggests: 0, missed: {} })
  tell()
}

let theApp: App | null = null
export function appOf() {
  if (!theApp) {
    installDom()
    theApp = new App()
    if (Platform.isDesktopApp) theApp.vault.adapter = new FileSystemAdapter(theApp.vault)
    ;(window as any).app = theApp
    ;(window as any).moment = moment
    // (only moment's English is here: a locale it hasn't, Calendar's "en-us", answers with the current one's data)
    const localeData = moment.localeData
    moment.localeData = (k?: string) => localeData(k) ?? localeData()
    installGlobals()
    theApp.workspace.missing = (what) => miss("workspace", what)
  }
  return theApp
}

/** Load one plugin's main.js and run its onload. */
// What a plugin needs to run, fetched ahead for all of them at once (its main.js as a script, its styles and settings),
// so loading them in order waits on no network.
type Fetched = { meta: Promise<{ css: string; data: unknown }>; main: Promise<(s: Record<string, unknown>, module: any, exports: any) => void> }
const fetched = new Map<string, Fetched>()
const mains = new Map<string, (fn: any) => void>()
;(globalThis as any).__obsidianMain = (id: string, fn: any) => { mains.get(id)?.(fn); mains.delete(id) }

export function prefetch(id: string, hash: string) {
  if (fetched.has(id)) return
  const main = new Promise<any>((ok, no) => {
    mains.set(id, ok)
    const s = document.createElement("script")
    s.async = true
    s.src = new URL(`api/plugin-compat/main/${encodeURIComponent(id)}?h=${hash}&s=${SCOPE_NAMES.join(",")}`, document.baseURI).href
    s.onerror = () => { mains.delete(id); no(new Error("its main.js couldn't be loaded")) }
    s.onload = () => { s.remove(); if (mains.has(id)) { mains.delete(id); no(new Error("its main.js doesn't parse")) } }
    document.head.append(s)
  })
  main.catch(() => {})
  fetched.set(id, { main, meta: get<{ css: string; data: unknown }>(`plugin-compat/plugin/${id}`) })
}

export async function loadPlugin(id: string, manifest: Manifest, hash = "") {
  const app = appOf()
  const started = performance.now()
  const result: Result = { id, name: manifest.name, version: manifest.version, state: "ok", ms: 0, commands: 0, views: [], fences: [], settings: false, ribbon: 0, statusBar: 0, postProcessors: 0, editorExtensions: false, suggests: 0, missed: {} }
  results.set(id, result)
  if (manifest.isDesktopOnly && Platform.isPhone) { result.state = "skipped"; result.error = "It runs on computers only (desktop only, its manifest says)"; return result }
  try {
    prefetch(id, hash)
    const got = fetched.get(id)!
    fetched.delete(id)
    const [{ css, data }, main] = await Promise.all([got.meta, got.main])
    datas.set(id, data)
    await globalsReady()
    if (css) { const s = document.createElement("style"); s.dataset.obsidianPlugin = id; s.textContent = layered(css); document.head.append(s) }
    const papp = watched(app, id, "app", ["vault", "workspace", "metadataCache", "fileManager", "plugins", "internalPlugins", "commands", "setting", "keymap"])
    const mod = watched(moduleFor(papp as App), id, "obsidian")
    const module = { exports: {} as any }
    main(scopeFor(id, mod), module, module.exports)
    const Cls = module.exports.default ?? module.exports
    if (typeof Cls !== "function") throw new Error("main.js exports no Plugin class")
    const p: Plugin = new Cls(papp, { ...manifest, dir: `.obsidian/plugins/${id}` })
    app.plugins.plugins[id] = p
    app.plugins.manifests[id] = manifest
    app.plugins.enabledPlugins.add(id)
    loaded.set(id, p)
    p._loaded = true
    // (one whose onload never settles mustn't hold up the rest: it goes on in the background, said in its result)
    // (an onload that throws leaves what it registered, as Obsidian does: a "Plugin failure" in the console)
    const slow = await Promise.race([Promise.resolve().then(() => p.onload()).then(() => false, (e) => { result.error = `onload threw: ${String(e?.stack ?? e).split("\n").slice(0, 3).join("\n")}`; console.error(`Plugin failure: ${id}`, e); return false }),
      new Promise((r) => setTimeout(() => r(true), 10000))])
    if (slow) result.error = "onload took more than 10 s"
    for (const c of p._children) c.load()
  } catch (e) {
    result.state = "failed"
    result.error = String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n")
    console.error(`obsidian plugin ${id}:`, e)
  }
  result.ms = Math.round(performance.now() - started)
  tell()
  return result
}

export function unloadPlugin(id: string) {
  results.delete(id)
  const p = loaded.get(id)
  if (!p) return
  try { p.unload() } catch (e) { console.error(e) }
  loaded.delete(id)
  delete appOf().plugins.plugins[id]
  appOf().plugins.enabledPlugins.delete(id)
  document.querySelectorAll(`style[data-obsidian-plugin="${CSS.escape(id)}"]`).forEach((s) => s.remove())
  tell()
}

/** The properties notes use and their types (the app's, from types.json), for app.metadataTypeManager. */
export function syncProperties(app: App) {
  const types = (getStore()?.propertyTypes?.types ?? {}) as Record<string, string>
  const props: Record<string, { name: string; type: string; count: number }> = {}
  for (const c of app.vault.meta.cache.values()) for (const k of Object.keys(c.frontmatter ?? {})) {
    const p = props[k.toLowerCase()] ??= { name: k, type: types[k] ?? "text", count: 0 }
    p.count++
  }
  app.metadataTypeManager.properties = props
  app.metadataTypeManager.types = Object.fromEntries(Object.entries(types).map(([k, t]) => [k.toLowerCase(), { name: k, type: t }]))
}

/** What a plugin has registered now (some register only once the layout is ready). */
export function summaryOf(id: string): Result {
  const r = results.get(id)!
  const own = <T extends { plugin: string }>(l: Iterable<T>) => [...l].filter((x) => x.plugin === id)
  return { ...r, commands: own(registered.commands.values()).length, fences: [...registered.fences].filter(([, f]) => f.plugin === id).map(([k]) => k),
    views: [...registered.views].filter(([, p]) => p === id).map(([k]) => k), settings: registered.settingTabs.has(id), ribbon: own(registered.ribbon).length,
    statusBar: own(registered.statusBar).length, postProcessors: own(registered.postProcessors).length,
    suggests: registered.suggests.filter((s) => owners.get(s) === id).length, missed: missedOf(id) }
}

export const missedOf = (id: string) => missedBy.get(id) ?? {}

/** A plugin's styles under the app's utilities (the `plugins` layer): its `.hidden` mustn't hide the app's `md:flex`. */
function layered(css: string) {
  const imports = css.match(/^\s*@(import|charset)[^;]+;/gm) ?? []
  return `${imports.join("\n")}\n@layer plugins {\n${imports.reduce((c, i) => c.replace(i, ""), css)}\n}`
}
