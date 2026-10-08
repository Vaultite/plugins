// What the app has of Style settings: the sections found (the app's own, then each snippet that's on), the values
// (data.json, with edits not yet saved over them) and the stylesheet made of both, kept on the page.
import { useSyncExternalStore } from "react"
import { get, patch, readFile, notifyError } from "@vaultite"
import { readSettings, type Section } from "./parse.ts"
import { outputOf, stylesheet, type Values } from "./css.ts"
import { APP, appSection } from "./builtin.ts"

export const ID = "style-settings"
export const DATA = `.vaultite/plugins/${ID}/data.json`

export type Snippet = { name: string; on: boolean; sections: Section[] }
export type State = {
  ready: boolean
  sections: Section[]
  values: Values
  /** Snippets that have settings but are off, and the Obsidian theme in use if it has some (they don't apply). */
  off: { name: string; count: number }[]
  theme: { name: string; count: number } | null
  problems: string[]
  snippetsOn: string[]
}

let state: State = { ready: false, sections: [appSection()], values: {}, off: [], theme: null, problems: [], snippetsOn: [] }
const subs = new Set<() => void>()
const set = (next: Partial<State>) => { state = { ...state, ...next }; apply(); subs.forEach((f) => f()) }
export const useStyleState = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => state)
export const getStyleState = () => state

const count = (secs: Section[]) => secs.reduce((n, s) => n + s.settings.filter((x) => x.type !== "heading" && x.type !== "info-text").length, 0)
const text = async (path: string) => { try { return (await readFile(path)).text } catch { return "" } }

/** Every stylesheet the vault has, read again: the snippets (on or off) and the Obsidian theme in use. */
export async function loadSources() {
  const look = await get<Record<string, unknown>>("config/appearance").catch(() => ({} as Record<string, unknown>))
  const on = Array.isArray(look.snippets) ? (look.snippets as unknown[]).map(String) : []
  const list = await get<{ name: string }[]>("snippets").catch(() => [])
  const sections: Section[] = [appSection()], off: State["off"] = [], problems: string[] = []
  for (const { name } of list) {
    const found = readSettings(await text(`.vaultite/snippets/${name}.css`), name)
    if (!found.sections.length && !found.problems.length) continue
    if (on.includes(name)) { sections.push(...found.sections); problems.push(...found.problems) }
    else off.push({ name, count: count(found.sections) })
  }
  let theme: State["theme"] = null
  const scheme = typeof look.scheme === "string" ? look.scheme : ""
  if (scheme.startsWith("theme:")) {
    const name = scheme.slice(6)
    const n = count(readSettings(await text(`.vaultite/themes/${name}/theme.css`), name).sections)
    if (n) theme = { name, count: n }
  }
  set({ sections, off, theme, problems, snippetsOn: on })
}

// Values typed but not saved yet (or on their way): a reload of data.json mid-drag doesn't undo them.
const pending = new Map<string, unknown>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export async function loadValues() {
  const saved = await get<Values>(`config/plugin/${ID}`).catch(() => ({} as Values))
  const values = { ...(saved && typeof saved === "object" ? saved : {}) }
  for (const [k, v] of pending) { if (v === null) delete values[k]; else values[k] = v }
  set({ values, ready: true })
}

/** Change a value now (null: back to its default); saved after `wait` ms of quiet, so a drag is one write. */
export function setValue(key: string, value: unknown, wait = 0) {
  const values = { ...state.values }
  if (value === null || value === undefined) delete values[key]; else values[key] = value
  pending.set(key, value ?? null)
  set({ values })
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    const v = pending.get(key)
    patch(`config/plugin/${ID}`, { [key]: v }).catch((e) => notifyError(e, "Couldn't save it"))
      .finally(() => { if (pending.get(key) === v) pending.delete(key) })
  }, wait))
}

/** Turn a snippet on (appearance.json's `snippets`). */
export const turnOn = (name: string) =>
  patch("config/appearance", { snippets: [...state.snippetsOn.filter((n) => n !== name), name] }).catch((e) => notifyError(e, "Couldn't turn it on"))

// ---------- on the page

const STYLE = "style-settings"
const CACHE = "vaultite.style-settings"
let classes: string[] = []

function put(css: string, wanted: string[]) {
  let el = document.getElementById(STYLE) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = STYLE
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
  const body = document.body.classList
  body.add("css-settings-manager")
  for (const c of classes) if (!wanted.includes(c)) body.remove(c)
  for (const c of wanted) body.add(c)
  classes = wanted
}

function apply() {
  if (!state.ready) return
  const out = outputOf(state.sections, state.values, new Set([APP]))
  const css = stylesheet(out)
  put(css, out.classes)
  try { localStorage.setItem(CACHE, JSON.stringify({ css, classes: out.classes })) } catch { /* private mode */ }
}

/** The last look applied, at once while the vault's files are read (no flash of the plain look on start). */
export function applyCached() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) ?? "null")
    if (c && typeof c.css === "string" && Array.isArray(c.classes)) put(c.css, c.classes.filter((x: unknown) => typeof x === "string"))
  } catch { /* none */ }
}

/** Turned off: the page as the app draws it. */
export function takeDown() {
  document.getElementById(STYLE)?.remove()
  document.body.classList.remove("css-settings-manager", ...classes)
  classes = []
  state = { ...state, ready: false }
}
