// What runtime/dom.ts adds to the DOM, as Obsidian's typings declare it.
/* eslint-disable @typescript-eslint/no-explicit-any */
type DomInfo = import("./runtime/dom.ts").DomInfo

declare global {
  interface Node {
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: DomInfo | string, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K]
    createDiv(o?: DomInfo | string, cb?: (el: HTMLDivElement) => void): HTMLDivElement
    createSpan(o?: DomInfo | string, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement
    empty(): void
    detach(): void
    appendText(t: string): void
  }
  interface Element {
    setText(t: string | DocumentFragment): void
    addClass(...c: string[]): void
    removeClass(...c: string[]): void
    toggleClass(c: string | string[], on: boolean): void
    hasClass(c: string): boolean
    setAttr(k: string, v: any): void
  }
}
export {}
