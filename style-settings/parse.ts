// Reads Style Settings' `/* @settings ... */` blocks (Obsidian's convention, YAML inside a CSS comment) into sections.
// Shared by the app (index.tsx) and the server (plugin.ts): no DOM, no Node.
import { parse as parseYaml } from "yaml"

export type Option = { label: string; value: string }
export type Setting = {
  id: string; type: string; title: string; description: string
  default?: unknown; defaultLight?: string; defaultDark?: string
  options?: Option[]; allowEmpty?: boolean; quotes?: boolean
  format?: string; min?: number; max?: number; step?: number
  opacity?: boolean; altFormat?: { id: string; format: string }[]
  level?: number; collapsed?: boolean; markdown?: boolean
}
export type Section = { id: string; name: string; collapsed: boolean; settings: Setting[]; source: string }
export type Found = { sections: Section[]; problems: string[] }

/** The types it draws and applies; others (color-gradient) are listed as problems, not drawn. */
export const TYPES = ["heading", "info-text", "class-toggle", "class-select", "variable-text", "variable-number",
  "variable-number-slider", "variable-select", "variable-color", "variable-themed-color"]

/** A name a CSS variable or class can take: anything else is dropped, so a value can't reach outside its rule. */
export const NAME = /^-?[A-Za-z_][\w-]*$/

/** The key a value is kept under in data.json, as Obsidian's Style Settings keeps it (so its data.json carries over). */
export const keyOf = (section: string, id: string, mode?: "light" | "dark") => `${section}@@${id}${mode ? `@@${mode}` : ""}`

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "")
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined)

function options(v: unknown): Option[] {
  if (!Array.isArray(v)) return []
  return v.map((o) => (o && typeof o === "object" ? { label: str((o as Record<string, unknown>).label) || str((o as Record<string, unknown>).value), value: str((o as Record<string, unknown>).value) } : { label: str(o), value: str(o) }))
    .filter((o) => o.value !== "" || o.label !== "")
}

function setting(raw: Record<string, unknown>): Setting {
  const s: Setting = { id: str(raw.id), type: str(raw.type), title: str(raw.title) || str(raw.id), description: str(raw.description) }
  if ("default" in raw) s.default = raw.default
  if (raw["default-light"] !== undefined) s.defaultLight = str(raw["default-light"])
  if (raw["default-dark"] !== undefined) s.defaultDark = str(raw["default-dark"])
  if (raw.options !== undefined) s.options = options(raw.options)
  if (raw.allowEmpty === true) s.allowEmpty = true
  if (raw.quotes === true) s.quotes = true
  if (raw.format !== undefined) s.format = str(raw.format)
  for (const k of ["min", "max", "step", "level"] as const) { const n = num(raw[k]); if (n !== undefined) s[k] = n }
  if (raw.opacity === true) s.opacity = true
  if (raw.collapsed === true) s.collapsed = true
  if (raw.markdown === true) s.markdown = true
  if (Array.isArray(raw["alt-format"])) {
    s.altFormat = raw["alt-format"].filter((a) => a && typeof a === "object")
      .map((a) => ({ id: str((a as Record<string, unknown>).id), format: str((a as Record<string, unknown>).format) }))
      .filter((a) => NAME.test(a.id))
  }
  return s
}

/** Every @settings block in a stylesheet's text. `source` names it ("Snippet: Callouts"); a block that doesn't read is a
 *  problem, the others still count. */
export function readSettings(css: string, source: string): Found {
  const sections: Section[] = [], problems: string[] = []
  for (const m of css.matchAll(/\/\*\s*@settings\b([\s\S]*?)\*\//g)) {
    let doc: unknown
    try { doc = parseYaml(m[1].replace(/\t/g, "    ")) } catch (e) {
      problems.push(`${source}: a @settings block isn't valid YAML (${(e as Error).message.split("\n")[0]})`)
      continue
    }
    const d = doc as Record<string, unknown> | null
    const id = str(d?.id)
    if (!d || !id || !Array.isArray(d.settings)) { problems.push(`${source}: a @settings block needs an id and a list of settings`); continue }
    const list: Setting[] = []
    for (const raw of d.settings) {
      if (!raw || typeof raw !== "object") continue
      const s = setting(raw as Record<string, unknown>)
      if (!TYPES.includes(s.type)) { problems.push(`${source}: '${s.id || s.title}' is a ${s.type || "setting without a type"}, which isn't supported`); continue }
      const named = s.type === "heading" || s.type === "info-text" || NAME.test(s.id)
      if (!s.id || !named) { problems.push(`${source}: '${s.id}' isn't a name a CSS variable or class can have`); continue }
      list.push(s)
    }
    sections.push({ id, name: str(d.name) || id, collapsed: d.collapsed === true, settings: list, source })
  }
  return { sections, problems }
}
