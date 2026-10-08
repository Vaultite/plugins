// Markdown drawn as Obsidian draws it: the app's renderer, its HTML reshaped to Obsidian's elements (internal links,
// tags, tasks, callouts, embeds), plugins' code blocks and post-processors run over it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CM } from "./cm.ts"
import { followLink, getStore, get, hydrateMarkdown, markdownHtml, noteFor, onMarkdownDrawn, rawUrl } from "@vaultite"
import { Component } from "./core.ts"
import { registered } from "./state.ts"
import * as ui from "./ui.ts"

export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement
  constructor(el: HTMLElement) { super(); this.containerEl = el }
}

type Section = { text: string; lineStart: number; lineEnd: number }
export type PostCtx = { docId: string; sourcePath: string; frontmatter: any; displayMode?: boolean; el?: HTMLElement
  addChild(c: Component): void; getSectionInfo(el: HTMLElement): Section | null; remainingNestLevel: number }

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
const TASK = /^\[(.)\]\s/
const app = () => (window as any).app
const fmOf = (path: string) => (path ? app()?.metadataCache?.getCache?.(path)?.frontmatter : undefined) ?? {}
const stripFm = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")

// Raw HTML in Markdown, which Obsidian draws (sanitized) and the app shows as text: its tags are kept aside as
// private-use marks while the app renders, then put back and cleaned of scripts.
const TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g
function holdHtml(md: string) {
  const held: string[] = []
  const hold = (t: string) => t.replace(TAG, (m) => `\uE000${held.push(m) - 1}\uE001`)
  // (not inside code: fenced blocks and `spans` keep their text)
  const out = md.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m).map((part, i) => (i % 2 ? part : part.split(/(`+[^`\n]*`+)/).map((p, j) => (j % 2 ? p : hold(p))).join(""))).join("")
  return { md: out, back: (html: string) => html.replace(/\uE000(\d+)\uE001/g, (_, n) => held[Number(n)] ?? "") }
}
function clean(root: HTMLElement) {
  for (const el of root.querySelectorAll("script, object, embed, base, meta, link")) el.remove()
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name)
  }
}

/** The app's HTML for `md` reshaped as Obsidian's, into `el`. */
function draw(md: string, el: HTMLElement) {
  const box = document.createElement("div")
  const raw = holdHtml(stripFm(md))
  box.innerHTML = raw.back(markdownHtml(raw.md))
  clean(box)
  for (const a of box.querySelectorAll<HTMLAnchorElement>("a[data-wiki]")) {
    const target = a.dataset.wiki ?? ""
    if (a.hasAttribute("data-wiki-embed")) {
      const s = document.createElement("span")
      s.className = "internal-embed"
      s.setAttribute("src", target)
      s.setAttribute("alt", a.textContent ?? "")
      a.replaceWith(s)
      continue
    }
    a.classList.add("internal-link")
    if (a.classList.contains("missing")) a.classList.add("is-unresolved")
    a.setAttribute("data-href", target)
    a.setAttribute("href", target)
    a.setAttribute("target", "_blank")
    a.setAttribute("rel", "noopener nofollow")
  }
  for (const a of box.querySelectorAll<HTMLAnchorElement>("a[href^='http'], a[href^='mailto']")) if (!a.dataset.wiki) a.classList.add("external-link")
  for (const a of box.querySelectorAll<HTMLAnchorElement>("a.tag")) a.setAttribute("href", `#${a.dataset.tag ?? ""}`)
  for (const h of box.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) h.setAttribute("data-heading", h.textContent ?? "")
  for (const t of box.querySelectorAll<HTMLElement>(".callout-title-text")) t.classList.add("callout-title-inner")
  for (const c of box.querySelectorAll<HTMLElement>("details.callout")) c.classList.add("is-collapsible")
  // Tasks: GitHub's [ ] and [x] come as disabled inputs; any other mark ([/], [-]) is still text.
  for (const li of box.querySelectorAll<HTMLLIElement>("li")) {
    const first = li.firstChild
    let mark: string | null = null
    if (first instanceof HTMLInputElement && first.type === "checkbox") { mark = first.checked ? "x" : " "; first.remove() }
    else {
      const node = first instanceof HTMLParagraphElement ? first.firstChild : first
      const m = node?.nodeType === Node.TEXT_NODE ? TASK.exec(node.textContent ?? "") : null
      if (m) { mark = m[1]; node!.textContent = (node!.textContent ?? "").slice(m[0].length) }
    }
    if (mark === null) continue
    li.classList.add("task-list-item")
    if (mark !== " ") li.classList.add("is-checked")
    li.setAttribute("data-task", mark)
    const box2 = document.createElement("input")
    box2.type = "checkbox"
    box2.className = "task-list-item-checkbox"
    box2.checked = mark !== " "
    li.prepend(box2)
    li.parentElement?.classList.add("contains-task-list")
  }
  // As Obsidian's: text never loose at the top (a paragraph), blocks marked dir="auto" (plugins slice "<p dir=\"auto\">")
  let para: HTMLParagraphElement | null = null
  for (const n of [...box.childNodes]) {
    const block = n instanceof HTMLElement && BLOCK.test(n.tagName)
    if (n.nodeType === Node.TEXT_NODE && !n.textContent?.trim() && !para) { n.remove(); continue }
    if (block) { para = null; continue }
    if (!para) { para = document.createElement("p"); n.before(para) }
    para.append(n)
  }
  for (const b of box.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li")) b.setAttribute("dir", "auto")
  el.append(...box.childNodes)
}
const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|PRE|BLOCKQUOTE|TABLE|HR|DETAILS|FIGURE|SECTION|DL)$/

/** Plugins' code blocks (```dataview) in what was drawn: each replaced by what its processor draws. */
async function codeBlocks(el: HTMLElement, ctx: PostCtx) {
  for (const block of [...el.querySelectorAll<HTMLElement>(".md-code")]) {
    const code = block.querySelector("code")
    const lang = /language-(\S+)/.exec(code?.className ?? "")?.[1] ?? ""
    const proc = registered.fences.get(lang)
    if (!proc) {
      // As Obsidian has them: <pre><code class="language-x">, the app's copy button kept.
      block.classList.add("el-pre")
      continue
    }
    const div = document.createElement("div")
    div.className = `block-language-${lang}`
    block.replaceWith(div)
    try { await proc.fn((code?.textContent ?? "").replace(/\n$/, ""), div, ctx) } catch (e) { console.error(e); div.createDiv({ cls: "plugin-compat-error", text: `${proc.plugin}: ${(e as Error).message}` }) }
  }
}

/** Embeds (![[image.png]], ![[Note]]) drawn: images at their size, notes as their Markdown, a few levels deep. */
async function embeds(el: HTMLElement, from: string, comp: Component, depth: number) {
  const store = getStore()
  for (const s of [...el.querySelectorAll<HTMLElement>(".internal-embed:not(.is-loaded)")]) {
    s.classList.add("is-loaded")
    const src = s.getAttribute("src") ?? "", [name, sub] = src.split("#")
    const alt = s.getAttribute("alt") ?? ""
    const path = store ? noteFor(store, name, from) ?? (IMAGE.test(name) ? (app()?.metadataCache?.getFirstLinkpathDest?.(name, from)?.path ?? null) : null) : null
    if (IMAGE.test(name)) {
      s.classList.add("media-embed", "image-embed")
      const img = s.createEl("img", { attr: { src: rawUrl(path ?? name), alt } })
      const size = /^(\d+)(?:x(\d+))?$/.exec(alt.split("|").pop() ?? "")
      if (size) { img.setAttribute("width", size[1]); if (size[2]) img.setAttribute("height", size[2]) }
      continue
    }
    if (!path || depth <= 0) { s.addClass("is-unresolved"); s.setText(alt || src); continue }
    s.classList.add("markdown-embed", "inline-embed", "is-loaded")
    s.setAttribute("data-preview-path", path)
    const body = s.createDiv({ cls: "markdown-embed-content" }).createDiv({ cls: "markdown-preview-view markdown-rendered" })
    let text = ""
    try { text = (await get<{ text: string }>(`file?path=${encodeURIComponent(path)}`)).text } catch { body.setText(`Couldn't read ${path}`); continue }
    if (sub) text = sectionOf(text, sub)
    await renderInto(text, body, path, comp, depth - 1, sub ? null : text)
  }
}

/** A heading's section (#Heading) or a block's paragraph (#^id) of a note. */
function sectionOf(text: string, sub: string) {
  const lines = text.split("\n")
  if (sub.startsWith("^")) { const l = lines.find((x) => x.trimEnd().endsWith(` ${sub}`) || x.trimEnd() === sub); return l ? l.replace(new RegExp(`\\s*\\${sub}\\s*$`), "") : "" }
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim() === sub.trim())
  if (at < 0) return ""
  const level = /^#+/.exec(lines[at])![0].length
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l) && /^#+/.exec(l)![0].length <= level)
  return lines.slice(at, end < 0 ? undefined : end).join("\n")
}

/** A note's own text drawn: its checkboxes check the line they came from (the n-th task of the file). */
function wireTasks(el: HTMLElement, path: string, text: string) {
  const lines = text.split("\n"), at: number[] = []
  let fence = false
  lines.forEach((l, i) => { if (/^\s*(```|~~~)/.test(l)) fence = !fence; else if (!fence && /^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s/.test(l)) at.push(i) })
  el.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox").forEach((box, n) => {
    const line = at[n]
    if (line === undefined) return
    box.closest("li")?.setAttribute("data-line", String(line))
    box.addEventListener("click", async (e) => {
      e.stopPropagation()
      const f = app()?.vault?.getFileByPath?.(path)
      if (!f) return
      const on = box.checked
      await app().vault.process(f, (t: string) => {
        const ls = t.split("\n")
        if (ls[line] !== undefined) ls[line] = ls[line].replace(/\[(.)\]/, on ? "[x]" : "[ ]")
        return ls.join("\n")
      })
    })
  })
}

async function renderInto(md: string, el: HTMLElement, from: string, comp: Component, depth: number, wholeFile: string | null) {
  const start = el.childNodes.length
  draw(md, el)
  const added = () => [...el.childNodes].slice(start).filter((n): n is HTMLElement => n instanceof HTMLElement)
  const ctx = postCtx(from, comp, md)
  await codeBlocks(el, ctx)
  await embeds(el, from, comp, depth)
  for (const n of added()) hydrateMarkdown(n)
  await postProcess(el, ctx)
  if (wholeFile !== null && from) wireTasks(el, from, wholeFile)
}

function postCtx(from: string, comp: Component, text: string | null): PostCtx {
  return { docId: from, sourcePath: from, frontmatter: fmOf(from), displayMode: true, remainingNestLevel: 4,
    addChild: (c) => comp.addChild(c),
    getSectionInfo: (el) => {
      if (text === null) return null
      const lines = text.split("\n")
      const at = el.dataset.line ? Number(el.dataset.line) : -1
      return at >= 0 ? { text, lineStart: at, lineEnd: at } : { text, lineStart: 0, lineEnd: lines.length - 1 }
    } }
}

/** Plugins' post-processors over `el`, in their order. */
export async function postProcess(el: HTMLElement, ctx: PostCtx) {
  const list = [...registered.postProcessors].sort((a, b) => ((a.fn as any).sortOrder ?? 0) - ((b.fn as any).sortOrder ?? 0))
  for (const p of list) {
    try { await p.fn(el, { ...ctx, el }) } catch (e) { console.error(`obsidian plugin ${p.plugin}: post-processor`, e) }
  }
}

/** Clicks on internal links and tags in what a plugin drew follow in the app (unless the plugin took the click). */
function follow(el: HTMLElement, at: string) {
  if ((el as any)._followWired) return
  ;(el as any)._followWired = true
  const go = (e: MouseEvent) => {
    let from = at
    if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return
    const a = (e.target as Element).closest?.<HTMLElement>("a.internal-link, a.tag")
    const store = getStore()
    if (!a || !el.contains(a) || !store) return
    e.preventDefault()
    const newTab = e.metaKey || e.ctrlKey || e.button === 1
    from = from || (a.closest<HTMLElement>("[data-preview-path]")?.dataset.previewPath ?? "")
    if (a.classList.contains("tag")) followLink(store, { tag: (a.dataset.tag ?? a.textContent ?? "").replace(/^#/, "") }, newTab, from)
    else followLink(store, { wiki: a.getAttribute("data-href") ?? a.dataset.wiki ?? "" }, newTab, from)
  }
  el.addEventListener("click", go)
  el.addEventListener("auxclick", go)
}

/** Obsidian's MarkdownRenderer: `md` drawn into `el`, as the note `from` would have it. */
export async function renderMarkdown(md: string, el: HTMLElement, from: string, comp?: Component) {
  // (the app's prose, at the size it's drawn in)
  el.classList.add("markdown-rendered", "note-prose", "inline")
  if (from) el.setAttribute("data-preview-path", from)
  follow(el, from)
  await renderInto(md ?? "", el, from ?? "", comp ?? new Component(), 3, null)
}

export const MarkdownRenderer = {
  render: (_app: any, md: string, el: HTMLElement, from: string, comp: Component) => renderMarkdown(md, el, from, comp),
  renderMarkdown: (md: string, el: HTMLElement, from: string, comp: Component) => renderMarkdown(md, el, from, comp),
}

/** A note's reading view; its static render is Obsidian's older name for MarkdownRenderer's. */
export class MarkdownPreviewView extends MarkdownRenderChild {
  static render(_app: any, md: string, el: HTMLElement, from: string, comp: Component) { return renderMarkdown(md, el, from, comp) }
  file: any = null
  get() { return this.containerEl.textContent ?? "" }
  set(md: string) { this.containerEl.empty(); void renderMarkdown(md, this.containerEl, this.file?.path ?? "", this) }
  rerender() {}
  clear() { this.containerEl.empty() }
  applyScroll() { return false }
  getScroll() { return 0 }
}

export const MarkdownPreviewRenderer = {
  registerPostProcessor(fn: (el: HTMLElement, ctx: any) => any) { registered.postProcessors.push({ plugin: "?", fn }) },
  unregisterPostProcessor(fn: (el: HTMLElement, ctx: any) => any) { registered.postProcessors = registered.postProcessors.filter((p) => p.fn !== fn) },
  createCodeBlockPostProcessor(lang: string, fn: (source: string, el: HTMLElement, ctx: any) => any) {
    return (el: HTMLElement, ctx: PostCtx) => {
      for (const code of el.querySelectorAll<HTMLElement>(`code.language-${CSS.escape(lang)}`)) {
        const div = document.createElement("div")
        div.className = `block-language-${lang}`
        ;(code.closest(".md-code, pre") ?? code).replaceWith(div)
        void fn(code.textContent ?? "", div, ctx)
      }
    }
  },
}

/** Post-processors over Markdown the app draws itself (embeds, previews, callouts in the editor), while plugins have
 *  some; and internal links a plugin drew anywhere followed in the app, not as an address. */
export function watchAppMarkdown() {
  const root = document.body as HTMLElement
  follow(root, "")
  ;(window as any).__obsidianCompat = { ...ui, renderMarkdown, CM } // (for QA and debugging in the console)
  const ws = app()?.workspace, ref = ws?.on?.("hover-link", ui.hoverLink)
  const stop = onMarkdownDrawn((el) => {
    if (!registered.postProcessors.length || el.closest(".markdown-rendered")) return
    const from = el.closest<HTMLElement>("[data-markdown-from], [data-embed], [data-note-preview], [data-preview-path], [data-path]")
    const path = from?.dataset.markdownFrom ?? from?.dataset.embed ?? from?.dataset.notePreview ?? from?.dataset.previewPath ?? from?.dataset.path ?? ""
    for (const a of el.querySelectorAll<HTMLAnchorElement>("a[data-wiki]")) { a.classList.add("internal-link"); a.setAttribute("data-href", a.dataset.wiki ?? "") }
    void postProcess(el, postCtx(path, new Component(), null))
  })
  return () => { stop(); if (ref) ws.offref(ref) }
}
