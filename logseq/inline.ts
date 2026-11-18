// A line of Logseq's Markdown made Vaultite's: links, tags, block refs, embeds, macros, highlights and assets.
import { readDate } from "./dates.ts"
import type { GraphConfig } from "./edn.ts"

export type Stats = { queries: number; queriesKept: number; macrosKept: Map<string, number>; brokenRefs: number }
export type Ctx = {
  cfg: GraphConfig
  /** What a [[link]] to a page names: its note's link (`Logseq/a/b`) or null when no file has it. */
  page: (title: string) => string | null
  /** The daily note's link for a date (YYYY-MM-DD). */
  day: (iso: string) => string
  /** A block by its uuid: its note's link and its text, as a link's label. */
  block: (uuid: string) => { note: string; label: string } | null
  /** The vault path an asset was copied to, from a link as written in the page. */
  asset: (href: string) => string | null
  /** A link to another page's file ([label](other.org)), relative to this page's: that page's title. */
  file?: (href: string) => string | null
  /** A drawing (draws/x.excalidraw) as copied into the vault. */
  drawing: (name: string) => string | null
  stats: Stats
  /** The page being converted. */
  title?: string
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const TAG_END = /[\s,!?;"'()[\]{}]|[.:](?=\s|$)/u
const IMG_ATTRS = /^\{:([^}]*)\}/

/** A [[link]], with a label when its target isn't the text the page wrote. */
export function wikilink(ctx: Ctx, title: string, label?: string, embed = false): string {
  const t = title.trim()
  const date = readDate(t, ctx.cfg.journalTitleFormat)
  const target = date ? ctx.day(date) : ctx.page(t) ?? t
  const shown = label ?? t
  const same = target.toLowerCase() === shown.toLowerCase()
  return `${embed ? "!" : ""}[[${same ? shown : target}${same || embed ? "" : `|${clean(shown)}`}]]`
}

/** A tag as Vaultite reads one: no spaces; letters needed (#2024 isn't one: a link then). */
export function tagOf(ctx: Ctx, name: string): string {
  const t = name.trim().replace(/\s*\/\s*/g, "/").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, "-").replace(/-{2,}/g, "-").replace(/^[-/]+|[-/]+$/g, "")
  return /[\p{L}_]/u.test(t) ? `#${t}` : wikilink(ctx, name)
}

const clean = (s: string) => s.replace(/[[\]|]/g, "").replace(/\s+/g, " ").trim()

function blockRef(ctx: Ctx, uuid: string, label?: string, embed = false) {
  const b = ctx.block(uuid.toLowerCase())
  if (!b) { ctx.stats.brokenRefs++; return null }
  return `${embed ? "!" : ""}[[${b.note}#^${uuid.toLowerCase()}${embed ? "" : `|${(label === undefined ? b.label : clean(label)) || "block"}`}]]`
}

function size(attrs: string | undefined) {
  const w = attrs ? /:width\s+([\d.]+)/.exec(attrs) : null
  return w ? `|${Math.round(Number(w[1]))}` : ""
}

function macro(ctx: Ctx, all: string, name: string, arg: string): string {
  const a = arg.trim()
  switch (name.toLowerCase()) {
    case "embed": {
      const r = new RegExp(`^\\(\\((${UUID})\\)\\)$`, "i").exec(a)
      if (r) return blockRef(ctx, r[1], undefined, true) ?? all
      const p = /^\[\[(.+)\]\]$/.exec(a)
      return p ? wikilink(ctx, p[1], undefined, true) : all
    }
    case "cloze": return `==${a}==`
    case "video": return `[Video](${a})`
    case "youtube": return `[YouTube](${/^https?:/.test(a) ? a : `https://youtu.be/${a}`})`
    case "tweet": case "twitter": return `[Tweet](${a})`
    case "pdf": {
      const local = ctx.asset(a)
      return local ? `![[${local}]]` : `[PDF](${a})`
    }
    case "namespace": return `${wikilink(ctx, a.replace(/^\[\[|\]\]$/g, ""))} (namespace)`
    default: {
      const own = ctx.cfg.macros[name]
      // (one that draws HTML or runs another macro has nothing to be in a note: kept as written)
      if (own !== undefined && !/^\s*\[:|<\w|\{\{/.test(own)) {
        const args = a ? a.split(/\s*,\s*/) : []
        return line(ctx, own.replace(/\$(\d+)/g, (_, n: string) => args[Number(n) - 1] ?? ""))
      }
      ctx.stats.macrosKept.set(name, (ctx.stats.macrosKept.get(name) ?? 0) + 1)
      return all
    }
  }
}

const PATTERN = new RegExp([
  /\[[^\]\n]*\]\((?:[a-z][\w+.-]*:)[^)\n]*\)/.source, // a link to a web page, as it is
  /\{\{\s*([\w-]+)\s*(.*?)\}\}/.source, // 1 macro, 2 its argument
  /!\[([^\]\n]*)\]\(([^)\n]+)\)/.source, // 3 image alt, 4 its path
  `\\[([^\\]\\n]*)\\]\\(\\(\\((${UUID})\\)\\)\\)`, // 5 label, 6 uuid
  /\[([^\]\n]*)\]\(\[\[([^\]\n]+)\]\]\)/.source, // 7 label, 8 page
  /\[([^\]\n]*)\]\((\.\.?\/[^)\n]+|assets\/[^)\n]+|[^)\s:]+\.(?:org|md))\)/.source, // 9 label, 10 a local file
  /\[\[([^\][\n]+)\]\[([^\]\n]+)\]\]/.source, // 11 url, 12 label (org's)
  /\[\[([^\][\n]+(?:\[\[[^\][\n]+\]\][^\][\n]*)*)\]\]/.source, // 13 page
  `\\(\\((${UUID})\\)\\)`, // 14 block ref
  /(?<=^|[\s(,])#\[\[([^\][\n]+)\]\]/.source, // 15 #[[tag]]
  /(?<=^|[\s(,])#([^\s#,!?;"'()[\]{}][^\s,!?;"'()[\]{}]*)/.source, // 16 #tag
  /\^\^([^^\n]+?)\^\^/.source, // 17 highlight
].join("|"), "giu")

/** One line's inline syntax, outside its code and math. */
export function line(ctx: Ctx, text: string): string {
  return text.split(/(`+[^`\n]*`+|\$\$[^$\n]*\$\$|\$[^$\n]+\$)/).map((part, i) => (i % 2 ? part : convert(ctx, part))).join("")
}

function convert(ctx: Ctx, text: string): string {
  let out = "", at = 0
  for (const m of text.matchAll(PATTERN)) {
    if (m.index < at) continue
    out += text.slice(at, m.index)
    let rep = m[0], end = m.index + m[0].length
    if (m[1] !== undefined) rep = macro(ctx, m[0], m[1], m[2])
    else if (m[4] !== undefined) {
      const attrs = IMG_ATTRS.exec(text.slice(end))
      const local = ctx.asset(m[4])
      if (local) { rep = `![[${local}${size(attrs?.[1])}]]`; if (attrs) end += attrs[0].length }
      else if (attrs) end += attrs[0].length
    } else if (m[6] !== undefined) rep = blockRef(ctx, m[6], m[5]) ?? m[0]
    else if (m[8] !== undefined) rep = wikilink(ctx, m[8], m[7])
    else if (m[10] !== undefined) {
      const local = ctx.asset(m[10]), page = local ? null : ctx.file?.(m[10])
      if (local) rep = `[[${local}|${clean(m[9]) || local.split("/").pop()}]]`
      else if (page) rep = wikilink(ctx, page, m[9] || undefined)
    } else if (m[11] !== undefined) rep = /^[a-z]+:/i.test(m[11]) ? `[${m[12]}](${m[11]})` : wikilink(ctx, m[11], m[12])
    else if (m[13] !== undefined) {
      const d = /^draws\/(.+\.excalidraw)$/i.exec(m[13].trim())
      const drawing = d ? ctx.drawing(d[1]) : null
      rep = drawing ? `![[${drawing}]]` : wikilink(ctx, m[13])
    } else if (m[14] !== undefined) rep = blockRef(ctx, m[14]) ?? m[0]
    else if (m[15] !== undefined) rep = tagOf(ctx, m[15])
    else if (m[16] !== undefined) {
      const cut = TAG_END.exec(m[16])
      const name = cut ? m[16].slice(0, cut.index) : m[16]
      end = m.index + 1 + name.length
      rep = name ? tagOf(ctx, name) : "#"
    } else if (m[17] !== undefined) rep = `==${m[17]}==`
    out += rep
    at = end
  }
  return out + text.slice(at)
}
