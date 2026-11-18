// Logseq's simple queries ({{query ...}}) as a Tasks or Dataview query where one means the same; else null.
type Node = string | Node[]

function parse(src: string): Node[] {
  const toks = src.match(/\[\[[^\]]*\]\]|#\[\[[^\]]*\]\]|"[^"]*"|[()]|[^\s()]+/g) ?? []
  let i = 0
  const read = (): Node => {
    const t = toks[i++]
    if (t !== "(") return t
    const out: Node[] = []
    while (i < toks.length && toks[i] !== ")") out.push(read())
    i++
    return out
  }
  const all: Node[] = []
  while (i < toks.length) all.push(read())
  return all
}

const head = (n: Node) => (Array.isArray(n) && typeof n[0] === "string" ? n[0].toLowerCase() : null)
const words = (n: Node[]) => n.slice(1).map((x) => (typeof x === "string" ? x : "")).filter(Boolean)
const unq = (s: string) => s.replace(/^"|"$/g, "").replace(/^\[\[|\]\]$/g, "").replace(/^#\[\[|\]\]$/g, "").replace(/^#/, "")
const isRef = (n: Node) => typeof n === "string" && (/^\[\[.+\]\]$/.test(n) || /^#/.test(n))

const STATUS: Record<string, string> = { todo: "TODO", later: "TODO", wait: "TODO", waiting: "TODO", doing: "IN_PROGRESS", now: "IN_PROGRESS", "in-progress": "IN_PROGRESS", done: "DONE", canceled: "CANCELLED", cancelled: "CANCELLED" }
const PRIORITY: Record<string, string> = { a: "high", b: "medium", c: "low" }

export type Converted = { lang: "tasks" | "dataview"; text: string }

/** `page`: a page title as the note path a query names (a folder for namespace). */
export function convertQuery(src: string, page: (title: string) => string | null): Converted | null {
  let nodes: Node[]
  try { nodes = parse(src.trim()) } catch { return null }
  if (nodes.length !== 1) return null
  const root = nodes[0]
  const terms: Node[] = head(root) === "and" ? (root as Node[]).slice(1) : [root]
  const task = terms.find((t) => head(t) === "task" || head(t) === "todo")
  if (task) return tasksQuery(terms, task as Node[], page)
  return dataviewQuery(root, page)
}

function tasksQuery(terms: Node[], task: Node[], page: (title: string) => string | null): Converted | null {
  const types = [...new Set(words(task).map((w) => STATUS[w.toLowerCase()]))]
  if (!types.length || types.includes(undefined as unknown as string)) return null
  const lines = [types.length === 1 ? `status.type is ${types[0]}` : types.map((t) => `(status.type is ${t})`).join(" OR ")]
  for (const t of terms) {
    if (t === task) continue
    const h = head(t)
    if (h === "priority") {
      const ps = words(t as Node[]).map((w) => PRIORITY[w.toLowerCase()])
      if (!ps.length || ps.some((p) => !p)) return null
      lines.push(ps.map((p) => `(priority is ${p})`).join(" OR "))
    } else if (h === "page") {
      const ps = words(t as Node[]).map((w) => page(unq(w)))
      if (!ps.length || ps.some((p) => !p)) return null
      lines.push(ps.map((p) => `(path includes ${p}.md)`).join(" OR "))
    } else if (isRef(t)) {
      const name = unq(t as string)
      if ((t as string).startsWith("#")) lines.push(`tags include #${name.replace(/\s+/g, "-")}`)
      else lines.push(`description includes ${name}`)
    } else return null
  }
  return { lang: "tasks", text: lines.join("\n") }
}

function from(n: Node, page: (title: string) => string | null): string | null {
  if (isRef(n)) {
    const s = n as string, name = unq(s)
    return s.startsWith("#") ? `#${name.replace(/\s+/g, "-")}` : `[[${page(name) ?? name}]]`
  }
  const h = head(n)
  if (h === "and" || h === "or") {
    const parts = (n as Node[]).slice(1).map((x) => from(x, page))
    return parts.length && parts.every(Boolean) ? `(${parts.join(` ${h} `)})` : null
  }
  if (h === "not" && (n as Node[]).length === 2) { const p = from((n as Node[])[1], page); return p ? `-${p}` : null }
  if (h === "page-tags") { const ws = words(n as Node[]); return ws.length ? `(${ws.map((w) => `#${unq(w).replace(/\s+/g, "-")}`).join(" or ")})` : null }
  if (h === "namespace" && (n as Node[]).length === 2) { const p = page(unq(String((n as Node[])[1]))); return p ? `"${p}"` : null }
  return null
}

function where(n: Node): string | null {
  const h = head(n)
  if ((h === "page-property" || h === "property") && Array.isArray(n) && (n.length === 2 || n.length === 3)) {
    const key = unq(String(n[1])).replace(/^:/, "")
    if (!/^[\w-]+$/.test(key)) return null
    if (n.length === 2) return key
    const v = unq(String(n[2]))
    return /^-?\d+(\.\d+)?$/.test(v) ? `${key} = ${v}` : `contains(${key}, "${v.replace(/"/g, '\\"')}")`
  }
  if (h === "and" || h === "or") {
    const parts = (n as Node[]).slice(1).map(where)
    return parts.length && parts.every(Boolean) ? `(${parts.join(` ${h.toUpperCase()} `)})` : null
  }
  return null
}

function dataviewQuery(root: Node, page: (title: string) => string | null): Converted | null {
  const f = from(root, page)
  if (f) return { lang: "dataview", text: `LIST\nFROM ${f.replace(/^\((.*)\)$/, "$1")}` }
  const w = where(root)
  if (w) return { lang: "dataview", text: `LIST\nWHERE ${w.replace(/^\((.*)\)$/, "$1")}` }
  return null
}
