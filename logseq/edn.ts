// Logseq's config.edn, read: maps, vectors, lists, sets, keywords, strings, numbers, booleans; other forms (fn, regex)
// read as their text, so a config with them still gives the keys we need.
export type Edn = string | number | boolean | null | { kw: string } | Edn[] | { map: Map<string, Edn> }

const isKw = (v: Edn | undefined): v is { kw: string } => !!v && typeof v === "object" && "kw" in v
const isMap = (v: Edn | undefined): v is { map: Map<string, Edn> } => !!v && typeof v === "object" && "map" in v

/** A map key as a string: `:journal/page-title-format`, `"docs-base-url"`. */
const keyOf = (v: Edn) => (isKw(v) ? `:${v.kw}` : typeof v === "string" ? v : JSON.stringify(v))

export function readEdn(text: string): Edn {
  let i = 0
  const skip = () => {
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++
      if (text[i] === ";") { while (i < text.length && text[i] !== "\n") i++; continue }
      if (text.startsWith("#_", i)) { i += 2; form(); continue }
      return
    }
  }
  const seq = (close: string): Edn[] => {
    const out: Edn[] = []
    for (;;) {
      skip()
      if (i >= text.length) return out
      if (text[i] === close) { i++; return out }
      if (")]}".includes(text[i])) { i++; continue }
      out.push(form())
    }
  }
  const str = () => {
    let s = ""
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") { i++; s += ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[text[i]] ?? text[i] }
      else s += text[i]
      i++
    }
    i++
    return s
  }
  const form = (): Edn => {
    skip()
    const c = text[i]
    if (c === undefined) return null
    if (c === "{") { i++; const xs = seq("}"); const map = new Map<string, Edn>(); for (let k = 0; k + 1 < xs.length; k += 2) map.set(keyOf(xs[k]), xs[k + 1]); return { map } }
    if (c === "[" || c === "(") { i++; return seq(c === "[" ? "]" : ")") }
    if (c === "#" && text[i + 1] === "{") { i += 2; return seq("}") }
    if (c === "#" && text[i + 1] === '"') { i++; return str() }
    if (c === "#" && text[i + 1] === "(") { i++; return form() }
    if (c === '"') return str()
    if (c === "\\") { i += 2; while (i < text.length && /\w/.test(text[i])) i++; return null }
    if (c === "'" || c === "`" || c === "@" || c === "~") { i++; return form() }
    const start = i
    while (i < text.length && !/[\s,;()[\]{}"]/.test(text[i])) i++
    const tok = text.slice(start, i)
    if (!tok) { i++; return null }
    if (tok.startsWith(":")) return { kw: tok.slice(1) }
    if (tok === "true" || tok === "false") return tok === "true"
    if (tok === "nil") return null
    if (/^[-+]?\d+(\.\d+)?$/.test(tok)) return Number(tok)
    return tok
  }
  return form()
}

/** What the importer reads of config.edn, with Logseq's defaults. */
export type GraphConfig = {
  fileNameFormat: "triple-lowbar" | "legacy"
  journalFileFormat: string
  journalTitleFormat: string
  workflow: "todo" | "now"
  hidden: string[]
  macros: Record<string, string>
  pagesDir: string
  journalsDir: string
  format: "markdown" | "org"
}

export const DEFAULT_CONFIG: GraphConfig = {
  fileNameFormat: "legacy", journalFileFormat: "yyyy_MM_dd", journalTitleFormat: "MMM do, yyyy", workflow: "now",
  hidden: [], macros: {}, pagesDir: "pages", journalsDir: "journals", format: "markdown",
}

export function graphConfig(text: string | null): GraphConfig {
  if (text === null) return { ...DEFAULT_CONFIG, fileNameFormat: "triple-lowbar" }
  let root: Edn
  try { root = readEdn(text) } catch { root = null }
  const m = isMap(root) ? root.map : new Map<string, Edn>()
  const s = (k: string) => { const v = m.get(k); return typeof v === "string" && v.trim() ? v.trim() : isKw(v) ? v.kw : null }
  const macros: Record<string, string> = {}
  const mv = m.get(":macros")
  if (isMap(mv)) for (const [k, v] of mv.map) if (typeof v === "string") macros[k.replace(/^:/, "")] = v
  const hidden = m.get(":hidden")
  const fmt = (s(":preferred-format") ?? "markdown").toLowerCase()
  return {
    fileNameFormat: s(":file/name-format") === "triple-lowbar" ? "triple-lowbar" : "legacy",
    journalFileFormat: s(":journal/file-name-format") ?? DEFAULT_CONFIG.journalFileFormat,
    journalTitleFormat: s(":journal/page-title-format") ?? s(":date-formatter") ?? DEFAULT_CONFIG.journalTitleFormat,
    workflow: s(":preferred-workflow") === "todo" ? "todo" : "now",
    hidden: Array.isArray(hidden) ? hidden.filter((h): h is string => typeof h === "string").map((h) => h.replace(/^\/+|\/+$/g, "")) : [],
    macros,
    pagesDir: (s(":pages-directory") ?? "pages").replace(/^\/+|\/+$/g, ""),
    journalsDir: (s(":journals-directory") ?? "journals").replace(/^\/+|\/+$/g, ""),
    format: fmt === "org" ? "org" : "markdown",
  }
}
