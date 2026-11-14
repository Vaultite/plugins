// Live preview, as a note's: off the cursor's line Org's syntax hides and keywords, boxes, tags and dates become the
// reading view's chips; on it, the text shows as in source.
import { foldEffect, foldedRanges, foldState, unfoldEffect } from "@codemirror/language"
import type { EditorState, Extension, Range } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import type { Store } from "@vaultite"
import { isText, parse, settingsOf, walk, type OrgNode, type Settings } from "../parser/index.ts"
import { foldsOf, putFolds, type Fold } from "../view/folds.ts"
import { follow, resolve } from "../view/Link.tsx"
import { headlineKeys, indexDoc } from "../view/tree.ts"
import { HEAD, scan, type Keywords, type Span } from "./scan.ts"
import { keywordSets, lineClass, lineDeco, markDeco, ROLE_CLASS } from "./source.ts"
import { drawerRange, headlineRange, orgEditing } from "./structure.ts"
import { BoxWidget, BulletWidget, CookieWidget, DateWidget, FenceWidget, KeywordWidget, PriorityWidget, RuleWidget, TagsWidget } from "./widgets.ts"

const hide = Decoration.replace({})
const replace = (widget: WidgetType) => Decoration.replace({ widget })
const EMPHASIS = new Set(["strong", "em", "u", "strike", "code"])

/** The lines the selection is on, while the editor has the keyboard: they show their text. */
function activeLines(view: EditorView): Set<number> {
  const out = new Set<number>()
  if (!view.hasFocus) return out
  for (const r of view.state.selection.ranges) {
    for (let p = view.state.doc.lineAt(r.from).from; p <= r.to;) { const l = view.state.doc.lineAt(p); out.add(l.from); p = l.to + 1 }
  }
  return out
}

/** Whether the headline above a planning line is done (its dates are then quiet). */
function headDone(state: EditorState, at: number, kw: Keywords) {
  const n = state.doc.lineAt(at).number
  const h = n > 1 ? HEAD.exec(state.doc.line(n - 1).text) : null
  return !!h && kw.done.has(/^(\S+)/.exec(h[3])?.[1] ?? "")
}

function decorations(view: EditorView, kw: Keywords, settings: Settings): DecorationSet {
  const out: Range<Decoration>[] = []
  const active = activeLines(view), state = view.state
  const taken = new Set<Span>()
  for (const { from, to } of view.visibleRanges) {
    const { lines, spans } = scan(state, from, to, kw)
    const shown = (pos: number) => active.has(state.doc.lineAt(pos).from)
    for (const l of lines) {
      const c = lineClass(l), raw = active.has(l.at)
      if (c) out.push(lineDeco(raw ? c : l.role === "code-first" ? `${c} cm-fence-top${l.lang ? "" : " cm-fence-bare"}` : l.role === "code-last" ? `${c} cm-fence-bottom` : c).range(l.at))
      if (raw || l.to <= l.at) continue
      if (l.role === "code-first") out.push(Decoration.replace({ widget: new FenceWidget(l.lang ?? "") }).range(l.at, l.to))
      else if (l.role === "code-last") out.push(hide.range(l.at, l.to))
      else if (l.role === "delim") { out.push(lineDeco("cm-org-gone").range(l.at)); out.push(hide.range(l.at, l.to)) }
      else if (l.role === "hr") out.push(Decoration.replace({ widget: new RuleWidget() }).range(l.at, l.to))
    }
    const lineRoles = new Map(lines.map((l) => [l.at, l.role]))
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]
      if (s.to <= s.from) continue
      const at = state.doc.lineAt(s.from).from
      if (shown(s.from) || lineRoles.get(at) === "hr" || (lineRoles.get(at) ?? "").startsWith("code")) { out.push(markDeco(ROLE_CLASS[s.role]).range(s.from, s.to)); continue }
      live(s, s.role === "plan-word" ? spans.find((t) => t.role === "time" && t.from >= s.to && t.from - s.to <= 2) : undefined, at, lineRoles.get(at) === "planning")
    }
  }
  function live(s: Span, next: Span | undefined, at: number, planning: boolean) {
    switch (s.role) {
      case "stars": out.push(hide.range(s.from, s.to)); return
      case "todo": case "done": out.push(replace(new KeywordWidget(s.text!, s.role === "done", s.from)).range(s.from, s.to)); return
      case "prio": out.push(replace(new PriorityWidget(s.text!.charCodeAt(0), settings.priorityHighest, settings.priorityLowest)).range(s.from, s.to)); return
      case "tags": out.push(replace(new TagsWidget(s.text!.split(":").filter(Boolean))).range(s.from, s.to)); return
      case "cookie": out.push(replace(new CookieWidget(s.text!)).range(s.from, s.to)); return
      case "box":
        out.push(replace(new BoxWidget(s.text!, s.from)).range(s.from, s.to))
        if (/[xX]/.test(s.text!)) out.push(lineDeco("cm-task-done").range(at))
        return
      case "bullet":
        // A task's box stands for its bullet, as in a note.
        if (s.close !== undefined) out.push(hide.range(s.from, s.close))
        else if (s.text === "-" || s.text === "+") out.push(replace(new BulletWidget()).range(s.from, s.to))
        else out.push(markDeco("cm-listmark").range(s.from, s.to))
        return
      case "plan-word": {
        // SCHEDULED: <date>: one chip, as the reading view draws it.
        if (planning && next?.role === "time") {
          const kind = state.sliceDoc(s.from, s.to - 1).toLowerCase() as "scheduled" | "deadline" | "closed"
          out.push(replace(new DateWidget(next.text!, kind, headDone(state, at, kw))).range(s.from, next.to))
          taken.add(next)
        } else out.push(markDeco(ROLE_CLASS[s.role]).range(s.from, s.to))
        return
      }
      case "time": if (!taken.has(s)) out.push(replace(new DateWidget(s.text!, null, false)).range(s.from, s.to)); return
      case "link":
        if (s.open !== undefined && s.close !== undefined && s.close > s.open) {
          out.push(hide.range(s.from, s.open), hide.range(s.close, s.to))
          out.push(Decoration.mark({ class: "cm-link cm-org-link", attributes: { "data-org-link": String(s.from) } }).range(s.open, s.close))
        } else out.push(Decoration.mark({ class: "cm-link cm-org-link", attributes: { "data-org-link": String(s.from) } }).range(s.from, s.to))
        return
      default:
        if (s.role === "footnote" && s.open !== undefined && s.close !== undefined) {
          out.push(hide.range(s.from, s.open), hide.range(s.close, s.to), markDeco("footnote-ref").range(s.open, s.close))
        } else if (EMPHASIS.has(s.role) && s.open !== undefined && s.close !== undefined) {
          out.push(hide.range(s.from, s.open), hide.range(s.close, s.to), markDeco(ROLE_CLASS[s.role]).range(s.open, s.close))
        } else out.push(markDeco(ROLE_CLASS[s.role]).range(s.from, s.to))
    }
  }
  return Decoration.set(out, true)
}

const settingsLine = (u: ViewUpdate) => {
  let hit = false
  u.changes.iterChangedRanges((_a, _b, from, to) => {
    for (let p = from; p <= to && !hit;) { const l = u.state.doc.lineAt(p); if (/^[ \t]*#\+/.test(l.text)) hit = true; p = l.to + 1 }
  })
  return hit
}

const drawing = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  kw: Keywords
  settings: Settings
  constructor(view: EditorView) {
    const doc = view.state.doc.toString()
    this.kw = keywordSets(doc); this.settings = settingsOf(doc)
    this.decorations = decorations(view, this.kw, this.settings)
  }
  update(u: ViewUpdate) {
    if (u.docChanged && settingsLine(u)) { const doc = u.state.doc.toString(); this.kw = keywordSets(doc); this.settings = settingsOf(doc) }
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = decorations(u.view, this.kw, this.settings)
  }
}, { decorations: (v) => v.decorations })

/** A click on a link (off the cursor's line) follows it: the web and vault files as the app opens them, a place in the
 *  file by moving there. */
function links(path: string, store?: Store) {
  return EditorView.domEventHandlers({
    click(e, view) {
      const a = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-org-link]") : null
      if (!a || e.button !== 0) return false
      const at = Number(a.dataset.orgLink), text = view.state.doc.toString(), root = parse(text)
      const n = [...walk(root)].find((c): c is OrgNode => !isText(c) && c.type === "link" && c.begin <= at && at < c.end)
      if (!n) return false
      e.preventDefault()
      const ctx = { path, store, doc: indexDoc(root), settings: settingsOf(text) }
      follow(ctx, resolve(ctx, n), e, (pos) => reveal(view, pos))
      return true
    },
  })
}

/** Moves to `pos`, opening the folds that hide it. */
function reveal(view: EditorView, pos: number) {
  const effects = []
  for (const r of folded(view.state)) if (r.from <= pos && pos <= r.to) effects.push(unfoldEffect.of(r))
  const line = view.state.doc.lineAt(pos)
  view.dispatch({ effects: [...effects, EditorView.scrollIntoView(line.from, { y: "start", yMargin: 80 })], selection: { anchor: line.to } })
  view.focus()
}

function folded(state: EditorState) {
  const out: { from: number; to: number }[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => { out.push({ from, to }) })
  return out
}

/** Folds as the reading view keeps them for the file (and drawers closed), and kept again as they change. */
function keptFolds(path: string) {
  return ViewPlugin.fromClass(class {
    view: EditorView
    timer: ReturnType<typeof setTimeout> | null = null
    constructor(view: EditorView) {
      this.view = view
      setTimeout(() => { if (view.dom.isConnected) this.restore() }, 0)
    }
    keys() {
      const text = this.view.state.doc.toString(), root = parse(text)
      return { root, keys: headlineKeys(root), settings: settingsOf(text), startup: (text.match(/^[ \t]*#\+STARTUP:[ \t]*(.*)$/im)?.[1] ?? "").split(/\s+/) }
    }
    restore() {
      const { root, keys, settings, startup } = this.keys(), s = this.view.state
      const kept = foldsOf(path, root, keys, startup, settings.archiveTag), effects = []
      for (const [n, key] of keys) if (kept.get(key) === "folded") { const r = headlineRange(s, n.begin); if (r) effects.push(foldEffect.of(r)) }
      for (let i = 1; i <= s.doc.lines; i++) { const r = drawerRange(s, s.doc.line(i).from); if (r) effects.push(foldEffect.of(r)) }
      if (effects.length) this.view.dispatch({ effects })
    }
    update(u: ViewUpdate) {
      if (u.startState.field(foldState, false) === u.state.field(foldState, false)) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => { this.timer = null; this.keep() }, 300)
    }
    keep() {
      const { keys } = this.keys(), ends = new Set(folded(this.view.state).map((r) => r.from))
      const all = new Map<string, Fold>()
      for (const [n, key] of keys) if (ends.has(this.view.state.doc.lineAt(n.begin).to)) all.set(key, "folded")
      putFolds(path, all)
    }
    destroy() { if (this.timer) { clearTimeout(this.timer); this.keep() } }
  })
}

const kwOf = new WeakMap<object, Keywords>()
/** Whether from..to is text the reader sees off the cursor's line (not a link's target, a marker, a block's line):
 *  what Find finds. */
export function findable(state: EditorState, from: number, to: number): boolean {
  let kw = kwOf.get(state.doc)
  if (!kw) kwOf.set(state.doc, kw = keywordSets(state.doc.toString()))
  const { lines, spans } = scan(state, from, to, kw)
  const over = (a: number, b: number) => from < b && to > a
  if (lines.some((l) => (l.role === "code-first" || l.role === "code-last" || l.role === "delim") && over(l.at, l.to))) return false
  return !spans.some((sp) => {
    if (sp.role === "stars") return over(sp.from, sp.to)
    if (sp.role === "bullet" && sp.close !== undefined) return over(sp.from, sp.close)
    if (sp.open === undefined || sp.close === undefined) return false
    return over(sp.from, sp.open) || over(sp.close, sp.to)
  })
}

/** Everything the live preview editor gets for the file at `path`. */
export function orgLive(path: string, store?: Store): Extension {
  return [drawing, orgEditing, links(path, store), keptFolds(path)]
}
