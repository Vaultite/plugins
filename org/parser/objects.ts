// Objects: what's inside paragraphs, titles and cells (markup, links, timestamps, entities, footnote references...).
// The text is scanned once; at each character, the objects allowed in the container that may start with it are tried.
import { walk, type OrgChild, type OrgNode } from "./ast.ts"
import { parseDocument, type Ctx } from "./driver.ts"
import { entity, latexFragment, lineBreak } from "./objects/entities.ts"
import { obj, text, type Lex, type ObjectParser } from "./objects/lex.ts"
import { angleLink, plainLink, plainStart, radioLink, radioRegex, radioTarget, regularLink, target } from "./objects/links.ts"
import { emphasis, script } from "./objects/markup.ts"
import { citation, exportSnippet, footnoteReference, inlineBabelCall, inlineSrcBlock, macro, statisticsCookie } from "./objects/references.ts"
import { timestamp, timestampObject } from "./objects/timestamps.ts"

const STANDARD = ["bold", "citation", "code", "entity", "export-snippet", "footnote-reference", "inline-babel-call", "inline-src-block",
  "italic", "line-break", "latex-fragment", "link", "macro", "radio-target", "statistics-cookie", "strike-through", "subscript",
  "superscript", "target", "timestamp", "underline", "verbatim"]
const MINIMAL = ["bold", "code", "entity", "italic", "latex-fragment", "strike-through", "subscript", "superscript", "underline", "verbatim"]
const without = (xs: string[], ...not: string[]) => xs.filter((x) => !not.includes(x))

// Emacs's object restrictions: which objects each container may hold.
const RESTRICTIONS: Record<string, string[]> = {
  "citation-reference": without(STANDARD, "citation", "footnote-reference", "line-break", "link"),
  "headline": without(STANDARD, "line-break"), "inlinetask": without(STANDARD, "line-break"), "item": without(STANDARD, "line-break"),
  "keyword": without(STANDARD, "footnote-reference"),
  "link": [...MINIMAL, "export-snippet", "inline-babel-call", "inline-src-block", "macro", "statistics-cookie"],
  "radio-target": MINIMAL,
  "table-cell": [...MINIMAL, "citation", "export-snippet", "footnote-reference", "link", "macro", "radio-target", "target", "timestamp"],
}
const allowed = new Map<string, Set<string>>()
const allowedIn = (r: string) => allowed.get(r) ?? allowed.set(r, new Set(RESTRICTIONS[r] ?? STANDARD)).get(r)!

const MARKUP: Record<string, string> = { "*": "bold", "/": "italic", "_": "underline", "+": "strike-through", "=": "verbatim", "~": "code" }

/** The parsers to try, in order, for an object starting with each character. */
function candidates(c: string): [string, ObjectParser][] {
  switch (c) {
    case "*": case "/": case "+": case "=": case "~": return [[MARKUP[c], emphasis]]
    case "_": return [["underline", emphasis], ["subscript", script]]
    case "^": return [["superscript", script]]
    case "[": return [["link", regularLink], ["footnote-reference", footnoteReference], ["citation", citation],
      ["statistics-cookie", statisticsCookie], ["timestamp", timestampObject]]
    case "<": return [["radio-target", radioTarget], ["target", target], ["timestamp", timestampObject], ["link", angleLink]]
    case "\\": return [["line-break", lineBreak], ["entity", entity], ["latex-fragment", latexFragment]]
    case "$": return [["latex-fragment", latexFragment]]
    case "@": return [["export-snippet", exportSnippet]]
    case "{": return [["macro", macro]]
    case "c": return [["inline-babel-call", inlineBabelCall]]
    case "s": return [["inline-src-block", inlineSrcBlock]]
    default: return []
  }
}
const TABLE = new Map<string, [string, ObjectParser][]>()
for (const c of "*/+=~_^[<\\$@{cs") TABLE.set(c, candidates(c))

type State = { radio: RegExp | null; radioFirst: Set<string> }
const states = new WeakMap<Ctx, State>()
let collecting = false

/** Radio targets are the document's: found by parsing it once (without radio links) the first time they're needed. */
function stateOf(ctx: Ctx): State {
  let st = states.get(ctx)
  if (st) return st
  st = { radio: null, radioFirst: new Set() }
  states.set(ctx, st)
  if (collecting || !ctx.s.includes("<<<")) return st
  const values: string[] = []
  collecting = true
  try {
    for (const n of walk(parseDocument(ctx.s, ctx.settings))) if (n.type === "radio-target") values.push((n as OrgNode).value as string)
  } finally { collecting = false }
  st.radio = radioRegex(values)
  for (const v of values) st.radioFirst.add(v[0].toLowerCase()).add(v[0].toUpperCase())
  return st
}

/** The objects in [begin, end), those allowed in an element of type `restriction`; text between them as plain text. */
export function parseObjects(ctx: Ctx, begin: number, end: number, restriction: string): OrgChild[] {
  if (restriction === "table-row") return tableCells(ctx, begin, end)
  const ok = allowedIn(restriction), s = ctx.s, L: Lex = { ctx, s, begin, end }, st = stateOf(ctx)
  const plain = ok.has("link"), radio = st.radio && ok.has("link") ? st.radio : null
  const out: OrgChild[] = []
  let from = begin
  for (let i = begin; i < end;) {
    const c = s[i]
    let o: OrgNode | null = null
    const tries = TABLE.get(c)
    // Radio links come first, but for dollar math (Emacs looks for both from the character before).
    const radioHere = radio && st.radioFirst.has(c)
    if (radioHere && c !== "$") o = radioLink(L, i, radio)
    if (!o && tries) for (const [type, parse] of tries) if (ok.has(type) && (o = parse(L, i))) break
    if (!o && radioHere && c === "$") o = radioLink(L, i, radio)
    if (!o && plain && plainStart(L, i)) o = plainLink(L, i)
    if (!o) { i++; continue }
    if (from < i) out.push(text(s, from, i))
    let e = o.end
    // A line break ends its line: the indentation after it isn't its blank.
    if (o.type !== "line-break") while (e < end && (s[e] === " " || s[e] === "\t")) e++
    o.postBlank = e - o.end
    o.end = e
    out.push(o)
    from = i = e
  }
  if (from < end) out.push(text(s, from, end))
  return out
}

/** A table row's cells: up to each `|`, their contents without the spaces around them. */
function tableCells(ctx: Ctx, begin: number, end: number): OrgChild[] {
  const s = ctx.s, out: OrgChild[] = []
  for (let i = begin; i < end;) {
    let bar = s.indexOf("|", i)
    if (bar < 0 || bar >= end) bar = end
    let cb = i, ce = bar
    while (cb < bar && (s[cb] === " " || s[cb] === "\t")) cb++
    while (ce > cb && (s[ce - 1] === " " || s[ce - 1] === "\t")) ce--
    const e = bar < end ? bar + 1 : end
    out.push(obj("table-cell", i, e, { contentsBegin: cb, contentsEnd: ce, children: parseObjects(ctx, cb, ce, "table-cell") }))
    i = e
  }
  return out
}

/** The timestamp object starting at `pos` (before `limit`), with the blanks after it, or null. */
export function timestampAt(ctx: Ctx, pos: number, limit: number): OrgNode | null {
  const s = ctx.s, o = timestamp(s, pos, limit)
  if (!o) return null
  let e = o.end
  while (e < limit && (s[e] === " " || s[e] === "\t")) e++
  o.postBlank = e - o.end
  o.end = e
  return o
}
