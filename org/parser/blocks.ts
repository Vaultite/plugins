// Blocks (#+begin_NAME ... #+end_NAME), dynamic blocks, drawers and footnote definitions, and the dispatch to the rest
// of this area: keywords (keywords.ts) and elements taken line by line (lines.ts).
import { node, type OrgNode } from "./ast.ts"
import type { Affiliated, Ctx } from "./driver.ts"
import { blockEnd, drawerEnd, dynamicEnd } from "./ends.ts"
import { cpAt, isWord, width } from "./objects/chars.ts"
import { collectAffiliated, keyword, keywordAt, keywordStarts, noAffiliated } from "./keywords.ts"
import * as lines from "./lines.ts"
import { at, backBlank, blankLine, eol, nextLine, skipBlank } from "./text.ts"

export { collectAffiliated, keyword }
export { clock, comment, isClock, isComment } from "./lines.ts"

const BEGIN = /[ \t]*#\+begin_(\S+)/iy
const DYNAMIC = /[ \t]*#\+begin:[ \t]+(\S+)(?:[ \t]+([^\n]+))?/iy
const HEADLINE = /\*+ /y
const INDENT = /[ \t]*/y
const LESSER = new Set(["src", "example", "export", "comment", "verse"])

/** The first character of the line at `pos` after its indentation. */
function lead(s: string, pos: number) {
  INDENT.lastIndex = pos
  INDENT.test(s)
  return INDENT.lastIndex
}

const atBol = (s: string, pos: number) => pos === 0 || s[pos - 1] === "\n"
const TRAILING = /[ \t]*(?=\n|$)/y

/** Past the run of word characters (Emacs's syntax table's), hyphens and underscores from `pos`. */
function nameEnd(s: string, pos: number) {
  let p = pos
  for (let c; (c = cpAt(s, p)) >= 0 && (c === 45 || c === 95 || isWord(c)); p += width(c));
  return p
}

/** A footnote definition's label (`[fn:LABEL]` starting an unindented line), or null. */
function footnoteLabel(s: string, pos: number) {
  if (!atBol(s, pos) || !s.startsWith("[fn:", pos)) return null
  const e = nameEnd(s, pos + 4)
  return e > pos + 4 && s[e] === "]" ? s.slice(pos + 4, e) : null
}
const isFootnote = (s: string, pos: number) => footnoteLabel(s, pos) !== null

/** A drawer's opening line (`:NAME:`): its name, or null. */
function drawerName(s: string, pos: number) {
  const p = lead(s, pos)
  if (s[p] !== ":") return null
  const e = nameEnd(s, p + 1)
  return e > p + 1 && s[e] === ":" && at(TRAILING, s, e + 1) ? s.slice(p + 1, e) : null
}

/** Where the block at `pos` ends (the start of its #+end_ line) before `limit`, or -1. */
function blockClose(ctx: Ctx, pos: number, limit: number) {
  const m = at(BEGIN, ctx.s, pos)
  return m ? blockEnd(ctx, m[1], nextLine(ctx.s, pos), limit) : -1
}

const drawerClose = (ctx: Ctx, pos: number, limit: number) => drawerName(ctx.s, pos) !== null ? drawerEnd(ctx, nextLine(ctx.s, pos), limit) : -1

/** Elements that can't take affiliated keywords: before them (or a blank line), those are plain keywords. */
function refusesAffiliated(ctx: Ctx, pos: number) {
  const s = ctx.s
  return blankLine(s, pos) || lines.isComment(ctx, pos) || lines.isClock(ctx, pos) || !!at(HEADLINE, s, pos)
}

/** The element at `pos` this module parses (a block, a drawer, a keyword...), or null (a paragraph, a list, a table). */
export function element(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode | null {
  const s = ctx.s
  if (aff.begin < aff.at && refusesAffiliated(ctx, pos)) return keyword(ctx, aff.begin, limit, noAffiliated(aff.begin))
  const c = s[lead(s, pos)]
  if (c === "#") {
    if (at(BEGIN, s, pos)) {
      const close = blockClose(ctx, pos, limit)
      return close < 0 ? null : block(ctx, pos, limit, aff, close)
    }
    if (at(DYNAMIC, s, pos)) {
      const close = dynamicEnd(ctx, nextLine(s, pos), limit)
      return close < 0 ? null : dynamicBlock(ctx, pos, limit, aff, close)
    }
    return keywordAt(ctx, pos, limit, aff)
  }
  if (c === ":") {
    const close = drawerClose(ctx, pos, limit)
    if (close >= 0) return drawer(ctx, pos, limit, aff, close)
    return lines.isFixedWidth(ctx, pos) ? lines.fixedWidth(ctx, pos, limit, aff) : null
  }
  if (c === "\\") {
    const close = lines.latexClose(ctx, pos, limit)
    return close < 0 ? null : lines.latexEnvironment(ctx, pos, limit, aff, close)
  }
  if (c === "-") return lines.isRule(ctx, pos) ? lines.rule(ctx, pos, limit, aff) : null
  if (c === "[") return isFootnote(s, pos) ? footnoteDefinition(ctx, pos, limit, aff) : null
  if (c === "%") return lines.isDiary(ctx, pos) ? lines.diary(ctx, pos, limit, aff) : null
  return null
}

/** Lines that end a paragraph before them and belong to this module. */
export function starts(ctx: Ctx, pos: number, limit: number) {
  const s = ctx.s, c = s[lead(s, pos)]
  switch (c) {
    case "#":
      if (lines.isComment(ctx, pos) || at(DYNAMIC, s, pos)) return true
      if (at(BEGIN, s, pos)) return blockClose(ctx, pos, limit) >= 0
      return keywordStarts(s, pos)
    case ":": return lines.isFixedWidth(ctx, pos) || drawerClose(ctx, pos, limit) >= 0
    case "-": return lines.isRule(ctx, pos)
    case "\\": return lines.latexClose(ctx, pos, limit) >= 0
    case "[": return isFootnote(s, pos)
    case "%": return lines.isDiary(ctx, pos)
    case "c": case "C": return lines.isClock(ctx, pos)
  }
  return false
}

/** After an element's last line: its end past the blank lines that follow, and how many. */
const close = (ctx: Ctx, last: number, limit: number) => skipBlank(ctx.s, last, limit)

function block(ctx: Ctx, pos: number, limit: number, aff: Affiliated, endLine: number): OrgNode {
  const s = ctx.s, m = at(BEGIN, s, pos)!, name = m[1], kind = name.toLowerCase()
  const data = s.slice(pos + m[0].length, eol(s, pos))
  const inner = nextLine(s, pos)
  const [end, postBlank] = close(ctx, nextLine(s, endLine), limit)
  const base = { postBlank, postAffiliated: pos, ...aff.props }
  if (!LESSER.has(kind)) {
    const contents = inner < endLine ? { contentsBegin: inner, contentsEnd: endLine } : {}
    if (kind === "center" || kind === "quote") return node(`${kind}-block`, aff.begin, end, { ...base, ...contents })
    return node("special-block", aff.begin, end, { ...base, ...contents, kind: name, parameters: data.trim() || null })
  }
  if (kind === "verse") {
    return node("verse-block", aff.begin, end, { ...base, contentsBegin: inner, contentsEnd: endLine, children: ctx.objects(inner, endLine, "verse-block") })
  }
  const raw = s.slice(inner, endLine)
  if (kind === "comment") return node("comment-block", aff.begin, end, { ...base, value: raw })
  const value = unescape(raw)
  if (kind === "export") {
    const backend = /^[ \t]+(\S+)[ \t]*$/.exec(data)
    return node("export-block", aff.begin, end, { ...base, kind: backend ? backend[1].toUpperCase() : null, value })
  }
  if (kind === "example") {
    const sw = /^[ \t]+([^\n]*)/.exec(data), switches = sw ? sw[1] : null
    return node("example-block", aff.begin, end, { ...base, value, switches, ...switchProps(switches ?? "", switches ?? "") })
  }
  const h = SRC_DATA.exec(data)!
  const switches = h[2]?.trim() || null
  return node("src-block", aff.begin, end, { ...base, language: h[1] ?? null, switches, parameters: h[3].trim() || null,
    ...switchProps(switches ?? "", h[2] ?? ""), value })
}

const SRC_DATA = /^(?: +(\S+))?((?: +(?:-l "[^"\n]+"|-[ikr]|[-+]n(?: *\d+)?))*)([^\n]*)$/i
const wordEnd = (s: string, i: number) => !isWord(cpAt(s, i))
const NUMBER = / *(\d+)/y

/** Where the switch -<letter> first appears in `s` as a whole word, or -1. */
function flag(s: string, letter: string) {
  for (const m of s.matchAll(new RegExp(`-${letter}`, "gi"))) if (wordEnd(s, m.index + 2)) return m.index
  return -1
}

/** -n or +n with its optional number, the first standing as a word: [new or continued, the number less one]. */
function numberLines(s: string) {
  for (const m of s.matchAll(/([-+])n/gi)) {
    const kind = m[1] === "+" ? "continued" : "new", after = m.index + 2, num = at(NUMBER, s, after)
    if (num && wordEnd(s, after + num[0].length)) return [kind, Number(num[1]) - 1]
    if (wordEnd(s, after)) return [kind, 0]
  }
  return null
}

/** What a src or example block's switches say: numbering, indentation, labels. `raw` is where -i's offset is read. */
function switchProps(switches: string, raw: string) {
  const i = flag(raw, "i"), r = flag(switches, "r") >= 0
  return {
    numberLines: numberLines(switches),
    preserveIndent: i >= 0 ? i : null,
    retainLabels: !r, useLabels: !r && flag(switches, "k") < 0,
    labelFmt: /-l "([^"\n]+)"/i.exec(switches)?.[1] ?? null,
  }
}

/** Contents of a src, example or export block: a comma before `*` or `#+` at a line's start is dropped. */
const unescape = (v: string) => v.replace(/(^|\n)([ \t]*),(,*(?:\*|#\+))/g, "$1$2$3")

function dynamicBlock(ctx: Ctx, pos: number, limit: number, aff: Affiliated, endLine: number): OrgNode {
  const s = ctx.s, m = at(DYNAMIC, s, pos)!, inner = nextLine(s, pos)
  const [end, postBlank] = close(ctx, nextLine(s, endLine), limit)
  return node("dynamic-block", aff.begin, end, { postBlank, postAffiliated: pos, ...aff.props,
    ...(inner < endLine ? { contentsBegin: inner, contentsEnd: endLine } : {}), blockName: m[1], arguments: m[2] ?? null })
}

function drawer(ctx: Ctx, pos: number, limit: number, aff: Affiliated, endLine: number): OrgNode {
  const s = ctx.s
  const [inner, preBlank] = skipBlank(s, nextLine(s, pos), endLine)
  const [end, postBlank] = close(ctx, nextLine(s, endLine), limit)
  return node("drawer", aff.begin, end, { postBlank, postAffiliated: pos, ...aff.props,
    ...(inner < endLine ? { contentsBegin: inner, contentsEnd: endLine } : {}), preBlank, drawerName: drawerName(s, pos) })
}

/** A footnote definition runs to the next one, a headline, or two blank lines in a row. */
function footnoteDefinition(ctx: Ctx, pos: number, limit: number, aff: Affiliated): OrgNode {
  const s = ctx.s, label = footnoteLabel(s, pos)!
  let stop = limit
  for (let p = nextLine(s, pos), blanks = 0; p < limit; p = nextLine(s, p)) {
    if (blankLine(s, p)) { if (++blanks === 2) { stop = p; break } continue }
    blanks = 0
    if (isFootnote(s, p) || at(HEADLINE, s, p)) { stop = p; break }
  }
  const contentsEnd = backBlank(s, stop, nextLine(s, pos))
  const [end, postBlank] = close(ctx, contentsEnd, limit)
  // Its contents start at the first thing after the label: on its line, or at the start of a later line.
  let inner = pos + label.length + 5, preBlank = 0
  while (inner < contentsEnd && /[ \t\n]/.test(s[inner])) if (s[inner++] === "\n") preBlank++
  if (preBlank) inner = s.lastIndexOf("\n", inner - 1) + 1
  const contents = inner < contentsEnd ? { contentsBegin: inner, contentsEnd } : {}
  return node("footnote-definition", aff.begin, end, { postBlank, postAffiliated: pos, ...aff.props, ...contents,
    label, preBlank: contents.contentsBegin === undefined ? 0 : preBlank })
}
