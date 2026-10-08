// The syntax tree plugins get from `syntaxTree(state)`: Obsidian's Markdown parser names its nodes by token classes
// ("inline-code", "header_header-1", "hmd-codeblock"), so the app's Lezer tree is read into a flat tree named that way.
import { NodeProp, NodeSet, NodeType, Tree } from "@lezer/common"
import * as language from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import { StreamLanguage } from "./cm5.ts"

export const tokenClassNodeProp = new NodeProp<string>()

type Span = { from: number; to: number; cls: string; ctx?: boolean }
const BEGIN = "HyperMD-codeblock_HyperMD-codeblock-begin_HyperMD-codeblock-begin-bg_HyperMD-codeblock-bg"
const END = "HyperMD-codeblock_HyperMD-codeblock-bg_HyperMD-codeblock-end_HyperMD-codeblock-end-bg"

const types: NodeType[] = [NodeType.define({ id: 0, name: "Document", top: true })]
const byName = new Map<string, number>()
function typeOf(name: string) {
  let id = byName.get(name)
  if (id === undefined) {
    id = types.length
    types.push(NodeType.define({ id, name, props: [[tokenClassNodeProp, name.replace(/_/g, " ")]] }))
    byName.set(name, id)
  }
  return id
}

/** Obsidian's spans of a Markdown document, from the app's tree and what it leaves to live preview (math, links, tags). */
function spansOf(tree: Tree, doc: string): Span[] {
  const out: Span[] = [], code: [number, number][] = []
  const lineEnd = (p: number) => { const i = doc.indexOf("\n", p); return i < 0 ? doc.length : i }
  let depth = 0
  tree.iterate({
    enter: (n) => {
      const { name, from, to } = n
      const h = /^(ATX|Setext)Heading(\d)$/.exec(name)
      if (h) { out.push({ from, to, cls: `header_header-${h[2]}`, ctx: true }); return }
      switch (name) {
        case "Frontmatter": out.push({ from, to, cls: "hmd-frontmatter" }); code.push([from, to]); return false
        case "HeaderMark": out.push({ from, to: Math.min(to + 1, lineEnd(from)), cls: `formatting_formatting-header_formatting-header-${(n.node.parent?.name.match(/\d/) ?? ["1"])[0]}` }); return
        case "InlineCode": code.push([from, to]); out.push({ from, to, cls: "inline-code" }); return
        case "FencedCode": {
          code.push([from, to])
          const first = lineEnd(from), lastStart = doc.lastIndexOf("\n", to - 1) + 1
          out.push({ from, to: first, cls: `formatting_formatting-code-block_${BEGIN}` })
          if (/^\s*(```|~~~)/.test(doc.slice(lastStart, to)) && lastStart > first) {
            if (lastStart - 1 > first + 1) out.push({ from: first + 1, to: lastStart - 1, cls: "hmd-codeblock" })
            out.push({ from: lastStart, to, cls: `formatting_formatting-code-block_${END}` })
          } else if (to > first + 1) out.push({ from: first + 1, to, cls: "hmd-codeblock" })
          return false
        }
        case "CodeMark": if (n.node.parent?.name === "InlineCode") out.push({ from, to, cls: "formatting_formatting-code_inline-code" }); return
        case "StrongEmphasis": out.push({ from, to, cls: "strong", ctx: true }); return
        case "Emphasis": out.push({ from, to, cls: "em", ctx: true }); return
        case "Strikethrough": out.push({ from, to, cls: "strikethrough", ctx: true }); return
        case "EmphasisMark": out.push({ from, to, cls: `formatting_formatting-${to - from === 2 ? "strong" : "em"}` }); return
        case "StrikethroughMark": out.push({ from, to, cls: "formatting_formatting-strikethrough" }); return
        case "BulletList": case "OrderedList": depth++; return
        case "ListItem": out.push({ from, to, cls: `list-${Math.min(depth, 3)}`, ctx: true }); return
        case "ListMark": out.push({ from, to: Math.min(to + 1, lineEnd(from)), cls: `formatting_formatting-list_formatting-list-${n.node.parent?.parent?.name === "OrderedList" ? "ol" : "ul"}` }); return
        case "TaskMarker": out.push({ from, to, cls: "formatting_formatting-task" }); return
        case "Blockquote": out.push({ from, to, cls: "quote_quote-1", ctx: true }); return
        case "QuoteMark": out.push({ from, to, cls: "formatting_formatting-quote_formatting-quote-1" }); return
        case "Link": if (doc[from - 1] !== "[" && !/^\[\[|^\[!|^\[\^/.test(doc.slice(from, from + 2))) out.push({ from, to, cls: "link", ctx: true }); return
        case "URL": out.push({ from, to, cls: "string_url" }); return
      }
    },
    leave: (n) => { if (n.name === "BulletList" || n.name === "OrderedList") depth-- },
  })
  // What the app's parser leaves as text: math, wikilinks, tags, highlights, comments (outside code).
  const inCode = (a: number, b: number) => code.some(([x, y]) => a < y && b > x)
  const scan = (re: RegExp, fn: (m: RegExpExecArray) => void) => { for (const m of doc.matchAll(re)) if (!inCode(m.index!, m.index! + m[0].length)) fn(m as RegExpExecArray) }
  scan(/\$\$([\s\S]*?)\$\$/g, (m) => {
    const a = m.index!, b = a + m[0].length
    code.push([a, b])
    out.push({ from: a, to: a + 2, cls: "formatting_formatting-math_formatting-math-begin_keyword_math_math-block" }, { from: a + 2, to: b - 2, cls: "math" }, { from: b - 2, to: b, cls: "formatting_formatting-math_formatting-math-end_keyword_math_math-" })
  })
  scan(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g, (m) => {
    const a = m.index!, b = a + m[0].length
    out.push({ from: a, to: a + 1, cls: "formatting_formatting-math_formatting-math-begin_keyword_math" }, { from: a + 1, to: b - 1, cls: "math" }, { from: b - 1, to: b, cls: "formatting_formatting-math_formatting-math-end_keyword_math_math-" })
  })
  scan(/(!?)\[\[([^\]|\n]*)(\|[^\]\n]*)?\]\]/g, (m) => {
    const a = m.index! + m[1].length, b = m.index! + m[0].length, t = a + 2 + m[2].length
    out.push({ from: a, to: a + 2, cls: "formatting-link_formatting-link-start" }, { from: a + 2, to: t, cls: "hmd-internal-link" })
    if (m[3]) out.push({ from: t, to: t + 1, cls: "hmd-internal-link_link-alias-pipe" }, { from: t + 1, to: b - 2, cls: "hmd-internal-link_link-alias" })
    out.push({ from: b - 2, to: b, cls: "formatting-link_formatting-link-end" })
  })
  scan(/(?<=^|\s)#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/gu, (m) => {
    const a = m.index!
    out.push({ from: a, to: a + 1, cls: "formatting_formatting-hashtag_hashtag_hashtag-begin_meta" }, { from: a + 1, to: a + m[0].length, cls: "hashtag_hashtag-end_meta" })
  })
  scan(/==([^=\n]+)==/g, (m) => { const a = m.index!, b = a + m[0].length; out.push({ from: a, to: a + 2, cls: "formatting_formatting-highlight_highlight" }, { from: a + 2, to: b - 2, cls: "highlight" }, { from: b - 2, to: b, cls: "formatting_formatting-highlight_highlight" }) })
  scan(/%%[\s\S]*?%%/g, (m) => out.push({ from: m.index!, to: m.index! + m[0].length, cls: "comment" }))
  return out.filter((s) => s.to > s.from)
}

/** The flat tree: each stretch named by the innermost span over it, with the classes of the contexts around it. */
function build(tree: Tree, doc: string) {
  const spans = spansOf(tree, doc)
  const cuts = new Set<number>([0, doc.length])
  for (const s of spans) { cuts.add(s.from); cuts.add(s.to) }
  const at = [...cuts].sort((a, b) => a - b)
  const buffer: number[] = []
  for (let i = 0; i + 1 < at.length; i++) {
    const a = at[i], b = at[i + 1]
    const over = spans.filter((s) => s.from <= a && s.to >= b)
    if (!over.length) continue
    const own = over.filter((s) => !s.ctx).sort((x, y) => (x.to - x.from) - (y.to - y.from))[0]
    // (nested lists: only the innermost's level, as Obsidian names it)
    const ctx = over.filter((s) => s.ctx).sort((x, y) => (y.to - y.from) - (x.to - x.from)).flatMap((s) => s.cls.split("_"))
    const lists = ctx.filter((c) => /^list-\d$/.test(c))
    const cls = [...new Set([...(own ? own.cls.split("_") : []), ...ctx.filter((c) => !/^list-\d$/.test(c) || c === lists.at(-1))])].join("_")
    buffer.push(typeOf(cls), a, b, 4)
  }
  return Tree.build({ buffer, nodeSet: new NodeSet(types), topID: 0, length: doc.length })
}

const cache = new WeakMap<Tree, Tree>()
/** The tree as Obsidian's would be, for a Markdown document; other languages' trees as they are. */
export function obsidianTree(state: EditorState, tree: Tree) {
  if (tree.type.name !== "Document") return tree
  let t = cache.get(tree)
  if (!t) { t = build(tree, state.doc.toString()); cache.set(tree, t) }
  return t
}

export const languageForPlugins = {
  ...language, tokenClassNodeProp, StreamLanguage,
  syntaxTree: (state: EditorState) => obsidianTree(state, language.syntaxTree(state)),
  ensureSyntaxTree: (state: EditorState, upto: number, timeout?: number) => { const t = language.ensureSyntaxTree(state, upto, timeout); return t && obsidianTree(state, t) },
}
