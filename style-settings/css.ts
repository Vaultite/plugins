// Settings' values as CSS: variables (each colour in its declared format) and the classes to put on <body>, the way
// Obsidian's Style Settings writes them. Shared by the app and the server (no DOM).
import { keyOf, NAME, type Section, type Setting } from "./parse.ts"

export type Values = Record<string, unknown>
export type RGBA = { r: number; g: number; b: number; a: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** A colour as written in data.json or a default: #hex, rgb(a)() or hsl(a)(); null when it's none of them. */
export function parseColor(v: unknown): RGBA | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : ""
  let m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1]
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 100) / 100 : 1 }
  }
  m = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s)
  if (!m) return null
  const parts = m[2].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const val = (p: string, scale: number) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p))
  const a = parts[3] !== undefined ? clamp(val(parts[3], 1), 0, 1) : 1
  if (m[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) => clamp(Math.round(val(p, 255)), 0, 255))
    return [r, g, b, a].some(Number.isNaN) ? null : { r, g, b, a }
  }
  const h = parseFloat(parts[0]), sat = clamp(parseFloat(parts[1]) / 100, 0, 1), l = clamp(parseFloat(parts[2]) / 100, 0, 1)
  if ([h, sat, l, a].some(Number.isNaN)) return null
  const k = (n: number) => (n + h / 30) % 12
  const f = (n: number) => l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a }
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0")
export const toHex = (c: RGBA, alpha = false) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${alpha && c.a < 1 ? hex2(c.a * 255) : ""}`

function toHsl({ r, g, b }: RGBA) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min
  let h = 0, s = 0
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h: Math.round(h), s, l }
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const dec = (n: number) => String(Math.round(n * 100) / 100)

/** One colour as the declarations its format asks for (`hsl-split` is three variables, -h -s -l). */
export function colorDecls(id: string, c: RGBA, format = "hex", opacity = false): [string, string][] {
  const { r, g, b, a } = c
  const { h, s, l } = toHsl(c)
  const al = opacity ? [dec(a)] : []
  switch (format) {
    case "rgb": return [[id, opacity ? `rgba(${r}, ${g}, ${b}, ${dec(a)})` : `rgb(${r}, ${g}, ${b})`]]
    case "rgb-values": return [[id, [r, g, b, ...al].join(", ")]]
    case "rgb-split": return [[`${id}-r`, String(r)], [`${id}-g`, String(g)], [`${id}-b`, String(b)], ...al.map((x): [string, string] => [`${id}-a`, x])]
    case "hsl": return [[id, opacity ? `hsla(${h}, ${pct(s)}, ${pct(l)}, ${dec(a)})` : `hsl(${h}, ${pct(s)}, ${pct(l)})`]]
    case "hsl-values": return [[id, [h, pct(s), pct(l), ...al].join(", ")]]
    case "hsl-split": return [[`${id}-h`, String(h)], [`${id}-s`, pct(s)], [`${id}-l`, pct(l)], ...al.map((x): [string, string] => [`${id}-a`, x])]
    case "hsl-split-decimal": return [[`${id}-h`, String(h)], [`${id}-s`, dec(s)], [`${id}-l`, dec(l)], ...al.map((x): [string, string] => [`${id}-a`, x])]
    default: return [[id, toHex(c, opacity)]]
  }
}

/** A text value made safe inside a declaration: no way out of it (; { } <) and on one line. */
export const cleanText = (v: string) => v.replace(/[;{}<>\\\n\r]/g, "").trim()

/** What a setting is now: its value in data.json, else its default (a section that `quiet` has no defaults applied). */
export function valueOf(sec: Section, s: Setting, values: Values, mode?: "light" | "dark") {
  const v = values[keyOf(sec.id, s.id, mode)]
  if (v !== undefined && v !== null) return v
  return mode === "light" ? s.defaultLight : mode === "dark" ? s.defaultDark : s.default
}

export type Output = { all: [string, string][]; light: [string, string][]; dark: [string, string][]; classes: string[] }

/** Every section's values as declarations by mode, and the body classes on. `quiet`: sections whose defaults aren't
 *  written (the app's own knobs: unset is the app's look). */
export function outputOf(sections: Section[], values: Values, quiet: Set<string> = new Set()): Output {
  const out: Output = { all: [], light: [], dark: [], classes: [] }
  for (const sec of sections) {
    const get = (s: Setting, mode?: "light" | "dark") => {
      const v = values[keyOf(sec.id, s.id, mode)]
      return v !== undefined && v !== null ? v : quiet.has(sec.id) ? undefined : valueOf(sec, s, {}, mode)
    }
    for (const s of sec.settings) {
      const v = get(s)
      switch (s.type) {
        case "class-toggle":
          if (v === true || v === "true") out.classes.push(s.id)
          break
        case "class-select":
          if (typeof v === "string" && v !== "none" && NAME.test(v) && s.options?.some((o) => o.value === v)) out.classes.push(v)
          break
        case "variable-text": case "variable-select": {
          const t = cleanText(typeof v === "string" || typeof v === "number" ? String(v) : "")
          if (t) out.all.push([s.id, s.quotes ? `'${t.replace(/'/g, "")}'` : t])
          break
        }
        case "variable-number": case "variable-number-slider": {
          const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
          if (Number.isFinite(n)) out.all.push([s.id, `${n}${cleanText(s.format ?? "")}`])
          break
        }
        case "variable-color": {
          const c = parseColor(v)
          if (c) for (const f of [{ id: s.id, format: s.format ?? "hex" }, ...(s.altFormat ?? [])]) out.all.push(...colorDecls(f.id, c, f.format, s.opacity))
          break
        }
        case "variable-themed-color":
          for (const mode of ["light", "dark"] as const) {
            const c = parseColor(get(s, mode))
            if (c) for (const f of [{ id: s.id, format: s.format ?? "hex" }, ...(s.altFormat ?? [])]) out[mode].push(...colorDecls(f.id, c, f.format, s.opacity))
          }
          break
      }
    }
  }
  return out
}

/** The stylesheet: on <html> (so the app's own tokens, which are made there, follow) and on <body>, as Style Settings
 *  sets them (so a snippet's `body { }` defaults are beaten too); !important, as a setting is the user's last word. */
export function stylesheet(o: Output) {
  const block = (sel: string, d: [string, string][]) => (d.length ? `${sel} {\n${d.map(([k, v]) => `  --${k}: ${v} !important;`).join("\n")}\n}\n` : "")
  return block(":root, body.css-settings-manager", o.all) +
    block(":root:not(.dark), :root:not(.dark) body.css-settings-manager", o.light) +
    block(":root.dark, :root.dark body.css-settings-manager", o.dark)
}
