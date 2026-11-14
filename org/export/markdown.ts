// An Org file as Markdown, for /api/render, embeds and AIs reading it: headings keep their TODO keyword, priority and
// tags; planning, properties and clocks stay as Org writes them (in code); file: links become vault links.
import { isText, type OrgChild, type OrgNode, parse } from "../parser/index.ts"
import { isFileLink, isImage, vaultPath } from "./links.ts"

export type MarkdownOptions = {
  /** The file's vault path: file: links resolve from its folder, and a #+TITLE that is its name isn't repeated. */
  path?: string
  /** Only the subtree under this heading (its title or CUSTOM_ID): an embed's ![[Plan.org#Heading]]. */
  sub?: string
}

type Ctx = { src: string; dir: string; notes: string[]; defined: Set<string>; anon: number }
/** A block of Markdown; `meta` ones (planning, properties, settings) sit on consecutive lines, not apart. */
type Block = { md: string; meta?: boolean }

const str = (x: unknown) => (typeof x === "string" ? x : isText(x as OrgChild) ? (x as { value: string }).value : String(x ?? ""))
const kids = (n: OrgNode): OrgChild[] => n.children ?? []
const nodes = (n: OrgNode): OrgNode[] => kids(n).filter((c): c is OrgNode => !isText(c))

export const orgMarkdown = (text: string, opts: MarkdownOptions = {}) => treeMarkdown(parse(text), text, opts)

/** A parsed file (`doc`, of `text`) as Markdown. */
export function treeMarkdown(doc: OrgNode, text: string, opts: MarkdownOptions = {}): string {
  const rel = opts.path ?? ""
  const c: Ctx = { src: text, dir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "", notes: [], defined: new Set(), anon: 0 }
  let out: string
  if (opts.sub) {
    const h = findHeadline(doc, opts.sub)
    if (!h) return `_(no heading ${opts.sub} in ${rel || "this file"})_`
    out = join(element(h, c))
  } else {
    const title = titleOf(doc), stem = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.org$/i, "")
    const head = title && norm(title) !== norm(stem) ? [{ md: `# ${escape(title)}` }] : []
    out = join([...head, ...children(doc, c, true)])
  }
  if (c.notes.length) out += `\n\n${c.notes.join("\n")}`
  return out.trim()
}

const norm = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, " ").trim()

/** The document's #+TITLE (several are joined, as Org does), from its first section. */
function titleOf(doc: OrgNode): string {
  const first = nodes(doc)[0]
  if (first?.type !== "section") return ""
  return nodes(first).filter((n) => n.type === "keyword" && n.key === "TITLE").map((n) => String(n.value ?? "").trim()).filter(Boolean).join(" ")
}

function findHeadline(n: OrgNode, sub: string): OrgNode | null {
  const want = sub.trim().replace(/^\*+\s*/, "").toLowerCase(), id = want.replace(/^#/, "")
  for (const h of nodes(n)) {
    if (h.type !== "headline") continue
    if (String(h.rawValue ?? "").trim().toLowerCase() === want || (typeof h.properties?.CUSTOM_ID === "string" && h.properties.CUSTOM_ID.toLowerCase() === id)) return h
    const deeper = findHeadline(h, sub)
    if (deeper) return deeper
  }
  return null
}

function join(blocks: Block[]): string {
  let out = ""
  blocks.forEach((b, i) => {
    if (i) out += b.meta && blocks[i - 1].meta ? "\n" : "\n\n"
    out += b.md
  })
  return out
}

function children(n: OrgNode, c: Ctx, top = false): Block[] {
  const out: Block[] = []
  for (const k of nodes(n)) {
    if (top && k.type === "section") {
      for (const x of nodes(k)) if (!(x.type === "keyword" && x.key === "TITLE")) out.push(...element(x, c))
      continue
    }
    out.push(...element(k, c))
  }
  return out
}

const INFO: Record<string, string> = { AUTHOR: "Author", DATE: "Date", EMAIL: "Email", SUBTITLE: "Subtitle", DESCRIPTION: "Description",
  KEYWORDS: "Keywords", FILETAGS: "Tags", CATEGORY: "Category", LANGUAGE: "Language" }

function element(n: OrgNode, c: Ctx): Block[] {
  const raw = (s: string) => [{ md: s }]
  const meta = (s: string) => [{ md: s, meta: true }]
  switch (n.type) {
    case "section": case "center-block": return children(n, c)
    case "headline": return [{ md: heading(n, c) }, ...children(n, c)]
    case "inlinetask": return raw(quote(join([{ md: `**${headParts(n, c)}**` }, ...children(n, c)])))
    case "paragraph": return raw(paragraph(inline(kids(n), c)))
    case "planning": {
      const stamps = (["closed", "scheduled", "deadline"] as const).map((k) => [k, n[k] as OrgNode | null] as const).filter(([, t]) => t)
        .sort((a, b) => a[1]!.begin - b[1]!.begin)
      return meta(code(stamps.map(([k, t]) => `${k.toUpperCase()}: ${t!.rawValue}`).join(" ")))
    }
    case "property-drawer": {
      const props = nodes(n).filter((p) => p.type === "node-property").map((p) => code(`:${p.key}: ${p.value ?? ""}`.trimEnd()))
      return props.length ? meta(props.join(" ")) : []
    }
    case "clock": {
      const t = n.value as OrgNode | null
      return meta(code(`CLOCK: ${t?.rawValue ?? ""}${n.duration ? ` =>  ${n.duration}` : ""}`))
    }
    case "drawer": return raw(quote(join([{ md: code(`:${n.drawerName}:`) }, ...children(n, c)])))
    case "keyword": {
      const key = String(n.key), value = String(n.value ?? "").trim()
      if (INFO[key]) return meta(`${INFO[key]}: ${escape(value)}`)
      return meta(code(`#+${key}: ${value}`.trimEnd()))
    }
    case "plain-list": return raw(list(n, c))
    case "table": return table(n, c)
    case "src-block": return raw(fence(dedent(String(n.value ?? "")), [n.language, n.switches, n.parameters].filter(Boolean).join(" ")))
    case "example-block": case "fixed-width": return raw(fence(dedent(String(n.value ?? "")), ""))
    case "export-block": {
      const kind = String(n.kind ?? "").toLowerCase(), value = String(n.value ?? "").replace(/\n$/, "")
      return raw(kind === "md" || kind === "markdown" ? value : fence(value, kind))
    }
    case "quote-block": return raw(quote(join(children(n, c))))
    case "verse-block": {
      const lines = inline(kids(n), c).replace(/\n$/, "").split("\n").map((l) => l.trim())
      return raw(quote(lines.map((l, i) => (l && lines[i + 1] ? `${l}\\` : l)).join("\n")))
    }
    case "special-block": {
      const kind = String(n.kind ?? "")
      return raw(quote(join([{ md: `**${kind.charAt(0).toUpperCase()}${kind.slice(1)}**` }, ...children(n, c)])))
    }
    case "dynamic-block": return [...meta(code(`#+BEGIN: ${n.blockName}${n.arguments ? ` ${n.arguments}` : ""}`)), ...children(n, c)]
    case "horizontal-rule": return raw("---")
    case "latex-environment": return raw(`$$\n${String(n.value ?? "").trim()}\n$$`)
    case "babel-call": return meta(code(`#+CALL: ${n.value ?? ""}`))
    case "diary-sexp": return meta(code(String(n.value ?? "")))
    case "footnote-definition": return raw(footnote(String(n.label), join(children(n, c))))
    case "comment": case "comment-block": return []
    case "table-row": case "item": case "node-property": return []
    default: return n.children ? children(n, c) : raw(escape(c.src.slice(n.begin, n.end).trim()))
  }
}

function headParts(n: OrgNode, c: Ctx): string {
  const parts: string[] = []
  if (n.todoKeyword) parts.push(String(n.todoKeyword))
  if (typeof n.priority === "number") parts.push(`[#${String.fromCharCode(n.priority)}]`)
  if (n.commentedp) parts.push("COMMENT")
  const title = inline((n.title as OrgChild[] | null) ?? [], c).replace(/\s*\n\s*/g, " ").trim()
  if (title) parts.push(title)
  const tags = ((n.tags as unknown[] | null) ?? []).map(str)
  if (tags.length) parts.push(`:${tags.join(":")}:`)
  return parts.join(" ")
}

/** Level 1 is ##: the file's name (or its #+TITLE) is the page's #. */
const heading = (n: OrgNode, c: Ctx) => `${"#".repeat(Math.min(6, Number(n.level) + 1))} ${headParts(n, c)}`.trimEnd()

const quote = (md: string) => md.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")
const indent = (md: string, by: number) => md.split("\n").map((l, i) => (i && l ? " ".repeat(by) + l : l)).join("\n")
const footnote = (label: string, md: string) => `[^${label}]: ${indent(md, 4)}`

function code(s: string): string {
  const runs = s.match(/`+/g), n = runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1, tick = "`".repeat(n)
  return n > 1 || s.startsWith(" ") || s.endsWith(" ") ? `${tick} ${s} ${tick}` : `${tick}${s}${tick}`
}

export function fence(body: string, info: string): string {
  const runs = body.match(/^`{3,}/gm), tick = "`".repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 3)
  return `${tick}${info}\n${body.replace(/\n$/, "")}\n${tick}`
}

function dedent(s: string): string {
  const lines = s.split("\n"), widths = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const by = widths.length ? Math.min(...widths) : 0
  return by ? lines.map((l) => l.slice(by)).join("\n") : s
}

// What would start a Markdown block at a line's start: a heading, quote, list item, rule or setext underline.
const LINE_START = /^(?:#{1,6}(?=\s|$)|>|[-+*](?=\s)|=+\s*$|-+\s*$|\|)/
const NUMBERED = /^(\d+)([.)])(?=\s)/

function paragraph(md: string): string {
  return md.replace(/\n$/, "").split("\n").map((l) => {
    const t = l.replace(/^[ \t]+/, "")
    if (NUMBERED.test(t)) return t.replace(NUMBERED, "$1\\$2")
    return LINE_START.test(t) ? `\\${t}` : t
  }).join("\n")
}

function list(n: OrgNode, c: Ctx): string {
  const ordered = n.kind === "ordered"
  let num = 0
  return nodes(n).filter((i) => i.type === "item").map((it, i) => {
    // (numbered as Org exports them: from the first bullet's number, a [@5] counter restarting the count)
    num = typeof it.counter === "number" ? it.counter : i ? num + 1 : parseInt(String(it.bullet), 10) || 1
    const marker = ordered ? `${num}. ` : "- "
    const box = it.checkbox === "on" ? "[x] " : it.checkbox === "off" ? "[ ] " : it.checkbox === "trans" ? "[-] " : ""
    const tag = Array.isArray(it.tag) && it.tag.length ? `**${inline(it.tag as OrgChild[], c).trim()}**: ` : ""
    const parts = nodes(it)
    let body = ""
    parts.forEach((p, i) => {
      const md = join(element(p, c))
      if (!md) return
      body += !body ? md : (p.type === "plain-list" && parts[i - 1]?.type === "paragraph" ? "\n" : "\n\n") + md
    })
    const lead = marker + box + tag
    const first = parts[0]?.type === "paragraph" || !body ? body : `\n${body}`
    return indent(lead + first, marker.length).replace(/[ \t]+$/, "")
  }).join("\n")
}

function table(n: OrgNode, c: Ctx): Block[] {
  if (n.kind === "table.el") return [{ md: fence(String(n.value ?? "").replace(/\n$/, ""), "") }]
  const rows = nodes(n).filter((r) => r.type === "table-row")
  const cells = (r: OrgNode) => nodes(r).filter((x) => x.type === "table-cell").map((x) => inline(kids(x), c).trim().replace(/\|/g, "\\|"))
  const cookies = (cs: string[]) => cs.some(Boolean) && cs.every((x) => !x || /^\\?<[lrc]?\d*>$/.test(x))
  const body = rows.filter((r) => r.kind !== "rule").map(cells).filter((cs) => !cookies(cs))
  if (!body.length) return []
  const width = Math.max(...body.map((r) => r.length))
  const line = (cs: string[]) => `| ${Array.from({ length: width }, (_, i) => cs[i] ?? "").join(" | ")} |`
  // (Markdown's header is the first row, whether or not a rule follows it in Org)
  const out = [line(body[0]), `|${" --- |".repeat(width)}`, ...body.slice(1).map(line)].join("\n")
  const blocks: Block[] = []
  const caption = captionOf(n, c)
  if (caption) blocks.push({ md: `_${caption}_` })
  blocks.push({ md: out })
  for (const f of ((n.tblfm as unknown[] | null) ?? []).map(str)) blocks.push({ md: code(`#+TBLFM: ${f}`), meta: true })
  return blocks
}

/** #+CAPTION: as Emacs keeps it: a list of [caption] or [caption, short caption], each objects. */
function captionOf(n: OrgNode, c: Ctx): string {
  const cap = n.caption
  if (!Array.isArray(cap) || !cap.length) return ""
  return cap.map((entry) => {
    const long = Array.isArray(entry) ? entry[0] : entry
    return Array.isArray(long) ? inline(long as OrgChild[], c).trim() : isText(long as OrgChild) ? escape((long as { value: string }).value) : ""
  }).filter(Boolean).join(" ")
}

// ---------- objects

function inline(list: OrgChild[], c: Ctx): string {
  let out = ""
  for (const o of list) out += isText(o) ? escape(o.value) : object(o, c) + " ".repeat(o.postBlank || 0)
  return out
}

function object(o: OrgNode, c: Ctx): string {
  const inner = () => inline(kids(o), c)
  switch (o.type) {
    case "bold": return `**${inner()}**`
    case "italic": return `*${inner()}*`
    case "underline": return `<u>${inner()}</u>`
    case "strike-through": return `~~${inner()}~~`
    case "code": case "verbatim": case "inline-src-block": return code(String(o.value ?? ""))
    case "inline-babel-call": return code(String(o.value ?? ""))
    case "entity": return String(o.utf8 ?? `\\${o.name}`)
    case "latex-fragment": return math(String(o.value ?? ""))
    case "line-break": return "\\\n"
    case "link": return link(o, c, inner())
    case "target": return ""
    case "radio-target": return inner()
    case "statistics-cookie": return String(o.value ?? "")
    case "timestamp": return String(o.rawValue ?? "")
    case "macro": return String(o.value ?? "")
    case "footnote-reference": {
      let label = o.label ? String(o.label) : ""
      if (o.kind === "inline") {
        if (!label) label = `inline-${++c.anon}`
        if (!c.defined.has(label)) { c.defined.add(label); c.notes.push(footnote(label, paragraph(inner()))) }
      }
      return `[^${label}]`
    }
    case "export-snippet": return /^(md|markdown)$/i.test(String(o.backEnd)) ? String(o.value ?? "") : ""
    case "subscript": return o.useBracketsP ? `<sub>${inner()}</sub>` : `_${inner()}`
    case "superscript": return o.useBracketsP ? `<sup>${inner()}</sup>` : `^${inner()}`
    case "citation": return c.src.slice(o.begin, o.end).trimEnd()
    default: return o.children ? inner() : escape(c.src.slice(o.begin, o.end).trimEnd())
  }
}

function math(v: string): string {
  if (v.startsWith("\\(") && v.endsWith("\\)")) return `$${v.slice(2, -2).trim()}$`
  if (v.startsWith("\\[") && v.endsWith("\\]")) return `$$${v.slice(2, -2).trim()}$$`
  if (v.startsWith("$")) return v
  return `$${v}$`
}

const SAFE_URL = /^[^\s()<>]+$/
const mdLink = (text: string, url: string) => `[${text}](${SAFE_URL.test(url) ? url : `<${url.replace(/[<>]/g, encodeURIComponent)}>`})`
const wikiText = (s: string) => s.replace(/\]\]/g, "] ]").replace(/\|/g, "\\|")

function link(o: OrgNode, c: Ctx, desc: string): string {
  const kind = String(o.kind ?? ""), path = String(o.path ?? ""), raw = String(o.rawLink ?? path)
  if (kind === "radio") return desc || escape(path)
  if (kind === "coderef") return desc || escape(`(${path})`)
  if (isFileLink(o)) {
    const p = vaultPath(c.dir, path)
    if (p === null) return mdLink(desc || escape(raw), raw)
    if (!desc && isImage(p)) return `![[${p}]]`
    const anchor = searchAnchor(String(o.searchOption ?? ""))
    return `[[${p}${anchor}${desc ? `|${wikiText(desc)}` : ""}]]`
  }
  if (kind === "fuzzy" && path.startsWith("*")) return `[[#${path.slice(1).trim()}${desc ? `|${wikiText(desc)}` : ""}]]`
  if (kind === "fuzzy" || kind === "custom-id") return mdLink(desc || escape(path), `#${path.replace(/\s+/g, "-")}`)
  const url = kind === "doi" ? `https://doi.org/${path}` : raw
  if (!desc && /^https?:/.test(url) && isImage(url)) return `![](${url})`
  if (!desc && SAFE_URL.test(url) && /^[a-z][\w+.-]*:/i.test(url)) return `<${url}>`
  return mdLink(desc || escape(raw), url)
}

/** file:x.org::*Heading or ::#custom-id as #Heading; a line number or a regexp has no anchor. */
function searchAnchor(opt: string): string {
  const s = opt.replace(/^::/, "").trim()
  if (s.startsWith("*")) return `#${s.slice(1).trim()}`
  if (s.startsWith("#")) return s
  return s && !/^\d+$/.test(s) && !s.startsWith("/") && !s.startsWith("(") ? `#${s}` : ""
}

/** Plain text that Markdown would read as markup, escaped; intraword underscores and lone symbols left as they are. */
export function escape(s: string): string {
  return s.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\").replace(/[*`$]/g, "\\$&").replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_")
    .replace(/~~/g, "\\~\\~").replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/\[(?=\[)/g, "\\[").replace(/\](?=\()/g, "\\]")
}
