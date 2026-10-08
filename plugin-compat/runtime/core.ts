// Obsidian's small building blocks: Events, Component, and what a plugin reaches for that isn't here (recorded per
// plugin: the report says what each one missed).
/* eslint-disable @typescript-eslint/no-explicit-any */

export type EventRef = { e: Events; name: string; fn: (...a: any[]) => any; ctx?: any }

export class Events {
  _ev: Record<string, EventRef[]> = {}
  on(name: string, fn: (...a: any[]) => any, ctx?: any): EventRef {
    const ref = { e: this, name, fn, ctx }
    ;(this._ev[name] ??= []).push(ref)
    return ref
  }
  off(name: string, fn: (...a: any[]) => any) { if (this._ev[name]) this._ev[name] = this._ev[name].filter((r) => r.fn !== fn) }
  offref(ref: EventRef) { if (ref?.e === this && this._ev[ref.name]) this._ev[ref.name] = this._ev[ref.name].filter((r) => r !== ref) }
  trigger(name: string, ...a: any[]) { for (const r of [...(this._ev[name] ?? [])]) this.tryTrigger(r, a) }
  tryTrigger(ref: EventRef, a: any[]) { try { ref.fn.apply(ref.ctx, a) } catch (e) { setTimeout(() => { throw e }, 0) } }
}

export class Component {
  _loaded = false
  _events: (() => void)[] = []
  _children: Component[] = []
  load() {
    if (this._loaded) return
    this._loaded = true
    this.onload()
    for (const c of this._children) c.load()
  }
  onload(): any {}
  unload() {
    if (!this._loaded) return
    this._loaded = false
    for (const c of this._children.splice(0)) c.unload()
    for (const fn of this._events.splice(0).reverse()) { try { fn() } catch (e) { console.error(e) } }
    this.onunload()
  }
  onunload(): any {}
  addChild<T extends Component>(c: T): T { this._children.push(c); if (this._loaded) c.load(); return c }
  removeChild<T extends Component>(c: T): T { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); c.unload() } return c }
  register(fn: () => any) { this._events.push(fn) }
  registerEvent(ref: EventRef) { this.register(() => ref.e.offref(ref)) }
  registerDomEvent(el: EventTarget, type: string, fn: any, o?: any) { el.addEventListener(type, fn, o); this.register(() => el.removeEventListener(type, fn, o)) }
  registerScopeEvent(handler: { scope: { unregister(h: any): void } }) { this.register(() => handler.scope?.unregister(handler)) }
  registerInterval(id: number) { this.register(() => { clearInterval(id); clearTimeout(id) }); return id }
}

/** C callable as an ES5 base class too: a plugin transpiled to ES5 calls `Base.call(this, …)`, which a class refuses.
 *  The instance is made with the subclass's prototype; a caller that ignores the result gets its fields copied. */
export function es5<T extends abstract new (...a: any[]) => any>(C: T): T {
  return new Proxy(C, {
    apply(target, self, args) {
      const sub = self && typeof self === "object" && typeof self.constructor === "function" && self.constructor !== Object ? self.constructor : target
      const made: object = Reflect.construct(target as any, args, sub)
      if (self && typeof self === "object" && self !== made) {
        for (const k of Reflect.ownKeys(made)) { const d = Object.getOwnPropertyDescriptor(made, k)!; if (!Object.prototype.hasOwnProperty.call(self, k)) Object.defineProperty(self, k, d) }
      }
      return made
    },
  })
}

// --- what a plugin missed: a property of the module, the app, or a part of it that isn't here

export type Missed = Record<string, number>
export const missedBy = new Map<string, Missed>()
export const miss = (plugin: string, what: string) => {
  let m = missedBy.get(plugin); if (!m) missedBy.set(plugin, m = {})
  m[what] = (m[what] ?? 0) + 1
}

const SKIP = new Set(["then", "toJSON", "constructor", "$$typeof", "prototype", "__esModule", "default", "asymmetricMatch", "nodeType", "tagName"])

/** `target` as `plugin` sees it: reading a name it doesn't have is recorded as `label.name`; parts named in `deep` are
 *  watched the same way. */
export function watched<T extends object>(target: T, plugin: string, label: string, deep: string[] = []): T {
  const kids = new Map<string, any>()
  return new Proxy(target, {
    get(t, k, r) {
      const v = Reflect.get(t, k, t)
      if (typeof k === "symbol" || SKIP.has(k)) return v
      if (v === undefined && !(k in t)) miss(plugin, `${label}.${k}`)
      if (deep.includes(k) && v && typeof v === "object") {
        if (!kids.has(k)) kids.set(k, watched(v, plugin, `${label}.${k}`))
        return kids.get(k)
      }
      void r
      return v
    },
  })
}

/** Base64 to bytes, without a callback per byte (files of megabytes come this way). */
export function fromB64(s: string) {
  const bin = atob(s), out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
