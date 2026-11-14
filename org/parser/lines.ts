// Elements made of lines taken as they are: comments, fixed-width areas, horizontal rules, diary sexps, clocks and
// LaTeX environments.
import { node, type OrgNode } from "./ast.ts"
import type { Affiliated, Ctx } from "./driver.ts"
import { latexEnd } from "./ends.ts"
import { timestampAt } from "./objects.ts"
import { at, eol, nextLine, skipBlank } from "./text.ts"

const COMMENT = /[ \t]*#(?= |\n|$)/y
const FIXED = /[ \t]*:(?= |\n|$)/y
const RULE = /[ \t]*-{5,}[ \t]*(?=\n|$)/y
const DIARY = /%%\(/y
const CLOCK = new RegExp(String.raw`[ \t]*clock:[ \t]+(?:\[\d{4}-\d\d-\d\d[^\n]*?\](?:[ \t]*--[ \t]*\[[^\n]*\](?:[ \t]+=>[ \t]+\d+:\d\d)?)?|=>[ \t]+\d+:\d\d)[ \t]*(?=\n|$)`, "iy")
const DURATION = /=> +(\d+:\d\d)[ \t]*$/
const LATEX = /[ \t]*\\begin\{([A-Za-z0-9*]+)\}/iy

/** Consecutive lines matching `re` from `pos`, before `limit`: the start of the line after them. */
function run(s: string, re: RegExp, pos: number, limit: number) {
  let p = pos
  while (p < limit && at(re, s, p)) p = nextLine(s, p)
  return Math.min(p, limit)
}

/** Each line in [pos, end) without its marker (what `re` matched) and one space after it, joined. */
function strip(s: string, re: RegExp, pos: number, end: number) {
  const out: string[] = []
  for (let p = pos; p < end; p = nextLine(s, p)) {
    const m = at(re, s, p)!
    let b = p + m[0].length
    if (s[b] === " ") b++
    out.push(s.slice(Math.min(b, eol(s, p)), eol(s, p)))
  }
  return out.join("\n")
}

function lined(ctx: Ctx, type: string, pos: number, last: number, limit: number, aff: Affiliated, props: Record<string, unknown>): OrgNode {
  const [end, postBlank] = skipBlank(ctx.s, last, limit)
  return node(type, aff.begin, end, { postBlank, postAffiliated: pos, ...aff.props, ...props })
}

export const isComment = (ctx: Ctx, pos: number) => !!at(COMMENT, ctx.s, pos)

export function comment(ctx: Ctx, pos: number, limit: number): OrgNode {
  const last = run(ctx.s, COMMENT, pos, limit)
  return lined(ctx, "comment", pos, last, limit, { begin: pos, at: pos, props: {} }, { value: strip(ctx.s, COMMENT, pos, last) })
}

export const isFixedWidth = (ctx: Ctx, pos: number) => !!at(FIXED, ctx.s, pos)

export function fixedWidth(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode {
  const last = run(ctx.s, FIXED, pos, limit)
  return lined(ctx, "fixed-width", pos, last, limit, aff, { value: strip(ctx.s, FIXED, pos, last) })
}

export const isRule = (ctx: Ctx, pos: number) => !!at(RULE, ctx.s, pos)

export function rule(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode {
  return lined(ctx, "horizontal-rule", pos, nextLine(ctx.s, pos), limit, aff, {})
}

/** A diary sexp starts its line, unindented. */
export const isDiary = (ctx: Ctx, pos: number) => (pos === 0 || ctx.s[pos - 1] === "\n") && !!at(DIARY, ctx.s, pos)

export function diary(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode {
  return lined(ctx, "diary-sexp", pos, nextLine(ctx.s, pos), limit, aff, { value: ctx.s.slice(pos, eol(ctx.s, pos)) })
}

export const isClock = (ctx: Ctx, pos: number) => !!at(CLOCK, ctx.s, pos)

export function clock(ctx: Ctx, pos: number, limit: number): OrgNode {
  const s = ctx.s, lineEnd = eol(s, pos), line = s.slice(pos, lineEnd)
  const open = line.indexOf("["), duration = DURATION.exec(line)?.[1] ?? null
  const value = open >= 0 ? timestampAt(ctx, pos + open, lineEnd) : null
  return lined(ctx, "clock", pos, nextLine(s, pos), limit, { begin: pos, at: pos, props: {} },
    { status: duration ? "closed" : "running", value, duration })
}

/** The LaTeX environment at `pos` when it's closed before `limit`: the start of its last line, else -1. */
export function latexClose(ctx: Ctx, pos: number, limit: number) {
  const m = at(LATEX, ctx.s, pos)
  return m ? latexEnd(ctx, m[1], pos, limit) : -1
}

export function latexEnvironment(ctx: Ctx, pos: number, limit: number, aff: Affiliated, close: number): OrgNode {
  const s = ctx.s, last = nextLine(s, close)
  return lined(ctx, "latex-environment", pos, last, limit, aff, { value: s.slice(pos, last) })
}
