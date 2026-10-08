// Obsidian's Editor over the app's CodeMirror. Obsidian's editor holds the whole file; the app's live preview holds
// the body, so lines are shifted by the frontmatter's and reading or writing it goes to the file.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { EditorSelection, EditorState, StateField, type Extension, Compartment, StateEffect } from "@codemirror/state"
import { EditorView, ViewPlugin, keymap, drawSelection } from "@codemirror/view"
import { indentMore, indentLess, cursorLineUp, cursorLineDown, cursorCharLeft, cursorCharRight, cursorGroupLeft, cursorGroupRight, defaultKeymap, history, historyKeymap,
  cursorLineBoundaryBackward, cursorLineBoundaryForward, deleteCharBackward, deleteCharForward, insertNewlineAndIndent, undo, redo, selectAll, toggleComment, cursorDocStart, cursorDocEnd,
  moveLineUp, moveLineDown } from "@codemirror/commands"
import { foldAll, unfoldAll, toggleFold } from "@codemirror/language"
import { markdown, insertNewlineContinueMarkup } from "@codemirror/lang-markdown"
import { currentEditor, runCommandById, type OpenEditor, onTabLayoutChange } from "@vaultite"
import { Component } from "./core.ts"
import { PopoverSuggest } from "./ui.ts"
import * as ws from "./workspace.ts"

export type EditorPosition = { line: number; ch: number }

const COMMANDS: Record<string, (v: EditorView) => boolean> = {
  goUp: cursorLineUp, goDown: cursorLineDown, goLeft: cursorCharLeft, goRight: cursorCharRight, goWordLeft: cursorGroupLeft, goWordRight: cursorGroupRight,
  goStart: cursorLineBoundaryBackward, goEnd: cursorLineBoundaryForward, indentMore, indentLess, newlineAndIndent: insertNewlineAndIndent,
  deleteLine: (v) => { const l = v.state.doc.lineAt(v.state.selection.main.head); v.dispatch({ changes: { from: l.from, to: Math.min(l.to + 1, v.state.doc.length) } }); return true },
  undo, redo, selectAll, toggleComment, goDocStart: cursorDocStart, goDocEnd: cursorDocEnd, delCharBefore: deleteCharBackward, delCharAfter: deleteCharForward,
  swapLineUp: moveLineUp, swapLineDown: moveLineDown, toggleFold, foldAll, unfoldAll, newlineAndIndentContinueMarkdownList: insertNewlineContinueMarkup,
}

export class Editor {
  cm: EditorView
  open: OpenEditor
  // (the app's editor holds the whole file, frontmatter too: its positions are the file's)
  constructor(open: OpenEditor) {
    this.open = open
    this.cm = open.view
  }
  private get doc() { return this.cm.state.doc }
  refresh() {}
  getValue() { return this.doc.toString() }
  // Only what differs, so the cursor, scroll and undo history stay as they were.
  setValue(v: string) {
    const was = this.doc.toString()
    if (v === was) return
    let from = 0
    while (from < was.length && from < v.length && was[from] === v[from]) from++
    let end = 0
    while (end < was.length - from && end < v.length - from && was[was.length - 1 - end] === v[v.length - 1 - end]) end++
    this.cm.dispatch({ changes: { from, to: was.length - end, insert: v.slice(from, v.length - end) } })
  }
  getLine(n: number) {
    const i = n + 1
    return i >= 1 && i <= this.doc.lines ? this.doc.line(i).text : ""
  }
  setLine(n: number, text: string) { this.replaceRange(text, { line: n, ch: 0 }, { line: n, ch: this.getLine(n).length }) }
  lineCount() { return this.doc.lines }
  lastLine() { return this.lineCount() - 1 }
  posToOffset(p: EditorPosition) {
    const line = Math.max(1, Math.min(this.doc.lines, p.line + 1))
    const l = this.doc.line(line)
    return l.from + Math.max(0, Math.min(p.ch, l.length))
  }
  offsetToPos(o: number): EditorPosition {
    const at = Math.max(0, Math.min(this.doc.length, o))
    const l = this.doc.lineAt(at)
    return { line: l.number - 1, ch: at - l.from }
  }
  private at(p: EditorPosition) { return this.posToOffset(p) }
  getRange(a: EditorPosition, b: EditorPosition) { return this.getValue().slice(this.posToOffset(a), this.posToOffset(b)) }
  replaceRange(text: string, from: EditorPosition, to?: EditorPosition, origin?: string) {
    void origin
    this.cm.dispatch({ changes: { from: this.at(from), to: to ? this.at(to) : this.at(from), insert: text }, userEvent: "input" })
  }
  getCursor(which: "from" | "to" | "head" | "anchor" = "head") {
    const s = this.cm.state.selection.main
    const o = which === "from" ? s.from : which === "to" ? s.to : which === "anchor" ? s.anchor : s.head
    return this.offsetToPos(o)
  }
  setCursor(p: EditorPosition | number, ch?: number) {
    const pos = typeof p === "number" ? { line: p, ch: ch ?? 0 } : p
    this.cm.dispatch({ selection: { anchor: this.at(pos) }, scrollIntoView: true })
  }
  getSelection() { const s = this.cm.state.selection.main; return this.doc.sliceString(s.from, s.to) }
  replaceSelection(t: string) { this.cm.dispatch(this.cm.state.replaceSelection(t)) }
  somethingSelected() { return this.cm.state.selection.ranges.some((r) => !r.empty) }
  listSelections() { return this.cm.state.selection.ranges.map((r) => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) })) }
  setSelection(anchor: EditorPosition, head?: EditorPosition) { this.cm.dispatch({ selection: { anchor: this.at(anchor), head: this.at(head ?? anchor) } }) }
  setSelections(list: { anchor: EditorPosition; head?: EditorPosition }[], main = 0) {
    this.cm.dispatch({ selection: EditorSelection.create(list.map((r) => EditorSelection.range(this.at(r.anchor), this.at(r.head ?? r.anchor))), main) })
  }
  transaction(tx: { changes?: { from: EditorPosition; to?: EditorPosition; text: string }[]; selection?: { from: EditorPosition; to?: EditorPosition }; selections?: { from: EditorPosition; to?: EditorPosition }[]; replaceSelection?: string }) {
    const changes = (tx.changes ?? []).map((c) => ({ from: this.at(c.from), to: c.to ? this.at(c.to) : this.at(c.from), insert: c.text }))
    if (tx.replaceSelection !== undefined) { const s = this.cm.state.selection.main; changes.push({ from: s.from, to: s.to, insert: tx.replaceSelection }) }
    const sel = tx.selections ?? (tx.selection ? [tx.selection] : null)
    this.cm.dispatch({ changes, ...(sel ? { selection: EditorSelection.create(sel.map((r) => EditorSelection.range(this.at(r.from), this.at(r.to ?? r.from)))) } : {}), userEvent: "input" })
  }
  wordAt(p: EditorPosition) {
    const r = this.cm.state.wordAt(this.at(p))
    return r ? { from: this.offsetToPos(r.from), to: this.offsetToPos(r.to) } : null
  }
  processLines(read: (line: number, text: string) => any, write: (line: number, text: string, value: any) => any, ignoreEmpty = true) {
    const sel = this.listSelections(), changes: any[] = []
    for (const s of sel) {
      for (let l = Math.min(s.anchor.line, s.head.line); l <= Math.max(s.anchor.line, s.head.line); l++) {
        const t = this.getLine(l)
        if (ignoreEmpty && !t) continue
        const v = read(l, t), out = write(l, t, v)
        if (out) changes.push({ from: { line: l, ch: 0 }, to: { line: l, ch: t.length }, text: out.text ?? out })
      }
    }
    this.transaction({ changes })
  }
  exec(cmd: string) { COMMANDS[cmd]?.(this.cm) }
  newlineAndIndentContinueMarkdownList() { if (!insertNewlineContinueMarkup(this.cm)) insertNewlineAndIndent(this.cm) }
  newlineAndIndentOnly() { insertNewlineAndIndent(this.cm) }
  getDoc() { return this }
  get containerEl() { return this.cm.dom }
  get activeCM() { return this.cm }
  undo() { undo(this.cm) }
  redo() { redo(this.cm) }
  focus() { this.cm.focus() }
  blur() { this.cm.contentDOM.blur() }
  hasFocus() { return this.cm.hasFocus }
  getScrollInfo() { const s = this.cm.scrollDOM; return { top: s.scrollTop, left: s.scrollLeft, height: s.scrollHeight, width: s.scrollWidth, clientHeight: s.clientHeight, clientWidth: s.clientWidth } }
  scrollTo(x?: number | null, y?: number | null) { if (x !== null && x !== undefined) this.cm.scrollDOM.scrollLeft = x; if (y !== null && y !== undefined) this.cm.scrollDOM.scrollTop = y }
  scrollIntoView(r: { from: EditorPosition; to: EditorPosition }, center?: boolean) { this.cm.dispatch({ effects: EditorView.scrollIntoView(this.at(r.from), { y: center ? "center" : "nearest" }) }) }
  coordsAtPos(p: EditorPosition) { return this.cm.coordsAtPos(this.at(p)) }
  posAtCoords(x: number, y: number) { const o = this.cm.posAtCoords({ x, y }); return o === null ? null : this.offsetToPos(o) }
  /** The tag, link or address at a position, as Obsidian's editor finds what a click would follow. */
  getClickableTokenAt(p: EditorPosition): { type: "tag" | "internal-link" | "external-link"; text: string; start: EditorPosition; end: EditorPosition } | null {
    const line = this.getLine(p.line)
    const found = [
      ...[...line.matchAll(/\[\[([^\]|#^]+)[^\]]*\]\]/g)].map((m) => ["internal-link", m, m[1]] as const),
      ...[...line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => [/^[a-z][\w+.-]*:/i.test(m[1]) ? "external-link" : "internal-link", m, decodeURI(m[1])] as const),
      ...[...line.matchAll(/(?:^|[\s(])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)].map((m) => ["tag", m, m[1]] as const),
      ...[...line.matchAll(/https?:\/\/[^\s<>)\]]+/g)].map((m) => ["external-link", m, m[0]] as const),
    ]
    for (const [type, m, text] of found) {
      const from = (m.index ?? 0) + (type === "tag" ? m[0].length - m[1].length : 0), to = (m.index ?? 0) + m[0].length
      if (p.ch >= from && p.ch <= to) return { type, text, start: { line: p.line, ch: from }, end: { line: p.line, ch: to } }
    }
    return null
  }
  // Obsidian's own formatting (private, but toolbars call it): the app's editing commands, in this editor.
  private edit(id: string) { this.cm.focus(); return runCommandById(id) }
  toggleMarkdownFormatting(kind: string) { const id = FORMATS[kind]; return id ? this.edit(id) : false }
  toggleBlockquote() { return this.edit("editor:toggle-blockquote") }
  toggleBulletList() { return this.edit("editor:toggle-bullet-list") }
  toggleNumberList() { return this.edit("editor:toggle-numbered-list") }
  toggleCheckList() { return this.edit("editor:toggle-task-list") }
  setHeading(level: number) { return this.edit(`editor:set-heading-${Math.max(0, Math.min(6, level))}`) }
}
const FORMATS: Record<string, string> = { bold: "editor:toggle-bold", italic: "editor:toggle-italics", strikethrough: "editor:toggle-strikethrough",
  highlight: "editor:toggle-highlight", code: "editor:toggle-code", math: "editor:toggle-inline-math", comment: "editor:toggle-comment" }

/** The editor in front, as Obsidian's Editor (made again for each ask: the app's editors come and go). */
// (found again only when it may have changed: finding it measures the page, and plugins ask for the active leaf over and
// over; focus, the tabs, an editor coming or going, or the window's size change it)
let front: OpenEditor | null | undefined, hooked = false
const stale = () => { front = undefined }
export function editorInFront() {
  if (!hooked) {
    hooked = true
    for (const t of ["focusin", "focusout", "pointerdown"]) document.addEventListener(t, stale, true)
    addEventListener("resize", stale)
    onTabLayoutChange(stale)
  }
  if (front === undefined || (front && !front.view.dom.isConnected)) front = currentEditor()
  return front
}

export function activeEditor() {
  const o = editorInFront()
  if (!o || o.kind !== "markdown") return null
  return new Editor(o)
}

// --- plugins' CodeMirror extensions, in every note's editor; added and taken away while editors are open

const extensions: Extension[] = []
const views = new Set<EditorView>()
const slot = new Compartment()
let shown = () => {}
/** Told when an editor comes on screen (a note's tab draws its editor after the tab: the leaf in front may change). */
export const setEditorShown = (fn: () => void) => { shown = fn }
// (Obsidian loads a note into an open editor, so plugins' view plugins see a first update; here the note is there from
// the start, so they're given one: the selection set again, as it is)
const touch = (v: EditorView) => requestAnimationFrame(() => { if (views.has(v)) v.dispatch({ selection: v.state.selection }) })
const tracker = ViewPlugin.define((v) => {
  views.add(v)
  stale()
  setTimeout(() => shown(), 0)
  const info = v.state.field(editorInfoField, false)
  if (info) info.cm = v
  touch(v)
  return { destroy: () => { views.delete(v); stale() } }
})
// A note's editor sits in Obsidian's element (.markdown-source-view), where plugins put toolbars and aim their styles.
const noteDom = ViewPlugin.define((v) => {
  const el = v.dom.parentElement, cls = ["markdown-source-view", "cm-s-obsidian", "mod-cm6", "is-live-preview"]
  el?.classList.add(...cls)
  return { destroy: () => { if (!el?.querySelector(":scope > .cm-editor")) el?.classList.remove(...cls) } }
})
// Obsidian's editor-paste and editor-drop: a plugin that takes one prevents its default, and the app's own handling is skipped.
const told = (type: "editor-paste" | "editor-drop") => (e: Event, v: EditorView) => {
  const info = infoOf(v), ws = info.app?.workspace
  if (!ws || !info.editor) return false
  ws.trigger(type, e, info.editor, ws.markdownLeaf?.()?.view ?? null)
  return e.defaultPrevented
}
const pasteDrop = EditorView.domEventHandlers({ paste: told("editor-paste"), drop: told("editor-drop") })
const changes = EditorView.updateListener.of((u) => {
  const info = infoOf(u.view), ws = info.app?.workspace
  if (u.docChanged && ws && info.editor) ws.trigger("editor-change", info.editor, ws.markdownLeaf?.()?.view ?? null)
})
// A right-click puts the cursor where it is, unless inside the selection, as Obsidian's editor does: plugins' editor-menu
// items read what's under the cursor (getClickableTokenAt(getCursor())).
const rightClick = ViewPlugin.define((view) => {
  // (capture phase: before any menu is drawn, a finger's hold on a phone too)
  const at = (e: MouseEvent) => {
    const p = view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (p === null || view.state.selection.ranges.some((r) => !r.empty && r.from <= p && p <= r.to)) return
    view.dispatch({ selection: { anchor: p } })
  }
  view.dom.addEventListener("contextmenu", at, true)
  return { destroy: () => view.dom.removeEventListener("contextmenu", at, true) }
})
// (an array a plugin registered may change in place: workspace.updateOptions() reads them all again)
const flat = (): Extension[] => extensions.map((e) => (Array.isArray(e) ? [...e] : e))
// (`path`: the note the editor is for, known before its view exists)
export const editorExtension = (path?: string, note = false) => [editorInfoField.init(() => Object.assign(new EditorInfo(), { path })), editorEditorField,
  editorLivePreviewField, tracker, ...(note ? [noteDom, pasteDrop, changes, rightClick] : []), slot.of(flat())]
export function reconfigureEditors() { for (const v of views) { v.dispatch({ effects: slot.reconfigure(flat()) }); touch(v) } }
export function addEditorExtension(ext: Extension) {
  extensions.push(ext)
  reconfigureEditors()
  return () => {
    const i = extensions.indexOf(ext); if (i >= 0) extensions.splice(i, 1)
    reconfigureEditors()
  }
}
export const editorViews = () => [...views]

/** Obsidian's state fields: what an editor belongs to (its app, file and Editor: Linter, Dataview and Tasks read it from
 *  the state), and whether it's live preview. `info.cm` is set once its view exists. */
export let infoOf: (cm: EditorView | null, path?: string) => { app: any; file: any; editor: Editor | null } = () => ({ app: null, file: null, editor: null })
export const setInfoOf = (fn: typeof infoOf) => { infoOf = fn }
class EditorInfo {
  cm: EditorView | null = null
  path: string | undefined
  /** An editor that isn't a note's tab (an inline one) says whose it is itself. */
  own: { app: any; file: any; editor: Editor | null } | null = null
  get app() { return this.own?.app ?? infoOf(this.cm, this.path).app }
  get file() { return this.own ? this.own.file : infoOf(this.cm, this.path).file }
  get editor() { return this.own ? this.own.editor : this.cm ? infoOf(this.cm, this.path).editor : null }
  get hoverPopover() { return null }
}
export const editorInfoField = StateField.define<EditorInfo>({ create: () => new EditorInfo(), update: (v) => v })
/** The editor's EditorView, as Obsidian's field holds it: a stand-in until the view exists (an extension's create reads it). */
const viewOf = (info: EditorInfo | undefined): EditorView => new Proxy({} as EditorView, {
  get(_t, k) {
    const v = info?.cm as any
    if (v) { const x = v[k]; return typeof x === "function" ? x.bind(v) : x }
    return k === "defaultCharacterWidth" ? 7 : k === "defaultLineHeight" ? 20 : undefined
  },
})
export const editorEditorField = StateField.define<EditorView>({ create: (s) => viewOf(s.field(editorInfoField, false)), update: (v) => v })
export const editorLivePreviewField = StateField.define<boolean>({ create: () => true, update: (v) => v })
export const editorViewField = editorInfoField

// --- EditorSuggest: suggestions as you type (Natural Language Dates' @today), in a list under the cursor

export class EditorSuggest<T> extends PopoverSuggest<T> {
  context: any = null
  limit = 100
  instructionsEl: HTMLElement
  constructor(app: any) {
    super(app)
    this.instructionsEl = this.suggestEl.createDiv({ cls: "prompt-instructions" })
  }
  setInstructions(list: { command: string; purpose: string }[]) {
    this.instructionsEl.empty()
    for (const i of list) { const d = this.instructionsEl.createDiv({ cls: "prompt-instruction" }); d.createSpan({ cls: "prompt-instruction-command", text: i.command }); d.createSpan({ text: i.purpose }) }
  }
  onTrigger(_c: EditorPosition, _e: Editor, _f: any): any { return null }
  getSuggestions(_ctx: any): T[] | Promise<T[]> { return [] }
  close() { this.context = null; super.close() }
  /** Show these, under the cursor of the context's editor (Obsidian's own, which plugins call too). */
  showSuggestions(items: T[]) {
    const ed: Editor | undefined = this.context?.editor
    if (!items.length || !ed) return this.close()
    this.chooser.set(items.slice(0, this.limit))
    const c = ed.cm.coordsAtPos(ed.cm.state.selection.main.head)
    if (c) Object.assign(this.suggestEl.style, { left: `${c.left}px`, top: `${c.bottom + 4}px` })
    this.open()
  }
  async show(ctx: any) {
    this.context = ctx
    const got = await this.getSuggestions(ctx)
    if (this.context === ctx) this.showSuggestions(got ?? [])
  }
  // (what the prototype's callers used)
  get items() { return this.chooser.items }
  get selected() { return this.chooser.selected }
  select(i: number) { this.chooser.select(i) }
  choose(e: any) { const it = this.chooser.items[this.chooser.selected]; if (it !== undefined) { this.selectSuggestion(it, e); this.close() } }
}

/** The suggesters registered, asked after each change in the editor in front. */
export function suggestExtension(list: EditorSuggest<any>[], editorOf: (v: EditorView) => Editor | null, fileOf: (v: EditorView) => any) {
  const open = () => list.find((s) => s.isOpen)
  return [
    EditorView.updateListener.of((u) => {
      if (!u.docChanged && !u.selectionSet) return
      if (!u.docChanged) { const s = open(); if (s) s.close(); return }
      const ed = editorOf(u.view)
      if (!ed) return
      for (const s of list) {
        let ctx: any = null
        try { ctx = s.onTrigger(ed.getCursor(), ed, fileOf(u.view)) } catch (e) { console.error(e) }
        if (ctx) { void s.show({ ...ctx, editor: ed, file: fileOf(u.view) }); for (const o of list) if (o !== s) o.close(); return }
        s.close()
      }
    }),
  ]
}
export { StateEffect }

// --- inline editors: Obsidian's own Markdown editor class, which plugins subclass for editors of their own (Kanban's
// cards reach it through a note embed's editMode), and the note embed itself

export class InlineMarkdownEditor extends Component {
  app: any; containerEl: HTMLElement; owner: any; editorEl: HTMLElement; cm: EditorView; editor: Editor
  private info = new EditorInfo()
  private local = new Compartment()
  constructor(app: any, containerEl: HTMLElement, owner: any) {
    super()
    this.app = app; this.containerEl = containerEl; this.owner = owner
    this.editorEl = containerEl.createDiv({ cls: "markdown-source-view cm-s-obsidian mod-cm6 is-live-preview is-readable-line-width" })
    this.cm = new EditorView({ parent: this.editorEl, state: EditorState.create({ doc: "", extensions: this.extensions() }) })
    this.editor = new Editor({ view: this.cm, kind: "markdown" } as OpenEditor)
    this.info.cm = this.cm
    this.info.own = { app, get file() { return owner?.file ?? null }, editor: this.editor }
    // (a subclass's buildLocalExtensions reads what its constructor sets after super(): asked once that's done)
    queueMicrotask(() => {
      try { this.cm.dispatch({ effects: this.local.reconfigure(this.buildLocalExtensions()) }) } catch (e) { console.error(e) }
    })
  }
  private extensions(): Extension[] {
    return [editorInfoField.init(() => this.info), editorEditorField, editorLivePreviewField, tracker, slot.of(flat()), this.local.of([]),
      EditorView.updateListener.of((u) => this.onUpdate(u, u.docChanged))]
  }
  buildLocalExtensions(): Extension[] { return [markdown(), history(), drawSelection(), EditorView.lineWrapping, keymap.of([...defaultKeymap, ...historyKeymap])] }
  onUpdate(_u: unknown, _changed: boolean) {}
  get() { return this.cm.state.doc.toString() }
  set(text: string, clear = false) {
    this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: text }, ...(clear ? { selection: { anchor: 0 } } : {}) })
  }
  focus() { this.cm.focus() }
  getSelection() { return this.editor.getSelection() }
  destroy() { this.cm.destroy(); this.editorEl.remove() }
  onunload() { this.destroy() }
}
class EmbedEditMode extends InlineMarkdownEditor {}

/** A note embedded somewhere (![[note]]): its text drawn, or an editor once `showEditor` (embedRegistry's "md"). */
export class MarkdownEmbed extends Component {
  app: any; containerEl: HTMLElement; file: any; subpath: string; editable = false; editMode: EmbedEditMode | null = null
  previewEl: HTMLElement; text = ""
  constructor(ctx: { app?: any; containerEl: HTMLElement; state?: unknown }, file: any, subpath = "") {
    super()
    this.app = ctx.app ?? (window as any).app; this.containerEl = ctx.containerEl; this.file = file; this.subpath = subpath
    this.previewEl = this.containerEl.createDiv({ cls: "markdown-preview-view markdown-rendered" })
  }
  onload() { void this.loadFile() }
  async loadFile() {
    if (!this.file) return
    this.text = await this.app.vault.cachedRead(this.file)
    this.previewEl.empty()
    await ws.MarkdownRenderer.render(this.app, this.text, this.previewEl, this.file.path, this)
  }
  showEditor() {
    if (!this.editMode) { this.editMode = new EmbedEditMode(this.app, this.containerEl, this); this.addChild(this.editMode); this.editMode.set(this.text) }
    this.previewEl.style.display = "none"
  }
  showPreview() { if (this.editMode) { this.removeChild(this.editMode); this.editMode = null } this.previewEl.style.display = "" }
  get editor() { return this.editMode?.editor ?? null }
  /** Its text (Obsidian's embed is editable in place: `set` puts text in, shown in its editor once there's one). */
  get() { return this.editMode?.get() ?? this.text }
  set(text: string, clear = false) { this.text = text; this.editMode?.set(text, clear) }
  onunload() { this.previewEl.remove() }
}
