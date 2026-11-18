// A Logseq page's file as its outline: page properties, then blocks, each its lines and children.
export type Prop = { key: string; value: string }
export type Block = {
  /** Its lines, without its bullet and indentation: the first is its title. */
  lines: string[]
  children: Block[]
  /** `1.` instead of `-`. */
  numbered?: boolean
  /** A paragraph of a note (not a list item, nor a heading). */
  para?: boolean
  /** Written without a bullet: a heading at a line's start, or text before the first bullet. */
  bare?: boolean
}
export type Page = { props: Prop[]; blocks: Block[] }

export const PROP = /^([^\s:`"'[\](){}#][^\s:]*?)::(?:[ \t]+(.*?))?\s*$/u
const BULLET = /^([ \t]*)([-*+])(?:[ \t]+(.*)|[ \t]*)$/
const FENCE = /^\s*(`{3,}|~{3,})/
const BEGIN = /^\s*#\+BEGIN_(\w+)/i

const width = (ws: string) => { let w = 0; for (const c of ws) w = c === "\t" ? w + 4 - (w % 4) : w + 1; return w }

/** Strips up to `n` columns of leading whitespace. */
function dedent(line: string, n: number) {
  let w = 0, i = 0
  while (i < line.length && w < n && (line[i] === " " || line[i] === "\t")) { w = line[i] === "\t" ? w + 4 - (w % 4) : w + 1; i++ }
  return line.slice(i)
}

function yamlProps(lines: string[]): { props: Prop[]; rest: string[] } | null {
  if (lines[0]?.trim() !== "---") return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
  if (end < 0) return null
  const props: Prop[] = []
  let key: string | null = null
  for (const l of lines.slice(1, end)) {
    const m = /^([\w.\-/]+):\s*(.*)$/.exec(l)
    if (m) { key = m[1]; props.push({ key, value: m[2].replace(/^["']|["']$/g, "") }); continue }
    const item = /^\s+-\s+(.*)$/.exec(l)
    if (item && key) { const p = props[props.length - 1]; p.value = p.value ? `${p.value}, ${item[1]}` : item[1] }
  }
  return { props, rest: lines.slice(end + 1) }
}

export function parsePage(text: string): Page {
  let lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")
  const page: Page = { props: [], blocks: [] }
  const yaml = yamlProps(lines)
  if (yaml) { page.props.push(...yaml.props); lines = yaml.rest }
  const stack: { block: Block; indent: number; content: number }[] = []
  let fence: string | null = null, begin: string | null = null
  let i = 0
  // page properties: key:: value lines at the top
  while (i < lines.length && !lines[i].trim()) i++
  for (; i < lines.length; i++) {
    // (an older page wrote them Org's way: #+alias: x)
    const org = /^#\+(?!BEGIN_|END_)(\w[\w-]*):[ \t]*(.*)$/i.exec(lines[i].trim())
    const m = PROP.exec(lines[i].trim()) ?? org
    if (!m || BULLET.test(lines[i])) break
    page.props.push({ key: org ? m[1].toLowerCase() : m[1], value: m[2] ?? "" })
  }
  for (; i < lines.length; i++) {
    const l = lines[i]
    const free = !fence && !begin
    const b = free ? BULLET.exec(l) : null
    if (b) {
      const indent = width(b[1])
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      const block: Block = { lines: [b[3] ?? ""], children: [] }
      if (stack.length) stack[stack.length - 1].block.children.push(block)
      else page.blocks.push(block)
      stack.push({ block, indent, content: indent + 2 })
      track(b[3] ?? "")
      continue
    }
    // Logseq makes a block of a heading at a line's start, and of text before the first bullet: one without a bullet
    if ((free && /^#{1,6}\s/.test(l)) || (!stack.length && l.trim())) {
      const block: Block = { lines: [l], children: [], bare: true }
      page.blocks.push(block)
      stack.length = 0
      stack.push({ block, indent: 0, content: 0 })
      track(l)
      continue
    }
    const top = stack[stack.length - 1]
    if (!top) continue
    const line = dedent(l, top.content)
    top.block.lines.push(line)
    track(line)
  }
  for (const s of allBlocks(page.blocks)) while (s.lines.length > 1 && !s.lines[s.lines.length - 1].trim()) s.lines.pop()
  return page

  function track(line: string) {
    if (fence) { if (line.trim().startsWith(fence) && /^\s*(`+|~+)\s*$/.test(line)) fence = null; return }
    if (begin) { if (new RegExp(`^\\s*#\\+END_${begin}\\b`, "i").test(line)) begin = null; return }
    const f = FENCE.exec(line)
    if (f) { fence = f[1]; return }
    const m = BEGIN.exec(line)
    if (m && !new RegExp(`#\\+END_${m[1]}\\b`, "i").test(line)) begin = m[1]
  }
}

export function* allBlocks(blocks: Block[]): Generator<Block> {
  for (const b of blocks) { yield b; yield* allBlocks(b.children) }
}

/** A block's parts: its properties, its SCHEDULED/DEADLINE, its logbook and the rest of its text. */
export type Parts = { title: string; props: Prop[]; scheduled: string | null; deadline: string | null; logbook: string[]; body: string[] }

const PLANNING = /^\s*(SCHEDULED|DEADLINE):\s*(<[^>]+>)/

export function blockParts(lines: string[]): Parts {
  const out: Parts = { title: "", props: [], scheduled: null, deadline: null, logbook: [], body: [] }
  let k = 0
  if (PROP.test((lines[0] ?? "").trim())) out.title = ""
  else { out.title = lines[0] ?? ""; k = 1 }
  for (; k < lines.length; k++) {
    const l = lines[k]
    const p = PROP.exec(l.trim())
    if (p) { out.props.push({ key: p[1], value: p[2] ?? "" }); continue }
    if (PLANNING.test(l)) {
      let rest = l
      for (let m = PLANNING.exec(rest); m; m = PLANNING.exec(rest)) {
        if (m[1] === "SCHEDULED") out.scheduled = m[2]
        else out.deadline = m[2]
        rest = rest.slice(m[0].length)
      }
      if (rest.trim()) { out.body.push(rest.trim()); k++; break }
      continue
    }
    if (/^\s*:LOGBOOK:\s*$/.test(l)) {
      const end = lines.findIndex((x, j) => j > k && /^\s*:END:\s*$/.test(x))
      if (end < 0) break
      out.logbook = lines.slice(k, end + 1).map((x) => x.trim())
      k = end
      continue
    }
    break
  }
  out.body.push(...lines.slice(k))
  return out
}
