// A note's Markdown as an outline, for Logseq: list items keep their nesting; headings hold what's under them; a
// paragraph, a code block, a quote or a table is one block.
import type { Block } from "./outline.ts"

const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/
const HEADING = /^(#{1,6})[ \t]+\S/
const FENCE = /^[ \t]*(`{3,}|~{3,})/

const width = (ws: string) => { let w = 0; for (const c of ws) w = c === "\t" ? w + 4 - (w % 4) : w + 1; return w }
function dedent(line: string, n: number) {
  let w = 0, i = 0
  while (i < line.length && w < n && (line[i] === " " || line[i] === "\t")) { w = line[i] === "\t" ? w + 4 - (w % 4) : w + 1; i++ }
  return line.slice(i)
}

type Open = { block: Block; indent: number; content: number }

/** The blocks of a note's body (no frontmatter). */
export function outlineOf(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n")
  const top: Block[] = []
  const headings: { block: Block; level: number }[] = []
  const container = () => (headings.length ? headings[headings.length - 1].block.children : top)
  let items: Open[] = []
  let para: Block | null = null
  let fence: string | null = null, math = false, comment = false
  let pendingBlank = 0

  for (const raw of lines) {
    const l = raw.replace(/\s+$/, (s) => (fence ? s : ""))
    // inside a code block, $$ math or a %% comment: the line is the open block's, as it is
    const inner = fence || math || comment
    if (inner) {
      const into = items.length ? items[items.length - 1] : null
      if (into) into.block.lines.push(dedent(l, into.content))
      else para!.lines.push(l)
      if (fence && l.trim().startsWith(fence) && /^\s*(`+|~+)\s*$/.test(l)) fence = null
      else if (math && /\$\$/.test(l)) math = false
      else if (comment && /%%\s*$/.test(l)) comment = false
      continue
    }
    if (!l.trim()) { pendingBlank++; para = null; continue }
    const indent = width(/^[ \t]*/.exec(l)![0])
    const m = ITEM.exec(l)
    const opens = (s: string) => {
      const f = FENCE.exec(s)
      if (f) fence = f[1]
      // ($$ math is open after a line with an odd number of $$)
      else if (/^\s*\$\$/.test(s) && (s.match(/\$\$/g) ?? []).length % 2) math = true
      else if (/^\s*%%/.test(s) && !/^\s*%%.*%%\s*$/.test(s)) comment = true
    }
    // a list item, or a line of the one it's in
    // (a numbered line at its item's text column is that item's text: Logseq writes no list in a block)
    const text = m && /\d/.test(m[2]) && items.length && indent >= items[items.length - 1].content && indent < items[items.length - 1].content + 2 && !items[items.length - 1].block.numbered
    if (m && !text && (items.length || indent < 4)) {
      while (items.length && items[items.length - 1].indent >= indent) items.pop()
      const block: Block = { lines: [m[3] ?? ""], children: [], numbered: /\d/.test(m[2]) }
      ;(items.length ? items[items.length - 1].block.children : container()).push(block)
      items.push({ block, indent, content: indent + m[2].length + 1 })
      opens(m[3] ?? "")
      pendingBlank = 0; para = null
      continue
    }
    if (items.length) {
      const into = [...items].reverse().find((o) => indent >= o.content)
      if (into || !pendingBlank) {
        const o = into ?? items[items.length - 1]
        while (items[items.length - 1] !== o) items.pop()
        for (let k = 0; k < pendingBlank; k++) o.block.lines.push("")
        o.block.lines.push(dedent(l, o.content))
        opens(dedent(l, o.content))
        pendingBlank = 0
        continue
      }
      items = []
    }
    const h = HEADING.exec(l)
    if (h) {
      const level = h[1].length
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop()
      const block: Block = { lines: [l], children: [] }
      container().push(block)
      headings.push({ block, level })
      para = null; pendingBlank = 0
      continue
    }
    // a paragraph, quote or table goes on until a blank line
    const kind = (s: string) => (/^\s*>/.test(s) ? ">" : /^\s*\|/.test(s) ? "|" : "p")
    if (para && kind(para.lines[para.lines.length - 1]) === kind(l)) para.lines.push(l)
    else {
      para = { lines: [l], children: [], para: true }
      container().push(para)
    }
    opens(l)
    pendingBlank = 0
  }
  return top
}
