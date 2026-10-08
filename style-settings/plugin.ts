// Style settings' backend: its ops, so an agent can see every setting the vault's CSS declares and change one by key
// (the app applies data.json live). It reads the snippets that are on, as the app does.
import fs from "node:fs"
import { OpError, Plugin } from "@vaultite/core/plugins.ts"
import { keyOf, readSettings, type Section, type Setting } from "./parse.ts"
import { parseColor, valueOf } from "./css.ts"
import { appSection } from "./builtin.ts"

export const plugin = new Plugin(import.meta.url)

const read = (rel: string) => { try { return fs.readFileSync(plugin.vault.abs(rel), "utf8") } catch { return "" } }

/** The app's section, then each snippet that's on with @settings (appearance.json's `snippets`, in the folder's order). */
function sections(): Section[] {
  const on = plugin.vault.config("appearance").snippets
  const names = Array.isArray(on) ? on.map(String) : []
  let files: string[] = []
  try { files = fs.readdirSync(plugin.vault.abs(".vaultite/snippets")).filter((f) => f.endsWith(".css") && !f.startsWith(".")) } catch { /* none */ }
  const out = [appSection()]
  for (const f of files.sort()) {
    const name = f.slice(0, -4)
    if (names.includes(name)) out.push(...readSettings(read(`.vaultite/snippets/${f}`), name).sections)
  }
  return out
}

const valued = (s: Setting) => s.type !== "heading" && s.type !== "info-text"
const modes = (s: Setting) => (s.type === "variable-themed-color" ? (["light", "dark"] as const) : [undefined])

type Row = { key: string; title: string; type: string; section: string; value: unknown; set: boolean; default?: unknown; choices?: string[]; min?: number; max?: number; unit?: string }

function rows(): Row[] {
  const values = plugin.settings()
  const out: Row[] = []
  for (const sec of sections()) {
    for (const s of sec.settings.filter(valued)) {
      for (const m of modes(s)) {
        const key = keyOf(sec.id, s.id, m)
        const def = valueOf(sec, s, {}, m)
        out.push({
          key, title: m ? `${s.title} (${m})` : s.title, type: s.type, section: sec.name, value: valueOf(sec, s, values, m), set: values[key] != null,
          ...(def !== undefined && def !== "" ? { default: def } : {}),
          ...(s.options ? { choices: [...(s.allowEmpty ? ["none"] : []), ...s.options.map((o) => o.value)] } : {}),
          ...(s.min !== undefined ? { min: s.min } : {}), ...(s.max !== undefined ? { max: s.max } : {}),
          ...(s.format && /number/.test(s.type) ? { unit: s.format } : {}),
        })
      }
    }
  }
  return out
}

/** A value as the setting takes it, or why not. */
function checked(r: Row, v: unknown): unknown {
  switch (r.type) {
    case "class-toggle":
      if (v === true || v === "true") return true
      if (v === false || v === "false") return false
      throw new OpError(`${r.key} is on or off: true or false`)
    case "class-select": case "variable-select":
      if (!r.choices?.includes(String(v))) throw new OpError(`${r.key} is one of: ${r.choices?.map((c) => `"${c}"`).join(", ")}`)
      return String(v)
    case "variable-number": case "variable-number-slider": {
      const n = Number(v)
      if (typeof v === "boolean" || !Number.isFinite(n)) throw new OpError(`${r.key} is a number${r.unit ? ` (in ${r.unit})` : ""}`)
      if ((r.min !== undefined && n < r.min) || (r.max !== undefined && n > r.max)) throw new OpError(`${r.key} is from ${r.min} to ${r.max}`)
      return n
    }
    case "variable-color": case "variable-themed-color":
      if (!parseColor(v)) throw new OpError(`${r.key} is a colour: #rrggbb, rgb() or hsl()`)
      return String(v).trim()
    default:
      if (typeof v !== "string" && typeof v !== "number") throw new OpError(`${r.key} is text`)
      return String(v)
  }
}

const show = (v: unknown) => (v === undefined || v === "" ? "unset" : typeof v === "string" ? v : JSON.stringify(v))

plugin.op({
  id: "style-settings.list",
  summary: "Every style setting the vault's CSS declares (the app's accent and line width, snippets' @settings): key, value, choices.",
  help: "Lists the settings drawn in Style settings' sheet: the app's own (accent colour, line width) and those of each CSS snippet that's on. Change one with style-settings.set and its key.",
  kind: "read",
  cli: "style-settings list",
  mcp: true,
  run: () => ({ settings: rows() }),
  text: (r: { settings: Row[] }) => {
    let last = ""
    const lines: string[] = []
    for (const s of r.settings) {
      if (s.section !== last) { lines.push(`${lines.length ? "\n" : ""}## ${s.section}`); last = s.section }
      const more = [s.choices && `one of ${s.choices.map((c) => `\`${c}\``).join(", ")}`, s.min !== undefined && `${s.min} to ${s.max}${s.unit ?? ""}`, s.default !== undefined && `default ${show(s.default)}`].filter(Boolean).join("; ")
      lines.push(`- \`${s.key}\` ${s.title} (${s.type}): ${show(s.value)}${s.set ? "" : " (default)"}${more ? `; ${more}` : ""}`)
    }
    return lines.join("\n")
  },
})

plugin.op({
  id: "style-settings.set",
  summary: "Change a style setting by its key (style-settings.list has them); null or default puts it back. The app follows live.",
  kind: "write",
  params: {
    key: { type: "string", required: true, description: "the setting's key, as style-settings.list gives it (\"vaultite@@primary\")" },
    value: { format: "json", required: true, description: "its new value: true/false, a choice, a number, a colour (#d33682) or text; null for its default" },
  },
  args: ["key", "value"],
  cli: "style-settings set",
  mcp: true,
  run: (p: { key: string; value: unknown }) => {
    const r = rows().find((x) => x.key === p.key)
    if (!r) throw new OpError(`no style setting '${p.key}': style-settings.list has them (a snippet's are there only while it's on)`)
    const v = p.value === null || p.value === "default" || p.value === "null" ? null : checked(r, p.value)
    const cur = plugin.readSettings() ?? {}
    const next = { ...cur }
    if (v === null || JSON.stringify(v) === JSON.stringify(r.default)) delete next[p.key]; else next[p.key] = v
    plugin.saveSettings(Object.keys(next).length ? next : null)
    return { key: p.key, value: v ?? r.default ?? null }
  },
  text: (r: { key: string; value: unknown }) => `${r.key} is ${show(r.value)}.`,
})

