// Obsidian's UI pieces plugins build with: icons, notices, modals and suggesters, settings rows and their controls,
// menus, scopes. Raw DOM with Obsidian's class names, styled by obsidian.css in the app's colours.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DisplayValueComponent } from "./values.ts"
import { dismissNotice, menuShowing, namedIcon, notify, openMenu, type MenuItem as AppMenuItem } from "@vaultite"
import { Component, Events } from "./core.ts"
import { createEl } from "./dom.ts"

// --- icons: Lucide's, by name, from the server (plugin.ts); Obsidian's older names mapped

const custom = new Map<string, string>()
// Obsidian's own icon names (older than Lucide, still used by plugins), as Lucide's.
const OLD: Record<string, string> = { "dice": "dices", "documents": "files", "document": "file", "checkmark": "check", "check-small": "check", "cross": "x",
  "cross-in-box": "square-x", "gear": "settings", "left-arrow": "arrow-left", "right-arrow": "arrow-right", "up-arrow": "arrow-up", "down-arrow": "arrow-down",
  "left-arrow-with-tail": "arrow-left", "right-arrow-with-tail": "arrow-right", "up-arrow-with-tail": "arrow-up", "down-arrow-with-tail": "arrow-down",
  "up-chevron-glyph": "chevron-up", "down-chevron-glyph": "chevron-down", "right-chevron-glyph": "chevron-right", "left-chevron-glyph": "chevron-left",
  "right-triangle": "chevron-right", "double-up-arrow-glyph": "chevrons-up", "double-down-arrow-glyph": "chevrons-down", "up-and-down-arrows": "arrow-up-down",
  "calendar-with-checkmark": "calendar-check", "plus-with-circle": "circle-plus", "minus-with-circle": "circle-minus", "check-in-circle": "circle-check",
  "trash": "trash-2", "reset": "rotate-ccw", "three-horizontal-bars": "menu", "vertical-three-dots": "more-vertical", "more-horizontal": "ellipsis",
  "sync": "refresh-cw", "sync-small": "refresh-cw", "help": "circle-help", "bullet-list": "list", "lines-of-text": "align-left", "sheets-in-box": "archive",
  "any-key": "keyboard", "keyboard-glyph": "keyboard", "audio-file": "file-audio", "image-file": "file-image", "video-file": "file-video", "pdf-file": "file-text",
  "blocks": "blocks", "broken-link": "unlink", "create-new": "square-pen", "crossed-star": "star-off", "csv": "file-spreadsheet", "dot-network": "network",
  "enter": "corner-down-left", "expand-vertically": "unfold-vertical", "filled-pin": "pin", "forward-arrow": "forward", "fullscreen": "maximize",
  "go-to-file": "file-search", "hashtag": "hash", "heading-glyph": "heading", "install": "download", "links-coming-in": "arrow-down-left",
  "links-going-out": "arrow-up-right", "magnifying-glass": "search", "search-glyph": "search", "microphone-filled": "mic", "microphone": "mic",
  "note-glyph": "sticky-note", "open-vault": "folder-open", "pane-layout": "layout-dashboard", "paper-plane": "send", "paste": "clipboard-paste",
  "paste-text": "clipboard-type", "popup-open": "external-link", "presentation": "presentation", "price-tag-glyph": "tag", "quote-glyph": "quote",
  "redo-glyph": "redo", "undo-glyph": "undo", "restore-file-glyph": "history", "run-command": "terminal", "scissors": "scissors", "select-all-text": "text-select",
  "stacked-levels": "layers", "strikethrough-glyph": "strikethrough", "switch": "toggle-left", "uppercase-lowercase-a": "case-sensitive", "vault": "vault",
  "vertical-split": "columns-2", "horizontal-split": "rows-2", "wand": "wand-2", "wrench-screwdriver-glyph": "wrench", "yaml": "file-code", "deleteColumn": "trash",
  "lucide-alert-triangle": "triangle-alert", "alert-triangle": "triangle-alert", "alert-circle": "circle-alert", "edit": "pencil", "pencil": "pencil",
  "bold-glyph": "bold", "italic-glyph": "italic", "code-glyph": "code", "link-glyph": "link", "image-glyph": "image", "number-list-glyph": "list-ordered",
  "checkbox-glyph": "square-check", "info": "info", "star": "star", "link": "link", "clock": "clock", "folder": "folder", "search": "search",
  "graph-glyph": "git-fork", "file-explorer-glyph": "folder", "star-list": "list", "cloud": "cloud", "dice-glyph": "dices", "languages": "languages" }
const nameOf = (id: string) => { const n = id.replace(/^lucide-/, ""); return OLD[n] ?? n }
const parse = (svg: string) => { const t = document.createElement("template"); t.innerHTML = svg.trim(); return t.content.firstElementChild as SVGSVGElement | null }

// Lucide's icons, all at once the first time one is asked for (Obsidian answers getIcon synchronously, for every name).
let lucide: { icons: Record<string, string>; aliases: Record<string, string> } | null = null
/** Fetched ahead (as plugins start loading), so getIcon rarely has to wait for them. */
export function prefetchIcons() {
  if (!lucide) void fetch(new URL("api/plugin-compat/icons", document.baseURI).href).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && !lucide) lucide = j }, () => {})
}
function icons() {
  if (lucide) return lucide
  lucide = { icons: {}, aliases: {} }
  try {
    const x = new XMLHttpRequest()
    x.open("GET", new URL("api/plugin-compat/icons", document.baseURI).href, false)
    x.send()
    if (x.status === 200) lucide = JSON.parse(x.responseText)
  } catch { /* offline: none */ }
  return lucide!
}
const svgOf = (n: string, inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${n}">${inner}</svg>`
function lucideSvg(id: string) {
  const n = nameOf(id), l = icons(), name = l.icons[n] ? n : l.aliases[n] ?? n
  const inner = l.icons[name]
  return inner === undefined ? null : svgOf(name, inner)
}
export async function loadIcon(id: string) { return lucideSvg(id) }
/** An icon now, as Obsidian's getIcon is. */
export function getIcon(id: string): SVGSVGElement | null {
  if (custom.has(id)) return parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="svg-icon ${id}" fill="currentColor">${custom.get(id)}</svg>`)
  const s = lucideSvg(id)
  return s ? parse(s) : null
}
export function setIcon(el: HTMLElement, id: string) {
  el.empty?.()
  const i = getIcon(id)
  if (i) el.append(i)
}
export const addIcon = (id: string, svg: string) => { custom.set(id, svg) }
export const removeIcon = (id: string) => { custom.delete(id) }
export const getIconIds = () => [...custom.keys(), ...Object.keys(icons().icons).map((n) => `lucide-${n}`)]
/** The app's own tooltip (data-tip), above or wherever `placement` says. */
export function setTooltip(el: HTMLElement, text: string, o?: { placement?: "top" | "bottom" | "left" | "right" }) {
  if (!text) { el.removeAttribute("data-tip"); return }
  el.setAttribute("aria-label", text)
  el.setAttribute("data-tip", text)
  if (o?.placement) el.setAttribute("data-tip-side", o.placement)
}
export const displayTooltip = (el: HTMLElement, text: string, o?: { placement?: "top" | "bottom" | "left" | "right" }) => setTooltip(el, text, o)

// --- notices: the app's toasts

let notices = 0
export class Notice {
  noticeEl: HTMLElement
  messageEl: HTMLElement
  containerEl: HTMLElement
  id = `obsidian-notice-${++notices}`
  duration: number
  constructor(message: string | DocumentFragment, duration?: number) {
    this.noticeEl = this.containerEl = createEl("div", { cls: "notice" })
    this.messageEl = this.noticeEl.createDiv({ cls: "notice-message" })
    this.duration = duration ?? 5000
    this.setMessage(message)
  }
  setMessage(m: string | DocumentFragment) {
    this.messageEl.replaceChildren(typeof m === "string" ? m : m.cloneNode(true))
    const text = (typeof m === "string" ? m : m.textContent ?? "").trim()
    // (0: until the plugin hides it)
    if (text) notify(text, { id: this.id, duration: this.duration > 0 ? this.duration : 24 * 3600_000 })
    return this
  }
  hide() { dismissNotice(this.id) }
}

// --- scopes and keys

export type KeymapEventHandler = { scope: Scope; modifiers: string | null; key: string | null; func: (e: KeyboardEvent, ctx: any) => any }
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export class Keymap {
  static isModEvent(e?: any) { if (!e) return false; return isMac ? (e.metaKey ? (e.altKey ? "split" : "tab") : false) : e.ctrlKey ? "tab" : false }
  static isModifier(e: KeyboardEvent | MouseEvent, m: string) {
    return m === "Mod" ? (isMac ? e.metaKey : e.ctrlKey) : m === "Ctrl" ? e.ctrlKey : m === "Meta" ? e.metaKey : m === "Shift" ? e.shiftKey : m === "Alt" ? e.altKey : false
  }
  pushScope(s: Scope) { scopes.push(s) }
  popScope(s: Scope) { const i = scopes.lastIndexOf(s); if (i >= 0) scopes.splice(i, 1) }
  getRootScope() { return scopes[0] ?? null }
  hasModifier(m: string) { return !!this.modifiers?.[m] }
  modifiers: Record<string, boolean> = {}
}
const scopes: Scope[] = []
const mods = (e: KeyboardEvent) => ["Mod", "Ctrl", "Meta", "Shift", "Alt"].filter((m) => Keymap.isModifier(e, m) && !(m === (isMac ? "Meta" : "Ctrl")))
export class Scope {
  keys: KeymapEventHandler[] = []
  parent?: Scope
  constructor(parent?: Scope) { this.parent = parent }
  register(modifiers: string[] | null, key: string | null, func: KeymapEventHandler["func"]) {
    const h = { scope: this, modifiers: modifiers ? modifiers.join(",") : null, key, func }
    this.keys.push(h)
    return h
  }
  unregister(h: KeymapEventHandler) { this.keys = this.keys.filter((x) => x !== h) }
  handle(e: KeyboardEvent): boolean {
    // (in the order registered, as Obsidian: a plugin overriding a key unregisters the one there first)
    for (const h of [...this.keys]) {
      if (h.key !== null && h.key.toLowerCase() !== e.key.toLowerCase()) continue
      if (h.modifiers !== null && h.modifiers.split(",").filter(Boolean).sort().join() !== mods(e).sort().join()) continue
      if (h.func(e, { modifiers: mods(e).join(","), key: e.key, vkey: e.key }) !== true) { e.preventDefault(); e.stopPropagation(); return true }
    }
    return this.parent ? this.parent.handle(e) : false
  }
}
window.addEventListener("keydown", (e) => { const s = scopes[scopes.length - 1]; if (s) s.handle(e) }, true)

// --- modals

export class Modal extends Component {
  app: any
  scope: Scope
  containerEl: HTMLElement
  modalEl: HTMLElement
  titleEl: HTMLElement
  contentEl: HTMLElement
  headerEl: HTMLElement
  shouldRestoreSelection = true
  isOpen = false
  constructor(app: any) {
    super()
    this.app = app
    this.scope = new Scope()
    this.scope.register([], "Escape", () => { this.close(); return false })
    this.containerEl = createEl("div", { cls: "modal-container mod-dim" })
    this.containerEl.createDiv({ cls: "modal-bg" }).addEventListener("click", () => this.close())
    this.modalEl = this.containerEl.createDiv({ cls: "modal" })
    const close = this.modalEl.createDiv({ cls: "modal-close-button", attr: { "aria-label": "Close" } })
    setIcon(close, "x")
    close.addEventListener("click", () => this.close())
    this.headerEl = this.modalEl.createDiv({ cls: "modal-header" })
    this.titleEl = this.headerEl.createDiv({ cls: "modal-title" })
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" })
  }
  open() {
    if (this.isOpen) return
    this.isOpen = true
    document.body.append(this.containerEl)
    scopes.push(this.scope)
    this.load()
    this.restore = document.activeElement as HTMLElement | null
    try { void this.onOpen() } catch (e) { console.error(e) }
    // (the keyboard leaves the note behind it: its first field takes it, unless onOpen put it somewhere in the modal)
    queueMicrotask(() => {
      if (!this.isOpen || this.containerEl.contains(document.activeElement)) return
      const f = this.modalEl.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([disabled]), textarea, [contenteditable=true]")
      if (f) f.focus(); else { this.modalEl.tabIndex = -1; this.modalEl.focus() }
    })
  }
  private restore: HTMLElement | null = null
  close() {
    if (!this.isOpen) return
    this.isOpen = false
    const i = scopes.lastIndexOf(this.scope); if (i >= 0) scopes.splice(i, 1)
    this.containerEl.detach()
    this.unload()
    try { void this.onClose() } catch (e) { console.error(e) }
    if (this.shouldRestoreSelection && this.restore?.isConnected && !document.querySelector(".modal-container")) this.restore.focus({ preventScroll: true })
  }
  onOpen(): any {}
  onClose(): any {}
  setTitle(t: string) { this.titleEl.setText(t); return this }
  setContent(c: string | DocumentFragment) { this.contentEl.setText(c); return this }
  setCloseCallback(fn: () => void) { const was = this.onClose.bind(this); this.onClose = () => { was(); fn() }; return this }
}

/** Obsidian's suggestion list (SuggestModal's `chooser`, a suggester's `suggestions`), with its names plugins use. */
export class Chooser<T> {
  owner: any
  el: HTMLElement
  items: T[] = []
  rows: HTMLElement[] = []
  selected = 0
  constructor(owner: any, el: HTMLElement) { this.owner = owner; this.el = el }
  get containerEl() { return this.el }
  get values() { return this.items }
  get suggestions() { return this.rows }
  get selectedItem() { return this.selected }
  set selectedItem(i: number) { this.select(i) }
  set(items: T[]) {
    this.items = items
    this.el.empty()
    this.rows = items.map((it, i) => {
      const row = this.el.createDiv({ cls: "suggestion-item" })
      row.addEventListener("mousemove", () => this.select(i))
      row.addEventListener("mousedown", (e) => { e.preventDefault(); this.select(i); this.choose(e) })
      try { this.owner.renderSuggestion(it, row) } catch (e) { console.error(e) }
      return row
    })
    this.select(0)
  }
  select(i: number) {
    this.rows[this.selected]?.removeClass("is-selected")
    this.selected = this.rows.length ? (i + this.rows.length) % this.rows.length : 0
    this.rows[this.selected]?.addClass("is-selected")
    this.rows[this.selected]?.scrollIntoView({ block: "nearest" })
  }
  choose(e: Event) { const it = this.items[this.selected]; if (it !== undefined) this.owner.selectSuggestion(it, e) }
  setSuggestions(items: T[] | null) { this.set(items ?? []) }
  setSelectedItem(i: number, _e?: Event) { this.select(i) }
  useSelectedItem(e: Event) { this.choose(e); return this.items[this.selected] !== undefined }
  moveUp(_e?: Event) { this.select(this.selected - 1); return false }
  moveDown(_e?: Event) { this.select(this.selected + 1); return false }
  addMessage(text: string) { this.el.createDiv({ cls: "suggestion-empty", text }) }
  keys(scope: Scope) {
    scope.register([], "ArrowDown", () => { this.select(this.selected + 1); return false })
    scope.register([], "ArrowUp", () => { this.select(this.selected - 1); return false })
    scope.register([], "Enter", (e) => { this.choose(e); return false })
  }
}

export class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement
  resultContainerEl: HTMLElement
  instructionsEl: HTMLElement
  limit = 100
  emptyStateText = "No results found."
  chooser: Chooser<T>
  constructor(app: any) {
    super(app)
    this.modalEl.addClass("prompt")
    this.headerEl.detach(); this.contentEl.detach()
    this.inputEl = this.modalEl.createEl("input", { cls: "prompt-input", attr: { type: "text", enterkeyhint: "done" } }) as HTMLInputElement
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" })
    this.instructionsEl = this.modalEl.createDiv({ cls: "prompt-instructions" })
    this.chooser = new Chooser<T>(this, this.resultContainerEl)
    this.chooser.keys(this.scope)
    this.inputEl.addEventListener("input", () => void this.updateSuggestions())
  }
  open() { super.open(); this.inputEl.focus(); void this.updateSuggestions() }
  // (Obsidian's own name for it, which plugins call: never `update`, which a subclass may have)
  async updateSuggestions() {
    const q = this.inputEl.value
    const got = await this.getSuggestions(q)
    if (q !== this.inputEl.value) return
    const list = (got ?? []).slice(0, this.limit)
    this.chooser.set(list)
    if (!list.length && this.emptyStateText) this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText })
  }
  setPlaceholder(t: string) { this.inputEl.placeholder = t }
  setInstructions(list: { command: string; purpose: string }[]) {
    this.instructionsEl.empty()
    for (const i of list) { const d = this.instructionsEl.createDiv({ cls: "prompt-instruction" }); d.createSpan({ cls: "prompt-instruction-command", text: i.command }); d.createSpan({ text: i.purpose }) }
  }
  selectSuggestion(v: T, e: MouseEvent | KeyboardEvent) { this.close(); this.onChooseSuggestion(v, e) }
  selectActiveSuggestion(e: any) { this.chooser.choose(e) }
  getSuggestions(_q: string): T[] | Promise<T[]> { return [] }
  renderSuggestion(v: T, el: HTMLElement) { el.setText(String(v)) }
  onChooseSuggestion(_v: T, _e: MouseEvent | KeyboardEvent): any {}
  onNoSuggestion() {}
}

export type FuzzyMatch<T> = { item: T; match: { score: number; matches: [number, number][] } }
export function prepareFuzzySearch(q: string) {
  const want = q.toLowerCase().replace(/\s+/g, "")
  return (text: string) => {
    if (!want) return { score: 0, matches: [] as [number, number][] }
    const t = text.toLowerCase(), matches: [number, number][] = []
    let i = 0, score = 0, last = -2
    for (const ch of want) {
      const j = t.indexOf(ch, i)
      if (j < 0) return null
      if (j === last + 1 && matches.length) matches[matches.length - 1][1] = j + 1; else matches.push([j, j + 1])
      score -= j - i
      last = j; i = j + 1
    }
    return { score, matches }
  }
}
export function prepareSimpleSearch(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return (text: string) => {
    const t = text.toLowerCase(), matches: [number, number][] = []
    for (const w of words) { const j = t.indexOf(w); if (j < 0) return null; matches.push([j, j + w.length]) }
    return { score: 0, matches }
  }
}
export const fuzzySearch = (q: ReturnType<typeof prepareFuzzySearch>, text: string) => q(text)
export function renderMatches(el: HTMLElement, text: string, matches: [number, number][] | null, offset = 0) {
  let at = 0
  for (const [a, b] of matches ?? []) {
    const s = a + offset, e = b + offset
    if (s < 0 || s >= text.length) continue
    if (s > at) el.appendText(text.slice(at, s))
    el.createSpan({ cls: "suggestion-highlight", text: text.slice(s, e) })
    at = e
  }
  if (at < text.length) el.appendText(text.slice(at))
}
export const renderResults = (el: HTMLElement, text: string, r: { matches: [number, number][] } | null, offset = 0) => renderMatches(el, text, r?.matches ?? null, offset)
export const sortSearchResults = (list: { match: { score: number } }[]) => list.sort((a, b) => b.match.score - a.match.score)

export class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  getSuggestions(q: string) {
    const f = prepareFuzzySearch(q)
    const out: FuzzyMatch<T>[] = []
    for (const item of this.getItems()) { const m = f(this.getItemText(item)); if (m) out.push({ item, match: m }) }
    return q ? out.sort((a, b) => b.match.score - a.match.score) : out
  }
  renderSuggestion(m: FuzzyMatch<T>, el: HTMLElement) { renderMatches(el, this.getItemText(m.item), m.match.matches) }
  onChooseSuggestion(m: FuzzyMatch<T>, e: MouseEvent | KeyboardEvent) { this.onChooseItem(m.item, e) }
  getItems(): T[] { return [] }
  getItemText(item: T) { return String(item) }
  onChooseItem(_item: T, _e: MouseEvent | KeyboardEvent): any {}
}

/** A suggester under a text field (a settings row's folder or file). */
export class PopoverSuggest<T> {
  app: any
  scope: Scope
  suggestEl: HTMLElement
  chooser: Chooser<T>
  isOpen = false
  get suggestions() { return this.chooser }
  constructor(app: any, scope?: Scope) {
    this.app = app
    this.scope = new Scope(scope)
    this.suggestEl = createEl("div", { cls: "suggestion-container" })
    this.chooser = new Chooser<T>(this, this.suggestEl.createDiv({ cls: "suggestion" }))
    this.chooser.keys(this.scope)
    this.scope.register([], "Escape", () => { this.close(); return false })
  }
  open() { if (!this.isOpen) { this.isOpen = true; document.body.append(this.suggestEl); scopes.push(this.scope) } }
  close() { if (this.isOpen) { this.isOpen = false; this.suggestEl.detach(); const i = scopes.lastIndexOf(this.scope); if (i >= 0) scopes.splice(i, 1) } }
  renderSuggestion(v: T, el: HTMLElement) { el.setText(String(v)) }
  selectSuggestion(_v: T, _e: any): any {}
}

export class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  textInputEl: HTMLInputElement | HTMLElement
  limit = 100
  private picked?: (v: T, e: any) => any
  constructor(app: any, inputEl: HTMLInputElement | HTMLDivElement) {
    super(app)
    this.textInputEl = inputEl
    inputEl.addEventListener("input", () => void this.updateSuggestions())
    inputEl.addEventListener("focus", () => void this.updateSuggestions())
    inputEl.addEventListener("blur", () => setTimeout(() => this.close(), 150))
  }
  async updateSuggestions() { this.showSuggestions((await this.getSuggestions(this.getValue())).slice(0, this.limit)) }
  /** Show these (plugins wrap it to change rows as they're drawn). */
  showSuggestions(list: T[]) {
    if (!list.length) return this.close()
    this.chooser.set(list)
    const r = this.textInputEl.getBoundingClientRect()
    Object.assign(this.suggestEl.style, { left: `${r.left}px`, top: `${r.bottom + 4}px`, minWidth: `${r.width}px` })
    this.open()
  }
  getValue() { return "value" in this.textInputEl ? (this.textInputEl as HTMLInputElement).value : this.textInputEl.textContent ?? "" }
  setValue(v: string) { if ("value" in this.textInputEl) (this.textInputEl as HTMLInputElement).value = v; else this.textInputEl.textContent = v }
  onSelect(fn: (v: T, e: any) => any) { this.picked = fn; return this }
  selectSuggestion(v: T, e: any) { this.picked?.(v, e); this.close() }
  getSuggestions(_q: string): T[] | Promise<T[]> { return [] }
}

// --- settings: a tab of rows, each with controls

export class PluginSettingTab {
  app: any
  plugin: any
  containerEl: HTMLElement
  icon = "settings"
  settingItems: any[] = []
  /** Pages opened from it, innermost last: Back returns. */
  pages: { title: string; el: HTMLElement; done?: () => void; page?: SettingPage }[] = []
  // (id and name: Obsidian's own, from the plugin's manifest, which plugins read)
  id: string
  name: string
  constructor(app: any, plugin: any) {
    this.app = app; this.plugin = plugin; this.containerEl = createEl("div", { cls: "vertical-tab-content" })
    this.id = plugin?.manifest?.id ?? ""; this.name = plugin?.manifest?.name ?? ""
  }
  /** Obsidian 1.13's settings as data (getSettingDefinitions), drawn as rows; a tab that draws itself overrides it. */
  display(): any { this.update() }
  hide(): any {}
  getSettingDefinitions(): any[] { return [] }
  getControlValue(key: string) { return this.plugin?.settings?.[key] }
  async setControlValue(key: string, v: unknown) { if (this.plugin?.settings) { this.plugin.settings[key] = v; await this.plugin.saveSettings?.() } }
  refreshDomState() { this.update() }
  update() {
    const top = this.pages[this.pages.length - 1]
    if (top) return
    this.containerEl.empty()
    this.settingItems = this.getSettingDefinitions()
    drawItems(this, this.containerEl, this.settingItems)
  }
  /** A sub-page (a declared one, or a SettingPage) in place of the tab, with Back. */
  openPage(title: string, draw: (el: HTMLElement) => void, done?: () => void, page?: SettingPage) {
    const el = createEl("div", { cls: "setting-page" })
    // (a SettingPage has its own title bar, which plugins retitle: Back goes in it)
    const bar = page ? page.titlebarEl : el.createDiv()
    bar.empty()
    bar.addClass("setting-page-bar")
    const back = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Back" } })
    setIcon(back, "chevron-left")
    bar.createDiv({ cls: "setting-page-title", text: title })
    back.addEventListener("click", () => this.closePage())
    draw(page ? el : el.createDiv())
    this.pages.push({ title, el, done, page })
    this.containerEl.replaceChildren(el)
  }
  closePage() {
    this.pages.pop()?.done?.()
    const top = this.pages[this.pages.length - 1]
    if (top) this.containerEl.replaceChildren(top.el)
    else this.update()
  }
}

const on = (v: unknown) => (typeof v === "function" ? v() : v) !== false
function drawItems(tab: PluginSettingTab, el: HTMLElement, items: any[]) {
  for (const it of items ?? []) {
    if (!it || !on(it.visible)) continue
    if (it.type === "group" || it.type === "list") {
      const group = el.createDiv({ cls: `setting-group${it.type === "list" ? " mod-list" : ""}${it.cls ? ` ${it.cls}` : ""}` })
      if (it.heading) new Setting(group).setName(it.heading).setHeading()
      const g = group.createDiv({ cls: "setting-items" })
      ;(it.items ?? []).forEach((x: any, i: number) => {
        const before = g.childElementCount
        drawItems(tab, g, [x])
        const row = g.children[before] as HTMLElement | undefined
        if (row && it.onDelete) { const d = row.querySelector(".setting-item-control") ?? row; const b = d.createDiv({ cls: "clickable-icon" }); setIcon(b, "trash-2"); b.addEventListener("click", () => { it.onDelete(i); tab.update() }) }
      })
      if (it.type === "list" && !(it.items ?? []).length && it.emptyState) g.createDiv({ cls: "setting-item-description", text: it.emptyState })
      if (it.addItem) new Setting(g).setName(`+ ${it.addItem.name}`).then((s) => s.settingEl.addEventListener("click", () => it.addItem.action(s.settingEl)))
      continue
    }
    if (it.type === "page") {
      const s = new Setting(el).setName(it.name)
      if (it.desc) s.setDesc(it.desc)
      const v = typeof it.displayValue === "function" ? it.displayValue() : it.displayValue
      if (v) s.controlEl.createSpan({ cls: "setting-item-description", text: v })
      s.addExtraButton((b) => b.setIcon("chevron-right"))
      s.settingEl.addClass("mod-clickable")
      s.settingEl.addEventListener("click", () => {
        if (it.items) tab.openPage(it.name, (pel) => drawItems(tab, pel, it.items))
        else if (it.page) { const pg = it.page(); tab.openPage(it.name, (pel) => { pel.append(pg.rootEl); pg.display() }, () => pg.hide()) }
      })
      continue
    }
    const s = new Setting(el).setName(it.name)
    if (it.desc) s.setDesc(it.desc)
    if (it.render) { try { it.render(s, null) } catch (e) { console.error(e) } continue }
    if (it.action) { s.settingEl.addClass("mod-clickable"); s.settingEl.addEventListener("click", () => it.action(s.settingEl, 0)); continue }
    const c = it.control
    if (!c) continue
    const value = tab.getControlValue(c.key) ?? c.defaultValue
    const set = async (v: unknown) => { const bad = await c.validate?.(v); if (bad) { s.descEl.setText(String(bad)); return } await tab.setControlValue(c.key, v) }
    const off = typeof c.disabled === "function" ? c.disabled() : !!c.disabled
    if (c.type === "toggle") s.addToggle((t) => t.setValue(!!value).onChange(set))
    else if (c.type === "dropdown") s.addDropdown((d) => d.addOptions(c.options ?? {}).setValue(String(value ?? "")).onChange(set))
    else if (c.type === "textarea") s.addTextArea((t) => t.setPlaceholder(c.placeholder ?? "").setValue(String(value ?? "")).onChange(set))
    else if (c.type === "number") s.addText((t) => { t.inputEl.type = "number"; t.setPlaceholder(c.placeholder ?? "").setValue(String(value ?? "")).onChange((v) => set(v === "" ? (c.defaultValue ?? 0) : Number(v))) })
    else if (c.type === "slider") s.addSlider((t) => t.setLimits(c.min, c.max, c.step).setValue(Number(value ?? c.min)).onChange(set))
    else if (c.type === "color") s.addColorPicker((t) => t.setValue(String(value ?? "#000000")).onChange(set))
    else s.addText((t) => {
      t.setPlaceholder(c.placeholder ?? "").setValue(String(value ?? "")).onChange(set)
      if (c.type === "file" || c.type === "folder") {
        const v = tab.app.vault
        new PathSuggest(tab.app, t.inputEl, () => (c.type === "file" ? v.getFiles() : v.getAllFolders(c.includeRoot)).filter((f: any) => !c.filter || c.filter(f)).map((f: any) => f.path)).onSelect((p) => { t.setValue(p); void set(p) })
      }
    })
    if (off) s.setDisabled(true)
  }
}

class PathSuggest extends AbstractInputSuggest<string> {
  all: () => string[]
  constructor(app: any, el: HTMLInputElement, all: () => string[]) { super(app, el); this.all = all }
  getSuggestions(q: string) { const l = q.toLowerCase(); return this.all().filter((p) => p.toLowerCase().includes(l)).slice(0, 50) }
}

export { PluginSettingTab as SettingTab }

export class BaseComponent { disabled = false; then(cb: (c: this) => any) { cb(this); return this } setDisabled(d: boolean) { this.disabled = d; return this } }
export class ValueComponent<T> extends BaseComponent {
  registerOptionListener(map: Record<string, (v?: T) => T>, key: string) { this.onChange?.((v: any) => map[key]?.(v)); return this }
  getValue(): T { return undefined as T }
  setValue(_v: T) { return this }
  onChange?(fn: (v: T) => any): this
}
export class AbstractTextComponent<E extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
  inputEl: E
  constructor(inputEl: E) { super(); this.inputEl = inputEl }
  setDisabled(d: boolean) { super.setDisabled(d); this.inputEl.disabled = d; return this }
  getValue() { return this.inputEl.value }
  setValue(v: string) { this.inputEl.value = v ?? ""; return this }
  setPlaceholder(p: string) { this.inputEl.placeholder = p; return this }
  onChanged() {}
  onChange(fn: (v: string) => any) { this.inputEl.addEventListener("input", () => fn(this.inputEl.value)); return this }
}
export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(el: HTMLElement) { super(el.createEl("input", { attr: { type: "text", spellcheck: "false" } }) as HTMLInputElement) }
}
export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  clearButtonEl: HTMLElement
  containerEl: HTMLElement
  constructor(el: HTMLElement) {
    const c = el.createDiv({ cls: "search-input-container" })
    super(c.createEl("input", { attr: { type: "search", enterkeyhint: "search", spellcheck: "false" } }) as HTMLInputElement)
    this.containerEl = c
    this.clearButtonEl = c.createDiv({ cls: "search-input-clear-button" })
    this.clearButtonEl.addEventListener("click", () => { this.setValue(""); this.inputEl.dispatchEvent(new Event("input")) })
  }
  setClass(c: string) { this.containerEl.addClass(c); return this }
}
export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(el: HTMLElement) { super(el.createEl("textarea") as HTMLTextAreaElement) }
}
export class MomentFormatComponent extends TextComponent {
  sampleEl?: HTMLElement
  defaultFormat = ""
  setDefaultFormat(f: string) { this.defaultFormat = f; this.setPlaceholder(f); this.updateSample(); return this }
  setSampleEl(el: HTMLElement) { this.sampleEl = el; this.updateSample(); return this }
  setValue(v: string) { super.setValue(v); this.updateSample(); return this }
  onChanged() { this.updateSample() }
  updateSample() { if (this.sampleEl) this.sampleEl.setText((window as any).moment().format(this.getValue() || this.defaultFormat)) }
  onChange(fn: (v: string) => any) { this.inputEl.addEventListener("input", () => { this.updateSample(); fn(this.inputEl.value) }); return this }
}
export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement
  on = false
  fns: ((v: boolean) => any)[] = []
  constructor(el: HTMLElement) {
    super()
    this.toggleEl = el.createDiv({ cls: "checkbox-container", attr: { role: "switch", tabindex: "0" } })
    this.toggleEl.createEl("input", { attr: { type: "checkbox", tabindex: "-1" } })
    this.toggleEl.addEventListener("click", () => { if (!this.disabled) { this.setValue(!this.on); for (const f of this.fns) f(this.on) } })
  }
  getValue() { return this.on }
  setValue(v: boolean) { this.on = !!v; this.toggleEl.toggleClass("is-enabled", this.on); this.toggleEl.setAttr("aria-checked", String(this.on)); return this }
  setTooltip(t: string) { setTooltip(this.toggleEl, t); return this }
  onClick() { this.toggleEl.click() }
  onChange(fn: (v: boolean) => any) { this.fns.push(fn); return this }
}
export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement
  constructor(el: HTMLElement) { super(); this.selectEl = el.createEl("select", { cls: "dropdown" }) as HTMLSelectElement }
  setDisabled(d: boolean) { super.setDisabled(d); this.selectEl.disabled = d; return this }
  addOption(v: string, label: string) { this.selectEl.createEl("option", { value: v, text: label }); return this }
  addOptions(o: Record<string, string>) { for (const [v, l] of Object.entries(o)) this.addOption(v, l); return this }
  getValue() { return this.selectEl.value }
  setValue(v: string) { this.selectEl.value = v; return this }
  onChange(fn: (v: string) => any) { this.selectEl.addEventListener("change", () => fn(this.selectEl.value)); return this }
}
export class SliderComponent extends ValueComponent<number> {
  sliderEl: HTMLInputElement
  constructor(el: HTMLElement) { super(); this.sliderEl = el.createEl("input", { cls: "slider", attr: { type: "range" } }) as HTMLInputElement }
  setLimits(min: number | null, max: number | null, step: number | "any") { if (min !== null) this.sliderEl.min = String(min); if (max !== null) this.sliderEl.max = String(max); this.sliderEl.step = String(step); return this }
  setDynamicTooltip() { return this }
  showTooltip() {}
  setInstant() { return this }
  getValue() { return Number(this.sliderEl.value) }
  setValue(v: number) { this.sliderEl.value = String(v); return this }
  getValuePretty() { return this.sliderEl.value }
  onChange(fn: (v: number) => any) { this.sliderEl.addEventListener("input", () => fn(this.getValue())); return this }
}
export class ColorComponent extends ValueComponent<string> {
  colorPickerEl: HTMLInputElement
  constructor(el: HTMLElement) { super(); this.colorPickerEl = el.createEl("input", { attr: { type: "color" } }) as HTMLInputElement }
  getValue() { return this.colorPickerEl.value }
  setValue(v: string) { this.colorPickerEl.value = v; return this }
  getValueRgb() { const h = this.getValue(); return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) } }
  getValueHsl() { return { h: 0, s: 0, l: 0 } }
  setValueRgb(c: { r: number; g: number; b: number }) { return this.setValue(`#${[c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, "0")).join("")}`) }
  setValueHsl() { return this }
  onChange(fn: (v: string) => any) { this.colorPickerEl.addEventListener("input", () => fn(this.getValue())); return this }
}
export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement
  constructor(el: HTMLElement) { super(); this.buttonEl = el.createEl("button") as HTMLButtonElement }
  setDisabled(d: boolean) { super.setDisabled(d); this.buttonEl.disabled = d; return this }
  setCta() { this.buttonEl.addClass("mod-cta"); return this }
  removeCta() { this.buttonEl.removeClass("mod-cta"); return this }
  setWarning() { this.buttonEl.addClass("mod-warning"); return this }
  setDestructive() { this.buttonEl.addClass("mod-destructive"); return this }
  removeDestructive() { this.buttonEl.removeClass("mod-destructive"); return this }
  setTooltip(t: string) { setTooltip(this.buttonEl, t); return this }
  setButtonText(t: string) { this.buttonEl.setText(t); return this }
  setIcon(i: string) { setIcon(this.buttonEl, i); return this }
  setClass(c: string) { this.buttonEl.addClass(c); return this }
  onClick(fn: (e: MouseEvent) => any) { this.buttonEl.addEventListener("click", fn); return this }
}
export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement
  constructor(el: HTMLElement) { super(); this.extraSettingsEl = el.createDiv({ cls: "clickable-icon extra-setting-button" }) }
  setTooltip(t: string) { setTooltip(this.extraSettingsEl, t); return this }
  setIcon(i: string) { setIcon(this.extraSettingsEl, i); return this }
  onClick(fn: () => any) { this.extraSettingsEl.addEventListener("click", () => fn()); return this }
}
export class ProgressBarComponent extends ValueComponent<number> {
  progressBar: HTMLElement
  v = 0
  constructor(el: HTMLElement) { super(); this.progressBar = el.createDiv({ cls: "setting-progress-bar" }) }
  getValue() { return this.v }
  setValue(v: number) { this.v = v; this.progressBar.style.setProperty("--progress", `${v}%`); return this }
}

export class Setting {
  settingEl: HTMLElement
  infoEl: HTMLElement
  nameEl: HTMLElement
  descEl: HTMLElement
  controlEl: HTMLElement
  components: BaseComponent[] = []
  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" })
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" })
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" })
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" })
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" })
  }
  setName(n: string | DocumentFragment) { this.nameEl.setText(n); return this }
  setDesc(d: string | DocumentFragment) { this.descEl.setText(d); return this }
  setClass(c: string) { this.settingEl.addClass(c); return this }
  setTooltip(t: string) { setTooltip(this.nameEl, t); return this }
  setHeading() { this.settingEl.addClass("setting-item-heading"); return this }
  setDisabled(d: boolean) { this.settingEl.toggleClass("is-disabled", d); for (const c of this.components) c.setDisabled(d); return this }
  private add<C extends BaseComponent>(c: C, cb?: (c: C) => any) { this.components.push(c); cb?.(c); return this }
  addButton(cb: (c: ButtonComponent) => any) { return this.add(new ButtonComponent(this.controlEl), cb) }
  addExtraButton(cb: (c: ExtraButtonComponent) => any) { return this.add(new ExtraButtonComponent(this.controlEl), cb) }
  addToggle(cb: (c: ToggleComponent) => any) { return this.add(new ToggleComponent(this.controlEl), cb) }
  addText(cb: (c: TextComponent) => any) { return this.add(new TextComponent(this.controlEl), cb) }
  addSearch(cb: (c: SearchComponent) => any) { return this.add(new SearchComponent(this.controlEl), cb) }
  addTextArea(cb: (c: TextAreaComponent) => any) { return this.add(new TextAreaComponent(this.controlEl), cb) }
  addMomentFormat(cb: (c: MomentFormatComponent) => any) { return this.add(new MomentFormatComponent(this.controlEl), cb) }
  addDropdown(cb: (c: DropdownComponent) => any) { return this.add(new DropdownComponent(this.controlEl), cb) }
  addColorPicker(cb: (c: ColorComponent) => any) { return this.add(new ColorComponent(this.controlEl), cb) }
  addProgressBar(cb: (c: ProgressBarComponent) => any) { return this.add(new ProgressBarComponent(this.controlEl), cb) }
  addSlider(cb: (c: SliderComponent) => any) { return this.add(new SliderComponent(this.controlEl), cb) }
  addComponent<C extends BaseComponent>(make: (el: HTMLElement) => C) { return this.add(make(this.controlEl)) }
  then(cb: (s: this) => any) { cb(this); return this }
  clear() { this.controlEl.empty(); this.components = []; return this }
  errorEl: HTMLElement | null = null
  setErrorMessage(m: string | null) {
    if (!m) { this.errorEl?.remove(); this.errorEl = null; return this }
    ;(this.errorEl ??= this.infoEl.createDiv({ cls: "setting-item-error" })).setText(m)
    return this
  }
  addDisplayValue(cb: (c: DisplayValueComponent) => any) { cb(new DisplayValueComponent(this.controlEl)); return this }
  // (Obsidian 1.13's rows that act: the whole row is the button; a navigable one opens a page, with a chevron)
  setAction(run: () => any) {
    this.settingEl.addClass("mod-clickable")
    this.settingEl.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button, input, select, textarea, a")) run() })
    return this
  }
  setNavigable(open: () => any) {
    this.settingEl.addClass("mod-navigable")
    this.controlEl.createDiv({ cls: "setting-item-chevron" }, (el) => setIcon(el, "chevron-right"))
    return this.setAction(open)
  }
  iconEl: HTMLElement | null = null
  setIcon(icon: string | null) {
    if (!icon) { this.iconEl?.remove(); this.iconEl = null; return this }
    this.iconEl ??= createEl("div", { cls: "setting-item-icon" })
    this.settingEl.prepend(this.iconEl)
    setIcon(this.iconEl, icon)
    return this
  }
}

/** Obsidian 1.11's group of rows under a heading. */
export class SettingGroup {
  groupEl: HTMLElement
  listEl: HTMLElement
  private headEl: HTMLElement | null = null
  constructor(containerEl: HTMLElement) { this.groupEl = containerEl.createDiv({ cls: "setting-group" }); this.listEl = this.groupEl.createDiv({ cls: "setting-items" }) }
  /** Its heading row (made when first asked): a name, and controls at its end (Obsidian's controlEl). */
  private head() {
    if (!this.headEl) {
      this.headEl = createEl("div", { cls: "setting-item setting-item-heading" })
      this.headEl.createDiv({ cls: "setting-item-info" }).createDiv({ cls: "setting-item-name" })
      this.headEl.createDiv({ cls: "setting-item-control" })
      this.groupEl.prepend(this.headEl)
    }
    return this.headEl
  }
  get controlEl() { return this.head().querySelector<HTMLElement>(".setting-item-control")! }
  setHeading(t: string | DocumentFragment) { this.head().querySelector<HTMLElement>(".setting-item-name")!.setText(t); return this }
  addSetting(cb: (s: Setting) => any) { cb(new Setting(this.listEl)); return this }
  addClass(...c: string[]) { this.groupEl.addClass(...c); return this }
  /** A search field at the group's start, over its rows (filtering them is the plugin's). */
  addSearch(cb: (c: SearchComponent) => any) {
    const el = createEl("div", { cls: "setting-group-search" })
    this.listEl.before(el)
    cb(new SearchComponent(el))
    return this
  }
  addExtraButton(cb: (c: ExtraButtonComponent) => any) { cb(new ExtraButtonComponent(this.controlEl)); return this }
}

// --- menus: the app's own, built from the items a plugin added

export class MenuItem {
  dom: HTMLElement
  titleEl: HTMLElement
  iconEl: HTMLElement
  callback?: (e: any) => any
  section = ""
  icon: string | null = null
  checked: boolean | null = null
  disabled = false
  warning = false
  label = false
  menu: Menu
  submenu?: Menu
  constructor(menu: Menu) {
    this.menu = menu
    this.dom = createEl("div", { cls: "menu-item" })
    this.iconEl = this.dom.createDiv({ cls: "menu-item-icon" })
    this.titleEl = this.dom.createDiv({ cls: "menu-item-title" })
    this.dom.addEventListener("click", (e) => { if (this.disabled) return; this.menu.hide(); this.callback?.(e) })
  }
  setTitle(t: string | DocumentFragment) { this.titleEl.setText(t); return this }
  setIcon(i: string | null) { this.icon = i; if (i) setIcon(this.iconEl, i); return this }
  setChecked(c: boolean | null) { this.checked = c; this.dom.toggleClass("mod-checked", !!c); return this }
  setDisabled(d: boolean) { this.disabled = d; this.dom.toggleClass("is-disabled", d); return this }
  setWarning(w: boolean) { this.warning = w; this.dom.toggleClass("mod-warning", w); return this }
  setIsLabel(l: boolean) { this.label = l; this.dom.toggleClass("is-label", l); return this }
  setSection(s: string) { this.section = s; return this }
  setActive(a: boolean) { this.dom.toggleClass("selected", a); return this }
  setSubmenu() { this.submenu = new Menu(); this.submenu.parent = this.menu; return this.submenu }
  onClick(fn: (e: any) => any) { this.callback = fn; return this }
}

/** Obsidian's menu sections in its order; others after, in the order they came. */
const SECTIONS = ["title", "open", "action-primary", "action", "info", "view", "system", "", "danger"]

export class Menu extends Component {
  dom: HTMLElement
  items: (MenuItem | "sep")[] = []
  parent: Menu | null = null
  private hidden: (() => any)[] = []
  private shown = false
  constructor() { super(); this.dom = createEl("div", { cls: "menu" }) }
  setNoIcon() { return this }
  setUseNativeMenu() { return this }
  addItem(cb: (i: MenuItem) => any) { const i = new MenuItem(this); this.items.push(i); cb(i); return this }
  addSeparator() { this.items.push("sep"); return this }
  showAtMouseEvent(e: MouseEvent) { return this.showAtPosition({ x: e.clientX, y: e.clientY }) }
  /** The items as the app's menu rows: sections in order with a line between, submenus as its submenus. */
  rows(): AppMenuItem[] {
    const order = (s: string) => { const i = SECTIONS.indexOf(s.split(".")[0]); return i < 0 ? SECTIONS.length - 1.5 : i }
    const groups: MenuItem[][] = [[]]
    for (const i of this.items) { if (i === "sep") groups.push([]); else groups[groups.length - 1].push(i) }
    const out: AppMenuItem[] = []
    for (const g of groups) {
      const sorted = g.map((it, n) => [it, n] as const).sort((a, b) => order(a[0].section) - order(b[0].section) || a[1] - b[1]).map(([it]) => it)
      let last: string | null = null
      for (const it of sorted) {
        const sep = out.length > 0 && (last === null || last !== it.section)
        last = it.section
        const label = it.titleEl.textContent ?? ""
        const icon = it.icon ? namedIcon(nameOf(it.icon)) ?? undefined : undefined
        const run = () => { this.hide(); it.callback?.(new MouseEvent("click")) }
        out.push({ label, icon, run, sep, disabled: it.disabled || undefined, danger: it.warning || undefined, checked: it.checked ?? undefined,
          caption: it.label || undefined, items: it.submenu ? it.submenu.rows() : undefined })
      }
    }
    return out
  }
  showAtPosition(p: { x: number; y: number; left?: boolean; width?: number }) {
    const rows = this.rows()
    if (!rows.length) return this
    this.shown = true
    this.load()
    openMenu({ x: p.x, y: p.y }, rows)
    // (the app's menu says nothing when it closes: watched until it's gone)
    const watch = () => { if (!this.shown) return; if (menuShowing()) requestAnimationFrame(watch); else this.hide() }
    requestAnimationFrame(watch)
    return this
  }
  hide() {
    if (!this.shown) return this
    this.shown = false
    for (const f of this.hidden.splice(0)) { try { f() } catch (e) { console.error(e) } }
    this.unload()
    return this
  }
  close() { this.hide() }
  onHide(fn: () => any) { this.hidden.push(fn) }
  static forEvent(e: MouseEvent) { const m = new Menu(); queueMicrotask(() => m.showAtMouseEvent(e)); return m }
}
export class MenuSeparator {}

/** A plugin's own popover over an element it hovers (a calendar day's notes): shown after a moment, gone once the
 *  pointer leaves both. */
export class HoverPopover extends Component {
  hoverEl: HTMLElement
  targetEl: HTMLElement | null
  state = 0
  parent: any
  private timers: ReturnType<typeof setTimeout>[] = []
  constructor(parent: any, targetEl: HTMLElement | null, waitTime = 300) {
    super()
    this.parent = parent
    this.targetEl = targetEl
    this.hoverEl = createEl("div", { cls: "popover hover-popover" })
    if (parent) { parent.hoverPopover?.hide?.(); parent.hoverPopover = this }
    this.timers.push(setTimeout(() => this.show(), waitTime))
    const leave = () => this.timers.push(setTimeout(() => { if (!this.targetEl?.matches(":hover") && !this.hoverEl.matches(":hover")) this.hide() }, 300))
    targetEl?.addEventListener("mouseleave", leave)
    this.hoverEl.addEventListener("mouseleave", leave)
    this.register(() => targetEl?.removeEventListener("mouseleave", leave))
  }
  private show() {
    if (this.state === 3 || (this.targetEl && !this.targetEl.isConnected)) return
    document.body.append(this.hoverEl)
    const r = this.targetEl?.getBoundingClientRect() ?? new DOMRect(innerWidth / 2, innerHeight / 3, 0, 0)
    const w = Math.min(460, innerWidth - 16), below = r.bottom + 400 < innerHeight
    Object.assign(this.hoverEl.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`, ...(below ? { top: `${r.bottom + 6}px` } : { bottom: `${innerHeight - r.top + 6}px` }) })
    this.state = 2
    this.load()
    this.onShow()
  }
  onShow(): any {}
  onHide(): any {}
  hide() {
    if (this.state === 3) return
    this.state = 3
    for (const t of this.timers.splice(0)) clearTimeout(t)
    this.hoverEl.detach()
    if (this.parent?.hoverPopover === this) this.parent.hoverPopover = null
    this.unload()
    this.onHide()
  }
}

/** Obsidian's `hover-link` event: the app's page preview, for the element and link a plugin names. */
export function hoverLink(ev: { event?: MouseEvent; targetEl?: HTMLElement; linktext?: string; sourcePath?: string }) {
  const el = ev.targetEl ?? (ev.event?.target as HTMLElement | undefined)
  if (!el || !ev.linktext || el.dataset.wiki) return
  el.dataset.preview = ev.linktext
  if (ev.sourcePath) el.dataset.previewPath = ev.sourcePath
  const e = ev.event
  el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: e?.clientX ?? 0, clientY: e?.clientY ?? 0, metaKey: e?.metaKey, ctrlKey: e?.ctrlKey }))
}

export class WorkspaceEvents extends Events {}

/** Obsidian 1.13's page of settings drawn by its own code, opened from a tab. */
export class SettingPage {
  rootEl: HTMLElement
  titlebarEl: HTMLElement
  containerEl: HTMLElement
  title = ""
  constructor() {
    this.rootEl = createEl("div", { cls: "setting-page-root" })
    this.titlebarEl = this.rootEl.createDiv({ cls: "setting-page-titlebar" })
    this.containerEl = this.rootEl.createDiv({ cls: "vertical-tab-content" })
  }
  display(): any {}
  hide(): any {}
}

export class ConfirmationButton extends ButtonComponent {
  setInitialFocus() { queueMicrotask(() => this.buttonEl.focus()); return this }
  setSecondary() { this.buttonEl.addClass("mod-secondary"); return this }
  setCancel() { this.buttonEl.addClass("mod-cancel"); return this }
}
export class ConfirmationModal extends Modal {
  buttonContainerEl: HTMLElement
  constructor(app: any) { super(app); this.buttonContainerEl = this.modalEl.createDiv({ cls: "modal-button-container" }) }
  addClass(c: string) { this.modalEl.addClass(c); return this }
  addCheckbox(label: string, cb: (v: boolean) => any) {
    const l = this.buttonContainerEl.createEl("label", { cls: "mod-checkbox" })
    const i = l.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement
    l.appendText(label)
    i.addEventListener("change", () => cb(i.checked))
    return this
  }
  addButton(cb: (b: ConfirmationButton) => any) {
    const b = new ConfirmationButton(this.buttonContainerEl)
    cb(b)
    b.buttonEl.addEventListener("click", () => this.close())
    return this
  }
  addCancelButton(text = "Cancel") { return this.addButton((b) => b.setButtonText(text).setCancel()) }
}

/** Secrets plugins keep (API keys): on this device only, for now (the app keeps its own in the server's config). */
export class SecretStorage extends Events {
  setSecret(id: string, v: string) { localStorage.setItem(`obsidian-compat:secret:${id}`, v); this.trigger("change", id) }
  getSecret(id: string) { return localStorage.getItem(`obsidian-compat:secret:${id}`) }
  listSecrets() { return Object.keys(localStorage).filter((k) => k.startsWith("obsidian-compat:secret:")).map((k) => k.slice(23)) }
}
export class SecretComponent extends BaseComponent {
  inputEl: HTMLInputElement
  constructor(_app: any, el: HTMLElement) { super(); this.inputEl = el.createEl("input", { attr: { type: "password" } }) as HTMLInputElement }
  setValue(v: string) { this.inputEl.value = v; return this }
  onChange(fn: (v: string) => any) { this.inputEl.addEventListener("input", () => fn(this.inputEl.value)); return this }
}
