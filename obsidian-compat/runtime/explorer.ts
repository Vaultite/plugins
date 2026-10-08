// Obsidian's file explorer as plugins reach into it: a hidden tree of Obsidian-shaped rows (fileItems), whose classes,
// attributes, styles and added elements the app's file tree draws on its own rows (fileRows, index.tsx).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { fileRowsChanged, runCommandById, type FileRow } from "@vaultite"
import { createEl, hidden } from "./dom.ts"
import { setIcon } from "./ui.ts"
import { TFile, TFolder, type TAbstractFile, type Vault } from "./vault.ts"
import { ItemView, type WorkspaceLeaf } from "./workspace.ts"

type Item = { el: HTMLElement; selfEl: HTMLElement; innerEl: HTMLElement; titleEl: HTMLElement; titleInnerEl: HTMLElement
  file: TAbstractFile; collapsible: boolean; collapsed: boolean; childrenEl?: HTMLElement; collapseEl?: HTMLElement
  coverEl: HTMLElement; vChildren?: { children: Item[]; owner: Item }; parent: Item | null
  setCollapsed(c: boolean, _check?: boolean): Promise<void>; toggleCollapsed(): Promise<void>; isCollapsed(): boolean }

type Ref = Pick<Item, "el" | "selfEl" | "innerEl">
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
const BASE_ATTRS = new Set(["class", "style", "draggable"])

export class FileExplorerView extends ItemView {
  fileItems: Record<string, Item> = {}
  files = new WeakMap<HTMLElement, TAbstractFile>()
  navFileContainerEl: HTMLElement
  sortOrder = "alphabetical"
  tree: any
  private rootEl: HTMLElement
  private vault: Vault
  private rows: Record<string, FileRow> = {}
  private sigs = new Map<string, string>()
  private dirty = new Set<string>()
  private queued = false
  private restyling: ReturnType<typeof setTimeout> | undefined
  private building = false
  private refs: { file: Ref; folder: Ref }
  constructor(leaf: WorkspaceLeaf, vault: Vault) {
    super(leaf)
    this.vault = vault
    this.containerEl.dataset.type = "file-explorer"
    this.headerEl.className = "nav-header"
    this.navFileContainerEl = this.contentEl
    this.contentEl.className = "nav-files-container node-insert-event"
    this.rootEl = this.contentEl.createDiv()
    this.tree = { focusedItem: null, selectedDoms: new Set(), isAllCollapsed: false, setFocusedItem() {}, clearSelectedDoms() {}, toggleCollapseAll() {} }
    // (hidden, but in the page: plugins' delegated listeners and observers see it)
    hidden().append(this.containerEl)
    // Rows as nothing changed them, beside the real ones: what a plugin's styles did is what differs from these.
    const refs = this.contentEl.createDiv({ cls: "obsidian-compat-refs" })
    this.refs = { file: refRow(refs, false), folder: refRow(refs, true) }
    new MutationObserver((ms) => {
      if (this.building) return
      for (const m of ms) {
        const el = (m.target instanceof HTMLElement ? m.target : m.target.parentElement)?.closest<HTMLElement>(".tree-item")
        if (!el) continue
        // (a class on a folder can colour all in it)
        for (const r of [el.querySelector<HTMLElement>(":scope > .tree-item-self"), ...(m.type === "attributes" ? el.querySelectorAll<HTMLElement>(".tree-item-self") : [])]) {
          if (r?.dataset.path !== undefined) this.dirty.add(r.dataset.path)
        }
      }
      this.soon()
    }).observe(this.rootEl, { subtree: true, childList: true, attributes: true, characterData: true })
    // Plugins' styles coming or changing (a <style> in the head or the body): every row looks again.
    const restyle = new MutationObserver((ms) => {
      if (!ms.some((m) => [m.target, ...m.addedNodes, ...m.removedNodes].some((n) => n.nodeName === "STYLE" || n.nodeName === "LINK" || n.parentNode?.nodeName === "STYLE"))) return
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeName === "STYLE") restyle.observe(n, { subtree: true, childList: true, characterData: true })
      // (styles come one by one as plugins load: every row looks again once they've settled)
      clearTimeout(this.restyling)
      this.restyling = setTimeout(() => { styled = null; for (const p of Object.keys(this.fileItems)) this.dirty.add(p); this.soon() }, 300)
    })
    restyle.observe(document.head, { subtree: true, childList: true, characterData: true })
    restyle.observe(document.body, { childList: true })
    vault.on("create", (f: TAbstractFile) => { this.add(f); this.sortChildren(f.parent) })
    vault.on("delete", (f: TAbstractFile) => this.remove(f.path))
    vault.on("rename", (f: TAbstractFile, old: string) => { this.remove(old); this.add(f); this.sortChildren(f.parent) })
  }
  getViewType() { return "file-explorer" }
  getDisplayText() { return "Files" }
  getIcon() { return "folder-closed" }

  /** Every file and folder's row, made once the vault is read (and kept as it changes). */
  build() {
    this.building = true
    for (const f of this.vault.getAllLoadedFiles()) if (f.path !== "/") this.add(f)
    this.sortChildren(this.vault.getRoot())
    for (const f of this.vault.getAllFolders()) this.sortChildren(f)
    this.building = false
    for (const p of Object.keys(this.fileItems)) this.dirty.add(p)
    this.soon()
  }
  private add(f: TAbstractFile) {
    if (this.fileItems[f.path] || f.path === "/" || f.path === "") return
    const folder = f instanceof TFolder
    const el = createEl("div", { cls: `tree-item ${folder ? "nav-folder is-collapsed" : "nav-file"}` })
    const selfEl = el.createDiv({ cls: `tree-item-self ${folder ? "nav-folder-title mod-collapsible" : "nav-file-title"} is-clickable`, attr: { "data-path": f.path, draggable: "true" } })
    let collapseEl: HTMLElement | undefined
    if (folder) { collapseEl = selfEl.createDiv({ cls: "tree-item-icon collapse-icon" }); setIcon(collapseEl, "right-triangle") }
    const name = f instanceof TFile && f.extension === "md" ? f.basename : f.name
    const innerEl = selfEl.createDiv({ cls: `tree-item-inner ${folder ? "nav-folder-title-content" : "nav-file-title-content"}`, text: f instanceof TFile ? f.basename : name })
    if (f instanceof TFile && f.extension !== "md") selfEl.createDiv({ cls: "nav-file-tag", text: f.extension })
    const childrenEl = folder ? el.createDiv({ cls: "tree-item-children nav-folder-children" }) : undefined
    const parent = f.parent && f.parent.path !== "/" ? this.fileItems[f.parent.path] ?? null : null
    const item: Item = { el, selfEl, innerEl, titleEl: selfEl, titleInnerEl: innerEl, file: f, collapsible: folder, collapsed: true, childrenEl, collapseEl,
      coverEl: selfEl, parent,
      async setCollapsed(c) { item.collapsed = c; el.toggleClass("is-collapsed", c) },
      async toggleCollapsed() { await item.setCollapsed(!item.collapsed) },
      isCollapsed: () => item.collapsed }
    if (folder) item.vChildren = { children: [], owner: item }
    this.fileItems[f.path] = item
    this.files.set(selfEl, f)
    ;(parent?.childrenEl ?? this.rootEl).append(el)
    parent?.vChildren?.children.push(item)
    this.dirty.add(f.path)
    this.soon()
  }
  private remove(path: string) {
    const it = this.fileItems[path]
    if (!it) return
    for (const p of Object.keys(this.fileItems)) if (p.startsWith(`${path}/`)) { delete this.fileItems[p]; delete this.rows[p] }
    if (it.parent?.vChildren) it.parent.vChildren.children = it.parent.vChildren.children.filter((c) => c !== it)
    it.el.remove()
    delete this.fileItems[path]
    delete this.rows[path]
    this.sigs.delete(path)
    fileRowsChanged()
  }
  /** Folders first, then by name, as the app's tree. */
  private sortChildren(folder: TFolder | null) {
    const box = !folder || folder.path === "/" ? this.rootEl : this.fileItems[folder.path]?.childrenEl
    if (!box) return
    const items = [...box.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tree-item"))
    items.sort((a, b) => (Number(b.classList.contains("nav-folder")) - Number(a.classList.contains("nav-folder")))
      || collator.compare(a.querySelector(".tree-item-inner")?.textContent ?? "", b.querySelector(".tree-item-inner")?.textContent ?? ""))
    for (const el of items) box.append(el)
  }
  requestSort() { this.sort() }
  sort() { this.sortChildren(this.vault.getRoot()); for (const f of this.vault.getAllFolders()) this.sortChildren(f) }
  getSortedFolderItems(folder: TFolder) { return folder.children.map((c) => this.fileItems[c.path]).filter(Boolean) }
  setSortOrder(o: string) { this.sortOrder = o; this.sort() }
  revealInFolder(f: TAbstractFile) { if (f?.path) runCommandById("file:reveal") }
  async onCreate() {}
  onDelete() {}
  onRename() {}
  afterCreate() {}

  private soon() {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => { this.queued = false; this.flush() })
  }
  private flush() {
    let changed = false
    refLooks.clear()
    for (const path of this.dirty) {
      const it = this.fileItems[path]
      if (!it) continue
      const row = rowOf(it, it.collapsible ? this.refs.folder : this.refs.file), sig = sigOf(row)
      if (this.sigs.get(path) === sig) continue
      this.sigs.set(path, sig)
      this.rows[path] = row
      changed = true
    }
    this.dirty.clear()
    if (changed) { this.rows = { ...this.rows }; fileRowsChanged() }
  }
  /** What the app's tree draws on its rows (fileRows). */
  fileRows() { return this.rows }
}

/** A row nothing changes, for comparing. */
function refRow(box: HTMLElement, folder: boolean) {
  const el = box.createDiv({ cls: `tree-item ${folder ? "nav-folder is-collapsed" : "nav-file"}` })
  const selfEl = el.createDiv({ cls: `tree-item-self ${folder ? "nav-folder-title mod-collapsible" : "nav-file-title"} is-clickable` })
  const innerEl = selfEl.createDiv({ cls: `tree-item-inner ${folder ? "nav-folder-title-content" : "nav-file-title-content"}`, text: "x" })
  return { el, selfEl, innerEl }
}
// What a plugin's styles may change about a row, copied as it computes there (Obsidian's structure, which the app's
// tree hasn't): colours, weight, decoration.
const LOOKS = ["color", "background-color", "font-weight", "font-style", "text-decoration-line", "text-decoration-color", "opacity", "filter"]
// (computing a row's style is the costly part: done only while some plugin's or snippet's styles name the tree's rows,
// the untouched row's once per pass)
let styled: boolean | null = null
const refLooks = new Map<HTMLElement, string[]>()
const ROWS = /nav-file|nav-folder|tree-item|data-path/
function explorerStyled() {
  styled ??= [...document.querySelectorAll("style")].some((s) => (s as HTMLElement).dataset.vaultPlugin !== "obsidian-compat" && ROWS.test(s.textContent ?? ""))
  return styled
}
function looks(el: HTMLElement, ref: HTMLElement) {
  if (!explorerStyled()) return []
  const a = getComputedStyle(el)
  let b = refLooks.get(ref)
  if (!b) { const c = getComputedStyle(ref); b = LOOKS.map((k) => c.getPropertyValue(k)); refLooks.set(ref, b) }
  return LOOKS.flatMap((k, i) => { const v = a.getPropertyValue(k); return v !== b[i] ? [`${k}: ${v}`] : [] })
}

/** A row as plugins left it: its classes, attributes and style, and what they added before and after its name. */
function rowOf(it: Item, ref: Ref): FileRow {
  const attrs: Record<string, string> = {}
  for (const a of it.selfEl.attributes) if (!BASE_ATTRS.has(a.name)) attrs[a.name] = a.value
  const nameAttrs: Record<string, string> = {}
  for (const a of it.innerEl.attributes) if (!BASE_ATTRS.has(a.name)) nameAttrs[a.name] = a.value
  const kids = [...it.selfEl.children]
  const at = kids.indexOf(it.innerEl)
  const before = kids.slice(0, Math.max(0, at)).filter((k) => k !== it.collapseEl)
  const after = [...kids.slice(at + 1), ...it.innerEl.children]
  const style = [it.el.style.cssText, it.selfEl.style.cssText, ...looks(it.selfEl, ref.selfEl)].filter(Boolean).join("; ")
  const nameStyle = [it.innerEl.style.cssText, ...looks(it.innerEl, ref.innerEl)].filter(Boolean).join("; ")
  return { row: { className: [...it.el.classList].filter((c) => !/^(tree-item|nav-file|nav-folder|is-collapsed)$/.test(c)).concat([...it.selfEl.classList]).join(" "), attrs, ...(style ? { style } : {}) },
    name: { className: it.innerEl.className, attrs: nameAttrs, ...(nameStyle ? { style: nameStyle } : {}) },
    ...(before.length ? { before } : {}), ...(after.length ? { after } : {}) }
}
const sigOf = (r: FileRow) => JSON.stringify([r.row, r.name, (r.before ?? []).map((n) => (n as Element).outerHTML), (r.after ?? []).map((n) => (n as Element).outerHTML)])
