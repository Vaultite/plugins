// The class names Obsidian's editor gives what plugins' styles colour: the editor's own (cm-s-obsidian) and each tag's
// (cm-hashtag cm-tag-<name>), on notes in the app's editor; a finger held on a tag opens its menu, as a right-click does.
import { RangeSetBuilder } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"

const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu
const marks = new Map<string, Decoration>()
const markOf = (tag: string) => {
  const flat = tag.toLowerCase().replace(/\//g, "")
  let m = marks.get(flat)
  if (!m) marks.set(flat, (m = Decoration.mark({ class: `cm-hashtag cm-meta cm-tag-${flat}`, attributes: { "data-tag": tag, "data-hold-menu": "" } })))
  return m
}

function tagsIn(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    for (const m of text.matchAll(TAG)) {
      const at = from + (m.index ?? 0) + m[1].length, end = at + m[2].length + 1
      const node = tree.resolveInner(at, 1).name
      if (/Code|Frontmatter|URL|Link/i.test(node)) continue
      b.add(at, end, markOf(m[2]))
    }
  }
  return b.finish()
}

const SOURCE_VIEW = ["markdown-source-view", "mod-cm6", "is-live-preview"]

/** For notes' editors: plugins' styles and menus find them by these (tags, the editor's box). */
export const obsidianTokens = () => [
  EditorView.editorAttributes.of({ class: "cm-s-obsidian" }),
  // (the box around the editor, as Obsidian's: what plugins' selectors and delegated listeners look for)
  ViewPlugin.fromClass(class {
    box: HTMLElement | null
    constructor(v: EditorView) { this.box = v.dom.parentElement; this.box?.classList.add(...SOURCE_VIEW) }
    destroy() { this.box?.classList.remove(...SOURCE_VIEW) }
  }),
  ViewPlugin.fromClass(class {
    decorations: DecorationSet
    constructor(v: EditorView) { this.decorations = tagsIn(v) }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = tagsIn(u.view) }
  }, { decorations: (p) => p.decorations }),
]
