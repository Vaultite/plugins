// What live preview draws in place of Org's syntax off the cursor's line: the reading view's own chips (drawn as its
// markup, so they look the same), the editor's checkboxes and bullets, a code block's head, a rule.
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { EditorView, WidgetType } from "@codemirror/view"
import { openMenu, openTag, type MenuItem } from "@vaultite"
import { nextKeyword, todoSequences } from "../edit/edits.ts"
import { isText, parse, walk, type OrgNode } from "../parser/index.ts"
import { Cookie, Keyword, PlanChip, Priority, Tags, TimeChip } from "../view/Chips.tsx"
import { cycleKeyword, toggleBox } from "./structure.ts"

const html = (el: ReactElement, tag = "span") => {
  const box = document.createElement(tag)
  box.className = "org-live-chip"
  box.innerHTML = renderToStaticMarkup(el)
  return box
}

const stamps = new Map<string, OrgNode | null>()
/** A timestamp's node, parsed from its text. */
function stamp(raw: string): OrgNode | null {
  if (!stamps.has(raw)) {
    let hit: OrgNode | null = null
    for (const c of walk(parse(raw))) if (!isText(c) && c.type === "timestamp") { hit = c; break }
    if (stamps.size > 500) stamps.clear()
    stamps.set(raw, hit)
  }
  return stamps.get(raw)!
}

/** A TODO keyword: a click moves it on through its sequence, a right-click picks any. */
export class KeywordWidget extends WidgetType {
  word: string; done: boolean; at: number
  constructor(word: string, done: boolean, at: number) { super(); this.word = word; this.done = done; this.at = at }
  eq(o: KeywordWidget) { return o.word === this.word && o.done === this.done && o.at === this.at }
  toDOM(view: EditorView) {
    const el = html(createElement(Keyword, { kw: this.word, done: this.done, onClick: () => {} }))
    el.addEventListener("mousedown", (e) => e.preventDefault())
    el.addEventListener("click", (e) => {
      e.preventDefault()
      if (!view.state.readOnly) cycleKeyword(view, this.at, nextKeyword(view.state.doc.toString(), this.word, true))
    })
    el.addEventListener("contextmenu", (e) => {
      if (view.state.readOnly) return
      e.preventDefault()
      const states = todoSequences(view.state.doc.toString()).flatMap((s) => [...s.todo, ...s.done])
      const items: MenuItem[] = [...states.map((s) => ({ label: s, checked: s === this.word, run: () => { cycleKeyword(view, this.at, s) } })),
        { label: "No state", sep: true, run: () => { cycleKeyword(view, this.at, "") } }]
      openMenu({ x: e.clientX, y: e.clientY }, items)
    })
    return el
  }
  ignoreEvent() { return true }
}

export class PriorityWidget extends WidgetType {
  code: number; highest: number; lowest: number
  constructor(code: number, highest: number, lowest: number) { super(); this.code = code; this.highest = highest; this.lowest = lowest }
  eq(o: PriorityWidget) { return o.code === this.code && o.highest === this.highest && o.lowest === this.lowest }
  toDOM() { return html(createElement(Priority, { code: this.code, highest: this.highest, lowest: this.lowest })) }
}

export class TagsWidget extends WidgetType {
  tags: string[]
  constructor(tags: string[]) { super(); this.tags = tags }
  eq(o: TagsWidget) { return o.tags.join(":") === this.tags.join(":") }
  toDOM() {
    const el = html(createElement(Tags, { tags: this.tags }))
    el.querySelectorAll<HTMLElement>("a.tag").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openTag(a.textContent ?? "") }))
    return el
  }
  ignoreEvent() { return true }
}

export class CookieWidget extends WidgetType {
  text: string
  constructor(text: string) { super(); this.text = text }
  eq(o: CookieWidget) { return o.text === this.text }
  toDOM() { return html(createElement(Cookie, { value: this.text })) }
}

/** A planning date (SCHEDULED: <...>) or a timestamp in the text, as the reading view's chip. */
export class DateWidget extends WidgetType {
  raw: string; kind: "scheduled" | "deadline" | "closed" | null; done: boolean
  constructor(raw: string, kind: "scheduled" | "deadline" | "closed" | null, done: boolean) { super(); this.raw = raw; this.kind = kind; this.done = done }
  eq(o: DateWidget) { return o.raw === this.raw && o.kind === this.kind && o.done === this.done }
  toDOM() {
    const ts = stamp(this.raw)
    if (!ts) { const s = document.createElement("span"); s.textContent = this.raw; return s }
    return html(this.kind ? createElement(PlanChip, { kind: this.kind, ts, done: this.done }) : createElement(TimeChip, { ts }))
  }
}

/** A list item's box, as the editor draws a note's task. */
export class BoxWidget extends WidgetType {
  state: string; at: number
  constructor(state: string, at: number) { super(); this.state = state; this.at = at }
  eq(o: BoxWidget) { return o.state === this.state && o.at === this.at }
  toDOM(view: EditorView) {
    const box = document.createElement("input")
    box.type = "checkbox"
    box.className = "cm-task"
    box.checked = this.state === "X" || this.state === "x"
    if (this.state === "-") box.dataset.trans = ""
    box.setAttribute("aria-label", box.checked ? "Done" : "To do")
    box.addEventListener("mousedown", (e) => e.preventDefault())
    box.addEventListener("click", (e) => { e.preventDefault(); if (!view.state.readOnly) toggleBox(view, this.at) })
    return box
  }
  ignoreEvent() { return true }
}

export class BulletWidget extends WidgetType {
  eq() { return true }
  toDOM() { const s = document.createElement("span"); s.className = "cm-bullet"; s.textContent = "•"; return s }
}

export class RuleWidget extends WidgetType {
  eq() { return true }
  toDOM() { const s = document.createElement("span"); s.className = "cm-hr"; return s }
}

/** A src block's first line: its language, as a note's code fence shows it. */
export class FenceWidget extends WidgetType {
  lang: string
  constructor(lang: string) { super(); this.lang = lang }
  eq(o: FenceWidget) { return o.lang === this.lang }
  toDOM() {
    const head = document.createElement("span")
    head.className = "cm-fence-head"
    const l = document.createElement("span")
    l.className = "cm-fence-lang"
    l.textContent = this.lang
    head.append(l)
    return head
  }
}
