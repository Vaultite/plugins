// Obsidian's workspace over the app's: a leaf in the main area is a tab (view:obsidian-<type>/<file>), one in a side
// split is its plugin's sidebar panel, and each open note's editor is a MarkdownView leaf.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from "react"
import { closeView, currentEditor, currentFile, getTabLayout, isDesktop, openAt, openFile, openInSplit, openView, panesOf } from "@vaultite"
import type { EditorView } from "@codemirror/view"
import { Component, Events } from "./core.ts"
import { createEl, hidden } from "./dom.ts"
import { activeEditor, Editor, editorInFront, reconfigureEditors } from "./editor.ts"
import { setIcon } from "./ui.ts"
import { TFile, type Vault } from "./vault.ts"
import { registered, tell } from "./state.ts"

/** The app's view (a tab) that draws an Obsidian view type. */
export const viewName = (type: string) => `obsidian-${type.replace(/[^\w-]/g, "_")}`

export class View extends Component {
  app: any
  leaf: WorkspaceLeaf
  containerEl: HTMLElement
  icon = "file"
  navigation = false
  scope: any = null
  constructor(leaf: WorkspaceLeaf) {
    super()
    this.leaf = leaf
    this.app = leaf.app
    this.containerEl = createEl("div", { cls: "workspace-leaf-content" })
  }
  getViewType() { return "" }
  getDisplayText() { return "" }
  getIcon() { return this.icon }
  getState(): any { return {} }
  async setState(_s: any, _r: any): Promise<void> {}
  getEphemeralState() { return {} }
  setEphemeralState(_s: any) {}
  onResize() {}
  onPaneMenu(_m: any, _src: string) {}
  onHeaderMenu(_m: any) {}
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}
export class ItemView extends View {
  contentEl: HTMLElement
  headerEl: HTMLElement
  titleEl: HTMLElement
  actionsEl: HTMLElement
  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
    this.headerEl = this.containerEl.createDiv({ cls: "view-header" })
    this.titleEl = this.headerEl.createDiv({ cls: "view-header-title" })
    this.actionsEl = this.headerEl.createDiv({ cls: "view-actions" })
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" })
  }
  addAction(icon: string, title: string, cb: (e: MouseEvent) => any) {
    const b = this.actionsEl.createEl("button", { cls: "clickable-icon view-action", attr: { "aria-label": title } })
    setIcon(b, icon)
    b.addEventListener("click", cb)
    return b
  }
}
export class FileView extends ItemView {
  file: TFile | null = null
  allowNoFile = false
  navigation = true
  getState(): any { return this.file ? { file: this.file.path } : {} }
  /** As Obsidian's: a state naming a file loads it (onLoadFile), the one before unloaded. */
  async setState(s: any, _r: any) {
    const f = s?.file ? this.app.vault.getFileByPath(s.file) : null
    if (!f || f === this.file) return
    if (this.file) await this.onUnloadFile(this.file)
    this.file = f
    await this.onLoadFile(f)
    this.leaf.app.workspace.trigger("file-open", f)
  }
  getDisplayText() { return this.file?.basename ?? "" }
  canAcceptExtension(_e: string) { return false }
  async onLoadFile(_f: TFile): Promise<void> {}
  async onUnloadFile(_f: TFile): Promise<void> {}
  async onRename(_f: TFile): Promise<void> {}
}

const IMAGE = /^(png|jpe?g|gif|svg|webp|bmp|avif)$/
/** Obsidian's view type for a file the app draws itself ("" for a tab that isn't a file: "empty"). */
const coreType = (path: string) => { const e = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return !path ? "empty" : e === "md" ? "markdown" : IMAGE.test(e) ? "image" : e === "pdf" ? "pdf" : /^(mp3|wav|m4a|ogg|flac)$/.test(e) ? "audio" : /^(mp4|webm|mov)$/.test(e) ? "video" : e === "canvas" ? "canvas" : e === "base" ? "bases" : "empty" }
/** A tab the app draws, as the core view Obsidian would have there (its type and file; nothing drawn). */
class CoreView extends FileView {
  type: string
  constructor(leaf: WorkspaceLeaf, type: string) { super(leaf); this.type = type; this.allowNoFile = true }
  getViewType() { return this.type }
}
export class EditableFileView extends FileView {}
export class TextFileView extends EditableFileView {
  data = ""
  dirty = false
  /** It shows the file's text on its own; false for a note, whose text is the app's editor (it follows the disk itself). */
  protected followsDisk = true
  /** The file's text as last read or written here: a save writes only when the view's text differs from it. */
  private disk = ""
  requestSave = Object.assign(() => { this.dirty = true; clearTimeout(this.saving); this.saving = setTimeout(() => void this.save(), 2000) }, { cancel: () => clearTimeout(this.saving), run: () => void this.save() })
  private saving: ReturnType<typeof setTimeout> | undefined
  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
    // (changed elsewhere while it shows it, nothing unsaved here: it shows the new text)
    this.registerEvent(this.app.vault.on("modify", async (f: TFile) => {
      if (f !== this.file || this.dirty || !this.followsDisk) return
      const d = await this.app.vault.read(f)
      if (d === this.disk) return
      this.disk = d
      if (d !== this.data) { this.data = d; this.setViewData(d, false) }
    }))
  }
  async save(_clear?: boolean) {
    clearTimeout(this.saving)
    if (!this.file) return
    const d = this.getViewData()
    this.dirty = false
    if (d === this.disk) return
    this.disk = d
    this.data = d
    await this.app.vault.modify(this.file, d)
  }
  async onLoadFile(f: TFile) { this.data = this.disk = await this.app.vault.read(f); this.setViewData(this.data, true) }
  async onUnloadFile(_f: TFile) { if (this.dirty) await this.save() }
  getViewData() { return this.data }
  setViewData(d: string, _clear: boolean) { this.data = d }
  clear() {}
}

/** An open note, as Obsidian's MarkdownView: its editor and file (one per editor, so plugins can compare them). */
export class MarkdownView extends TextFileView {
  editor: Editor
  previewMode: any
  // (the disk's text lags what's typed: setting it would undo the last keystrokes and move the cursor)
  protected followsDisk = false
  currentMode: any
  constructor(leaf: WorkspaceLeaf, editor: Editor, file: TFile | null) {
    super(leaf)
    this.editor = editor
    this.file = file
    // (modes are components, as Obsidian's: plugins walk their children)
    this.currentMode = Object.assign(new Component(), { type: "source", editor, cm: editor.cm })
    // (a note's text, as typed: Obsidian's TextFileView.data)
    Object.defineProperty(this, "data", { get: () => this.editor.getValue(), set: (v: string) => { if (v !== this.editor.getValue()) this.editor.setValue(v) }, configurable: true })
    this.previewMode = Object.assign(new Component(), { type: "preview", rerender: () => {}, containerEl: createEl("div"), renderer: {}, get: () => this.editor.getValue(), set() {}, applyScroll() {}, getScroll: () => 0 })
    this.containerEl = editor.cm.dom.closest(".file-view") as HTMLElement ?? editor.cm.dom
    this.contentEl = this.containerEl
  }
  // (older names plugins still use: sourceMode.cmEditor, editMode.editor)
  get sourceMode() { return { type: "source", cmEditor: this.editor, editor: this.editor, cm: this.editor.cm } }
  get editMode() { return this.sourceMode }
  /** The note's title, for plugins that read it (the app draws its own: changing this one changes nothing). */
  inlineTitleEl = createEl("div", { cls: "inline-title" })
  // Obsidian's properties editor: the app draws its own, so this one is off-page, its items the file's frontmatter.
  metadataEditor = (() => {
    const contentEl = createEl("div", { cls: "metadata-content" }), view = this
    const items = new Map<string, any>()
    const itemOf = (key: string, value: unknown) => {
      let it = items.get(key)
      if (!it) {
        const containerEl = createEl("div", { cls: "metadata-property" })
        it = { entry: { key, value }, containerEl, keyEl: containerEl.createDiv({ cls: "metadata-property-key" }), valueEl: containerEl.createDiv({ cls: "metadata-property-value" }) }
        items.set(key, it)
      }
      it.entry.value = value
      return it
    }
    return { containerEl: createEl("div", { cls: "metadata-container" }), contentEl, propertyListEl: contentEl, addPropertyButtonEl: createEl("div", { cls: "metadata-add-button" }),
      get rendered() {
        const fm = view.file ? view.app?.metadataCache?.getFileCache(view.file)?.frontmatter ?? {} : {}
        return Object.entries(fm).map(([key, value]) => itemOf(key, value))
      },
      properties: [], focusKey() {}, synchronize() {}, onMetadataTypeChange() {}, insertProperties() {}, addProperty() {}, showPropertiesMenu() {}, owner: view }
  })()
  getViewType() { return "markdown" }
  getMode() { return "source" }
  getDisplayText() { return this.file?.basename ?? "" }
  getState(): any { return { file: this.file?.path, mode: "source", source: false } }
  getEphemeralState() { const c = this.editor.getCursor(); return { cursor: { from: c, to: c } } }
  setEphemeralState(s: any) { if (this.file) void placeCursor(this.file.path, s) }
  async setState(s: any) { if (s?.file && s.file !== this.file?.path) openFile(s.file) }
  getViewData() { return this.editor.getValue() }
  setViewData(d: string) { this.editor.setValue(d) }
  async save() {}
  showSearch() {}
  get hoverPopover() { return null }
}
export class MarkdownEditView {}

/** Where a view is: a tab in the app's panes ("main"), its plugin's sidebar panel ("left"/"right"). */
export class WorkspaceLeaf extends Events {
  app: any
  view: View | any
  side: "main" | "left" | "right"
  id = Math.random().toString(36).slice(2, 10)
  opened = false
  pinned = false
  /** A main leaf's tab: its view's file, or "" (view:obsidian-<type>/<arg>). */
  arg = ""
  /** Not shown yet: getLeaf(true) opens a tab of its own, "split" one beside. */
  fresh: boolean | "split" = false
  /** A note's leaf: the app's tab it is. */
  tab = ""
  parent: any
  tabHeaderEl = createEl("div", { cls: "workspace-tab-header" })
  tabHeaderInnerIconEl = createEl("div")
  tabHeaderInnerTitleEl = createEl("div")
  isDeferred = false
  constructor(app: any, side: WorkspaceLeaf["side"], fresh: WorkspaceLeaf["fresh"] = false) {
    super()
    this.app = app
    this.side = side
    this.fresh = fresh
    const ws = app.workspace as Workspace | undefined
    this.parent = side === "main" ? ws?.rootSplit : side === "left" ? ws?.leftSplit : ws?.rightSplit
    this.view = new EmptyView(this)
  }
  get containerEl() { return this.view.containerEl }
  get key() { return `${viewName(this.view.getViewType())}${this.arg ? `/${this.arg}` : ""}` }
  getViewState() { return { type: this.view.getViewType(), state: this.view.getState?.() ?? {}, active: this.app.workspace.activeLeaf === this, pinned: this.pinned } }
  /** Asked which view plugins give a note (Workspace.viewTypeFor): records the type their patches settle on, opens nothing. */
  probe = false
  probed = ""
  async setViewState(s: { type: string; state?: any; active?: boolean; pinned?: boolean }, eState?: any) {
    if (this.probe) { this.probed = s.type; return }
    const ws: Workspace = this.app.workspace
    if (s.type === "markdown" || (s.type === "empty" && s.state?.file)) {
      // (a note's leaf a plugin's view had, back to the note: the view goes, the app's editor shows it again)
      if (ws.isNoteLeaf(this) && this.view.getViewType() !== "empty") { await ws.detach(this, true); this.view = new EmptyView(this) }
      // (it shows that note already and isn't asked to come forward: only its state changes, a mode or a line)
      if (s.state?.file && !s.active && ws.isNoteLeaf(this) && this.view.file?.path === s.state.file) { if (eState) void placeCursor(s.state.file, eState); return }
      if (s.state?.file) ws.showFile(s.state.file, this.fresh, eState)
      return
    }
    if (s.type === "empty") return
    const make = ws.factories.get(s.type)
    if (!make) { ws.missing(`view type '${s.type}'`); return }
    if (this.view.getViewType() !== s.type) {
      await this.closeView()
      this.view = make(this)
    }
    if (s.pinned !== undefined) this.pinned = s.pinned
    if (this.side === "main") this.arg = typeof s.state?.file === "string" ? s.state.file : ""
    // (as Obsidian: the view opens, then always takes its state, {} for none: a file view loads its file)
    await this.opening()
    try { await this.view.setState?.(s.state ?? {}, { history: false }) } catch (e) { console.error(e) }
    if (eState) this.view.setEphemeralState?.(eState)
    ws.place(this, { reveal: !!s.active })
  }
  /** Its view's onOpen, once (when it's first given a view, before it's drawn). */
  async opening() {
    if (this.opened) return
    this.opened = true
    // (as in Obsidian, a view opens in the page: off screen until its tab or panel draws it)
    if (!this.view.containerEl.isConnected && !(this.view instanceof MarkdownView)) parking().append(this.view.containerEl)
    try { this.view.load(); await this.view.onOpen() } catch (e) { console.error(e) }
  }
  async closeView() {
    if (!this.opened) return
    this.opened = false
    // (a note's editor is the app's: nothing of it to close)
    if (this.view instanceof MarkdownView) return
    try { await this.view.onClose() } catch (e) { console.error(e) }
    this.view.unload()
    this.view.containerEl.remove()
  }
  async open(view: View) { await this.closeView(); this.view = view; await this.opening(); this.app.workspace.place(this, {}); return view }
  async openFile(f: TFile, o?: { active?: boolean; state?: any; eState?: any }) {
    const type = this.app.workspace.typeForExtension(f.extension)
    if (type) return this.setViewState({ type, state: { ...(o?.state ?? {}), file: f.path }, active: o?.active ?? true }, o?.eState)
    this.app.workspace.showFile(f.path, this.fresh, o?.eState)
  }
  getDisplayText() { return this.view.getDisplayText() }
  getIcon() { return this.view.getIcon() }
  getRoot() { return this.side === "main" ? this.app.workspace.rootSplit : this.parent }
  getContainer() { return this.app.workspace.rootSplit }
  getEphemeralState() { return this.view.getEphemeralState?.() ?? {} }
  setEphemeralState(s: any) { this.view.setEphemeralState?.(s) }
  setPinned(p: boolean) { this.pinned = p }
  togglePinned() { this.pinned = !this.pinned }
  setGroup() {}
  setGroupMember() {}
  async loadIfDeferred() {}
  onResize() { this.view.onResize?.() }
  updateHeader() { this.app.workspace.changed.trigger("changed") }
  detach() { void this.app.workspace.detach(this) }
}
class EmptyView extends ItemView { getViewType() { return "empty" } getDisplayText() { return "New tab" } }

/** Obsidian's ribbon as plugins read it: their icons' elements, in the page but drawn by the app's own (index.tsx). */
class Ribbon {
  containerEl: HTMLElement
  ribbonItemsEl: HTMLElement
  collapseButtonEl = createEl("div", { cls: "sidebar-toggle-button" })
  constructor(side: string) {
    this.containerEl = hidden().createDiv({ cls: `workspace-ribbon side-dock-ribbon mod-${side}` })
    this.ribbonItemsEl = this.containerEl.createDiv({ cls: "side-dock-actions" })
  }
  get items() { return registered.ribbon.map((r) => ({ id: `${r.plugin}:${r.title}`, icon: r.icon, title: r.title, iconEl: r.el, callback: r.run, hidden: false })) }
  get orderedRibbonActions() { return this.items }
  /** A plugin's ribbon icon ("<plugin>:<name>"), shown where the app draws them; gone with its element. */
  addRibbonItemButton(id: string, icon: string, title: string, cb: (e: MouseEvent) => any) {
    const el = this.makeRibbonItemButton(icon, title, cb)
    this.ribbonItemsEl.append(el)
    const item = { plugin: String(id).split(":")[0], icon, title, run: cb, el }
    registered.ribbon.push(item)
    const remove = el.remove.bind(el)
    el.remove = () => { remove(); registered.ribbon = registered.ribbon.filter((x) => x !== item); tell() }
    tell()
    return el
  }
  removeRibbonAction(title: string) { for (const r of registered.ribbon.filter((x) => x.title === title)) r.el.remove() }
  makeRibbonItemButton(icon: string, title: string, cb: (e: MouseEvent) => any) { const el = createEl("div", { cls: "clickable-icon side-dock-ribbon-action", attr: { "aria-label": title } }); setIcon(el, icon); el.addEventListener("click", cb); return el }
  show() {}
  hide() {}
}

type Factory = (leaf: WorkspaceLeaf) => View
let parked: HTMLElement | null = null
export const parking = () => {
  if (!parked?.isConnected) {
    parked = createEl("div", { cls: "obsidian-compat-parking", attr: { "aria-hidden": "true" } })
    parked.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;visibility:hidden;pointer-events:none"
    document.body.append(parked)
  }
  return parked
}
/** Obsidian's layout items, for plugins that build their own (a split holding a leaf they made). */
export class WorkspaceItem extends Events {
  parent: any = null
  protected el = createEl("div")
  get containerEl() { return this.el }
  getRoot(): any { return this.parent?.getRoot?.() ?? this }
  getContainer(): any { return this.parent?.getContainer?.() ?? this.getRoot() }
}
export class WorkspaceParent extends WorkspaceItem {
  private kids: any[] = []
  get children(): any[] { return this.kids }
  insertChild(i: number, item: any) { item.parent = this; this.kids.splice(i, 0, item) }
  removeChild(item: any) { this.kids = this.kids.filter((x) => x !== item) }
  replaceChild(i: number, item: any) { item.parent = this; this.kids[i] = item }
}
export class WorkspaceSplit extends WorkspaceParent {
  ws: any; direction: string
  constructor(ws: any, direction = "vertical") { super(); this.ws = ws; this.direction = direction; this.el.className = "workspace-split" }
}
/** The element holding the app's panes, marked as Obsidian's root split (plugins put toolbars there and aim styles at it). */
export function rootEl(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>("[data-group]")?.parentElement ?? null
  el?.classList.add("workspace-split", "mod-vertical", "mod-root")
  return el
}
/** A split of the workspace (its root, a sidebar): what plugins ask a leaf's place for. */
class Split extends WorkspaceSplit {
  side: WorkspaceLeaf["side"]
  collapsed = false
  win = window
  doc = document
  get containerEl() { return (this.side === "main" ? rootEl() : null) ?? this.el }
  constructor(ws: Workspace, side: WorkspaceLeaf["side"]) { super(ws); this.side = side }
  get children(): any[] { return this.ws.allLeaves().filter((l: WorkspaceLeaf) => l.side === this.side) }
  expand() { this.collapsed = false }
  collapse() { this.collapsed = true }
  toggle() { this.collapsed = !this.collapsed }
  getRoot() { return this }
  getContainer() { return this.ws.rootSplit }
}

const focusedTab = () => {
  const w = getTabLayout()
  const g = panesOf(w.root).find((x) => x.id === w.focus)
  return g?.tabs.find((t) => t.id === g.active) ?? null
}
const tabTo = () => focusedTab()?.to ?? ""

export class Workspace extends Events {
  app: any
  vault: Vault
  factories = new Map<string, Factory>()
  /** Extensions a plugin's view draws (registerExtensions): extension -> view type. */
  extensions = new Map<string, string>()
  /** Leaves showing a plugin's view, in a tab or a panel. */
  leaves: WorkspaceLeaf[] = []
  layoutReady = false
  containerEl = document.body
  rootSplit: Split
  leftSplit: Split
  rightSplit: Split
  leftRibbon = new Ribbon("left")
  rightRibbon = new Ribbon("right")
  /** obsidian:// actions plugins handle, by action (Obsidian's private map, which some plugins check). */
  get protocolHandlers() { return registered.protocols }
  requestSaveLayout = Object.assign(() => {}, { cancel() {}, run() {} })
  requestUpdateLayout = Object.assign(() => { this.trigger("resize") }, { cancel() {}, run: () => { this.trigger("resize") } })
  private last: WorkspaceLeaf | null = null
  private md = new WeakMap<EditorView, WorkspaceLeaf>()
  private ready: (() => any)[] = []
  /** Leaves of Obsidian's own views plugins reach into (the file explorer), drawn by the app's own. */
  internal: WorkspaceLeaf[] = []
  /** Files opened here, the latest first (getLastOpenFiles). */
  recent: string[] = []
  // (Obsidian's private tracker behind it: plugins read and restore its list in place)
  recentFileTracker = { ws: this, get lastOpenFiles() { return this.ws.recent }, collect() {}, getRecentFiles: (o?: any) => this.getRecentFiles(o) }
  /** A leaf was placed, drawn or closed: the hosted plugins' panels and tabs follow. */
  changed = new Events()
  missing: (what: string) => void = () => {}
  /** Show a side leaf's panel (index.tsx): `reveal` brings it into sight, else it's docked only the first time. */
  showPanel: (leaf: WorkspaceLeaf, reveal: boolean) => void = () => {}
  constructor(app: any, vault: Vault) {
    super()
    this.app = app
    this.vault = vault
    this.rootSplit = new Split(this, "main")
    this.leftSplit = new Split(this, "left")
    this.rightSplit = new Split(this, "right")
  }

  onLayoutReady(fn: () => any) { if (this.layoutReady) queueMicrotask(fn); else this.ready.push(fn) }
  setReady() {
    if (this.layoutReady) return
    this.layoutReady = true
    for (const l of this.internal) l.view.build?.()
    for (const f of this.ready.splice(0)) { try { f() } catch (e) { console.error(e) } }
    this.trigger("layout-ready")
    this.trigger("layout-change")
  }

  /** The open note's leaf (the editor the user means), one per editor. */
  markdownLeaf(): WorkspaceLeaf | null {
    const ed = activeEditor()
    if (!ed) return null
    const file = ed.open.path ? this.vault.getFileByPath(ed.open.path) : null
    // (a note's editor is its note leaf, unless a plugin's view has that leaf now)
    const note = ed.open.path ? this.noteLeaf(ed.open.path) : null
    let l = note && !this.leaves.includes(note) ? note : this.md.get(ed.cm)
    if (l && !(l.view instanceof MarkdownView)) { l.view = new MarkdownView(l, ed, file); l.opened = true }
    if (!l) {
      l = new WorkspaceLeaf(this.app, "main")
      l.view = new MarkdownView(l, ed, file)
      l.opened = true
      this.md.set(ed.cm, l)
    } else { Object.assign(l.view, { editor: ed, file }); Object.assign(l.view.currentMode, { editor: ed, cm: ed.cm }) }
    return l
  }
  /** The leaf in front: the focused tab's (a note's editor, a plugin's view), else the one made active last. */
  get activeLeaf(): WorkspaceLeaf {
    const to = tabTo()
    if (to.startsWith("view:obsidian-")) {
      const hit = this.leaves.find((l) => l.side === "main" && `view:${l.key}` === to)
      if (hit) return hit
    }
    if (to.startsWith("file:")) {
      const note = this.notes.get(to.slice(5))
      if (note && this.leaves.includes(note)) return note
    }
    const md = editorInFront()?.kind === "markdown" ? this.markdownLeaf() : null
    if (md) return md
    const tab = focusedTab()
    return tab ? this.tabLeaf(tab.id, tab.to) : this.last ?? (this.last = new WorkspaceLeaf(this.app, "main"))
  }
  /** The leaf of a tab the app draws itself (an image, a PDF, a page, search), as Obsidian's core views: its file, if any. */
  private others = new Map<string, WorkspaceLeaf>()
  private tabLeaf(id: string, to: string) {
    let l = this.others.get(id)
    if (!l) { l = new WorkspaceLeaf(this.app, "main"); l.tab = id; l.opened = true; this.others.set(id, l) }
    const path = to.startsWith("file:") ? to.slice(5) : ""
    if (l.view.file?.path !== path || !(l.view instanceof CoreView)) {
      const v = new CoreView(l, coreType(path))
      v.file = path ? this.vault.getFileByPath(path) : null
      l.view = v
    }
    return l
  }
  set activeLeaf(l: WorkspaceLeaf) { this.last = l }
  /** An editor a plugin says is in front (Kanban's card editor, as it takes focus), until another is. */
  private ownEditor: any = null
  get activeEditor() {
    if (this.ownEditor?.editor?.cm?.hasFocus || this.ownEditor?.editor?.hasFocus?.()) return this.ownEditor
    // (Obsidian's is the note's view itself: its editor, file and elements)
    return this.getActiveViewOfType(MarkdownView) ?? this.ownEditor
  }
  set activeEditor(e: any) { this.ownEditor = e }
  allLeaves() { const md = this.markdownLeaf(); return [...(md ? [md] : []), ...this.leaves, ...this.internal] }
  /** An Obsidian view the app draws itself, as a leaf in a sidebar for plugins to find. */
  addInternal(make: (leaf: WorkspaceLeaf) => View) {
    const l = new WorkspaceLeaf(this.app, "left")
    l.view = make(l)
    l.opened = true
    this.internal.push(l)
    return l
  }

  getActiveFile() { const p = currentFile(); return p ? this.vault.getFileByPath(p) : null }
  getActiveViewOfType(type: any) {
    // (a note's editor wherever it is, a sheet's too: what commands mean by the note in front)
    if (type === MarkdownView || type?.prototype instanceof MarkdownView || MarkdownView.prototype instanceof type) {
      const md = this.markdownLeaf()
      if (md && md.view instanceof type) return md.view
    }
    const v = this.activeLeaf.view
    return v instanceof type ? v : null
  }
  getActiveFileView() { return this.getActiveViewOfType(FileView) }
  getLeaf(how?: boolean | "tab" | "split" | "window") {
    const fresh = how === "split" ? "split" : !!how
    if (!fresh) { const a = this.activeLeaf; if (!a.pinned && (a.view instanceof MarkdownView || this.leaves.includes(a))) return a }
    return new WorkspaceLeaf(this.app, "main", fresh || true)
  }
  getUnpinnedLeaf() { return this.getLeaf(false) }
  getMostRecentLeaf() { return this.activeLeaf }
  createLeafInParent(parent: any) { return new WorkspaceLeaf(this.app, parent?.side ?? "main", true) }
  createLeafBySplit(_l?: any, _dir?: string) { return new WorkspaceLeaf(this.app, "main", "split") }
  splitActiveLeaf() { return this.createLeafBySplit() }
  getRightLeaf(_split?: boolean) { return new WorkspaceLeaf(this.app, "right") }
  getLeftLeaf(_split?: boolean) { return new WorkspaceLeaf(this.app, "left") }
  async ensureSideLeaf(type: string, side: "left" | "right", o: { active?: boolean; state?: any; reveal?: boolean } = {}) {
    const has = this.getLeavesOfType(type)[0]
    if (has) { if (o.reveal) await this.revealLeaf(has); return has }
    const l = new WorkspaceLeaf(this.app, side)
    await l.setViewState({ type, state: o.state, active: o.active || o.reveal })
    return l
  }
  getLeavesOfType(type: string) { return this.allLeaves().filter((l) => l.view.getViewType() === type) }
  getLeafById(id: string) { return this.allLeaves().find((l) => l.id === id) ?? null }
  getGroupLeaves() { return [] }
  iterateAllLeaves(cb: (l: WorkspaceLeaf) => any) { this.allLeaves().forEach(cb) }
  iterateRootLeaves(cb: (l: WorkspaceLeaf) => any) { this.allLeaves().filter((l) => l.side === "main").forEach(cb) }
  iterateCodeMirrors(cb: (cm: any) => any) { const md = this.markdownLeaf(); if (md) cb(md.view.editor.cm) }
  setActiveLeaf(l: WorkspaceLeaf, _o?: any) {
    if (this.last === l) return
    this.last = l
    this.trigger("active-leaf-change", l)
  }
  async revealLeaf(l: WorkspaceLeaf) {
    if (l.side === "main") { if (this.leaves.includes(l)) openView(l.key) }
    else this.showPanel(l, true)
    this.setActiveLeaf(l)
  }
  /** A note in a tab, as the leaf that asked would show it (in front, a new tab, a split). */
  showFile(path: string, fresh: WorkspaceLeaf["fresh"] = false, eState?: any) {
    const sub = typeof eState?.subpath === "string" ? eState.subpath.replace(/^#\^?/, "") : ""
    if (sub && fresh !== "split") return openAt(path, sub, { newTab: !!fresh })
    if (fresh === "split" && isDesktop()) openInSplit(`file:${path}`)
    else openFile(path, { newTab: !!fresh })
    if (eState) void placeCursor(path, eState)
  }
  typeForExtension(ext: string) { return this.extensions.get(ext.toLowerCase()) ?? null }
  /** A leaf now shows a plugin's view: kept, and drawn in its tab or panel. */
  place(l: WorkspaceLeaf, o: { reveal?: boolean; show?: boolean }) {
    // (a note's leaf given back its editor is the note's tab, never a tab of its own)
    if (l.view instanceof MarkdownView) { if (l.view.file && o.show !== false) this.showFile(l.view.file.path, l.fresh); return }
    if (!this.leaves.includes(l)) this.leaves.push(l)
    if (l.side === "main" && this.isNoteLeaf(l)) {
      // (a plugin's view taking a note: drawn in the note's own tab, FileView asking viewTypeFor)
      if (o.show !== false && currentFile() !== l.arg) this.showFile(l.arg, l.fresh)
      l.fresh = false
      this.setActiveLeaf(l)
    } else if (l.side === "main") {
      // (a split a plugin opens beside the note stays beside it: the note keeps the focus unless the leaf is made active)
      const focus = !!o.reveal || l.fresh !== "split"
      if (o.show !== false) openView(l.key, { newTab: l.fresh === true, split: l.fresh === "split" && isDesktop(), focus })
      l.fresh = false
      if (focus) this.setActiveLeaf(l)
    } else this.showPanel(l, !!o.reveal)
    this.changed.trigger("changed")
    this.trigger("layout-change")
  }
  /** A note's own leaf (one per path, so a plugin keeps what it decided for it by its id): the note's tab, when a
   *  plugin's view takes the note there (Kanban's board for its notes), through its patches of setViewState. */
  private notes = new Map<string, WorkspaceLeaf>()
  noteLeaf(path: string) {
    let l = this.notes.get(path)
    if (!l) { l = new WorkspaceLeaf(this.app, "main"); l.arg = path; this.notes.set(path, l) }
    return l
  }
  isNoteLeaf(l: WorkspaceLeaf) { return this.notes.get(l.arg) === l }
  /** The view type plugins give the note at `path` opened in its leaf ("markdown" when none takes it). */
  viewTypeFor(path: string) {
    const l = this.noteLeaf(path)
    l.probe = true
    l.probed = "markdown"
    try { void l.setViewState({ type: "markdown", state: { file: path } }) } catch (e) { console.error(e) } finally { l.probe = false }
    return this.factories.has(l.probed) ? l.probed : "markdown"
  }
  /** The leaf a tab shows (view:obsidian-<type>/<arg>): the one there, or one made for it (a tab kept from before). */
  async leafFor(type: string, arg: string) {
    const hit = this.leaves.find((l) => l.side === "main" && l.view.getViewType() === type && l.arg === arg)
    if (hit || !this.factories.has(type)) return hit ?? null
    const note = arg ? this.notes.get(arg) : undefined
    const l = note && note.view.getViewType() === "empty" ? note : new WorkspaceLeaf(this.app, "main")
    l.arg = arg
    l.view = this.factories.get(type)!(l)
    this.leaves.push(l)
    // (the leaf is there at once; its view opens and loads its file meanwhile, however long its plugin takes)
    void (async () => {
      await l.opening()
      if (arg) { try { await l.view.setState?.({ file: arg }, { history: false }) } catch (e) { console.error(e) } }
      this.changed.trigger("changed")
    })()
    return l
  }
  /** A side leaf for a panel drawn before its plugin asked for one (kept in the sidebars from before). */
  async sideLeafFor(type: string, side: "left" | "right") {
    const hit = this.leaves.find((l) => l.side !== "main" && l.view.getViewType() === type)
    if (hit || !this.factories.has(type)) return hit ?? null
    const l = new WorkspaceLeaf(this.app, side)
    l.view = this.factories.get(type)!(l)
    this.leaves.push(l)
    await l.opening()
    try { await l.view.setState?.({}, { history: false }) } catch (e) { console.error(e) }
    this.changed.trigger("changed")
    return l
  }
  /** A leaf closed (by its plugin, or its tab by the user: `fromTab`, the tab already gone). */
  async detach(l: WorkspaceLeaf, fromTab = false) {
    if (!this.leaves.includes(l)) return
    this.leaves = this.leaves.filter((x) => x !== l)
    if (l.side === "main" && !fromTab) closeView(l.key)
    await l.closeView()
    if (this.isNoteLeaf(l)) l.view = new EmptyView(l)
    if (this.last === l) this.last = null
    this.changed.trigger("changed")
    this.trigger("layout-change")
  }
  detachLeavesOfType(type: string) { for (const l of this.leaves.filter((x) => x.view.getViewType() === type)) void this.detach(l) }
  async openLinkText(link: string, from: string, newLeaf?: boolean | "tab" | "split" | "window", _state?: any) {
    const path = link.split(/[#^|]/)[0]
    let f = path ? this.vault.meta.getFirstLinkpathDest(path, from) : this.vault.getFileByPath(from)
    // (as Obsidian: a link to a note that isn't there makes it)
    if (!f && path) f = await this.vault.create(/\.\w+$/.test(path) ? path : `${path}.md`, "").catch(() => null)
    if (!f) return
    const type = this.typeForExtension(f.extension)
    if (type) return void await this.getLeaf(newLeaf).openFile(f)
    const sub = link.slice(path.length).split("|")[0]
    this.showFile(f.path, newLeaf === "split" ? "split" : !!newLeaf, sub.startsWith("#") ? { subpath: sub } : undefined)
    // (as Obsidian's, it resolves once the note is in front: what a plugin does next sees it there)
    for (let i = 0; i < 40 && !(currentFile() === f.path && (f.extension !== "md" || currentEditor()?.path === f.path)); i++) await new Promise((r) => setTimeout(r, 50))
  }
  getLastOpenFiles() { return this.recent.slice(0, 10) }
  /** Obsidian's private list behind the switcher's recent files, filtered by kind. */
  getRecentFiles(o: { showMarkdown?: boolean; showCanvas?: boolean; showNonImageAttachments?: boolean; showImages?: boolean; maxCount?: number } = {}) {
    const ok = (p: string) => { const e = p.slice(p.lastIndexOf(".") + 1).toLowerCase()
      return e === "md" ? o.showMarkdown !== false : e === "canvas" ? o.showCanvas !== false : /^(png|jpe?g|gif|svg|webp|bmp|avif)$/.test(e) ? !!o.showImages : !!o.showNonImageAttachments }
    return this.recent.filter(ok).slice(0, o.maxCount ?? 10)
  }
  async duplicateLeaf(l: WorkspaceLeaf) { return l }
  moveLeafToPopout(l: WorkspaceLeaf) { return l }
  openPopoutLeaf() { return this.getLeaf(true) }
  updateOptions() { reconfigureEditors() }
  getLayout() { return { main: {}, left: {}, right: {}, active: this.activeLeaf.id, lastOpenFiles: this.getLastOpenFiles() } }
  async changeLayout() {}
  onLayoutChange() { this.trigger("layout-change") }
  requestActiveLeafEvents() { return false }
  // Obsidian's private parts plugins reach for (WS4): hover link sources, the file view in front, suggesters.
  hoverLinkSources: Record<string, { display: string; defaultMod: boolean }> = {}
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }) { this.hoverLinkSources[id] = info }
  unregisterHoverLinkSource(id: string) { delete this.hoverLinkSources[id] }
  editorSuggest = { get suggests() { return registered.suggests }, currentSuggest: null }
  floatingSplit = { children: [] as any[] }
}

export { MarkdownPreviewRenderer, MarkdownPreviewView, MarkdownRenderChild, MarkdownRenderer } from "./render.ts"

// React drawn into a plugin's own elements: portals the host (index.tsx) draws, as the app gives plugins no createRoot.
export const portals = new Map<HTMLElement, ReactNode>()
export const portalsChanged = new Events()
export function portal(el: HTMLElement, node: ReactNode) {
  portals.set(el, node)
  portalsChanged.trigger("changed")
  // (gone with its element: checked when the next one comes)
  for (const k of portals.keys()) if (!k.isConnected && k !== el) portals.delete(k)
}

/** Obsidian's ephemeral state for a note (a line, a cursor, a start), once its editor is up: the cursor there, in view. */
async function placeCursor(path: string, e: any) {
  const line = e?.cursor?.from?.line ?? e?.startLoc?.line ?? e?.line
  if (typeof line !== "number") return
  for (let i = 0; i < 40; i++) {
    const o = currentEditor()
    if (o?.path === path) {
      const ed = new Editor(o), ch = e?.cursor?.from?.ch ?? e?.startLoc?.col ?? 0
      const place = () => { ed.setCursor({ line, ch }); ed.scrollIntoView({ from: { line, ch }, to: { line, ch } }, true); if (e.focus !== false) ed.focus() }
      place()
      // (the app puts a reopened note back where it was left a moment after drawing it: this place wins)
      await new Promise((r) => setTimeout(r, 500))
      if (ed.getCursor().line !== line) place()
      return
    }
    await new Promise((r) => setTimeout(r, 75))
  }
}
