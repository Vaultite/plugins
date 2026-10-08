// Inline queries in a note, `= this.file.name`: drawn as their value while the cursor isn't on their line (as the
// editor shows the rest of Markdown), asked of the server and again when a note changes.
import { RangeSetBuilder } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"
import { dateText, get, openFile } from "@vaultite"
import type { Wire } from "./values"

type Answer = { value: Wire; text: string } | { error: string }

// What each inline query answered, by note and expression, until a note changes (`changed`).
const answers = new Map<string, Promise<Answer>>()
const editors = new Set<EditorView>()
let gen = 0
export function changed() {
  answers.clear()
  gen++
  for (const v of editors) v.dispatch({})
}
const ask = (path: string, q: string) => {
  const k = `${path}\0${q}`
  let a = answers.get(k)
  if (!a) {
    a = get<Answer>(`dataview/inline?q=${encodeURIComponent(q)}&path=${encodeURIComponent(path)}`).catch((e) => ({ error: String(e).replace(/^Error: /, "") }))
    answers.set(k, a)
  }
  return a
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/
function words(v: Wire): string {
  if (v === null || v === undefined) return "–"
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (typeof v !== "object") return String(v)
  if (Array.isArray(v)) return v.map(words).join(", ")
  switch (v.$) {
    case "link": return v.display ?? v.path.replace(/^.*\//, "").replace(/\.md$/i, "")
    case "date": {
      const m = DAY.exec(v.iso)!
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0))
      const date = dateText(d, { day: "numeric", month: "long", year: "numeric" })
      return m[4] ? `${date}, ${dateText(d, { hour: "numeric", minute: "2-digit" })}` : date
    }
    case "dur": return v.text
    case "item": return v.text
    case "obj": return Object.entries(v.v).map(([k, x]) => `${k}: ${words(x)}`).join(", ")
    default: return ""
  }
}

class Value extends WidgetType {
  path: string; q: string; gen: number
  constructor(path: string, q: string) { super(); this.path = path; this.q = q; this.gen = gen }
  eq(o: Value) { return o.path === this.path && o.q === this.q && o.gen === this.gen }
  toDOM() {
    const el = document.createElement("span")
    el.className = "cm-dv-inline"
    el.dataset.dvInline = this.q
    el.textContent = "…"
    const js = this.q.startsWith("$=")
    if (js) { show(el, { error: "dataviewjs isn't run here" }); return el }
    void ask(this.path, this.q.slice(1)).then((a) => show(el, a))
    return el
  }
  ignoreEvent() { return false }
}

function show(el: HTMLElement, a: Answer) {
  el.replaceChildren()
  if ("error" in a) {
    el.textContent = `Dataview: ${a.error}`
    el.classList.add("cm-dv-error")
    return
  }
  const v = a.value
  if (v && typeof v === "object" && !Array.isArray(v) && v.$ === "link" && v.exists) {
    const b = document.createElement("span")
    b.className = "cm-dv-link"
    b.textContent = words(v)
    b.onmousedown = (e) => { e.preventDefault(); openFile(v.path, { newTab: e.metaKey || e.ctrlKey }) }
    el.append(b)
    return
  }
  el.textContent = words(v)
}

const theme = EditorView.baseTheme({
  ".cm-dv-inline": { borderRadius: "4px", padding: "0 3px", background: "color-mix(in srgb, var(--dataview, var(--indigo)) 10%, transparent)" },
  ".cm-dv-error": { color: "var(--muted-foreground)", fontSize: "0.9em" },
  ".cm-dv-link": { color: "var(--primary)", cursor: "pointer" },
})

/** The editor's inline queries, each `= ...` (and `$= ...`) span of inline code drawn as its value off the cursor's line. */
export function inlineQueries(path: string) {
  const build = (view: EditorView): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>()
    const { state } = view
    const editing = view.hasFocus && state.facet(EditorView.editable)
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from, to,
        enter: (n) => {
          if (n.name !== "InlineCode") return
          const src = state.sliceDoc(n.from, n.to)
          const m = /^(`+)\s*(\$?=[\s\S]*?)\s*\1$/.exec(src)
          if (!m || m[2].length < 2) return false
          const line = state.doc.lineAt(n.from)
          if (editing && state.selection.ranges.some((r) => r.to >= line.from && r.from <= line.to)) return false
          b.add(n.from, n.to, Decoration.replace({ widget: new Value(path, m[2]) }))
          return false
        },
      })
    }
    return b.finish()
  }
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet
    view: EditorView
    seen = gen
    constructor(view: EditorView) { this.view = view; this.decorations = build(view); editors.add(view) }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || this.seen !== gen) { this.seen = gen; this.decorations = build(u.view) }
    }
    destroy() { editors.delete(this.view) }
  }, { decorations: (p) => p.decorations })
  return [plugin, theme]
}
