// The `obsidian` module plugins import: its classes (callable as ES5 bases too) and functions, over the runtime's.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { post } from "@vaultite"
import { parse as parseYaml, stringify as yamlStringify } from "yaml"
import TurndownService from "turndown"
import moment from "../lib/moment.js"
import { Component, es5, Events, fromB64 } from "./core.ts"
import { App } from "./app.ts"
import { Plugin } from "./host.ts"
import { API_VERSION, Platform } from "./state.ts"
import * as editor from "./editor.ts"
import * as ui from "./ui.ts"
import * as values from "./values.ts"
import * as vault from "./vault.ts"
import * as ws from "./workspace.ts"

const newer = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false }

/** Obsidian's debounce: called again while waiting keeps the first timer, or restarts it with `resetTimer`. */
export function debounce<A extends any[]>(fn: (...a: A) => any, wait = 0, resetTimer = false) {
  let t: ReturnType<typeof setTimeout> | null = null, last: A | null = null, self: any
  const run = () => { t = null; const a = last!; last = null; return fn.apply(self, a) }
  const d = function (this: any, ...a: A) { self = this; last = a; if (t && !resetTimer) return d; if (t) clearTimeout(t); t = setTimeout(run, wait); return d }
  d.cancel = () => { if (t) clearTimeout(t); t = null; return d }
  d.run = () => { if (t) { clearTimeout(t); return run() } }
  return d
}

export const bufToB64 = (b: ArrayBuffer | ArrayBufferView) => {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  let s = ""
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
export const b64ToBuf = (s: string) => fromB64(s).buffer

type RequestParam = { url: string; method?: string; contentType?: string; body?: string | ArrayBuffer; headers?: Record<string, string>; throw?: boolean }
/** requestUrl: the server fetches, so no CORS. Its promise also has .json, .text and .arrayBuffer, as Obsidian's does. */
export function requestUrl(o: string | RequestParam) {
  const r = typeof o === "string" ? { url: o } : o
  // (its caller's frames, so a failure nobody catches is said under the plugin that asked)
  const site = new Error().stack?.split("\n").slice(1).join("\n") ?? ""
  const p = (async () => {
    const headers: Record<string, string> = { ...(r.headers ?? {}) }
    if (r.contentType) headers["Content-Type"] = r.contentType
    const bin = r.body !== undefined && typeof r.body !== "string"
    const body = r.body === undefined ? undefined : bin ? bufToB64(r.body as ArrayBuffer) : r.body
    // (a failure made here, so it's known as the plugin's: as Obsidian's, a network error rejects)
    const res = await post<{ status: number; headers: Record<string, string>; body: string }>("plugin-compat/request", { url: r.url, method: r.method ?? "GET", headers, body, base64: bin })
      .catch((e: Error) => { throw new Error(`${r.url}: ${e.message}`) })
    const buf = b64ToBuf(res.body), text = new TextDecoder().decode(buf)
    const out = { status: res.status, headers: res.headers, arrayBuffer: buf, text, get json() { return JSON.parse(text) } }
    if (res.status >= 400 && r.throw !== false) {
      const e = Object.assign(new Error(`Request failed, status ${res.status}`), out)
      e.stack = `${e.stack}\n${site}`
      throw e
    }
    return out
  })()
  return Object.assign(p, { get json() { return p.then((x) => x.json) }, get text() { return p.then((x) => x.text) }, get arrayBuffer() { return p.then((x) => x.arrayBuffer) } })
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*", hr: "---" })
export const parseLinktext = (t: string) => { const i = t.search(/[#^]/); return i < 0 ? { path: t, subpath: "" } : { path: t.slice(0, i), subpath: t.slice(i) } }

/** Markdown HTML without what runs: scripts, frames, event handlers, javascript: links. */
export function sanitizeHTMLToDom(html: string) {
  const t = document.createElement("template")
  t.innerHTML = html
  t.content.querySelectorAll("script, iframe, object, embed, frame, frameset, base, meta, link").forEach((e) => e.remove())
  t.content.querySelectorAll("*").forEach((e) => {
    for (const a of [...e.attributes]) if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) e.removeAttribute(a.name)
  })
  return t.content
}

/** A heading path ("#A#B") or block ("#^id") in a note's metadata, as Obsidian resolves it. */
export function resolveSubpath(cache: any, subpath: string) {
  if (!cache) return null
  const parts = subpath.replace(/^#/, "").split("#").filter(Boolean)
  if (!parts.length) return null
  if (parts[0].startsWith("^")) {
    const id = parts[0].slice(1).toLowerCase()
    const block = Object.values(cache.blocks ?? {}).find((b: any) => b.id.toLowerCase() === id) as any
    if (!block) return null
    const list = (cache.listItems ?? []).find((l: any) => l.position.start.line === block.position.start.line) ?? null
    return { type: "block", block, list, start: block.position.start, end: block.position.end }
  }
  const hs: any[] = cache.headings ?? []
  const norm = (s: string) => stripHeading(s).toLowerCase()
  let from = 0, current: any = null, level = 0
  for (const p of parts) {
    const i = hs.findIndex((h, j) => j >= from && h.level > level && norm(h.heading) === norm(p))
    if (i < 0) return null
    current = hs[i]; level = current.level; from = i + 1
  }
  const next = hs.slice(from).find((h) => h.level <= current.level) ?? null
  return { type: "heading", current, next, start: current.position.start, end: next ? next.position.start : null }
}

export const stripHeading = (h: string) => h.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, " ").replace(/\s+/g, " ").trim()
export const stripHeadingForLink = (h: string) => h.replace(/[#|^\\%[\]:]/g, " ").replace(/\s+/g, " ").trim()
const list = (v: unknown, split: RegExp) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(split) : v === null || v === undefined ? [] : [v]).map((x) => String(x).trim()).filter(Boolean)
const fmKey = (fm: any, names: string[]) => (fm ? Object.keys(fm).find((k) => names.includes(k.toLowerCase())) : undefined)
export const parseFrontMatterAliases = (fm: any) => { const k = fmKey(fm, ["aliases", "alias"]); const l = k ? list(fm[k], /,/) : []; return l.length ? l : null }
export const parseFrontMatterTags = (fm: any) => { const k = fmKey(fm, ["tags", "tag"]); const l = k ? list(fm[k], /[,\s]+/).map((x) => `#${x.replace(/^#/, "")}`) : []; return l.length ? l : null }
export const parseFrontMatterEntry = (fm: any, key: string | RegExp) => {
  if (!fm) return null
  if (typeof key === "string") return fm[key] ?? null
  const hits = Object.keys(fm).filter((k) => key.test(k))
  return hits.length ? (hits.length === 1 ? fm[hits[0]] : hits.map((k) => fm[k])) : null
}
export const parseFrontMatterStringArray = (fm: any, key: string | RegExp, nospaces = false) => {
  const v = parseFrontMatterEntry(fm, key)
  if (v === null) return null
  const l = list(Array.isArray(v) ? v.flat() : v, nospaces ? /[,\s]+/ : /,/)
  return l.length ? l : null
}

let katex: any = null
async function loadKatex() { katex ??= (await import("katex")).default; return katex }
/** TeX as an element: Obsidian's MathJax, here KaTeX (loaded with loadMathJax, which also gives a MathJax global). */
export function renderMath(src: string, display: boolean) {
  const el = document.createElement(display ? "div" : "span")
  el.className = display ? "math math-block" : "math math-inline"
  const draw = (k: any) => { try { k.render(src, el, { displayMode: display, throwOnError: false }) } catch { el.textContent = src } }
  if (katex) draw(katex); else { el.textContent = src; void loadKatex().then(draw) }
  return el
}
export async function loadMathJax() {
  const k = await loadKatex()
  const w = window as any
  w.MathJax ??= { tex2chtml: (s: string, o?: { display?: boolean }) => renderMath(s, !!o?.display), tex2svg: (s: string, o?: { display?: boolean }) => renderMath(s, !!o?.display),
    startup: { promise: Promise.resolve() }, typesetPromise: async () => {}, typeset() {}, config: { tex: {} }, version: "katex" }
  return k
}

const classes = new WeakMap<object, any>()
/** Classes as ES5 can extend them, the same wrapper for the same class (so `instanceof` and identity hold). */
function callable<T extends Record<string, any>>(m: T): T {
  for (const [k, v] of Object.entries(m)) {
    if (typeof v !== "function" || !/^class\b/.test(Function.prototype.toString.call(v))) continue
    if (!classes.has(v)) classes.set(v, es5(v))
    ;(m as any)[k] = classes.get(v)
  }
  return m
}

export function moduleFor(app: App) {
  return callable({
    App, Plugin, Component, Events, Platform, Notice: ui.Notice, Modal: ui.Modal, SuggestModal: ui.SuggestModal, FuzzySuggestModal: ui.FuzzySuggestModal,
    PopoverSuggest: ui.PopoverSuggest, AbstractInputSuggest: ui.AbstractInputSuggest, EditorSuggest: editor.EditorSuggest,
    Setting: ui.Setting, SettingGroup: ui.SettingGroup, PluginSettingTab: ui.PluginSettingTab, SettingTab: ui.PluginSettingTab, SettingPage: ui.SettingPage,
    ConfirmationModal: ui.ConfirmationModal, ConfirmationButton: ui.ConfirmationButton, SecretComponent: ui.SecretComponent, SecretStorage: ui.SecretStorage,
    getLanguage: () => (localStorage.getItem("language") || navigator.language || "en").split("-")[0],
    BaseComponent: ui.BaseComponent, ValueComponent: ui.ValueComponent, AbstractTextComponent: ui.AbstractTextComponent, TextComponent: ui.TextComponent,
    TextAreaComponent: ui.TextAreaComponent, SearchComponent: ui.SearchComponent, MomentFormatComponent: ui.MomentFormatComponent, ToggleComponent: ui.ToggleComponent,
    DropdownComponent: ui.DropdownComponent, SliderComponent: ui.SliderComponent, ColorComponent: ui.ColorComponent, ButtonComponent: ui.ButtonComponent,
    ExtraButtonComponent: ui.ExtraButtonComponent, ProgressBarComponent: ui.ProgressBarComponent, Menu: ui.Menu, MenuItem: ui.MenuItem, MenuSeparator: ui.MenuSeparator,
    HoverPopover: ui.HoverPopover, Keymap: ui.Keymap, Scope: ui.Scope, DisplayValueComponent: values.DisplayValueComponent,
    setIcon: ui.setIcon, getIcon: ui.getIcon, addIcon: ui.addIcon, removeIcon: ui.removeIcon, getIconIds: ui.getIconIds, setTooltip: ui.setTooltip, displayTooltip: ui.displayTooltip,
    prepareFuzzySearch: ui.prepareFuzzySearch, prepareSimpleSearch: ui.prepareSimpleSearch, fuzzySearch: ui.fuzzySearch, renderMatches: ui.renderMatches, renderResults: ui.renderResults, sortSearchResults: ui.sortSearchResults,
    Vault: vault.Vault, TAbstractFile: vault.TAbstractFile, TFile: vault.TFile, TFolder: vault.TFolder, MetadataCache: vault.MetadataCache, FileManager: vault.FileManager,
    DataAdapter: vault.DataAdapter,
    // (on a computer the vault's own adapter class, whose statics reach the server's files: readLocalFile)
    FileSystemAdapter: app.vault.adapter instanceof vault.FileSystemAdapter ? app.vault.adapter.constructor : vault.FileSystemAdapter, CapacitorAdapter: vault.CapacitorAdapter,
    normalizePath: vault.normalizePath, getAllTags: vault.getAllTags, getFrontMatterInfo: vault.getFrontMatterInfo,
    Workspace: ws.Workspace, WorkspaceLeaf: ws.WorkspaceLeaf, View: ws.View, ItemView: ws.ItemView, FileView: ws.FileView, EditableFileView: ws.EditableFileView, TextFileView: ws.TextFileView,
    MarkdownView: ws.MarkdownView, MarkdownPreviewView: ws.MarkdownPreviewView, MarkdownEditView: ws.MarkdownEditView, MarkdownRenderer: ws.MarkdownRenderer, MarkdownRenderChild: ws.MarkdownRenderChild,
    MarkdownPreviewRenderer: ws.MarkdownPreviewRenderer,
    WorkspaceSplit: (ws as any).WorkspaceSplit ?? class WorkspaceSplit {}, WorkspaceItem: (ws as any).WorkspaceItem ?? class WorkspaceItem {}, WorkspaceParent: (ws as any).WorkspaceParent ?? class WorkspaceParent {},
    WorkspaceTabs: (ws as any).WorkspaceTabs ?? class WorkspaceTabs {}, WorkspaceRoot: (ws as any).WorkspaceRoot ?? class WorkspaceRoot {}, WorkspaceSidedock: (ws as any).WorkspaceSidedock ?? class WorkspaceSidedock {},
    WorkspaceMobileDrawer: (ws as any).WorkspaceMobileDrawer ?? class WorkspaceMobileDrawer {}, WorkspaceWindow: (ws as any).WorkspaceWindow ?? class WorkspaceWindow {},
    WorkspaceContainer: (ws as any).WorkspaceContainer ?? class WorkspaceContainer {}, WorkspaceRibbon: (ws as any).WorkspaceRibbon ?? class WorkspaceRibbon {}, WorkspaceFloating: (ws as any).WorkspaceFloating ?? class WorkspaceFloating {},
    Editor: editor.Editor, editorInfoField: editor.editorInfoField, editorViewField: editor.editorViewField, editorEditorField: editor.editorEditorField,
    editorLivePreviewField: editor.editorLivePreviewField, livePreviewState: editor.editorLivePreviewField,
    moment, debounce, requestUrl, request: async (o: string | RequestParam) => (await requestUrl(o)).text, parseYaml,
    stringifyYaml: (o: unknown) => yamlStringify(o, { lineWidth: 0 }),
    htmlToMarkdown: (h: string | Node) => turndown.turndown(h as any), sanitizeHTMLToDom,
    parseLinktext, getLinkpath: (t: string) => parseLinktext(t).path, stripHeading, stripHeadingForLink,
    parseFrontMatterAliases, parseFrontMatterTags, parseFrontMatterEntry, parseFrontMatterStringArray, resolveSubpath,
    iterateCacheRefs: (c: any, cb: (r: any) => any) => { for (const r of [...(c?.links ?? []), ...(c?.embeds ?? []), ...(c?.frontmatterLinks ?? [])]) if (cb(r)) return true; return false },
    iterateRefs: (refs: any[], cb: (r: any) => any) => { for (const r of refs ?? []) if (cb(r)) return true; return false },
    arrayBufferToBase64: bufToB64, base64ToArrayBuffer: b64ToBuf,
    arrayBufferToHex: (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""),
    hexToArrayBuffer: (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)).buffer,
    apiVersion: API_VERSION, requireApiVersion: (v: string) => !newer(v, API_VERSION),
    loadMermaid: async () => { const m = (await import("mermaid")).default; (window as any).mermaid ??= m; return m },
    loadPrism: async () => (window as any).Prism ?? null, loadMathJax, renderMath, finishRenderMath: async () => {},
    loadPdfJs: async () => (window as any).pdfjsLib ?? null, getBlobArrayBuffer: (b: Blob) => b.arrayBuffer(),
    Tasks: values.Tasks, PopoverState: { Showing: 0, Shown: 1, Hiding: 2, Hidden: 3, 0: "Showing", 1: "Shown", 2: "Hiding", 3: "Hidden" },
    Value: values.Value, NotNullValue: values.NotNullValue, NullValue: values.NullValue, PrimitiveValue: values.PrimitiveValue, StringValue: values.StringValue,
    NumberValue: values.NumberValue, BooleanValue: values.BooleanValue, DateValue: values.DateValue, RelativeDateValue: values.RelativeDateValue,
    DurationValue: values.DurationValue, LinkValue: values.LinkValue, FileValue: values.FileValue, ListValue: values.ListValue, ObjectValue: values.ObjectValue,
    TagValue: values.TagValue, UrlValue: values.UrlValue, HTMLValue: values.HTMLValue, IconValue: values.IconValue, ImageValue: values.ImageValue, RegExpValue: values.RegExpValue,
    BasesView: values.BasesView, BasesEntry: values.BasesEntry, BasesEntryGroup: values.BasesEntryGroup, BasesQueryResult: values.BasesQueryResult,
    BasesViewConfig: values.BasesViewConfig, QueryController: values.QueryController, RenderContext: values.RenderContext, parsePropertyId: values.parsePropertyId,
    app,
  })
}
