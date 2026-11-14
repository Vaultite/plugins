// Tables: Org's own (rows of cells, rules, #+TBLFM:) and table.el's, kept as text.
import { node, type OrgNode } from "./ast.ts"
import type { Affiliated, Ctx } from "./driver.ts"
import { at, blankLine, eol, nextLine, skipBlank } from "./text.ts"

const ROW = /[ \t]*\|/y
const RULE = /[ \t]*\|-/y
const TBLFM = /[ \t]*#\+TBLFM:[ \t]+(.*)/iy
/** A table.el border, `+---+---+`. */
const BORDER = /[ \t]*\+(?:-+\+)+[ \t]*(?=\n|$)/y
const TABLE_EL_LINE = /[ \t]*[|+]/y

/** The table at `pos`, or null. */
export function tableAt(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode | null {
  const s = ctx.s
  let p = pos, kind: "org" | "table.el"
  if (at(ROW, s, pos)) {
    kind = "org"
    while (p < limit && at(ROW, s, p)) p = nextLine(s, p)
  } else if (at(BORDER, s, pos)) {
    // A table.el table runs over lines starting with | or +, its last one a border too.
    let lastLine = pos
    for (p = nextLine(s, pos); p < limit && !blankLine(s, p) && at(TABLE_EL_LINE, s, p); p = nextLine(s, p)) lastLine = p
    if (lastLine === pos || !at(BORDER, s, lastLine)) return null
    kind = "table.el"
  } else return null
  const rowsEnd = Math.min(p, limit), tblfm: string[] = []
  let m: RegExpExecArray | null
  while (p < limit && (m = at(TBLFM, s, p))) { tblfm.unshift(m[1]); p = nextLine(s, p) }
  const [end, postBlank] = skipBlank(s, Math.min(p, limit), limit)
  const props = { postBlank, postAffiliated: pos, ...aff.props, kind, tblfm: tblfm.length ? tblfm : null }
  return kind === "org"
    ? node("table", aff.begin, end, { contentsBegin: pos, contentsEnd: rowsEnd, ...props })
    : node("table", aff.begin, end, { ...props, value: s.slice(pos, rowsEnd) })
}

/** A row of an Org table: a rule (`|-...`) or cells, from after its first bar to the line's end, trailing blanks left out. */
export function tableRow(ctx: Ctx, pos: number, limit: number): OrgNode {
  const s = ctx.s, end = Math.min(nextLine(s, pos), limit)
  if (at(RULE, s, pos)) return node("table-row", pos, end, { postAffiliated: pos, kind: "rule" })
  const contentsBegin = pos + at(ROW, s, pos)![0].length
  let contentsEnd = Math.min(eol(s, pos), limit)
  while (contentsEnd > contentsBegin && (s[contentsEnd - 1] === " " || s[contentsEnd - 1] === "\t")) contentsEnd--
  return node("table-row", pos, end, { contentsBegin, contentsEnd, postAffiliated: pos, kind: "standard",
    children: ctx.objects(contentsBegin, contentsEnd, "table-row") })
}

/** A table's line (or a table.el border) ends a paragraph before it. */
export const starts = (ctx: Ctx, pos: number, limit: number) => pos < limit && (!!at(ROW, ctx.s, pos) || !!at(BORDER, ctx.s, pos))
