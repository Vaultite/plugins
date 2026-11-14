// What both Org editors (source, live preview) share: headlines and drawers fold, Org's keys (Tab folds, Alt+←/→
// promotes and demotes, Enter continues a list), keyword cycling and checkbox ticking as the drawing does them.
import { codeFolding, foldEffect, foldable, foldedRanges, foldService, unfoldEffect } from "@codemirror/language"
import { Prec, type EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { checkboxEdits, todoEdits, type Edit } from "../edit/edits.ts"
import { isText, parse, walk, type OrgNode } from "../parser/index.ts"
import { HEAD, LIST } from "./scan.ts"

// ---- Folding: a headline folds to the next one of its level or higher.

export const levelOf = (t: string) => { const m = HEAD.exec(t); return m ? m[1].length : 0 }

export function headlineRange(state: EditorState, lineFrom: number): { from: number; to: number } | null {
  const l = state.doc.lineAt(lineFrom), level = levelOf(l.text)
  if (!level) return null
  let end = state.doc.length
  for (let n = l.number + 1; n <= state.doc.lines; n++) {
    const x = state.doc.line(n), lv = levelOf(x.text)
    if (lv && lv <= level) { end = x.from - 1; break }
  }
  while (end > l.to && /\s/.test(state.sliceDoc(end - 1, end))) end--
  return end > l.to ? { from: l.to, to: end } : null
}

const DRAWER_OPEN = /^[ \t]*:([\w-]+):[ \t]*$/

/** A drawer folds from its :NAME: line to its :END:. */
export function drawerRange(state: EditorState, lineFrom: number): { from: number; to: number } | null {
  const l = state.doc.lineAt(lineFrom), m = DRAWER_OPEN.exec(l.text)
  if (!m || m[1].toUpperCase() === "END") return null
  for (let n = l.number + 1; n <= state.doc.lines && n < l.number + 2000; n++) {
    const x = state.doc.line(n)
    if (/^[ \t]*:END:[ \t]*$/i.test(x.text)) return { from: l.to, to: x.to }
    if (HEAD.test(x.text)) return null
  }
  return null
}

const folding = foldService.of((state, from) => headlineRange(state, from) ?? drawerRange(state, from))

function toggleFold(view: EditorView): boolean {
  const l = view.state.doc.lineAt(view.state.selection.main.head)
  if ((!levelOf(l.text) && !drawerRange(view.state, l.from)) || !view.state.selection.main.empty) return false
  let open: { from: number; to: number } | null = null
  foldedRanges(view.state).between(l.to, l.to, (from, to) => { if (from === l.to) open = { from, to } })
  if (open) { view.dispatch({ effects: unfoldEffect.of(open) }); return true }
  const r = foldable(view.state, l.from, l.to)
  if (r) view.dispatch({ effects: foldEffect.of(r) })
  return true
}

/** Shift+Tab: everything folded to its top headlines, or all open again. */
function cycleAll(view: EditorView): boolean {
  const s = view.state, folded: { from: number; to: number }[] = []
  foldedRanges(s).between(0, s.doc.length, (from, to) => { folded.push({ from, to }) })
  if (folded.length) { view.dispatch({ effects: folded.map((r) => unfoldEffect.of(r)) }); return true }
  const effects = []
  for (let n = 1; n <= s.doc.lines; n++) {
    const l = s.doc.line(n)
    if (levelOf(l.text) !== 1) continue
    const r = headlineRange(s, l.from)
    if (r) effects.push(foldEffect.of(r))
  }
  if (effects.length) view.dispatch({ effects })
  return true
}

// ---- Structure edits

/** Alt+←/→: the headline one level up or down; with Shift, its whole subtree. */
function shift(by: 1 | -1, subtree: boolean) {
  return (view: EditorView): boolean => {
    const s = view.state, l = s.doc.lineAt(s.selection.main.head), level = levelOf(l.text)
    if (!level) return false
    if (by < 0 && level === 1) return true
    const changes = [{ from: l.from, to: l.from + level, insert: "*".repeat(level + by) }]
    if (subtree) {
      for (let n = l.number + 1; n <= s.doc.lines; n++) {
        const x = s.doc.line(n), lv = levelOf(x.text)
        if (lv && lv <= level) break
        if (lv) changes.push({ from: x.from, to: x.from + lv, insert: "*".repeat(Math.max(1, lv + by)) })
      }
    }
    view.dispatch({ changes, userEvent: "input.org", scrollIntoView: true })
    return true
  }
}

/** The node of `type` starting on the line at `pos` (the cursor's), from a parse of the file as it is. */
function nodeOnLine(view: EditorView, type: string, pos = view.state.selection.main.head): { doc: OrgNode; node: OrgNode } | null {
  const s = view.state, l = s.doc.lineAt(pos)
  const doc = parse(s.doc.toString())
  for (const c of walk(doc)) if (!isText(c) && c.type === type && c.begin >= l.from && c.begin <= l.to) return { doc, node: c }
  return null
}

const dispatchEdits = (view: EditorView, edits: Edit[]) => {
  if (edits.length) view.dispatch({ changes: edits, userEvent: "input.org" })
  return true
}

/** The headline's keyword moved to the next in its sequence (then none), as Org's C-c C-t; `to`: that one. */
export function cycleKeyword(view: EditorView, pos?: number, to: string | null = null): boolean {
  const hit = nodeOnLine(view, "headline", pos)
  return hit ? dispatchEdits(view, todoEdits(view.state.doc.toString(), hit.node, to)) : false
}

/** The checkbox on the cursor's line ticked or unticked, its parents and cookies following (C-c C-c). */
export function toggleBox(view: EditorView, pos?: number): boolean {
  const hit = nodeOnLine(view, "item", pos)
  return hit?.node.checkbox ? dispatchEdits(view, checkboxEdits(view.state.doc.toString(), hit.doc, hit.node)) : false
}

/** Enter in a list item: the next item, with the same bullet (numbered on) and an empty box if it had one; Enter in
 *  an empty item ends the list. */
function newItem(view: EditorView): boolean {
  const s = view.state, r = s.selection.main
  if (!r.empty) return false
  const l = s.doc.lineAt(r.head), m = LIST.exec(l.text)
  if (!m || r.head < l.from + m[0].length) return false
  if (!l.text.slice(m[0].length).trim()) { view.dispatch({ changes: { from: l.from, to: l.to, insert: "" }, userEvent: "input.org" }); return true }
  const n = /^(\d+)([.)])$/.exec(m[2]), bullet = n ? `${Number(n[1]) + 1}${n[2]}` : m[2]
  const insert = `\n${m[1]}${bullet}${m[4] ? " [ ]" : ""} `
  view.dispatch({ changes: { from: r.head, insert }, selection: { anchor: r.head + insert.length }, userEvent: "input.org", scrollIntoView: true })
  return true
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

const keys = keymap.of([
  { key: "Enter", run: newItem },
  { key: "Tab", run: toggleFold },
  { key: "Shift-Tab", run: cycleAll },
  { key: "Alt-ArrowLeft", run: shift(-1, false) },
  { key: "Alt-ArrowRight", run: shift(1, false) },
  { key: "Alt-Shift-ArrowLeft", run: shift(-1, true) },
  { key: "Alt-Shift-ArrowRight", run: shift(1, true) },
  // Emacs's own keys where Control isn't copy.
  ...(MAC ? [{ key: "Ctrl-c Ctrl-t", run: (v: EditorView) => cycleKeyword(v) }, { key: "Ctrl-c Ctrl-c", run: (v: EditorView) => toggleBox(v) }] : []),
])

const theme = EditorView.theme({
  "& .cm-org-meta": { color: "var(--muted-foreground)" },
  "& .cm-org-delim": { color: "var(--muted-foreground)" },
  "& .cm-org-planning": { color: "var(--muted-foreground)", fontWeight: "600", fontSize: "0.875em" },
  "& .cm-org-time": { color: "oklch(from var(--primary) var(--ink-l) c h)", fontVariantNumeric: "tabular-nums" },
  "& .cm-org-kw": { color: "oklch(from var(--orange) var(--ink-l) c h)", fontWeight: "700" },
  "& .cm-org-kw.is-done": { color: "oklch(from var(--green) var(--ink-l) c h)" },
  "& .cm-org-prio": { color: "oklch(from var(--red) var(--ink-l) c h)", fontWeight: "600" },
  "& .cm-org-tags": { color: "oklch(from var(--primary) var(--ink-l) c h)", fontWeight: "500", fontSize: "0.8em" },
  "& .cm-org-cookie": { color: "var(--muted-foreground)", fontWeight: "600" },
  "& .cm-org-bullet": { color: "var(--muted-foreground)" },
  "& .cm-org-box": { color: "oklch(from var(--notes) var(--ink-l) c h)", fontWeight: "600" },
  "& .cm-org-u": { textDecoration: "underline", textUnderlineOffset: "3px" },
  "& .cm-org-table": { fontFamily: "var(--font-code)", fontSize: "0.875em" },
  "& .cm-foldPlaceholder": {
    display: "inline-block", margin: "0 6px", padding: "0 6px", border: "none", borderRadius: "5px", cursor: "pointer",
    background: "color-mix(in srgb, var(--foreground) 7%, transparent)", color: "var(--muted-foreground)", fontSize: "0.85em", lineHeight: "1.5",
    verticalAlign: "middle", fontWeight: "500",
  },
})

/** What both editors get: folding, Org's keys, the look of its marks. */
export const orgEditing: Extension = [folding, codeFolding({ placeholderText: "…" }), Prec.high(keys), theme]
