// Obsidian plugins in the app: the runtime (runtime/host.ts) loads the ones on in every window, and each becomes a plugin
// of the app's (hostPlugins): its commands, options, views, panels, ribbon, status items and code blocks drawn as any.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { LucideIcon } from "lucide-react"
import { commandList, currentEditor, currentFile, definePlugin, keysOf as keysOfApp, dockAtEnd, get, hostPlugins, isDesktop, standingIn, onTabLayoutChange, openPluginSettings, panelSide, post, revealPanel, useFocusedFile, useVaultChange,
  type BlockCtx, type BrowseSource, type FileFormat, type FileMenuItem, type HostedPlugin, type OpenEditor, type PluginCommand, type PluginHost, type SidebarCtx } from "@vaultite"
import { Prec } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import "./obsidian.css"
import { activeEditor, Editor, editorExtension, setEditorShown, setInfoOf, suggestExtension } from "./runtime/editor.ts"
import { appOf, changed, loaded, loadPlugin, prefetch, skipped, missedOf, Platform, registered, results, runObsidian, setSettingsOpener, summaryOf, syncProperties, unloadPlugin, type Manifest } from "./runtime/host.ts"
import { LooseStatus, NoteActions, ViewActions } from "./actions.tsx"
import type { FileExplorerView } from "./runtime/explorer.ts"
import { obsidianTokens } from "./runtime/tags.ts"
import { renderMarkdown, watchAppMarkdown } from "./runtime/render.ts"
import { routeWindowOpen, runUri } from "./runtime/uri.ts"
import { Menu, setIcon, prefetchIcons } from "./runtime/ui.ts"
import { Component, fromB64, type Events } from "./runtime/core.ts"
import { parking, portals, portalsChanged, rootEl, viewName, type WorkspaceLeaf } from "./runtime/workspace.ts"

type Installed = { id: string; manifest: Manifest & { authorUrl?: string }; enabled: boolean; styles: boolean; hash: string; allowed: boolean; here: boolean
  disclosures?: HostedPlugin["disclosures"]; changed?: boolean }

const HOST = "plugin-compat"
/** An Obsidian plugin's id here (`obsidian.calendar`), and its commands' (`obsidian.calendar:open`). */
const hosted = (id: string) => `obsidian.${id}`
const unhosted = (id: string) => id.replace(/^obsidian\./, "")

const useChanged = (ev: Events = changed) => {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => { const ref = ev.on("changed", bump); return () => ev.offref(ref) }, [ev])
  return n
}

// An icon by its Obsidian name (Lucide's, or one a plugin added), as a component the app draws where it wants one.
const icons = new Map<string, LucideIcon>()
function iconNamed(name: string): LucideIcon {
  let c = icons.get(name)
  if (!c) {
    const Icon = ({ className }: { className?: string }) => {
      const ref = useRef<HTMLSpanElement>(null)
      useLayoutEffect(() => { if (ref.current) setIcon(ref.current, name) }, [])
      return <span ref={ref} aria-hidden className={`obsidian-icon inline-grid shrink-0 place-items-center [&>svg]:size-full ${className ?? "size-4"}`} />
    }
    c = Icon as unknown as LucideIcon
    icons.set(name, c)
  }
  return c
}

/** A code fence a plugin draws (```dataview): its processor run on the fence's text, in an element of its own. */
function Fence({ lang, ctx }: { lang: string; ctx: BlockCtx }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current, f = registered.fences.get(lang)
    if (!el || !f) return
    const app = appOf(), children: { unload(): void }[] = []
    let gone = false
    void (async () => {
      const file = app.vault.getFileByPath(ctx.path)
      const text = file ? await app.vault.cachedRead(file).catch(() => "") : ""
      if (gone) return
      el.replaceChildren()
      const at = text.split("\n").findIndex((l, i, all) => l.trim().startsWith("```" + lang) && all.slice(i + 1).join("\n").startsWith(ctx.text))
      const pctx = { docId: ctx.path, sourcePath: ctx.path, frontmatter: ctx.fm, displayMode: true,
        addChild: (c: { load(): void; unload(): void }) => { c.load(); children.push(c) },
        getSectionInfo: () => (at < 0 ? null : { text, lineStart: at, lineEnd: at + ctx.text.split("\n").length + 1 }) }
      try { await f.fn(ctx.text, el, pctx) } catch (e) { console.error(e); el.createDiv({ cls: "plugin-compat-error", text: `${f.plugin}: ${(e as Error).message}` }) }
    })()
    return () => { gone = true; for (const c of children) c.unload() }
  }, [lang, ctx.text, ctx.path])
  return <div ref={ref} className="plugin-compat-fence markdown-rendered" data-fence={lang} />
}

/** A leaf's view, its own element put into the page while drawn; told when its size changes. */
function LeafHost({ leaf }: { leaf: WorkspaceLeaf }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const view = leaf.view
    el.append(view.containerEl)
    void leaf.opening()
    // (a side view laid out to fill its pane, a chat, has no height of its own in a stacked sidebar: it gets some)
    const fill = () => { if (leaf.side !== "main" && !el.classList.contains("mod-fill") && view.containerEl.scrollHeight < 120) el.classList.add("mod-fill") }
    const ro = new ResizeObserver(() => { fill(); leaf.onResize() })
    ro.observe(el)
    setTimeout(fill, 1500)
    // (still open, out of sight: parked in the page, as a hidden tab's view is in Obsidian)
    return () => { ro.disconnect(); if (leaf.opened && leaf.view === view) parking().append(view.containerEl); else view.containerEl.remove() }
  }, [leaf, leaf.view])
  return <div ref={ref} className="plugin-compat-leaf workspace-leaf mod-active" data-type={leaf.view.getViewType()} />
}

/** A tab showing a plugin's view (view:obsidian-<type>/<file>): the leaf there, or one made for it. */
function MainLeaf({ type, arg }: { type: string; arg: string }) {
  const n = useChanged()
  const [leaf, setLeaf] = useState<WorkspaceLeaf | null>(null)
  useEffect(() => {
    let on = true
    void appOf().workspace.leafFor(type, arg).then((l) => { if (on) setLeaf(l) })
    return () => { on = false }
  }, [type, arg, n])
  if (!leaf) return <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>
  // (its header's buttons, as a bar over it: Obsidian's view header is the tab's here)
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 justify-end px-2 pt-1"><ViewActions leaf={leaf} more /></div>
      <div className="min-h-0 flex-1"><LeafHost leaf={leaf} /></div>
    </div>
  )
}

/** A plugin's panel: its side leaf, or one made for it (a panel kept in the sidebars from before). */
function SideLeaf({ type, panel }: { type: string; panel: string }) {
  const n = useChanged()
  const [leaf, setLeaf] = useState<WorkspaceLeaf | null>(null)
  useEffect(() => {
    let on = true
    void appOf().workspace.sideLeafFor(type, panelSide(panel) === "left" ? "left" : "right").then((l) => { if (on) setLeaf(l) })
    return () => { on = false }
  }, [type, panel, n])
  return leaf ? <div className="plugin-compat-side h-full"><LeafHost leaf={leaf} /></div> : null
}

/** Where Obsidian has a note's properties, for plugins that put their own things after them (a toolbar): an empty
 *  place under the app's properties, shaped as Obsidian's. */
function NoteAnchors({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const box = el.createDiv({ cls: "markdown-source-view mod-cm6 is-live-preview plugin-compat-anchors" })
    box.createDiv({ cls: "metadata-container plugin-compat-hidden" })
    return () => { box.remove() }
  }, [path])
  return <div ref={ref} data-obsidian-anchors={path} />
}

/** A plugin's setting tab, drawn in its settings sheet as it draws itself. */
function SettingTab({ plugin }: { plugin: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useChanged()
  const tab = registered.settingTabs.get(plugin)
  useEffect(() => {
    const el = ref.current
    if (!el || !tab) return
    // (as Obsidian, it's shown as it is: a tab empties itself in display(), or keeps what it built once)
    el.append(tab.containerEl)
    void Promise.resolve().then(() => tab.display()).catch((e: Error) => tab.containerEl.createDiv({ cls: "plugin-compat-error", text: e.message }))
    return () => { void Promise.resolve().then(() => tab.hide()).catch(() => {}); tab.containerEl.remove() }
  }, [tab])
  return <div ref={ref} className="plugin-compat-settings mod-settings" data-obsidian-settings={plugin} />
}

/** A plugin's ribbon icons, where the app's header draws them (the sidebar's header; the rail; a phone's tab list). */
function Ribbon({ plugin, ctx }: { plugin: string; ctx: SidebarCtx }) {
  useChanged()
  const items = registered.ribbon.filter((r) => r.plugin === plugin)
  return (
    <div className={`flex items-center gap-0.5 ${ctx.open || ctx.phone ? "" : "flex-col"}`} data-obsidian-ribbon={plugin}>
      {items.map((r, i) => {
        const I = iconNamed(r.icon)
        return (
          <button key={i} type="button" data-tip={r.title} aria-label={r.title} onClick={(e) => r.run(e.nativeEvent)}
            className={`grid cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground ${ctx.phone ? "size-11" : "size-7"}`}>
            <I className={ctx.phone ? "size-[22px]" : "size-4"} />
          </button>
        )
      })}
    </div>
  )
}

function StatusItems({ plugin }: { plugin: string }) {
  useChanged()
  const ref = useRef<HTMLDivElement>(null)
  const items = registered.statusBar.filter((s) => s.plugin === plugin)
  // (moved in only when they differ: re-adding them on every render restyles them with every plugin's CSS)
  useEffect(() => {
    const box = ref.current, els = items.map((s) => s.el)
    if (box && (box.children.length !== els.length || els.some((e, i) => box.children[i] !== e))) box.replaceChildren(...els)
  })
  return items.length ? <div ref={ref} className="plugin-compat-status flex items-center gap-2" /> : null
}

type Hotkey = { modifiers: string[]; key: string }
const keyName = (k: string) => (k === " " ? "Space" : k.length === 1 ? k.toUpperCase() : k)
/** A command's keys in effect as the app writes them: the user's (.obsidian/hotkeys.json), else the plugin's. */
const keysOf = (id: string) => (appOf().hotkeyManager.keysOf(id) as Hotkey[]).map((h) => [...h.modifiers, keyName(h.key)].join("+"))
const stepOf = (mods: string[], key: string) => [...new Set(mods)].sort().join("+").toLowerCase() + "+" + keyName(key).toLowerCase()
function eventStep(e: KeyboardEvent) {
  const mods = [...((Platform.isMacOS ? e.metaKey : e.ctrlKey) ? ["Mod"] : []), ...(Platform.isMacOS && e.ctrlKey ? ["Ctrl"] : []), ...(e.shiftKey ? ["Shift"] : []), ...(e.altKey ? ["Alt"] : [])]
  const key = e.altKey && /^(Key|Digit)/.test(e.code) ? e.code.replace(/^(Key|Digit)/, "") : e.key
  return stepOf(mods, key)
}
// An Obsidian plugin's editor hotkeys come before the editor's own keys (as in Obsidian), unless one of the app's commands
// has them: the app's win.
const hotkeysFirst = Prec.highest(EditorView.domEventHandlers({ keydown: (e) => {
  if (e.isComposing || !(e.metaKey || e.ctrlKey || e.altKey)) return false
  const step = eventStep(e), app = appOf()
  const taken = () => commandList().some((c) => !c.id.startsWith("obsidian.") && keysOfApp(c).some((k) => !k.includes(" ") && stepOf(k.split("+").slice(0, -1), k.split("+").at(-1)!) === step))
  for (const [id, { cmd }] of registered.commands) {
    if (!cmd.editorCallback && !cmd.editorCheckCallback) continue
    if (!(app.hotkeyManager.keysOf(id) as Hotkey[]).some((h) => stepOf(h.modifiers, h.key) === step) || taken()) continue
    if (runObsidian(app, id, true)) { e.preventDefault(); runObsidian(app, id); return true }
  }
  return false
} }))
const label = (type: string) => type.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())

// --- each Obsidian plugin as a plugin of the app's

let list: Installed[] = []
// Panels: the view types plugins put in a sidebar (kept, so a panel left in the sidebars draws at the next start), and
// those docked once (a panel the user hid stays hidden when its plugin asks again).
const PANELS = "obsidian-compat:panels", DOCKED = "obsidian-compat:docked"
const stored = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? "") ?? d } catch { return d } }
const sideTypes: Record<string, "left" | "right"> = stored(PANELS, {})
const docked = new Set<string>(stored(DOCKED, []))
const keep = () => { try { localStorage.setItem(PANELS, JSON.stringify(sideTypes)); localStorage.setItem(DOCKED, JSON.stringify([...docked])) } catch { /* private mode */ } }
let toShow: { key: string; side: "left" | "right"; reveal: boolean }[] = []

function viewIcon(type: string) {
  return appOf().workspace.leaves.find((l) => l.view.getViewType() === type)?.getIcon() || "layout-panel-left"
}
function viewTitle(type: string, arg = "") {
  const l = appOf().workspace.leaves.find((x) => x.view.getViewType() === type && (!arg || x.arg === arg))
  return l?.getDisplayText() || (arg ? arg.slice(arg.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") : label(type))
}

function defOf(p: Installed): HostedPlugin {
  const app = appOf(), ws = app.workspace, id = p.id, hid = hosted(id), r = results.get(id)
  const types = [...registered.views].filter(([, o]) => o === id).map(([t]) => t)
  const ribbon = registered.ribbon.filter((x) => x.plugin === id)
  const commands: PluginCommand[] = [
    ...[...registered.commands].filter(([, c]) => c.plugin === id).map(([cid, { cmd }]) => ({ id: hosted(cid), name: cmd.name, keys: keysOf(cid),
      ...(cmd.icon ? { icon: iconNamed(cmd.icon) } : {}), when: () => runObsidian(app, cid, true), run: () => { runObsidian(app, cid) } })),
    ...ribbon.map((x, i) => ({ id: `${hid}:ribbon-${i}`, name: `${p.manifest.name}: ${x.title}`, label: x.title, icon: iconNamed(x.icon), run: () => x.run(new MouseEvent("click")) })),
  ]
  const fences = Object.fromEntries([...registered.fences].filter(([, f]) => f.plugin === id).map(([lang]) => [lang, (ctx: BlockCtx) => <Fence lang={lang} ctx={ctx} />]))
  // (an Obsidian view fills its leaf: the whole pane, no padding or scrolling of the tab's own)
  const views = Object.fromEntries(types.map((t) => [viewName(t), {
    full: true, icon: iconNamed(viewIcon(t)), iconFor: () => iconNamed(viewIcon(t)), title: (arg: string) => viewTitle(t, arg),
    render: ({ arg }: { arg: string }) => <MainLeaf type={t} arg={arg} />,
    onClose: (arg: string) => { const l = ws.leaves.find((x) => x.side === "main" && x.view.getViewType() === t && x.arg === arg); if (l) void ws.detach(l, true) },
  }]))
  const sidebar = Object.fromEntries(types.filter((t) => sideTypes[t]).map((t) => [t, {
    title: viewTitle(t), hidden: true, tall: true, view: viewName(t), flyout: { icon: iconNamed(viewIcon(t)) },
    actions: () => <ViewActions leaf={ws.leaves.find((l) => l.side !== "main" && l.view.getViewType() === t) ?? null} />,
    render: () => <SideLeaf type={t} panel={`${hid}:${t}`} />,
  }]))
  const formats = Object.fromEntries([...registered.extensions].filter(([, x]) => x.plugin === id).map(([ext, x]) => [ext, {
    exts: [ext], icon: iconNamed(viewIcon(x.type)), layout: "pane" as const, render: ({ path }: { path: string }) => <MainLeaf type={x.type} arg={path} />,
  }]))
  const problem = r?.state === "failed" || r?.state === "skipped" ? [r.error ?? "It couldn't load"] : []
  return {
    id: hid, name: p.manifest.name, description: p.manifest.description, version: p.manifest.version, author: p.manifest.author,
    url: /^https:\/\//.test(p.manifest.authorUrl ?? "") ? p.manifest.authorUrl : undefined, disclosures: p.disclosures,
    icon: iconNamed(ribbon[0]?.icon ?? (types[0] ? viewIcon(types[0]) : "blocks")),
    on: p.enabled, waiting: p.enabled && !p.allowed && (p.changed ? "changed" : "new"), problems: problem, replaces: { obsidian: [id] },
    commands, fences, views, sidebar, formats,
    ...(ribbon.length ? { header: { ribbon: { sort: 60, render: (ctx: SidebarCtx) => <Ribbon plugin={id} ctx={ctx} /> } } } : {}),
    ...(registered.statusBar.some((s) => s.plugin === id) ? { ambient: { status: { title: p.manifest.name, render: () => <StatusItems plugin={id} /> } } } : {}),
    ...(registered.settingTabs.has(id) ? { settingsPanel: () => <SettingTab plugin={id} /> } : {}),
    ...([...registered.protocols.values()].some((h) => h.plugin === id) ? { schemeLink: (url: string) => runUri(url, id) } : {}),
  }
}

async function refresh() { list = await get<Installed[]>("plugin-compat/plugins") }
// (the app is hosted again once all have loaded, not after each: every rehost redraws the app)
let loading = 0
// (the window's first picture of the vault: plugins load after it, as in Obsidian, even when turned on meanwhile)
let pictured: Promise<unknown> = Promise.resolve()
async function sync() {
  loading++
  try {
    await pictured
    const runs = (p: Installed) => p.enabled && p.allowed && !standingIn("obsidian", p.id).length
    for (const p of list) if (runs(p) && !loaded.has(p.id) && !results.has(p.id) && !(p.manifest.isDesktopOnly && Platform.isPhone)) prefetch(p.id, p.hash)
    for (const p of list) {
      // (a plugin of the app's standing in for it is on: the original stays off, they'd draw the same)
      const stand = standingIn("obsidian", p.id)
      const run = p.enabled && p.allowed && !stand.length
      if (!run && (loaded.has(p.id) || results.has(p.id))) unloadPlugin(p.id)
      if (run && !loaded.has(p.id) && results.get(p.id)?.state === "skipped") results.delete(p.id)
      if (run && !loaded.has(p.id) && !results.has(p.id)) {
        await loadPlugin(p.id, p.manifest, p.hash)
        // (the page answers the user between plugins)
        await new Promise((r) => setTimeout(r))
      }
      if (p.enabled && p.allowed && stand.length) skipped(p.id, p.manifest, `${stand.map((x) => x.name).join(" and ")} stands in for it here: turn that off to run the original`)
    }
  } finally { loading-- }
  appOf().workspace.setReady()
  rehost()
}
const run = (op: string, id: string) => post(`ops/plugin-compat.${op}`, { id })
type Found = { available: boolean; total: number; entries: { id: string; name: string; author: string; description: string; repo: string; downloads: number
  installed: boolean; desktopOnly: boolean | null; status: "works" | "partly" | "no" | "unneeded" | "untested"; natives: { id: string; name: string; on: boolean }[] }[] }
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const STATUS = { works: { text: "Works here", tone: "green" }, partly: { text: "Partly works here", tone: "orange" }, no: { text: "Doesn't run here", tone: "red" },
  unneeded: { text: "Not needed here", tip: "Vaultite does what it does itself (Obsidian's own look and views, images in the editor)" } } as const
const browse: BrowseSource = {
  title: "Obsidian",
  sorts: [{ value: "downloads", label: "Downloads" }, { value: "updated", label: "Updated" }, { value: "name", label: "Name" }],
  search: async (q, sort) => {
    const f = await get<Found>(`plugin-compat/directory?q=${encodeURIComponent(q)}&sort=${sort}`)
    return { available: f.available, total: f.total, entries: f.entries.map((e) => ({
      id: e.id, name: e.name, author: e.author, description: e.description, url: `https://github.com/${e.repo}`, stat: `${count(e.downloads)} downloads`,
      installed: e.installed, plugin: hosted(e.id),
      badges: [...(e.status !== "untested" ? [STATUS[e.status]] : []), ...(e.desktopOnly ? [{ text: "Desktop only" }] : [])],
      ...(e.natives[0] ? { standIn: { ...e.natives[0], use: () => post("ops/other-apps.use", { id: e.id, with: e.natives[0].id }) } } : {}),
    })) }
  },
  install: async (id) => { await post("ops/plugin-compat.install", { repo: id, on: true }); await refresh(); await sync() },
  note: "Obsidian plugins run with the app's full access, as in Obsidian. Works here: tested in Vaultite.",
}
const host: PluginHost = {
  title: "Obsidian plugins", kind: "Obsidian plugin", intro: "Your vault's Obsidian plugins, run as they are.", browse,
  trust: "Obsidian plugins run with the app's full access, as in Obsidian: it can read and change every file in this vault and reach the network.",
  setOn: async (hid, on) => { await post("plugin-compat/enable", { id: unhosted(hid), on }); await refresh(); await sync() },
  allow: async (hid) => { await run("allow", unhosted(hid)); await refresh(); await sync() },
  uninstall: async (hid) => { unloadPlugin(unhosted(hid)); await run("uninstall", unhosted(hid)); await refresh(); await sync() },
}

let hosting = false, soon: ReturnType<typeof setTimeout> | undefined
function rehost() {
  clearTimeout(soon)
  if (!hosting) return
  hostPlugins(HOST, host, list.map(defOf))
  // (a panel's plugin def exists now: dock or reveal it)
  for (const s of toShow.splice(0)) if (!(s.reveal && revealPanel(s.key))) dockAtEnd(s.key, s.side)
}
const rehostSoon = () => { clearTimeout(soon); if (!loading) soon = setTimeout(rehost, 60) }

/** A side leaf was given a view: its panel is docked the first time (or each time it's revealed). */
function showPanel(leaf: WorkspaceLeaf, reveal: boolean) {
  const type = leaf.view.getViewType(), owner = registered.views.get(type)
  if (!owner || leaf.side === "main") return
  const key = `${hosted(owner)}:${type}`
  if (!sideTypes[type]) sideTypes[type] = leaf.side
  if (reveal || (!panelSide(key) && !docked.has(key))) {
    docked.add(key)
    toShow.push({ key, side: panelSide(key) ?? leaf.side, reveal })
  }
  keep()
  rehostSoon()
}

// Coming from Obsidian: its sidebars' views (.obsidian/workspace.json) go where they were, once per device.
const RESTORED = "obsidian-compat:restored"
async function restoreSidebars() {
  if (localStorage.getItem(RESTORED)) return
  localStorage.setItem(RESTORED, "1")
  const ws = appOf().workspace
  const r = await get<{ base64: string }>(`plugin-compat/config/read?path=${encodeURIComponent(".obsidian/workspace.json")}`).catch(() => null)
  if (!r) return
  let layout: { left?: unknown; right?: unknown; lastOpenFiles?: string[] }
  try { layout = JSON.parse(new TextDecoder().decode(fromB64(r.base64))) } catch { return }
  type Node = { type?: string; children?: Node[]; state?: { type?: string; state?: unknown } }
  const leaves = (n: unknown): Node[] => { const x = n as Node; return !x || typeof x !== "object" ? [] : x.type === "leaf" ? [x] : (x.children ?? []).flatMap(leaves) }
  for (const side of ["left", "right"] as const) {
    for (const l of leaves(layout[side])) {
      const type = l.state?.type
      if (!type || !registered.views.has(type) || ws.getLeavesOfType(type).length) continue
      await (side === "left" ? ws.getLeftLeaf(false) : ws.getRightLeaf(false)).setViewState({ type, state: l.state?.state ?? {} })
    }
  }
  if (Array.isArray(layout.lastOpenFiles)) ws.recent = [...ws.recent, ...layout.lastOpenFiles.filter((f) => typeof f === "string" && !ws.recent.includes(f))].slice(0, 50)
}

// The leaf in front changed (a tab, or a note's editor arriving after its tab): said once.
let lastLeaf: WorkspaceLeaf | null = null
function leafChanged() {
  rootEl()
  const now = appOf().workspace.activeLeaf
  if (now !== lastLeaf) { lastLeaf = now; appOf().workspace.trigger("active-leaf-change", now) }
}

/** Runs in every window while this is on: loads the plugins, hosts them, keeps the vault's picture current. */
function Runtime({ seen }: { seen: unknown }) {
  useChanged(portalsChanged)
  // (turned on, off or allowed elsewhere: the server's state says so)
  useEffect(() => { if (hosting) void refresh().then(sync) }, [seen])
  useEffect(routeWindowOpen, [])
  const focused = useFocusedFile()
  const app = appOf()
  useEffect(() => {
    hosting = true
    app.workspace.showPanel = showPanel
    const offs = [changed.on("changed", rehostSoon), app.workspace.changed.on("changed", rehostSoon)]
    const layout = onTabLayoutChange(() => { app.workspace.trigger("layout-change"); leafChanged() })
    setEditorShown(leafChanged)
    const resize = () => app.workspace.trigger("resize")
    addEventListener("resize", resize)
    prefetchIcons()
    pictured = app.vault.refresh()
    void (async () => {
      await pictured
      syncProperties(app)
      await refresh()
      await sync()
      // (as Obsidian once its layout is ready: plugins loaded since are told which note is in front)
      app.workspace.trigger("file-open", app.workspace.getActiveFile())
      app.workspace.trigger("active-leaf-change", app.workspace.activeLeaf)
      if (isDesktop()) await restoreSidebars().catch(() => {})
      void report()
    })()
    return () => {
      hosting = false
      for (const r of offs) r.e.offref(r)
      layout()
      removeEventListener("resize", resize)
      for (const id of [...loaded.keys()]) unloadPlugin(id)
      hostPlugins(HOST, null)
    }
  }, [])
  useVaultChange((paths) => { void app.vault.refresh(paths) })
  useEffect(() => {
    void (async () => {
      // (a file made a moment ago may not have reached this window's picture yet: a hidden window hears changes late)
      if (focused.path && !app.vault.getFileByPath(focused.path)) await app.vault.refresh([focused.path]).catch(() => {})
      const f = focused.path ? app.vault.getFileByPath(focused.path) : null
      if (f) app.workspace.recent = [f.path, ...app.workspace.recent.filter((p) => p !== f.path)].slice(0, 50)
      // (a note's leaf is its editor's: once it's drawn, so the leaf plugins are told of is the note's)
      for (let i = 0; f?.extension === "md" && currentEditor()?.path !== f.path && i < 60; i++) await new Promise((r) => requestAnimationFrame(r))
      app.workspace.trigger("file-open", f)
      leafChanged()
      if (f) void app.vault.cachedRead(f).catch(() => {})
    })()
  }, [focused.path])
  useEffect(watchAppMarkdown, [])
  return <>{[...portals].filter(([el]) => el.isConnected || document.body.contains(el)).map(([el, node], i) => createPortal(node, el, String(i)))}</>
}

// What each window saw, for whoever tests the plugins (GET /api/plugin-compat/report).
const client = `${Platform.isPhone ? "phone" : Platform.isElectron ? "desktop" : "web"}-${Math.random().toString(36).slice(2, 7)}`
let reported = ""
async function report() {
  const body = JSON.stringify({ client, ua: navigator.userAgent, platform: Platform, results: [...results.keys()].map(summaryOf), workspace: missedOf("workspace") })
  // (said again only when something changed)
  if (body === reported) return
  reported = body
  await post("plugin-compat/report", JSON.parse(body)).catch(() => { reported = "" })
}
setInterval(() => { if (results.size) void report() }, 10000)

setSettingsOpener((id) => { const to = id ?? [...registered.settingTabs.keys()][0]; if (to) openPluginSettings(hosted(to)) })
setInfoOf((cm, own) => {
  const app = appOf(), open = currentEditor()
  const path = own ?? (open?.view === cm ? open.path : currentFile())
  return { app, file: path ? app.vault.getFileByPath(path) : null, editor: open?.view === cm ? new Editor(open) : null }
})

/** A note embedded as Obsidian draws embeds (`![[note]]` rendered, then plugins' post-processors: Excalidraw's picture). */
function Embedded({ path, from }: { path: string; from: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const comp = new Component()
    comp.load()
    void renderMarkdown(`![[${path.replace(/\.md$/i, "")}]]`, el, from, comp)
    return () => { comp.unload(); el.replaceChildren() }
  }, [path, from])
  return <div ref={ref} className="markdown-rendered plugin-compat-embed" />
}

// A note an Obsidian plugin's view takes when it opens (its patch of setViewState: Kanban's boards), drawn in its tab.
const taken = new Map<string, FileFormat>()
function fileFormat(path: string): FileFormat | null {
  const ws = appOf().workspace
  if (!ws.layoutReady) return null
  const type = ws.viewTypeFor(path), key = `${type}\n${path}`
  if (type === "markdown") return null
  let f = taken.get(key)
  if (!f) {
    f = { exts: [], icon: iconNamed(viewIcon(type)), layout: "pane", render: () => <MainLeaf type={type} arg={path} />,
      embed: (ctx) => <Embedded path={path} from={ctx.host ?? ""} /> }
    taken.set(key, f)
  }
  return f
}

export default definePlugin({
  fileFormat,
  background: ({ store }) => <Runtime seen={(store as { obsidianCompat?: string }).obsidianCompat} />,
  noteTop: { anchors: { render: (f) => <NoteAnchors path={f.path} /> } },
  fileBar: { actions: { render: (f) => <NoteActions path={f.path} /> } },
  ambient: { status: { title: "Obsidian plugins' status bar", render: () => <LooseStatus /> } },
  fileRows: () => (appOf().workspace.internal.find((l) => l.view.getViewType() === "file-explorer")?.view as FileExplorerView | undefined)?.fileRows() ?? {},
  editor: (ctx) => [ctx.kind === "markdown" ? obsidianTokens() : [], editorExtension(ctx.path, ctx.kind === "markdown"), hotkeysFirst, suggestExtension(registered.suggests, () => activeEditor(), () => appOf().workspace.getActiveFile())],
  // (one menu for all: a plugin turned off has unloaded its handler)
  editorMenu: ({ view }) => {
    const app = appOf(), open = activeEditor()
    const editor = open?.cm === view ? open : new Editor({ view, kind: "markdown" } as OpenEditor)
    const m = new Menu()
    app.workspace.trigger("editor-menu", m, editor, app.workspace.markdownLeaf()?.view ?? { editor, file: app.workspace.getActiveFile() })
    return m.rows()
  },
  fileMenu: (path) => {
    const app = appOf(), f = app.vault.getAbstractFileByPath(path)
    if (!f) return []
    const m = new Menu()
    app.workspace.trigger("file-menu", m, f, "file-explorer-context-menu", null)
    return m.items.flatMap((i): FileMenuItem[] => (i === "sep" ? [] : [{ label: i.titleEl.textContent ?? "", section: "more", run: () => i.callback?.(new MouseEvent("click")) }]))
  },
})
