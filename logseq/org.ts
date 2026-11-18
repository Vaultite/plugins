// A Logseq page written in Org mode as the same outline (its Markdown): headlines as blocks, drawers as properties.
// What it can't say (footnotes, other drawers, #+ settings past the page's own) gives null: the file is kept as .org.
import type { Block, Page } from "./outline.ts"

const EMPH = (c: string) => new RegExp(`(^|[\\s('"{\\[])${c}([^\\s${c}](?:[^${c}\\n]*?[^\\s${c}])?)${c}(?=[\\s.,;:!?')"}\\]]|$)`, "g")
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

/** Org's inline markup as Markdown's. */
export function orgInline(s: string): string {
  return s.split(/(=[^=\n]+=|~[^~\n]+~)/).map((part, i) => {
    if (i % 2) return `\`${part.slice(1, -1)}\``
    return part
      .replace(/\[\[([a-z][\w+.-]*:\/\/[^\]\s]+)\]\]/gi, "<$1>")
      .replace(/\[\[(file:)?([^\]]+)\]\[([^\]]+)\]\]/g, (_, file: string | undefined, href: string, label: string) => (file || /^[a-z]+:/i.test(href) || /^\.{0,2}\//.test(href) || /\.(org|md)$/i.test(href) ? `${IMAGE.test(href) ? "!" : ""}[${label}](${href})` : `[${label}]([[${href}]])`))
      .replace(/\[\[file:([^\]]+)\]\]/g, (_, href: string) => `${IMAGE.test(href) ? "!" : ""}[${href.split("/").pop()}](${href})`)
      .replace(/\[\[(\.{0,2}\/[^\]]+)\]\]/g, (_, href: string) => `${IMAGE.test(href) ? "!" : ""}[${href.split("/").pop()}](${href})`)
      .replace(EMPH("\\*"), "$1**$2**").replace(EMPH("/"), "$1*$2*").replace(EMPH("\\+"), "$1~~$2~~")
  }).join("")
}

const HEADLINE = /^(\*+)(?:\s+(.*))?$/
const KEYWORD = /^#\+(\w+):\s*(.*)$/

export function parseOrg(text: string): Page | null {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")
  const page: Page = { props: [], blocks: [] }
  const head: string[] = []
  const stack: { block: Block; level: number }[] = []
  let i = 0
  const drawer = (from: number, into: (k: string, v: string) => void) => {
    let j = from + 1
    for (; j < lines.length && !/^\s*:END:\s*$/i.test(lines[j]); j++) {
      const m = /^\s*:([^:\s]+):\s*(.*)$/.exec(lines[j])
      if (m) into(m[1], m[2])
    }
    return j
  }
  for (; i < lines.length && !HEADLINE.test(lines[i]); i++) {
    const l = lines[i], k = KEYWORD.exec(l)
    if (k && !/^BEGIN_|^END_/i.test(k[1])) { page.props.push({ key: k[1].toLowerCase(), value: k[2] }); continue }
    if (/^\s*:PROPERTIES:\s*$/i.test(l)) { i = drawer(i, (key, value) => page.props.push({ key, value })); continue }
    if (l.trim()) head.push(orgInline(l))
  }
  if (head.length) page.blocks.push({ lines: head, children: [], bare: true })
  let inBlock = false
  for (; i < lines.length; i++) {
    const l = lines[i]
    const h = inBlock ? null : HEADLINE.exec(l)
    if (h) {
      const level = h[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      const head = h[2] ?? "", tags = /\s+:([\w@#%:]+):\s*$/.exec(head)
      let title = orgInline(tags ? head.slice(0, tags.index) : head)
      if (tags) title += ` ${tags[1].split(":").filter(Boolean).map((t) => `#${t}`).join(" ")}`
      const block: Block = { lines: [title], children: [] }
      ;(stack.length ? stack[stack.length - 1].block.children : page.blocks).push(block)
      stack.push({ block, level })
      continue
    }
    const top = stack[stack.length - 1]
    if (!top) continue
    if (/^\s*#\+BEGIN_/i.test(l)) inBlock = true
    if (/^\s*#\+END_/i.test(l)) { inBlock = false; top.block.lines.push(l.trim()); continue }
    if (inBlock) { top.block.lines.push(l); continue }
    if (/^\s*:PROPERTIES:\s*$/i.test(l)) { i = drawer(i, (key, value) => top.block.lines.push(`${key}:: ${value}`)); continue }
    if (/^\s*:LOGBOOK:\s*$/i.test(l)) {
      const end = lines.findIndex((x, j) => j > i && /^\s*:END:\s*$/i.test(x))
      if (end < 0) return null
      top.block.lines.push(...lines.slice(i, end + 1).map((x) => x.trim()))
      i = end
      continue
    }
    if (/^\s*:\w+:\s*$/.test(l) || /\[fn:/.test(l) || (KEYWORD.test(l.trim()) && !/^#\+(CAPTION|NAME):/i.test(l.trim()))) return null
    const table = /^\s*\|[-+|]+\|?\s*$/.test(l) ? l.replace(/\+/g, "|") : l
    top.block.lines.push(orgInline(table.replace(/^\s+/, "")))
  }
  return page
}
