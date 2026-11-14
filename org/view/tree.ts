// What the view reads off the parse tree: typed properties, plain text of objects, and the document's indexes
// (headlines by custom id, id and title, targets, footnotes in reading order, keywords, macros).
import { isText, walk, type OrgChild, type OrgNode } from "../parser/index.ts"

export const str = (n: OrgNode, k: string) => (typeof n[k] === "string" ? (n[k] as string) : null)
export const num = (n: OrgNode, k: string) => (typeof n[k] === "number" ? (n[k] as number) : null)
/** A node property's value (a repeated one's first). */
export const prop = (n: OrgNode, k: string) => { const v = n.properties?.[k]; return (Array.isArray(v) ? v[0] : v) ?? null }
export const kids = (n: OrgNode): OrgChild[] => n.children ?? []
export const objs = (v: unknown): OrgChild[] => (Array.isArray(v) ? (v as OrgChild[]).filter((c) => c && typeof c === "object") : [])
export const nodeOf = (v: unknown): OrgNode | null => (v && typeof v === "object" && "type" in v ? (v as OrgNode) : null)

/** Objects as the text a reader sees (markup gone, entities as characters). */
export function plain(cs: OrgChild[]): string {
  let out = ""
  for (const c of cs) {
    if (isText(c)) out += c.value
    else if (c.type === "entity") out += str(c, "utf8") ?? ""
    else if (c.type === "link" && !c.children?.length) out += str(c, "rawLink") ?? ""
    else if (typeof c.value === "string" && !c.children?.length) out += c.value
    else out += plain(kids(c))
  }
  return out
}

/** A caption's objects, whatever list shape it comes in (Emacs gives a list of [value, short] pairs). */
export function captionOf(n: OrgNode): OrgChild[] {
  const c = n.caption
  if (!Array.isArray(c)) return []
  const flat = (v: unknown): OrgChild[] => (Array.isArray(v) ? (v.length && Array.isArray(v[0]) ? flat(v[0]) : objs(v)) : [])
  return c.flatMap((entry, i) => [...(i ? [{ type: "plain-text", value: " ", begin: -1, end: -1 } as OrgChild] : []), ...flat(entry)])
}

export type Doc = {
  keywords: Map<string, string>
  macros: Map<string, string>
  /** Headlines by CUSTOM_ID, by ID and by their title (lower case), for links inside the file. */
  customIds: Map<string, OrgNode>
  ids: Map<string, OrgNode>
  titles: Map<string, OrgNode>
  /** <<targets>> and #+NAME:d elements, lower case. */
  targets: Map<string, number>
  /** Footnote labels in the order they're first referenced, and each one's definition. */
  footnotes: string[]
  definitions: Map<string, OrgNode>
  /** Each footnote reference's label (anonymous inline ones get their own). */
  labels: Map<OrgNode, string>
  /** Where each footnote is first referenced. */
  refs: Map<string, number>
}

/** The indexes, in one pass over the tree. */
export function indexDoc(doc: OrgNode): Doc {
  const d: Doc = { keywords: new Map(), macros: new Map(), customIds: new Map(), ids: new Map(), titles: new Map(), targets: new Map(),
    footnotes: [], definitions: new Map(), labels: new Map(), refs: new Map() }
  let inline = 0
  for (const c of walk(doc)) {
    if (isText(c)) continue
    const name = str(c, "name")
    if (name) d.targets.set(name.toLowerCase(), c.begin)
    switch (c.type) {
      case "keyword": {
        const key = (str(c, "key") ?? "").toUpperCase(), value = str(c, "value") ?? ""
        if (key === "MACRO") { const m = /^(\S+)\s*(.*)$/.exec(value); if (m) d.macros.set(m[1].toLowerCase(), m[2]) }
        else if (!d.keywords.has(key)) d.keywords.set(key, value)
        else if (key === "TITLE" || key === "AUTHOR") d.keywords.set(key, `${d.keywords.get(key)} ${value}`)
        break
      }
      case "headline": case "inlinetask": {
        const id = prop(c, "ID"), custom = prop(c, "CUSTOM_ID")
        if (custom) d.customIds.set(custom, c)
        if (id) d.ids.set(id, c)
        const t = (str(c, "rawValue") ?? "").trim().toLowerCase()
        if (t && !d.titles.has(t)) d.titles.set(t, c)
        break
      }
      case "target": case "radio-target": {
        const v = str(c, "value") ?? plain(kids(c))
        d.targets.set(v.toLowerCase(), c.begin)
        break
      }
      case "footnote-reference": {
        let label = str(c, "label")
        if (!label) { label = `inline-${inline++}`; d.definitions.set(label, c) }
        else if (str(c, "kind") === "inline" && c.children?.length) d.definitions.set(label, c)
        d.labels.set(c, label)
        if (!d.refs.has(label)) { d.refs.set(label, c.begin); d.footnotes.push(label) }
        break
      }
      case "footnote-definition": {
        const label = str(c, "label")
        if (label && !d.definitions.has(label)) d.definitions.set(label, c)
        break
      }
    }
  }
  return d
}

/** A headline's key for remembering its fold: its titles from the top, and which of that path it is. */
export function headlineKeys(doc: OrgNode): Map<OrgNode, string> {
  const out = new Map<OrgNode, string>(), seen = new Map<string, number>()
  const go = (n: OrgNode, path: string) => {
    for (const c of kids(n)) {
      if (isText(c) || c.type !== "headline") continue
      const p = `${path}/${(str(c, "rawValue") ?? "").trim()}`, nth = seen.get(p) ?? 0
      seen.set(p, nth + 1)
      out.set(c, `${p}#${nth}`)
      go(c, p)
    }
  }
  go(doc, "")
  return out
}

export const isHeadline = (c: OrgChild): c is OrgNode => !isText(c) && c.type === "headline"
