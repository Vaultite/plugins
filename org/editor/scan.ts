// Org's lines as the editors see them: what each line is and the syntax in it, by role. Source styles every role;
// live preview styles the same and draws some as widgets, or hides them, off the cursor's line.
import type { EditorState } from "@codemirror/state"

export type LineRole = "heading" | "code" | "code-first" | "code-last" | "delim" | "quote" | "table" | "fixed" | "hr" | "keyword" | "drawer" | "planning" | "comment"
export type Line = { at: number; to: number; role: LineRole; level?: number; lang?: string; key?: string }

export type SpanRole = "stars" | "todo" | "done" | "prio" | "tags" | "cookie" | "strong" | "em" | "u" | "strike" | "code" | "mark" | "link" | "time"
  | "footnote" | "macro" | "meta" | "plan-word" | "bullet" | "box" | "term" | "pipe" | "comment" | "title" | "indent"
/** A span of `role`; `open`/`close`: its syntax (an emphasis's markers, a link's brackets and target) to hide. */
export type Span = { from: number; to: number; role: SpanRole; open?: number; close?: number; text?: string }

export const HEAD = /^(\*+)([ \t]+)(.*)$/
export const BLOCK = /^[ \t]*#\+(begin|end)_(\S+)(?:[ \t]+(\S+))?/i
const KEYWORD = /^([ \t]*#\+[^:\s]+:)(.*)$/
const DRAWER = /^[ \t]*:([\w-]+):[ \t]*(.*)$/
export const LIST = /^([ \t]*)([-+]|\d+[.)]|[A-Za-z][.)]|[ \t]+\*)(?=[ \t]|$)([ \t]+\[@[^\]\n]+\])?([ \t]+\[[ xX-]\])?/
const PLANNING = /\b(SCHEDULED|DEADLINE|CLOSED):/g
const TIMESTAMP = /[<[]\d{4}-\d{2}-\d{2}[^>\]\n]*[>\]](?:--[<[]\d{4}-\d{2}-\d{2}[^>\]\n]*[>\]])?/g
const BRACKET_LINK = /\[\[([^\]\n]+)\](?:\[([^\]\n]*)\])?\]/g
const PLAIN_LINK = /\b(?:https?|mailto|ftp):[^\s<>\]]+[^\s<>\].,;:!?'")]/g
const FOOTNOTE = /\[fn:[^\]:\n]+\]/g
const MACRO = /\{\{\{[^}\n]+\}\}\}/g
const COOKIE = /\[\d*(?:%|\/\d*)\]/g
const TAGS = /[ \t]+(:[\w@#%:]+:)[ \t]*$/
// Emphasis: a marker after a space or (-'"{ and before one of -.,;:!?'")}[ or a space, its text not starting or
// ending in a space.
const EMPHASIS = /(^|[\s\-('"{])([*/_+=~])([^\s](?:[^\n]*?[^\s])?)\2(?=[\s\-.,;:!?'")}[\]]|$)/g
const EMPHASIS_ROLE: Record<string, SpanRole> = { "*": "strong", "/": "em", _: "u", "+": "strike", "=": "code", "~": "code" }
const CODE_BLOCKS = new Set(["src", "example", "export"])

export type Keywords = { done: Set<string>; all: Set<string> }

/** Whether line `n` is inside a #+begin_ block, and which, from the lines above. */
function blockAt(state: EditorState, n: number): string | null {
  for (let i = n - 1, seen = 0; i >= 1 && seen < 3000; i--, seen++) {
    const t = state.doc.line(i).text, m = BLOCK.exec(t)
    if (m) return m[1].toLowerCase() === "begin" ? m[2].toLowerCase() : null
    if (HEAD.test(t)) return null
  }
  return null
}

/** The lines from `from` to `to` (positions) with their roles and spans. */
export function scan(state: EditorState, from: number, to: number, kw: Keywords): { lines: Line[]; spans: Span[] } {
  const lines: Line[] = [], spans: Span[] = []
  const first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number
  let block = blockAt(state, first)
  for (let n = first; n <= last; n++) {
    const l = state.doc.line(n), t = l.text, at = l.from
    const line = (role: LineRole, more: Partial<Line> = {}) => lines.push({ at, to: l.to, role, ...more })
    const b = BLOCK.exec(t)
    if (b) {
      const opens = b[1].toLowerCase() === "begin", kind = b[2].toLowerCase()
      const code = CODE_BLOCKS.has(kind) || CODE_BLOCKS.has(block ?? "")
      line(code ? (opens ? "code-first" : "code-last") : "delim", { lang: opens ? (b[3] ?? (kind === "src" ? "" : kind)) : undefined })
      spans.push({ from: at, to: l.to, role: "mark" })
      block = opens ? kind : null
      continue
    }
    if (block) {
      if (CODE_BLOCKS.has(block)) { line("code"); continue }
      if (block === "comment") { spans.push({ from: at, to: l.to, role: "comment" }); continue }
      if (block === "quote" || block === "verse") line("quote")
    }
    const h = HEAD.exec(t)
    if (h) { heading(at, t, h, lines, spans, kw); continue }
    if (/^[ \t]*#([ \t]|$)/.test(t)) { line("comment"); spans.push({ from: at, to: l.to, role: "comment" }); continue }
    const k = KEYWORD.exec(t)
    if (k) {
      line("keyword", { key: k[1].trim().slice(2, -1).toUpperCase() })
      spans.push({ from: at, to: at + k[1].length, role: "meta" })
      if (/^[ \t]*#\+title:/i.test(t)) spans.push({ from: at + k[1].length, to: l.to, role: "title" })
      continue
    }
    if (/^[ \t]*:([ \t]|$)/.test(t)) { line("fixed"); continue }
    const d = DRAWER.exec(t)
    if (d) {
      line("drawer", { key: d[1] })
      spans.push({ from: at, to: l.to - d[2].length, role: "meta" })
      inline(l.to - d[2].length, d[2], spans)
      continue
    }
    if (/^[ \t]*\|/.test(t)) { table(at, t, lines, spans, l.to); continue }
    if (/^[ \t]*-{5,}[ \t]*$/.test(t)) { line("hr"); spans.push({ from: at, to: l.to, role: "mark" }); continue }
    let start = 0
    if (/^[ \t]*(SCHEDULED|DEADLINE|CLOSED):/.test(t)) {
      line("planning")
      for (const m of t.matchAll(PLANNING)) spans.push({ from: at + m.index!, to: at + m.index! + m[0].length, role: "plan-word" })
    }
    const li = LIST.exec(t)
    if (li) {
      const b0 = at + li[1].length
      if (li[1]) spans.push({ from: at, to: b0, role: "indent" })
      spans.push({ from: b0, to: b0 + li[2].length, role: "bullet", text: li[2], close: li[4] ? at + li[0].length - 3 : undefined })
      if (li[4]) spans.push({ from: at + li[0].length - 3, to: at + li[0].length, role: "box", text: li[4].trim()[1] })
      start = li[0].length
      const desc = t.indexOf(" :: ", start)
      if (desc > 0) spans.push({ from: at + start, to: at + desc, role: "term" })
    }
    inline(at + start, t.slice(start), spans)
  }
  return { lines, spans }
}

function heading(at: number, t: string, h: RegExpExecArray, lines: Line[], spans: Span[], kw: Keywords) {
  lines.push({ at, to: at + t.length, role: "heading", level: h[1].length })
  spans.push({ from: at, to: at + h[1].length + h[2].length, role: "stars" })
  let p = h[1].length + h[2].length
  const word = /^(\S+)/.exec(h[3])?.[1] ?? ""
  if (kw.all.has(word)) {
    spans.push({ from: at + p, to: at + p + word.length, role: kw.done.has(word) ? "done" : "todo", text: word })
    p += word.length + (/^\S+([ \t]*)/.exec(h[3])?.[1].length ?? 0)
  }
  const prio = /^\[#([^\]])\][ \t]*/.exec(t.slice(p))
  if (prio) { spans.push({ from: at + p, to: at + p + prio[0].length, role: "prio", text: prio[1] }); p += prio[0].length }
  const tags = TAGS.exec(t)
  const end = tags ? t.length - tags[0].length : t.length
  if (tags) spans.push({ from: at + end, to: at + t.length, role: "tags", text: tags[1] })
  inline(at + p, t.slice(p, end), spans)
}

function table(at: number, t: string, lines: Line[], spans: Span[], to: number) {
  lines.push({ at, to, role: "table" })
  if (/^[ \t]*\|-/.test(t)) { spans.push({ from: at, to: at + t.length, role: "pipe" }); return }
  for (let i = t.indexOf("|"); i >= 0; i = t.indexOf("|", i + 1)) spans.push({ from: at + i, to: at + i + 1, role: "pipe" })
  inline(at, t, spans)
}

/** Links, dates, footnotes, macros, cookies and emphasis in a stretch of text at `at`. */
function inline(at: number, t: string, spans: Span[]) {
  const taken: [number, number][] = []
  const free = (f: number, e: number) => !taken.some(([a, b]) => f < b && e > a)
  for (const m of t.matchAll(BRACKET_LINK)) {
    const f = m.index!, e = f + m[0].length
    taken.push([f, e])
    // [[target][desc]]: the description shows; [[target]]: the target does.
    const open = m[2] !== undefined ? f + 2 + m[1].length + 2 : f + 2, close = e - (m[2] !== undefined ? 2 : 2)
    spans.push({ from: at + f, to: at + e, role: "link", open: at + open, close: at + close, text: m[1] })
  }
  const put = (re: RegExp, role: SpanRole) => {
    for (const m of t.matchAll(re)) {
      const f = m.index!, e = f + m[0].length
      if (!free(f, e)) continue
      taken.push([f, e]); spans.push({ from: at + f, to: at + e, role, text: m[0] })
    }
  }
  put(PLAIN_LINK, "link"); put(TIMESTAMP, "time")
  for (const m of t.matchAll(FOOTNOTE)) {
    const f = m.index!, e = f + m[0].length
    if (!free(f, e)) continue
    taken.push([f, e]); spans.push({ from: at + f, to: at + e, role: "footnote", open: at + f + 4, close: at + e - 1 })
  }
  put(MACRO, "macro"); put(COOKIE, "cookie")
  for (const m of t.matchAll(EMPHASIS)) {
    const f = m.index! + m[1].length, e = m.index! + m[0].length
    if (!free(f, e)) continue
    taken.push([f, e]); spans.push({ from: at + f, to: at + e, role: EMPHASIS_ROLE[m[2]], open: at + f + 1, close: at + e - 1 })
  }
}
