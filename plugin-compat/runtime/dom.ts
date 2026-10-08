// What Obsidian adds to the DOM and the globals (createEl, addClass, Array.prototype.last...): its plugins call them
// everywhere. Installed once, while this plugin is on in this window.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type DomInfo = { cls?: string | string[]; text?: string | DocumentFragment; attr?: Record<string, any>; title?: string; parent?: Node
  value?: string; type?: string; prepend?: boolean; placeholder?: string; href?: string }

function apply(el: HTMLElement | SVGElement, o?: DomInfo | string, cb?: (el: any) => void) {
  if (typeof o === "string") o = { cls: o }
  if (o) {
    if (o.cls) el.classList.add(...(Array.isArray(o.cls) ? o.cls : [o.cls]).flatMap((c) => String(c).split(/\s+/)).filter(Boolean))
    if (o.text !== undefined) { if (typeof o.text === "string") el.textContent = o.text; else el.append(o.text) }
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v))
    if (o.title !== undefined) el.setAttribute("title", o.title)
    if (o.value !== undefined) (el as any).value = o.value
    if (o.type !== undefined) el.setAttribute("type", o.type)
    if (o.placeholder !== undefined) el.setAttribute("placeholder", o.placeholder)
    if (o.href !== undefined) el.setAttribute("href", o.href)
    if (o.parent) { if (o.prepend) (o.parent as Element).prepend(el); else o.parent.appendChild(el) }
  }
  cb?.(el)
  return el
}

export function createEl(tag: string, o?: DomInfo | string, cb?: (el: any) => void) { return apply(document.createElement(tag), o, cb) as HTMLElement }
const createSvg = (tag: string, o?: DomInfo | string, cb?: (el: any) => void) => apply(document.createElementNS("http://www.w3.org/2000/svg", tag), o, cb)

let installed = false
/** A place in the page nobody sees, for Obsidian's own parts that plugins reach into (the app draws its own). */
let hiddenEl: HTMLElement | null = null
export function hidden() {
  if (!hiddenEl?.isConnected) { hiddenEl = createEl("div", { cls: "plugin-compat-hidden" }); hiddenEl.style.display = "none"; document.body.append(hiddenEl) }
  return hiddenEl
}

export function installDom() {
  if (installed) return
  installed = true
  const def = (proto: any, name: string, fn: any) => { if (!(name in proto)) Object.defineProperty(proto, name, { value: fn, configurable: true, writable: true }) }
  const N = Node.prototype, E = Element.prototype, H = HTMLElement.prototype
  def(N, "createEl", function (this: Node, tag: string, o?: DomInfo | string, cb?: any) {
    const info = typeof o === "string" ? { cls: o } : o
    const el = createEl(tag, { ...info, parent: undefined }, cb)
    if (info?.prepend) (this as Element).prepend(el); else this.appendChild(el)
    return el
  })
  def(N, "createDiv", function (this: any, o?: any, cb?: any) { return this.createEl("div", o, cb) })
  def(N, "createSpan", function (this: any, o?: any, cb?: any) { return this.createEl("span", o, cb) })
  def(N, "createSvg", function (this: Node, tag: string, o?: any, cb?: any) { const el = createSvg(tag, o, cb); this.appendChild(el); return el })
  def(N, "empty", function (this: Node) { while (this.firstChild) this.removeChild(this.firstChild) })
  def(N, "detach", function (this: Node) { this.parentNode?.removeChild(this) })
  def(N, "indexOf", function (this: Node, other: Node) { return Array.prototype.indexOf.call(this.childNodes, other) })
  def(N, "insertAfter", function (this: Node, node: Node, child: Node | null) { this.insertBefore(node, child ? child.nextSibling : this.firstChild); return node })
  def(N, "appendText", function (this: Node, t: string) { this.appendChild(document.createTextNode(t)) })
  def(N, "setChildrenInPlace", function (this: Node, children: Node[]) { (this as Element).replaceChildren(...children) })
  def(N, "instanceOf", function (this: Node, type: any) { return this instanceof type })
  def(N, "constructorWin", window)
  Object.defineProperty(N, "doc", { get() { return this.ownerDocument ?? document }, configurable: true })
  Object.defineProperty(N, "win", { get() { return window }, configurable: true })
  // (events too: the window and document they happened in, and the node they happened on)
  for (const k of ["win", "doc"]) if (!(k in UIEvent.prototype)) Object.defineProperty(UIEvent.prototype, k, { get() { return k === "win" ? window : document }, configurable: true })
  if (!("targetNode" in UIEvent.prototype)) Object.defineProperty(UIEvent.prototype, "targetNode", { get() { return this.target instanceof Node ? this.target : null }, configurable: true })
  def(UIEvent.prototype, "instanceOf", function (this: Event, type: any) { return this instanceof type })
  def(E, "getText", function (this: Element) { return this.textContent ?? "" })
  def(E, "setText", function (this: Element, t: string | DocumentFragment) { if (typeof t === "string") this.textContent = t; else this.replaceChildren(t) })
  def(E, "addClass", function (this: Element, ...c: string[]) { this.classList.add(...c.flatMap((x) => x.split(" ")).filter(Boolean)) })
  def(E, "addClasses", function (this: Element, c: string[]) { this.classList.add(...c.flatMap((x) => x.split(/\s+/)).filter(Boolean)) })
  def(E, "removeClass", function (this: Element, ...c: string[]) { this.classList.remove(...c.flatMap((x) => x.split(" ")).filter(Boolean)) })
  def(E, "removeClasses", function (this: Element, c: string[]) { this.classList.remove(...c.flatMap((x) => x.split(/\s+/)).filter(Boolean)) })
  def(E, "toggleClass", function (this: Element, c: string | string[], on: boolean) { for (const x of (Array.isArray(c) ? c : [c]).flatMap((y) => y.split(/\s+/)).filter(Boolean)) this.classList.toggle(x, on) })
  def(E, "hasClass", function (this: Element, c: string) { return this.classList.contains(c) })
  def(E, "setAttr", function (this: Element, k: string, v: any) { if (v === null || v === undefined || v === false) this.removeAttribute(k); else this.setAttribute(k, v === true ? "" : String(v)) })
  def(E, "setAttrs", function (this: any, o: Record<string, any>) { for (const [k, v] of Object.entries(o)) this.setAttr(k, v) })
  def(E, "getAttr", function (this: Element, k: string) { return this.getAttribute(k) })
  def(E, "matchParent", function (this: Element, sel: string, last?: Element) { let e: Element | null = this; while (e && e !== last) { if (e.matches(sel)) return e; e = e.parentElement } return null })
  def(E, "getCssPropertyValue", function (this: Element, p: string, pseudo?: string) { return getComputedStyle(this, pseudo).getPropertyValue(p) })
  def(E, "isActiveElement", function (this: Element) { return document.activeElement === this })
  def(E, "find", function (this: Element, sel: string) { return this.querySelector(sel) })
  def(E, "findAll", function (this: Element, sel: string) { return [...this.querySelectorAll(sel)] })
  def(E, "findAllSelf", function (this: Element, sel: string) { return [...(this.matches(sel) ? [this] : []), ...this.querySelectorAll(sel)] })
  def(H, "show", function (this: HTMLElement) { this.style.display = "" })
  def(H, "hide", function (this: HTMLElement) { this.style.display = "none" })
  def(H, "toggle", function (this: HTMLElement, on: boolean) { this.style.display = on ? "" : "none" })
  def(H, "toggleVisibility", function (this: HTMLElement, on: boolean) { this.style.visibility = on ? "" : "hidden" })
  def(H, "isShown", function (this: HTMLElement) { return !!this.offsetParent })
  def(H, "setCssStyles", function (this: HTMLElement, s: Partial<CSSStyleDeclaration>) { Object.assign(this.style, s) })
  def(H, "setCssProps", function (this: HTMLElement, p: Record<string, string>) { for (const [k, v] of Object.entries(p)) this.style.setProperty(k, v) })
  Object.defineProperty(H, "innerWidth", { get() { return this.clientWidth }, configurable: true })
  Object.defineProperty(H, "innerHeight", { get() { return this.clientHeight }, configurable: true })
  def(H, "onClickEvent", function (this: HTMLElement, fn: any, o?: any) { this.addEventListener("click", fn, o); this.addEventListener("auxclick", fn, o) })
  def(H, "onNodeInserted", function (this: HTMLElement, fn: () => void, once?: boolean) {
    const ob = new MutationObserver(() => { if (this.isConnected) { fn(); if (once) ob.disconnect() } })
    ob.observe(document.body, { childList: true, subtree: true })
    return () => ob.disconnect()
  })
  def(H, "onWindowMigrated", function () { return () => {} })
  def(H, "trigger", function (this: HTMLElement, type: string) { this.dispatchEvent(new Event(type)) })
  // el.on("click", ".selector", fn): a delegated listener; off with the same three.
  const delegated = new WeakMap<Node, Map<string, any>>()
  def(N, "on", function (this: Node, type: string, sel: string, fn: any, o?: any) {
    const wrap = (e: Event) => { const t = (e.target as Element)?.closest?.(sel); if (t && (this as Element).contains?.(t) !== false) fn.call(t, e, t) }
    let m = delegated.get(this); if (!m) delegated.set(this, m = new Map())
    m.set(`${type}\0${sel}\0${fn}`, wrap)
    this.addEventListener(type, wrap, o)
  })
  def(N, "off", function (this: Node, type: string, sel: string, fn: any, o?: any) {
    const k = `${type}\0${sel}\0${fn}`, w = delegated.get(this)?.get(k)
    if (w) { this.removeEventListener(type, w, o); delegated.get(this)!.delete(k) }
  })
  for (const P of [Document.prototype, DocumentFragment.prototype] as any[]) {
    def(P, "find", function (this: ParentNode, sel: string) { return this.querySelector(sel) })
    def(P, "findAll", function (this: ParentNode, sel: string) { return [...this.querySelectorAll(sel)] })
  }
  const A = Array.prototype as any
  def(A, "first", function (this: any[]) { return this[0] })
  def(A, "last", function (this: any[]) { return this[this.length - 1] })
  def(A, "contains", function (this: any[], x: any) { return this.includes(x) })
  def(A, "remove", function (this: any[], x: any) { const i = this.indexOf(x); if (i >= 0) this.splice(i, 1) })
  def(A, "unique", function (this: any[]) { return [...new Set(this)] })
  def(A, "shuffle", function (this: any[]) { for (let i = this.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this[i], this[j]] = [this[j], this[i]] } return this })
  def(Array, "combine", (arrs: any[][]) => arrs.flat())
  def(String.prototype, "contains", function (this: string, s: string) { return this.includes(s) })
  def(String.prototype, "format", function (this: string, ...a: any[]) { return this.replace(/\{(\d+)\}/g, (m, i) => (a[i] !== undefined ? String(a[i]) : m)) })
  def(String, "isString", (x: unknown) => typeof x === "string")
  def(Math, "clamp", (v: number, a: number, b: number) => Math.min(Math.max(v, a), b))
  def(Math, "square", (v: number) => v * v)
  def(Number, "isNumber", (x: unknown) => typeof x === "number")
  def(Object, "isEmpty", (o: object) => !o || Object.keys(o).length === 0)
  def(Object, "each", (o: Record<string, any>, fn: (v: any, k: string) => any) => { for (const k in o) if (fn(o[k], k) === false) return false; return true })
  const w = window as any
  const g: Record<string, any> = {
    createEl, createDiv: (o?: any, cb?: any) => createEl("div", o, cb), createSpan: (o?: any, cb?: any) => createEl("span", o, cb), createSvg,
    createFragment: (cb?: (f: DocumentFragment) => void) => { const f = document.createDocumentFragment(); cb?.(f); return f },
    activeWindow: window, activeDocument: document,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), nextFrame: () => new Promise((r) => requestAnimationFrame(r)),
    isBoolean: (x: unknown) => typeof x === "boolean", fish: (s: string) => document.querySelector(s), fishAll: (s: string) => [...document.querySelectorAll(s)],
    ready: (fn: () => void) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn()),
  }
  for (const [k, v] of Object.entries(g)) if (!(k in w)) w[k] = v
  bodyClasses()
  webview()
}

/** Electron's <webview>, which plugins show pages in on the desktop: an iframe inside it here (a site refusing frames
 *  shows nothing), with the methods they call; scripts and CSS reach only pages of this app's origin. */
function upgradeWebview(el: HTMLElement) {
  const frame = document.createElement("iframe")
  frame.style.cssText = "flex:1 1 auto;min-width:0;border:0;display:block"
  frame.addEventListener("load", () => { for (const t of ["dom-ready", "did-finish-load", "did-stop-loading"]) el.dispatchEvent(new Event(t)) })
  el.append(frame)
  el.style.display ||= "flex"
  const sync = () => { const src = el.getAttribute("src"); if (src && frame.getAttribute("src") !== src) frame.src = src }
  new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ["src"] })
  const win = () => { try { return frame.contentWindow && frame.contentDocument ? frame.contentWindow as any : null } catch { return null } }
  Object.defineProperty(el, "src", { get: () => el.getAttribute("src") ?? "", set: (v: string) => el.setAttribute("src", v), configurable: true })
  Object.assign(el, {
    getURL: () => win()?.location.href ?? el.getAttribute("src") ?? "", getTitle: () => win()?.document.title ?? "",
    loadURL: async (u: string) => el.setAttribute("src", u), reload: () => { frame.src = frame.src }, stop() {},
    goBack: () => win()?.history.back(), goForward: () => win()?.history.forward(), canGoBack: () => true, canGoForward: () => true,
    executeJavaScript: async (code: string) => { const w = win(); if (!w) throw new Error("a page of another site: its scripts can't be reached here"); return w.eval(code) },
    insertCSS: async (css: string) => { const d = win()?.document; if (d) d.head.append(Object.assign(d.createElement("style"), { textContent: css })); return "" },
    setZoomFactor: (z: number) => { frame.style.zoom = String(z) }, getZoomFactor: () => Number(frame.style.zoom || 1),
    setAudioMuted() {}, isLoading: () => false, openDevTools() {}, getWebContentsId: () => 0,
  })
  return el
}
function webview() {
  const make = Document.prototype.createElement
  if ((make as any).webview) return
  const wrapped = function (this: Document, tag: string, o?: ElementCreationOptions) {
    const el = make.call(this, tag, o)
    return typeof tag === "string" && tag.toLowerCase() === "webview" ? upgradeWebview(el) : el
  }
  ;(wrapped as any).webview = true
  Document.prototype.createElement = wrapped as typeof make
}

/** The classes Obsidian's <body> has that plugins' styles test: the theme (following the app's) and the platform. */
function bodyClasses() {
  const b = document.body, ua = navigator.userAgent, phone = matchMedia("(max-width: 767px)").matches || /iPhone|Android.*Mobile/.test(ua)
  const os = /Mac|iPhone|iPad/.test(navigator.platform) ? "mod-macos" : /Win/.test(navigator.platform) ? "mod-windows" : "mod-linux"
  b.classList.add(os, phone ? "is-mobile" : "is-desktop", ...(phone ? ["is-phone"] : []), ...(/iPhone|iPad/.test(ua) ? ["is-ios"] : []), ...(/Android/.test(ua) ? ["is-android"] : []))
  const theme = () => { const dark = document.documentElement.classList.contains("dark"); b.classList.toggle("theme-dark", dark); b.classList.toggle("theme-light", !dark) }
  // (Obsidian's whole app is in .app-container: plugins find it to mark or measure the app)
  document.getElementById("root")?.classList.add("app-container")
  theme()
  new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
}
