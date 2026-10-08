// Obsidian's CachedMetadata of a note (headings, links, embeds, tags, list items, sections, blocks, frontmatter), with
// positions over the whole file, frontmatter included, as Obsidian's metadataCache has them.
import { parse as parseYaml } from "yaml"

type Loc = { line: number; col: number; offset: number }
type Pos = { start: Loc; end: Loc }
type Ref = { link: string; original: string; displayText?: string; position: Pos }

export type CachedMetadata = {
  links?: Ref[]; embeds?: Ref[]; tags?: { tag: string; position: Pos }[]
  headings?: { heading: string; level: number; position: Pos }[]
  sections?: { type: string; position: Pos; id?: string }[]
  listItems?: { parent: number; task?: string; id?: string; position: Pos }[]
  blocks?: Record<string, { id: string; position: Pos }>
  frontmatter?: Record<string, unknown>; frontmatterPosition?: Pos; frontmatterLinks?: { key: string; link: string; original: string; displayText?: string }[]
  footnotes?: { id: string; position: Pos }[]
}

const LINK = /(!?)\[\[([^\]|#^]*)([#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g
const MDLINK = /(!?)\[([^\]]*)\]\(<?([^)\s>#]*)(#[^)\s>]*)?>?(?:\s+"[^"]*")?\)/g
const TAG = /(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu
const LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[(.)\]\s)?/

export function metadataOf(text: string): CachedMetadata {
  const lines = text.split("\n")
  const starts: number[] = []
  let off = 0
  for (const l of lines) { starts.push(off); off += l.length + 1 }
  const at = (line: number, col: number): Loc => ({ line, col, offset: starts[line] + col })
  const span = (line: number, a: number, b: number, endLine = line): Pos => ({ start: at(line, a), end: at(endLine, b) })
  const out: CachedMetadata = {}
  const push = <K extends keyof CachedMetadata>(k: K, v: NonNullable<CachedMetadata[K]> extends (infer T)[] ? T : never) => {
    ((out[k] ??= [] as never) as unknown[]).push(v)
  }
  let i = 0
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1)
    if (end > 0) {
      try {
        const fm = parseYaml(lines.slice(1, end).join("\n"))
        if (fm && typeof fm === "object" && !Array.isArray(fm)) {
          out.frontmatter = fm as Record<string, unknown>
          for (const [key, v] of Object.entries(fm)) {
            for (const s of (Array.isArray(v) ? v : [v])) {
              if (typeof s !== "string") continue
              for (const m of s.matchAll(LINK)) (out.frontmatterLinks ??= []).push({ key, link: m[2] + (m[3] ?? ""), original: m[0], ...(m[4] ? { displayText: m[4] } : {}) })
            }
          }
        }
      } catch { /* not YAML: no frontmatter */ }
      out.frontmatterPosition = span(0, 0, 3, end)
      push("sections", { type: "yaml", position: out.frontmatterPosition })
      i = end + 1
    }
  }
  // The list item each indentation belongs to, for listItems' parent (negative: the list's first line).
  let listStart = -1
  const stack: { indent: number; line: number }[] = []
  let section = null as { type: string; from: number } | null
  const close = (to: number) => {
    if (!section) return
    const pos = span(section.from, 0, lines[to].length, to)
    const last = lines[to].match(/\s\^([\w-]+)\s*$/)
    push("sections", { type: section.type, position: pos, ...(last ? { id: last[1] } : {}) })
    if (last) (out.blocks ??= {})[last[1]] = { id: last[1], position: pos }
    section = null
  }
  const open = (type: string, line: number) => {
    if (section?.type === type && (type === "list" || type === "blockquote" || type === "callout" || type === "table" || type === "paragraph")) return
    if (section) close(line - 1)
    section = { type, from: line }
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^(\s*)(```+|~~~+)/.exec(line)
    if (fence) {
      if (section) close(i - 1)
      let j = i + 1
      while (j < lines.length && !lines[j].trimStart().startsWith(fence[2])) j++
      push("sections", { type: "code", position: span(i, 0, (lines[j] ?? "").length, Math.min(j, lines.length - 1)) })
      i = j
      continue
    }
    if (line.trimStart().startsWith("%%") && !line.trim().slice(2).includes("%%")) {
      if (section) close(i - 1)
      let j = i + 1
      while (j < lines.length && !lines[j].includes("%%")) j++
      push("sections", { type: "comment", position: span(i, 0, (lines[j] ?? "").length, Math.min(j, lines.length - 1)) })
      i = j
      continue
    }
    if (line.trim() === "$$") {
      if (section) close(i - 1)
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== "$$") j++
      push("sections", { type: "math", position: span(i, 0, (lines[j] ?? "").length, Math.min(j, lines.length - 1)) })
      i = j
      continue
    }
    if (!line.trim()) { if (section) close(i - 1); stack.length = 0; listStart = -1; continue }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      if (section) close(i - 1)
      push("headings", { heading: h[2], level: h[1].length, position: span(i, 0, line.length) })
      push("sections", { type: "heading", position: span(i, 0, line.length) })
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      if (section) close(i - 1)
      push("sections", { type: "thematicBreak", position: span(i, 0, line.length) })
    } else if (/^\[\^[^\]]+\]:/.test(line)) {
      open("footnoteDefinition", i)
      push("footnotes", { id: /^\[\^([^\]]+)\]/.exec(line)![1], position: span(i, 0, line.length) })
    } else {
      const li = LIST.exec(line)
      if (li) {
        open("list", i)
        if (listStart < 0) listStart = i
        const indent = li[1].replace(/\t/g, "    ").length
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
        const id = line.match(/\s\^([\w-]+)\s*$/)?.[1]
        push("listItems", { parent: stack.length ? stack[stack.length - 1].line : -listStart - 1, ...(li[2] !== undefined ? { task: li[2] } : {}), ...(id ? { id } : {}), position: span(i, li[1].length, line.length) })
        if (id) (out.blocks ??= {})[id] = { id, position: span(i, li[1].length, line.length) }
        stack.push({ indent, line: i })
      } else if (/^\s*>/.test(line)) open(section?.type === "callout" ? "callout" : /^\s*>\s*\[!/.test(line) ? "callout" : "blockquote", i)
      else if (/^\s*\|/.test(line)) open("table", i)
      else if (/^\s*</.test(line) && section?.type !== "paragraph") open("html", i)
      else if (section?.type !== "list") open("paragraph", i)
    }
    // (inline code and %%comments%% hold no links or tags: blanked, so positions stay)
    const plain = line.replace(/`[^`]*`|%%.*?%%/g, (x) => " ".repeat(x.length))
    for (const m of plain.matchAll(LINK)) {
      const sub = (m[3] ?? "").replace(/^#/, "").replace(/#/g, " > ")
      const shown = m[4] ?? (m[2] ? (sub ? `${m[2]} > ${sub}` : m[2]) : sub)
      push(m[1] ? "embeds" : "links", { link: (m[2] + (m[3] ?? "")).trim(), original: line.slice(m.index!, m.index! + m[0].length), displayText: shown, position: span(i, m.index!, m.index! + m[0].length) })
    }
    for (const m of plain.matchAll(MDLINK)) {
      if (!m[3] || /^[a-z][\w+.-]*:/i.test(m[3])) continue
      let target = m[3]
      try { target = decodeURIComponent(target) } catch { /* as written */ }
      push(m[1] ? "embeds" : "links", { link: target.replace(/\.md$/i, "") + (m[4] ?? ""), original: line.slice(m.index!, m.index! + m[0].length), displayText: m[2], position: span(i, m.index!, m.index! + m[0].length) })
    }
    // (a heading's own # isn't a tag: TAG wants no space after it)
    for (const m of plain.matchAll(TAG)) {
      const col = m.index! + m[0].indexOf("#")
      push("tags", { tag: `#${m[1]}`, position: span(i, col, col + m[1].length + 1) })
    }
  }
  if (section) close(lines.length - 1)
  return out
}
