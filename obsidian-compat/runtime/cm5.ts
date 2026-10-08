// CodeMirror 5's global, which Obsidian still has for modes: plugins define modes and overlays on its Markdown mode
// (Templater's <% %>). The app's Markdown isn't a CM5 mode, so an overlay on it is drawn as marks, not a language.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Range } from "@codemirror/state"
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view"
import * as language from "@codemirror/language"

const MARKDOWN = new Set(["hypermd", "markdown", "gfm", "text/x-markdown"])
// (a character at a time: a mode wrapping it, like an overlay, still sees what follows on the line)
const plain = { name: "text", startState: () => ({}), token: (s: any) => { s.next(); return null } }
const markdown = { ...plain, name: "markdown", markdown: true }

class Pos { line: number; ch: number; sticky?: string; constructor(line: number, ch: number, sticky?: string) { this.line = line; this.ch = ch; this.sticky = sticky } }

export function cm5() {
  const modes: Record<string, any> = {}, mimeModes: Record<string, any> = {}
  const CM: any = {
    modes, mimeModes, modeInfo: [], commands: {}, keyMap: {}, Vim: null, Pass: {}, defaults: {},
    defineMode(name: string, factory: any) { modes[name] = factory },
    defineMIME(mime: string, spec: any) { mimeModes[mime] = spec },
    defineSimpleMode(name: string) { modes[name] = () => plain },
    getMode(cfg: any, spec: any): any {
      const name = typeof spec === "string" ? (mimeModes[spec] ?? spec) : spec?.name
      if (typeof name === "object") return CM.getMode(cfg, name)
      if (modes[name]) { try { return modes[name](cfg ?? {}, typeof spec === "object" ? spec : {}) ?? plain } catch (e) { console.error(e); return plain } }
      return MARKDOWN.has(name) ? markdown : plain
    },
    startState: (mode: any, a?: any, b?: any) => (mode?.startState ? mode.startState(a, b) : true),
    copyState: (mode: any, st: any) => (mode?.copyState ? mode.copyState(st) : typeof st === "object" ? { ...st } : st),
    overlayMode(base: any, overlay: any) {
      return { name: "overlay", base, overlay, startState: () => ({ base: base.startState?.(), overlay: overlay.startState?.() }),
        token: (s: any, st: any) => overlay.token(s, st.overlay) }
    },
    // (a plugin bringing its own keeps this one: its overlay must stay one the app can draw over its Markdown)
    get customOverlayMode() { return CM.overlayMode }, set customOverlayMode(_v: unknown) { /* ours */ },
    // (CodeMirror 5's own editors are gone, as in Obsidian: what configures them is there and does nothing)
    Init: { toString: () => "CodeMirror.Init" }, Pos, cmpPos: (a: any, b: any) => a.line - b.line || a.ch - b.ch,
    defineOption() {}, defineExtension() {}, defineDocExtension() {}, defineInitHook() {}, defineDefaults() {},
    isWordChar: (ch: string) => /[\p{L}\p{N}_]/u.test(ch), keyName: (e: KeyboardEvent) => e.key, normalizeKeyMap: (m: any) => m,
    splitLines: (s: string) => s.split(/\r\n?|\n/), countColumn: (s: string, end?: number, tab = 4) => { let n = 0; for (const c of s.slice(0, end ?? s.length)) n += c === "\t" ? tab - (n % tab) : 1; return n },
    findModeByName: () => null, findModeByExtension: () => null, findModeByMIME: () => null, registerHelper() {}, signal() {}, on() {}, off() {},
  }
  return CM
}

/** An overlay's tokens on the Markdown of what's on screen, as marks (`cm-<style>` classes, as CM5 named them). */
function overlayMarks(overlay: any) {
  const marks = new Map<string, Decoration>()
  const deco = (cls: string, line: boolean) => {
    const k = `${line}:${cls}`
    let m = marks.get(k)
    if (!m) marks.set(k, m = line ? Decoration.line({ class: cls }) : Decoration.mark({ class: cls }))
    return m
  }
  const draw = (view: EditorView) => {
    const out: Range<Decoration>[] = []
    for (const { from, to } of view.visibleRanges) {
      const st = overlay.startState?.() ?? {}
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos), s = new language.StringStream(line.text, 4, 2)
        const lines = new Set<string>()
        if (!line.text) { const bl = overlay.blankLine?.(st); if (bl) for (const c of String(bl).split(/\s+/)) if (c.startsWith("line-")) lines.add(c.replace(/^line-(background-)?/, "")) }
        while (!s.eol()) {
          const start = s.pos
          let style: string | null = null
          try { style = overlay.token(s, st) } catch { s.skipToEnd() }
          if (s.pos === start) s.next()
          if (!style) continue
          // (CM5's "line-x" and "line-background-x" are classes of the line, the rest of the token)
          const own = style.split(/\s+/).filter((c) => { if (!c.startsWith("line-")) return !!c; lines.add(c.replace(/^line-(background-)?/, "")); return false })
          if (own.length) out.push(deco(own.map((c) => `cm-${c}`).join(" "), false).range(line.from + start, line.from + s.pos))
        }
        if (lines.size) out.push(deco([...lines].join(" "), true).range(line.from))
        pos = line.to + 1
      }
    }
    return Decoration.set(out, true)
  }
  return ViewPlugin.fromClass(class { decorations: DecorationSet; constructor(v: EditorView) { this.decorations = draw(v) } update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = draw(u.view) } }, { decorations: (v) => v.decorations })
}

/** StreamLanguage for plugins: a mode over Markdown (an overlay on hypermd) becomes marks on the app's Markdown. */
export class StreamLanguage extends (language.StreamLanguage as any) {
  static define(spec: any): any {
    if (spec?.name === "overlay" && spec.base?.markdown) return overlayMarks(spec.overlay)
    if (spec?.markdown) return []
    return language.StreamLanguage.define(spec)
  }
}
