// Whether two Logseq pages say the same: a page as its properties and blocks, each block's lines written one way
// (TODO and LATER alike, #+BEGIN_SRC as a fence, an image by its file...), so a round trip compares as equivalent.
const P = (m: string) => import(new URL(`../${m}`, import.meta.url).href)
const { parsePage, blockParts, PROP } = await P("outline.ts")
const { parseOrg } = await P("org.ts")
type Block = { lines: string[]; children: Block[]; numbered?: boolean }

const MARK: Record<string, string> = { LATER: "TODO", NOW: "DOING", WAIT: "WAITING", CANCELLED: "CANCELED", "IN-PROGRESS": "DOING", STARTED: "DOING" }
/** Properties Logseq keeps for itself that a Vaultite note shows another way, or not at all (said in AGENTS.md). */
const DROP = /^(collapsed|heading|filters|title|card-[\w-]+|public)$/i

const tag = (t: string) => `#${t.trim().replace(/\s*\/\s*/g, "/").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, "-").replace(/-{2,}/g, "-").replace(/^[-/]+|[-/]+$/g, "").toLowerCase()}`
const base = (p: string) => { let s = p.split(/[?#]/)[0]; try { s = decodeURIComponent(s) } catch { /* as written */ } return s.split("/").pop()!.toLowerCase() }

let macros: Record<string, string> = {}
/** The graph's macros (config.edn): a line is compared as Logseq shows it, a macro of text expanded. */
export const useMacros = (m: Record<string, string>) => { macros = m }

export function normLine(l: string): string {
  let s = l.trim().replace(/\s+/g, " ")
  s = s.replace(/\{\{\s*([\w-]+)\s*(.*?)\}\}/g, (all, n: string, a: string) => {
    const own = macros[n]
    if (own === undefined || /^\s*\[:|<\w|\{\{/.test(own)) return all
    const args = a.trim() ? a.trim().split(/\s*,\s*/) : []
    return own.replace(/\$(\d+)/g, (_, k: string) => args[Number(k) - 1] ?? "")
  })
  if (!s) return ""
  s = s.replace(/^(LATER|NOW|WAIT|CANCELLED|IN-PROGRESS|STARTED)\b/, (m) => MARK[m])
  s = s.replace(/^#{1,6} /, "")
  s = s.replace(/^#\+BEGIN_SRC\s*(\S*).*$/i, "```$1").replace(/^#\+END_SRC$/i, "```").replace(/^`{3,}/, "```")
  s = s.replace(/^\[ \]\s/, "TODO ").replace(/^\[[xX]\]\s/, "DONE ")
  s = s.replace(/!\[[^\]]*\]\(([^)]+)\)(\{[^}]*\})?/g, (_, p: string) => `![](${base(p)})`)
  s = s.replace(/\[([^\]]*)\]\((\.\.\/[^)]+|assets\/[^)]+)\)/g, (_, _l: string, p: string) => `[](${base(p)})`)
  s = s.replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (all, l: string, t: string) => (l.toLowerCase() === t.toLowerCase() ? `[[${t}]]` : all))
  s = s.replace(/#\[\[([^\]]+)\]\]/g, (_, t: string) => tag(t))
  if (!s.startsWith("#+")) s = s.replace(/(?<=^|\s)#([^\s#,!?;"'()[\]{}]+?)([.:]?)(?=[\s,!?;"'()[\]{}]|$)/g, (_, t: string, p: string) => tag(t) + p)
  // (a #tag is a page ref in Logseq: #x and [[x]] are the same)
  if (!s.startsWith("#+")) s = s.replace(/(?<=^|\s)#([^\s#,!?;"'()[\]{}]+?)([.:]?)(?=[\s,!?;"'()[\]{}]|$)/g, (_, t: string, p: string) => `[[${t}]]${p}`)
  // ([x](./x.org): a link to the page of that file)
  s = s.replace(/\[([^\]]+)\]\((?:\.\/)?([^)]+)\.(?:org|md)\)/g, (all, l: string, f: string) => (l.toLowerCase() === f.toLowerCase() ? `[[${l.toLowerCase()}]]` : all))
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t: string) => `[[${t.toLowerCase().trim()}]]`)
  if (s === "[:span]") s = ""
  s = s.replace(/==([^=]+)==/g, "^^$1^^").replace(/\{\{cloze\s+(.*?)\s*\}\}/g, "^^$1^^")
  s = s.replace(/\{\{\s*(\w+)\s+(.*?)\s*\}\}/g, (_, n: string, a: string) => `{{${n.toLowerCase() === "youtube" ? "video" : n.toLowerCase()} ${/^[\w-]{11}$/.test(a) ? `https://youtu.be/${a}` : a}}}`)
  s = s.replace(/<(\d{4}-\d\d-\d\d) \w+( [^>]*)?>/g, (_, d: string, r?: string) => `<${d}${r ? r.replace(/\+\+/, "+") : ""}>`)
  return s
}

/** A block's lines as compared: properties (but those dropped) sorted, planning on lines of its own, sorted. */
function blockKey(b: Block): string[] {
  const parts = blockParts(b.lines)
  const props = parts.props.filter((p: { key: string }) => !DROP.test(p.key)).map((p: { key: string; value: string }) => `${p.key.toLowerCase()}:: ${normLine(p.value)}`)
  if (b.numbered) props.push("logseq.order-list-type:: number")
  const planning = [parts.scheduled && `SCHEDULED: ${normLine(parts.scheduled)}`, parts.deadline && `DEADLINE: ${normLine(parts.deadline)}`].filter(Boolean)
  const body = parts.body.map(normLine).filter(Boolean)
  const text = [normLine(parts.title), ...body].filter(Boolean)
  return [...[...new Set(props)].sort(), ...planning.sort(), ...parts.logbook.map(normLine), ...(text.length ? text : [""])]
}

/** The page as lines to compare, each block's indented by its depth. */
export function pageKey(text: string, org = false): string[] {
  const page = org ? parseOrg(text) : parsePage(text)
  if (!page) return text.split("\n")
  // (a first block of only properties is the page's)
  const first = page.blocks[0]
  if (!page.props.length && first && !first.children.length && first.lines.every((l: string) => !l.trim() || PROP.test(l.trim())) && PROP.test(first.lines[0].trim())) {
    page.props = blockParts(first.lines).props
    page.blocks = page.blocks.slice(1)
  }
  const props: { key: string; value: string }[] = page.props
  const pp = props.filter((p) => !DROP.test(p.key)).map((p) => {
    const key = p.key.toLowerCase()
    // (links one after another are a list too)
    const vals = (/^(\s*#?\[\[[^\]]+\]\]\s*,?)+$/.test(p.value) ? [...p.value.matchAll(/\[\[([^\]]+)\]\]/g)].map((r) => r[1]) : p.value.split(/,\s*/)).map((v: string) => v.replace(/^"(.*)"$/, "$1")).map((v) => normLine(v.replace(/^#/, "")).replace(/^\[\[(.*)\]\]$/, "$1").replace(/^#/, "")).filter(Boolean)
    return `${key}:: ${(key === "alias" || key === "tags" ? vals.map((v) => (key === "tags" ? tag(v).slice(1) : v.toLowerCase())).sort() : vals).join(", ")}`
  }).sort()
  const out = [...pp]
  const walk = (bs: Block[], d: number) => { for (const b of bs) { const k = blockKey(b); if (k.join("") || b.children.length) out.push(...k.map((x) => `${"  ".repeat(d)}${x}`)); walk(b.children, d + 1) } }
  walk(page.blocks, 0)
  // (an empty page is one Logseq writes as "-")
  return out.filter((l, i) => !(l === "" && i === out.length - 1))
}

/** The first lines where two pages differ, or null when they're equivalent. */
export function differ(a: string[], b: string[]): string | null {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: ${JSON.stringify(a[i] ?? "(none)")} vs ${JSON.stringify(b[i] ?? "(none)")}`
  }
  return null
}
