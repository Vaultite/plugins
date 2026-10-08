// require() for a plugin, and the rest of what its main.js runs with: `obsidian`, the editor's CodeMirror, Node's
// modules (the server's on a computer, through runtime/node/; on a phone only those that need no server).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from "../lib/buffer.js"
import { miss } from "./core.ts"
import { CM } from "./cm.ts"
import { bridgedModules, serverProcess } from "./node/bridge.ts"
import { browserProcess, builtin, pureModules, timers } from "./node/pure.ts"
import { Platform } from "./state.ts"

/** A module the browser hasn't: reading it is fine, calling it throws (a plugin's desktop-only path). */
const NO = (spec: string) => `${spec} ${Platform.isDesktopApp ? "isn't one of Node's modules this app gives plugins" : "needs Node, which this app doesn't give plugins on a phone"}`
function absent(plugin: string, spec: string): any {
  const f: any = function () { throw new Error(NO(spec)) }
  return new Proxy(f, {
    get(_t, k) { if (k === "__esModule" || k === "then" || typeof k === "symbol") return undefined; miss(plugin, `require(${spec}).${String(k)}`); return absent(plugin, `${spec}.${String(k)}`) },
    apply() { miss(plugin, `call ${spec}`); throw new Error(NO(spec)) },
    construct() { miss(plugin, `new ${spec}`); throw new Error(NO(spec)) },
  })
}

const t = (k: string | string[], o?: any) => (typeof o === "string" ? o : o?.defaultValue ?? (Array.isArray(k) ? k[0] : k))
const i18next: any = { createInstance: () => ({ ...i18next, init: async () => t }), cloneInstance: () => i18next, t, language: "en", languages: ["en"], isInitialized: true, options: { lng: "en" }, init: async () => t, use: () => i18next, on() {}, off() {},
  changeLanguage: async () => t, getFixedT: () => t, exists: () => false, addResourceBundle: () => i18next, addResources: () => i18next, hasResourceBundle: () => false, getResourceBundle: () => ({}), loadNamespaces: async () => {}, dir: () => "ltr" }

let proc: any = null
const processOf = () => (proc ??= Platform.isDesktopApp ? serverProcess("") : browserProcess())

/** What a plugin's main.js gets: require, module-level names Node and Electron give (process, Buffer…). */
/** The names main.js gets besides \`module\` and \`exports\` (scopeFor's keys), in the wrapper plugin.ts serves it in. */
export const SCOPE_NAMES = ["require", "process", "Buffer", "global", "setImmediate", "clearImmediate", "__dirname", "__filename", "SharedArrayBuffer"]

export function scopeFor(plugin: string, mod: any) {
  const node = Platform.isDesktopApp
  const p = processOf()
  const g = globalThis as any
  g.Buffer ??= Buffer
  g.setImmediate ??= timers.setImmediate
  g.clearImmediate ??= timers.clearImmediate
  let pure: Record<string, any> | null = null, bridged: ((s: string) => any) | null = null
  const require = (spec: string): any => {
    if (spec === "obsidian") return mod
    if (spec.startsWith("@codemirror/") || spec.startsWith("@lezer/")) {
      const m = CM[spec]
      if (m) return m
      miss(plugin, `require(${spec})`)
      return {}
    }
    // (Electron's original-fs is fs without its .asar handling: the same here)
    const bare = spec.replace(/^node:/, "").replace(/^original-fs(?=\/|$)/, "fs")
    pure ??= pureModules(p, require)
    if (bare in pure) return pure[bare]
    if (node && (builtin(bare) || bare === "electron" || bare === "original-fs" || bare === "@electron/remote")) {
      bridged ??= bridgedModules(plugin, p)
      return bare === "@electron/remote" ? bridged("electron").remote : bridged(bare)
    }
    // (no Electron on a phone, as in Obsidian's mobile app: plugins test for it)
    if (bare === "electron" || bare === "@electron/remote") return null
    miss(plugin, `require(${spec})`)
    return absent(plugin, spec)
  }
  // Electron's renderer has these on window too (window.require, window.electron), which some plugins reach for.
  if (node && !g.require) {
    g.require = require
    g.require = scopeFor("", mod).require
    Object.defineProperty(g, "electron", { configurable: true, get: () => g.require("electron") })
  }
  // Obsidian's i18next, which some plugins translate their text with: English, as written.
  g.i18next ??= i18next
  const dir = node ? `${p.cwd()}/.obsidian/plugins/${plugin}` : `/.obsidian/plugins/${plugin}`
  return { require, process: p, Buffer, global: globalThis, setImmediate: g.setImmediate, clearImmediate: g.clearImmediate,
    __dirname: dir, __filename: `${dir}/main.js`, SharedArrayBuffer: g.SharedArrayBuffer ?? ArrayBuffer }
}
