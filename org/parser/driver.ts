// The element parser: which element starts at a line (the dispatch), elements within a span (with the mode each
// container's children start in), sections, paragraphs and the document. Each element's own parser is in its module.
import { node, type Mode, type OrgChild, type OrgNode } from "./ast.ts"
import * as blocks from "./blocks.ts"
import * as heads from "./headline.ts"
import * as lists from "./lists.ts"
import { parseObjects } from "./objects.ts"
import { settingsOf, type Settings } from "./settings.ts"
import * as tables from "./tables.ts"
import { at, blankLine, bol, nextLine, skipBlank } from "./text.ts"

export type Ctx = {
  s: string
  settings: Settings
  /** Parses the elements in [begin, end) into `parent.children`, the first in `mode`. */
  elements(parent: OrgNode, begin: number, end: number, mode: Mode, struct?: unknown): void
  /** The objects in [begin, end), as allowed in an element of type `restriction` (Emacs's object restrictions). */
  objects(begin: number, end: number, restriction: string): OrgChild[]
  /** Whether an element other than a paragraph starts on the line at `pos` (so a paragraph ends before it). */
  startsElement(pos: number, limit: number): boolean
}

/** Affiliated keywords before an element (#+NAME:, #+CAPTION:...): where they start, and the properties they give. */
export type Affiliated = { begin: number; at: number; props: Record<string, unknown> }

const HEADLINE = /\*+ /y

/** What follows an element of `type` inside `parent`, given the mode it was parsed in. */
function nextMode(mode: Mode, type: string, parentType: string): Mode {
  if (parentType === "plain-list") return "item"
  if (parentType === "property-drawer") return "node-property"
  if (parentType === "table") return "table-row"
  if (parentType === "org-data" || parentType === "headline") return "section"
  if (mode === "top-comment") return type === "comment" ? "property-drawer" : null
  if (mode === "planning") return type === "planning" ? "property-drawer" : null
  return null
}

function elementAt(ctx: Ctx, pos: number, limit: number, mode: Mode, struct: unknown): OrgNode {
  const s = ctx.s
  if (mode === "item") return lists.item(ctx, pos, limit, struct)
  if (mode === "table-row") return tables.tableRow(ctx, pos, limit)
  if (mode === "node-property") return heads.nodeProperty(ctx, pos, limit)
  const atBol = pos === bol(s, pos)
  const starred = atBol && !!at(HEADLINE, s, pos)
  if (starred && !heads.isInlinetask(ctx, pos)) return heads.headline(ctx, pos, limit)
  if (mode === "section" || mode === "first-section") return section(ctx, pos, limit, mode)
  if (blocks.isComment(ctx, pos)) return blocks.comment(ctx, pos, limit)
  if (mode === "planning" && heads.isPlanning(ctx, pos)) return heads.planning(ctx, pos, limit)
  const drawer = mode === "planning" || mode === "property-drawer" || mode === "top-comment" ? heads.propertyDrawerAt(ctx, pos, limit) : null
  if (drawer) return drawer
  if (!atBol) return paragraph(ctx, pos, limit, { begin: pos, at: pos, props: {} })
  if (blocks.isClock(ctx, pos)) return blocks.clock(ctx, pos, limit)
  if (starred) return heads.inlinetask(ctx, pos, limit)
  const aff = blocks.collectAffiliated(ctx, pos, limit)
  if (aff.begin < aff.at && aff.at >= limit) return blocks.keyword(ctx, aff.begin, limit, { begin: aff.begin, at: aff.begin, props: {} })
  return blocks.element(ctx, aff.at, limit, aff) ?? lists.plainListAt(ctx, aff.at, limit, aff, struct) ?? tables.tableAt(ctx, aff.at, limit, aff) ??
    paragraph(ctx, aff.at, limit, aff)
}

/** A section: from `pos` to the next headline. Right below its headline's line, it may open with planning and a
 *  property drawer; the document's first, with a comment and a property drawer. */
function section(ctx: Ctx, pos: number, limit: number, mode: Mode): OrgNode {
  const end = heads.nextHeadline(ctx, pos, limit)
  // Its last element takes the blank lines at its end, so the section has none after it.
  const n = node("section", pos, end, { contentsBegin: pos, contentsEnd: end, postAffiliated: pos })
  n.childMode = mode === "first-section" ? "top-comment" : heads.afterHeadlineLine(ctx, pos) ? "planning" : null
  return n
}

/** A paragraph: up to a blank line or a line where another element starts. */
export function paragraph(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode {
  const s = ctx.s
  // One starting on an empty line (a container's leading blank lines) holds just that line, and counts it as blank.
  if (s[pos] === "\n") {
    const [end, blank] = skipBlank(s, pos, limit)
    return node("paragraph", aff.begin, end, { contentsBegin: pos, contentsEnd: pos + 1, postBlank: blank, postAffiliated: pos, ...aff.props,
      children: ctx.objects(pos, pos + 1, "paragraph") })
  }
  let p = nextLine(s, pos)
  while (p < limit && !blankLine(s, p) && !ctx.startsElement(p, limit)) p = nextLine(s, p)
  const contentsEnd = Math.min(p, limit)
  const [end, blank] = skipBlank(s, contentsEnd, limit)
  return node("paragraph", aff.begin, end, { contentsBegin: pos, contentsEnd, postBlank: blank, postAffiliated: pos, ...aff.props,
    children: ctx.objects(pos, contentsEnd, "paragraph") })
}

function startsElement(ctx: Ctx, pos: number, limit: number) {
  if (at(HEADLINE, ctx.s, pos)) return true
  return blocks.starts(ctx, pos, limit) || lists.starts(ctx, pos, limit) || tables.starts(ctx, pos, limit)
}

function elements(ctx: Ctx, parent: OrgNode, begin: number, end: number, mode: Mode, struct?: unknown) {
  const kids: OrgChild[] = []
  let pos = begin
  while (pos < end) {
    const el = elementAt(ctx, pos, end, mode, struct)
    if (el.end <= pos) throw new Error(`org: ${el.type} at ${pos} didn't move forward`)
    const hinted = "childMode" in el, childMode = hinted ? el.childMode as Mode : childModeOf(el.type)
    if (hinted) delete el.childMode
    if (el.contentsBegin !== null && el.contentsEnd !== null && !el.children && el.parseContents !== false)
      elements(ctx, el, el.contentsBegin, el.contentsEnd, childMode, el.struct)
    // Hints for this loop only: deleting a property an element doesn't have still costs.
    if ("parseContents" in el) delete el.parseContents
    if ("struct" in el) delete el.struct
    kids.push(el)
    mode = nextMode(mode, el.type, parent.type)
    pos = el.end
  }
  parent.children = kids
}

const childModeOf = (type: string): Mode =>
  type === "plain-list" ? "item" : type === "property-drawer" ? "node-property" : type === "table" ? "table-row" :
  type === "org-data" ? "first-section" : type === "headline" ? "section" : null

export function makeCtx(s: string, settings: Settings): Ctx {
  const ctx: Ctx = {
    s, settings,
    elements: (parent, begin, end, mode, struct) => elements(ctx, parent, begin, end, mode, struct),
    objects: (begin, end, restriction) => parseObjects(ctx, begin, end, restriction),
    startsElement: (pos, limit) => startsElement(ctx, pos, limit),
  }
  return ctx
}

/** The whole file as Emacs's org-data. */
export function parseDocument(s: string, given: Partial<Settings> = {}): OrgNode {
  const ctx = makeCtx(s, settingsOf(s, given))
  const [contentsBegin, preBlank] = skipBlank(s, 0, s.length)
  const doc = node("org-data", 0, s.length, { contentsBegin, contentsEnd: s.length, postAffiliated: 0, preBlank, properties: {} })
  if (ctx.settings.category !== null) doc.properties!.CATEGORY = ctx.settings.category
  elements(ctx, doc, contentsBegin, s.length, "first-section")
  heads.documentProperties(ctx, doc)
  return doc
}
