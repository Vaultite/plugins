// An .org file's source, drawn as a note's source is (the editor's own classes: headings by level, marks, code
// blocks), with what an Org user's hands expect (structure.ts).
import type { Extension } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { todoSequences } from "../edit/edits.ts"
import { scan, type Keywords, type Line, type SpanRole } from "./scan.ts"
import { orgEditing } from "./structure.ts"

export { cycleKeyword, toggleBox } from "./structure.ts"

/** Each role's class: the editor's own where a note's source has the same thing. */
export const ROLE_CLASS: Record<SpanRole, string> = {
  stars: "cm-hmark", todo: "cm-org-kw", done: "cm-org-kw is-done", prio: "cm-org-prio", tags: "cm-org-tags", cookie: "cm-org-cookie",
  strong: "cm-strong", em: "cm-em", u: "cm-org-u", strike: "cm-strike", code: "cm-code", mark: "cm-codemark", link: "cm-link-raw",
  time: "cm-org-time", footnote: "cm-link-raw", macro: "cm-org-meta", meta: "cm-org-meta", "plan-word": "cm-org-planning",
  bullet: "cm-org-bullet", box: "cm-org-box", term: "cm-strong", pipe: "cm-codemark", comment: "cm-comment", title: "cm-strong",
  indent: "cm-org-indent",
}

export function lineClass(l: Line): string | null {
  switch (l.role) {
    case "heading": return `cm-h cm-h${Math.min(l.level ?? 1, 6)}`
    case "code": return "cm-codeblock"
    case "code-first": return "cm-codeblock cm-codeblock-first"
    case "code-last": return "cm-codeblock cm-codeblock-last"
    case "fixed": return "cm-codeblock cm-codeblock-first cm-codeblock-last"
    case "delim": return "cm-org-delim"
    case "quote": return "cm-quote"
    case "table": return "cm-org-table"
    default: return null
  }
}

const made = new Map<string, Decoration>()
export const lineDeco = (cls: string) => made.get(`l ${cls}`) ?? made.set(`l ${cls}`, Decoration.line({ class: cls })).get(`l ${cls}`)!
export const markDeco = (cls: string) => made.get(`m ${cls}`) ?? made.set(`m ${cls}`, Decoration.mark({ class: cls })).get(`m ${cls}`)!

export function keywordSets(doc: string): Keywords {
  const seqs = todoSequences(doc)
  return { done: new Set(seqs.flatMap((s) => s.done)), all: new Set(seqs.flatMap((s) => [...s.todo, ...s.done])) }
}

/** The file's keywords, read again when a #+TODO: line changes. */
export function keywordsAfter(u: ViewUpdate, was: Keywords): Keywords {
  if (!u.docChanged) return was
  let changed = false
  u.changes.iterChangedRanges((_a, _b, from, to) => {
    for (let p = from; p <= to && !changed;) { const l = u.state.doc.lineAt(p); if (/^[ \t]*#\+(SEQ_|TYP_)?TODO:/i.test(l.text)) changed = true; p = l.to + 1 }
  })
  return changed ? keywordSets(u.state.doc.toString()) : was
}

function decorations(view: EditorView, kw: Keywords): DecorationSet {
  const out = []
  for (const { from, to } of view.visibleRanges) {
    const { lines, spans } = scan(view.state, from, to, kw)
    for (const l of lines) { const c = lineClass(l); if (c) out.push(lineDeco(c).range(l.at)) }
    for (const s of spans) if (s.to > s.from) out.push(markDeco(ROLE_CLASS[s.role]).range(s.from, s.to))
  }
  return Decoration.set(out, true)
}

const highlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  kw: Keywords
  constructor(view: EditorView) { this.kw = keywordSets(view.state.doc.toString()); this.decorations = decorations(view, this.kw) }
  update(u: ViewUpdate) {
    this.kw = keywordsAfter(u, this.kw)
    if (u.docChanged || u.viewportChanged) this.decorations = decorations(u.view, this.kw)
  }
}, { decorations: (v) => v.decorations })

/** Everything an .org file's source editor gets. */
export const orgSource: Extension = [highlight, orgEditing]
