// Templater's `tp` (its common parts) over a Host: what the server (plugin.ts) or a test gives it of the vault and the user.
import { formatDate, parseDate } from "@vaultite/core/plugins.ts"
import { Cancelled, render, type Rendered } from "./engine.ts"

export type Mode = "new" | "insert" | "create"
/** A file as tp.config and tp.file see it (Obsidian's TFile's names). */
export type FileInfo = { path: string; name: string; basename: string; extension: string }

export type Host = {
  /** The template, and the file it's written into (made later for "new": its path changes with rename and move). */
  template: string
  target: string
  mode: Mode
  now: Date
  /** A vault path on this machine's disk (tp.file.path). */
  abs: (path: string) => string
  /** A vault file's text, or null. */
  read: (path: string) => Promise<string | null>
  /** A link's target ("Note", "Folder/Note") to a vault path, or null. */
  resolve: (link: string) => string | null
  /** What the vault knows of a file, when it's there. */
  file: (path: string) => { fm: Record<string, unknown>; tags: string[]; created: number; modified: number } | null
  /** The user's answer: typed text, or null when they dismissed it. */
  prompt: (question: string, value: string | null, multiline: boolean) => Promise<string | null>
  /** The index of the label the user picked, or null. */
  suggest: (labels: string[], placeholder: string, items: unknown[]) => Promise<number | null>
}

const info = (path: string): FileInfo => {
  const name = path.slice(path.lastIndexOf("/") + 1), dot = name.lastIndexOf(".")
  return { path, name, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : "" }
}
const folderOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0))
/** A path a template gives (rename, move): in the vault, without a leading slash or .md. */
function vaultPath(p: unknown) {
  const s = String(p ?? "").trim().replace(/^\/+/, "").replace(/\.md$/i, "")
  if (!s || s.split("/").some((x) => x === ".." || x === "." || !x.trim())) throw new Error(`"${p}" isn't a path in the vault`)
  return s
}
/** A section of a note: the lines under `# heading` until the next heading of its level or above. */
function section(text: string, heading: string) {
  const lines = text.split("\n"), want = heading.trim().toLowerCase()
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s+/, "").trim().toLowerCase() === want)
  if (at < 0) return null
  const level = /^#+/.exec(lines[at])![0].length
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l) && /^#+/.exec(l)![0].length <= level)
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n").replace(/^\n+|\n+$/g, "")
}

/** `d` moved by an offset: a number of days, or an ISO 8601 duration ("P1W", "-P1M", "P-1M", "P1DT2H"), as moment adds them
 *  (a month later than January 31 is the end of February). */
export function shift(d: Date, offset: number | string | undefined): Date {
  const out = new Date(d)
  if (typeof offset === "number") { out.setDate(out.getDate() + offset); return out }
  const m = typeof offset === "string" ? /^([-+])?P(?:(-?\d+)Y)?(?:(-?\d+)M)?(?:(-?\d+)W)?(?:(-?\d+)D)?(?:T(?:(-?\d+)H)?(?:(-?\d+)M)?(?:(-?\d+)S)?)?$/i.exec(offset.trim()) : null
  if (!m) return out
  const sign = m[1] === "-" ? -1 : 1, n = (i: number) => sign * Number(m[i] ?? 0)
  const months = n(2) * 12 + n(3)
  if (months) {
    const day = out.getDate()
    out.setDate(1)
    out.setMonth(out.getMonth() + months)
    out.setDate(Math.min(day, new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate()))
  }
  out.setDate(out.getDate() + n(4) * 7 + n(5))
  out.setTime(out.getTime() + (n(6) * 3600 + n(7) * 60 + n(8)) * 1000)
  return out
}

/** tp.date's reference date: in its format, read loosely as moment does; else a day (local, as moment reads it, not UTC),
 *  else as JavaScript reads it. */
function dateOf(ref: unknown, fmt: unknown) {
  const text = String(ref), f = fmt == null ? "" : String(fmt)
  return (f ? parseDate(text, f, { loose: true }) : null) ?? parseDate(text.trim(), "YYYY-MM-DD") ?? new Date(text)
}

/** A cursor mark: where the app puts the cursor after the template (Templater writes it as this command). */
export const cursor = (n?: unknown) => `<% tp.file.cursor(${n ?? ""}) %>`
export const CURSOR = /<%\s*tp\.file\.cursor\((\d*)\)\s*%>/g

/** The tp object for one run (`depth`: includes inside includes). */
export function tpFor(h: Host, depth = 0): Record<string, unknown> {
  const date = (fmt?: unknown, offset?: unknown, ref?: unknown, refFmt?: unknown) =>
    formatDate(shift(ref == null ? h.now : dateOf(ref, refFmt), offset as number | string), fmt == null ? undefined : String(fmt))
  const target = () => h.file(h.target)
  const stamp = (t: number | undefined, fmt: unknown) => formatDate(t ? new Date(t) : h.now, fmt == null ? "YYYY-MM-DD HH:mm" : String(fmt))
  const tp: Record<string, unknown> = {
    date: {
      now: date,
      tomorrow: (fmt?: unknown) => date(fmt, 1),
      yesterday: (fmt?: unknown) => date(fmt, -1),
      weekday: (fmt: unknown, weekday: unknown, ref?: unknown, refFmt?: unknown) => {
        const d = ref == null ? h.now : dateOf(ref, refFmt)
        return formatDate(shift(d, Number(weekday) - (d.getDay() + 6) % 7), fmt == null ? undefined : String(fmt))
      },
    },
    file: {
      get title() { return info(h.target).basename },
      path: (relative?: unknown) => (relative ? h.target : h.abs(h.target)),
      get tags() { return (target()?.tags ?? []).map((t) => `#${t}`) },
      get content() { return target() ? h.read(h.target).then((t) => t ?? "") : "" },
      folder: (absolute?: unknown) => absolute ? folderOf(h.target) : folderOf(h.target).replace(/^.*\//, ""),
      creation_date: (fmt?: unknown) => stamp(target()?.created, fmt),
      last_modified_date: (fmt?: unknown) => stamp(target()?.modified, fmt),
      cursor,
      exists: (p: unknown) => !!h.file(String(p ?? "").replace(/^\/+/, "")),
      rename: (title: unknown) => { const t = vaultPath(title); if (t.includes("/")) throw new Error("tp.file.rename takes a name: tp.file.move moves"); h.target = `${folderOf(h.target) ? `${folderOf(h.target)}/` : ""}${t}.md` },
      move: (to: unknown) => { h.target = `${vaultPath(to)}.md` },
      include: async (link: unknown) => {
        if (depth >= 10) throw new Error("tp.file.include: includes nested more than 10 deep")
        const m = /^\s*(?:\[\[)?([^\]|#]*)(?:#([^\]|]*))?(?:\|[^\]]*)?(?:\]\])?\s*$/.exec(String(link ?? ""))
        const path = m && h.resolve(m[1])
        const whole = path ? await h.read(path) : null
        if (whole == null) throw new Error(`tp.file.include: there's no note ${link}`)
        const part = m![2] ? section(whole, m![2]) : whole
        if (part == null) throw new Error(`tp.file.include: ${link} has no such heading`)
        return (await render(part, { tp: tpFor(h, depth + 1) })).text
      },
    },
    get frontmatter() { return h.mode === "new" ? {} : target()?.fm ?? {} },
    system: {
      prompt: async (question?: unknown, value?: unknown, throwOnCancel?: unknown, multiline?: unknown) => {
        const a = await h.prompt(question == null ? "" : String(question), value == null ? null : String(value), !!multiline)
        if (a == null && throwOnCancel) throw new Cancelled()
        return a
      },
      suggester: async (labels: unknown, items: unknown, throwOnCancel?: unknown, placeholder?: unknown) => {
        if (!Array.isArray(labels) || !Array.isArray(items)) throw new Error("tp.system.suggester takes two lists (a function for the labels needs JavaScript)")
        const i = await h.suggest(labels.map(String), placeholder == null ? "" : String(placeholder), items)
        if (i == null && throwOnCancel) throw new Cancelled()
        return i == null ? null : items[i]
      },
    },
    get config() {
      return { template_file: info(h.template), target_file: info(h.target), active_file: h.mode === "insert" ? info(h.target) : undefined,
        run_mode: { new: 0, insert: 1, create: 2 }[h.mode] }
    },
  }
  return tp
}

/** A template run for the host: its text (null when the user cancelled), the file's path after rename and move, and
 *  what wasn't run. */
export async function run(text: string, h: Host): Promise<(Rendered & { path: string }) | null> {
  try {
    const r = await render(text, { tp: tpFor(h) })
    return { ...r, path: h.target }
  } catch (e) {
    if (e instanceof Cancelled) return null
    throw e
  }
}
