// What Dataview knows of a note: its frontmatter, its inline fields (`key:: value`, [key:: value], (key:: value)),
// its list items and tasks, links, tags and the implicit `file` fields. Built from the text the server already
// read (the vault's index), once per version of a file.
import { canonicalKey, DvDate, fromInline, fromYaml, isObject, Link, parseDate, type Value } from "./values.ts"

export type Note = {
  /** Its vault path, "Books/Dune.md". */
  path: string
  fm: Record<string, unknown>
  /** The text after the frontmatter. */
  body: string
  ctime: number
  mtime: number
  size: number
}
export type Resolve = (target: string) => string | null
type Row = Record<string, Value>

const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^([ \t]*)([-*+]|\d+[.)])(?:[ \t]+|$)(?:\[(.)\][ \t]*)?(.*)$/
const TAG = /(?<=^|[\s(,;])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu
const WIKI = /(!?)\[\[([^\]|#^\n]*)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g
const CODE = /(`+)(?!\1)[\s\S]*?\1/g
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/
// The Tasks plugin's dates (Dataview reads them as fields).
const EMOJI: [RegExp, string][] = [
  [/(?:🗓️|🗓|📅|📆)\s*(\d{4}-\d{2}-\d{2})/u, "due"], [/✅\s*(\d{4}-\d{2}-\d{2})/u, "completion"], [/➕\s*(\d{4}-\d{2}-\d{2})/u, "created"],
  [/🛫\s*(\d{4}-\d{2}-\d{2})/u, "start"], [/⏳\s*(\d{4}-\d{2}-\d{2})/u, "scheduled"],
]

export type Field = { key: string; value: string; at: number; end: number; hidden: boolean }

/** The [key:: value] and (key:: value) fields in a line (outside `code`), brackets inside the value kept whole. */
export function bracketFields(line: string): Field[] {
  const out: Field[] = []
  const masked = line.replace(CODE, (m) => " ".repeat(m.length))
  for (let i = 0; i < masked.length; i++) {
    const open = masked[i]
    if (open !== "[" && open !== "(") continue
    if (open === "[" && (masked[i + 1] === "[" || masked[i - 1] === "[")) continue
    const close = open === "[" ? "]" : ")"
    let depth = 0, j = i
    for (; j < masked.length; j++) {
      if (masked[j] === open) depth++
      else if (masked[j] === close && --depth === 0) break
    }
    if (j >= masked.length) continue
    const inner = line.slice(i + 1, j)
    const sep = inner.indexOf("::")
    if (sep > 0) {
      const key = inner.slice(0, sep).trim()
      if (key && !/[[\]()]/.test(key) && key.length <= 100) {
        out.push({ key, value: inner.slice(sep + 2).trim(), at: i, end: j + 1, hidden: open === "(" })
        i = j
      }
    }
  }
  return out
}

/** A whole line that is a field, `Key:: value` (the key may be **bold** or _italic_), or null. */
export function lineField(line: string): { key: string; value: string } | null {
  const sep = line.indexOf("::")
  if (sep <= 0) return null
  const key = line.slice(0, sep).replace(/[*_~]/g, "").trim()
  if (!key || !/^[\p{L}\p{N}\p{Emoji_Presentation}\p{Extended_Pictographic}\s_/-]+$/u.test(key)) return null
  let value = line.slice(sep + 2)
  if (/^[*_~]+/.test(value) && /[*_~]/.test(line.slice(0, sep))) value = value.replace(/^[*_~]+/, "")
  return { key, value: value.trim() }
}

const tagsIn = (s: string) => [...s.replace(CODE, " ").matchAll(TAG)].map((m) => `#${m[1].replace(/\/+$/, "")}`)

/** Each tag and its parents: #a/b/c -> #a, #a/b, #a/b/c (file.tags). */
const withParents = (tags: string[]) => {
  const out: string[] = []
  for (const t of tags) {
    const parts = t.slice(1).split("/")
    for (let i = 1; i <= parts.length; i++) out.push(`#${parts.slice(0, i).join("/")}`)
  }
  return [...new Set(out)]
}

function addField(into: Row, key: string, v: Value) {
  const put = (k: string) => {
    if (!Object.hasOwn(into, k)) into[k] = v
    else if (k !== "file") {
      const was = into[k]
      into[k] = Array.isArray(was) && (was as Value[] & { $multi?: true }).$multi ? [...(was as Value[]), v] : multi([was, v])
    }
  }
  put(key)
  const low = canonicalKey(key)
  if (low && low !== key) put(low)
}
/** A list made of a key's repeated values (`tag:: a` twice), told apart from a list value so a third adds to it. */
function multi(xs: Value[]) {
  Object.defineProperty(xs, "$multi", { value: true, enumerable: false })
  return xs
}

const fmTags = (v: unknown): string[] => {
  const xs = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : []
  return xs.map((x) => String(x ?? "").trim().replace(/^#/, "")).filter(Boolean).map((t) => `#${t}`)
}

const DAY_IN_NAME = /(\d{4})-?(\d{2})-?(\d{2})/

/** A note as Dataview's page: its fields (frontmatter, inline) and `file`. `inlinks` are filled in by `index`. */
export function page(n: Note, resolve: Resolve): Row {
  const row: Row = {}
  const name = n.path.replace(/^.*\//, "").replace(/\.md$/i, "")
  const folder = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : ""
  const link = new Link(n.path)
  const fmLinks: Link[] = []
  const linksOf = (v: Value) => { if (v instanceof Link) fmLinks.push(v); else if (Array.isArray(v)) v.forEach(linksOf); else if (isObject(v)) Object.values(v).forEach(linksOf) }
  for (const [k, v] of Object.entries(n.fm)) { const x = fromYaml(v, resolve); addField(row, k, x); linksOf(x) }

  const lines = n.body.split("\n")
  const outlinks: Link[] = [...fmLinks]
  const etags = new Set(fmTags(n.fm.tags ?? n.fm.tag))
  const items: Row[] = []
  const stack: { indent: number; item: Row; line: number }[] = []
  let section: Link = link, fence: string | null = null
  const linksIn = (s: string) => [...s.replace(CODE, " ").matchAll(WIKI)].map((m) => {
    const t = m[2].trim()
    const hit = t ? resolve(t) : n.path
    return new Link(hit ?? t, m[4]?.trim() || undefined, m[1] === "!", m[3] ? (m[3][0] === "^" ? m[3] : m[3].slice(1)) : undefined, !!hit)
  })

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (f) {
      if (fence === null) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    if (/^%%/.test(line.trim())) continue
    const h = HEADING.exec(line)
    if (h) { section = new Link(n.path, undefined, false, h[2]); stack.length = 0 }
    for (const l of linksIn(line)) outlinks.push(l)
    for (const t of tagsIn(line)) etags.add(t)

    const m = ITEM.exec(line)
    const fields = bracketFields(line)
    for (const fl of fields) addField(row, fl.key, fromInline(fl.value, resolve))
    // (as Dataview: a line's own field only when it has no bracketed ones; a list item's counts for the page too)
    const whole = fields.length ? null : lineField(m ? m[4] : line.trim())
    if (whole) addField(row, whole.key, fromInline(whole.value, resolve))

    if (!m) {
      // A line that isn't a list item and isn't indented ends the lists above it.
      if (line.trim() && !/^[ \t]/.test(line)) stack.length = 0
      continue
    }
    const indent = m[1].replace(/\t/g, "    ").length
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]
    const text = m[4]
    const status = m[3] ?? null
    const item: Row = {
      symbol: m[2], text, visual: text, line: i, lineCount: 1, path: n.path, section, task: status !== null,
      tags: tagsIn(text), outlinks: linksIn(text), children: [], parent: parent ? parent.line : null,
      annotated: fields.length > 0 || EMOJI.some(([r]) => r.test(text)),
    }
    const block = BLOCK_ID.exec(text)
    item.blockId = block ? block[1] : null
    item.link = block ? new Link(n.path, undefined, false, `^${block[1]}`) : section
    if (status !== null) {
      item.status = status
      item.checked = status !== " "
      item.completed = status.toLowerCase() === "x"
    }
    if (whole) addField(item, whole.key, fromInline(whole.value, resolve))
    for (const fl of fields) addField(item, fl.key, fromInline(fl.value, resolve))
    for (const [r, key] of EMOJI) {
      const e = r.exec(text)
      if (e && !Object.hasOwn(item, key)) item[key] = parseDate(e[1])
    }
    Object.defineProperty(item, "$ancestors", { value: stack.map((s) => s.line), enumerable: false })
    Object.defineProperty(item, "$raw", { value: line, enumerable: false })
    if (parent) (parent.item.children as Row[]).push(item)
    stack.push({ indent, item, line: i })
    items.push(item)
  }
  const done = (t: Row): boolean => (t.task ? !!t.completed : true) && (t.children as Row[]).every(done)
  for (const it of items) if (it.task) it.fullyCompleted = done(it)

  const day = DAY_IN_NAME.exec(name)
  let fileDay: Value = null
  if (day) fileDay = parseDate(`${day[1]}-${day[2]}-${day[3]}`)
  if (!fileDay && row.date instanceof DvDate) fileDay = new DvDate(new Date(row.date.d.getFullYear(), row.date.d.getMonth(), row.date.d.getDate()).getTime(), false)
  const aliases = n.fm.aliases ?? n.fm.alias
  const startOf = (t: number) => { const d = new Date(t); return new DvDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), false) }
  const unique = (ls: Link[]) => ls.filter((l, i) => ls.findIndex((x) => x.path === l.path && x.subpath === l.subpath) === i)
  row.file = {
    name, folder, path: n.path, ext: n.path.includes(".") ? n.path.slice(n.path.lastIndexOf(".") + 1) : "", link, size: n.size,
    ctime: new DvDate(n.ctime, true), cday: startOf(n.ctime), mtime: new DvDate(n.mtime, true), mday: startOf(n.mtime),
    tags: withParents([...etags]), etags: [...etags], inlinks: [], outlinks: unique(outlinks.map((l) => (l.subpath && l.path === n.path ? l : new Link(l.path, undefined, false, undefined, l.exists)))),
    aliases: (Array.isArray(aliases) ? aliases : aliases ? [aliases] : []).map((a) => String(a)),
    tasks: items.filter((t) => t.task), lists: items, frontmatter: fromYaml(n.fm) as Value, day: fileDay, starred: false,
  }
  return row
}

/** Every note's page, with each one's inlinks (the pages linking to it). */
export function index(notes: Note[], resolve: Resolve): Row[] {
  const pages = notes.map((n) => page(n, resolve))
  linkUp(pages)
  return pages
}

/** Fill in each page's file.inlinks from the others' outlinks. */
export function linkUp(pages: Row[]) {
  const by = new Map<string, Link[]>()
  for (const p of pages) {
    const f = p.file as Row
    for (const l of f.outlinks as Link[]) {
      if (!l.exists || l.path === f.path) continue
      const into = by.get(l.path) ?? []
      if (!into.some((x) => x.path === f.path)) into.push(f.link as Link)
      by.set(l.path, into)
    }
  }
  for (const p of pages) { const f = p.file as Row; f.inlinks = by.get(String(f.path)) ?? [] }
}
