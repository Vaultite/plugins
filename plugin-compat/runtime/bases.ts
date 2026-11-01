// Obsidian plugins' Bases views (registerBasesView), drawn in the app's bases: a view whose type is theirs gets its rows
// from the app's query, as entries whose values come from each file's metadata, and draws them itself.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vaultite from "@vaultite"
import type { BaseLayoutCtx } from "@vaultite"
import { BasesEntry, BasesEntryGroup, BasesQueryResult, BasesViewConfig, BooleanValue, DateValue, LinkValue, ListValue, NullValue, NumberValue, ObjectValue,
  QueryController, StringValue, type Value } from "./values.ts"

export type Registration = { name: string; icon?: string; factory: (controller: QueryController, el: HTMLElement) => any; options?: unknown }

/** The layouts the app draws itself (a plugin's of the same type isn't used: its own map or calendar is). */
const OWN = new Set(["table", "cards", "list", "board", "kanban", "map", "calendar"])
/** The views plugins registered, by type: what Obsidian's internal Bases plugin lists. */
export const basesViews = new Map<string, Registration & { plugin: string }>()

/** A YAML value as Bases' Value. */
export function valueOf(v: unknown): Value {
  if (v === null || v === undefined || v === "") return NullValue.value
  if (v instanceof Date) return new DateValue(v, true)
  if (typeof v === "number") return new NumberValue(v)
  if (typeof v === "boolean") return new BooleanValue(v)
  if (Array.isArray(v)) return new ListValue(v.map(valueOf))
  if (typeof v === "object") return new ObjectValue(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, valueOf(x)])))
  const s = String(v)
  return LinkValue.parseFromString(s) ?? (/^\d{4}-\d{2}-\d{2}(T[\d:.]+)?/.test(s) ? DateValue.parseFromString(s) : null) ?? new StringValue(s)
}

/** A file's value for a property id (note.status, file.mtime, formula.x, or a bare frontmatter key). */
function valueFor(app: any, file: any, row: Record<string, unknown>, id: string): Value {
  const dot = id.indexOf("."), kind = dot < 0 ? "note" : id.slice(0, dot), name = dot < 0 ? id : id.slice(dot + 1)
  if (kind === "file") {
    const cache = app.metadataCache.getFileCache(file)
    switch (name) {
      case "name": return new StringValue(file.name)
      case "basename": return new StringValue(file.basename)
      case "path": return new StringValue(file.path)
      case "folder": return new StringValue(file.parent?.path ?? "")
      case "ext": return new StringValue(file.extension)
      case "size": return new NumberValue(file.stat?.size ?? 0)
      case "ctime": return new DateValue(new Date(file.stat?.ctime ?? 0))
      case "mtime": return new DateValue(new Date(file.stat?.mtime ?? 0))
      case "tags": return new ListValue([...new Set([...(cache?.tags ?? []).map((t: any) => t.tag), ...[].concat(cache?.frontmatter?.tags ?? []).map((t: string) => `#${String(t).replace(/^#/, "")}`)])].map((t) => new StringValue(t)))
      case "links": return new ListValue((cache?.links ?? []).map((l: any) => new LinkValue(l.link)))
      case "file": return new LinkValue(file.path)
      default: return NullValue.value
    }
  }
  if (kind === "formula") return valueOf(row[id] ?? row[name])
  const fm = app.metadataCache.getFileCache(file)?.frontmatter
  return valueOf(fm && name in fm ? fm[name] : row[name])
}

class Entry extends BasesEntry {
  private app: any; private row: Record<string, unknown>
  constructor(app: any, file: any, row: Record<string, unknown>) { super(file); this.app = app; this.row = row }
  getValue(id: string) { return valueFor(this.app, this.file, this.row, id) }
}

/** The view's YAML as BasesViewConfig: its keys by get(), its order and sort as property ids. */
function configOf(view: Record<string, unknown>, name: string) {
  const c = new BasesViewConfig()
  c.name = name
  for (const [k, v] of Object.entries(view)) c.set(k, v)
  const ids = (k: string) => (k.includes(".") ? k : `note.${k}`)
  c.getOrder = () => (Array.isArray(view.order) ? view.order.map((k) => ids(String(k))) : [])
  c.getSort = () => (Array.isArray(view.sort) ? view.sort.map((s: any) => ({ property: ids(String(s?.column ?? s?.property ?? "")), direction: String(s?.direction ?? "ASC").toUpperCase() })) : [])
  return c
}

/** The rows as Obsidian's query result: entries, their groups, the properties the view shows. */
function resultOf(app: any, ctx: BaseLayoutCtx, config: BasesViewConfig) {
  const r = new BasesQueryResult()
  const entry = new Map<string, Entry>()
  const of = (row: { path: string; values: Record<string, unknown> }) => {
    let e = entry.get(row.path)
    if (!e) { const f = app.vault.getFileByPath(row.path); if (f) entry.set(row.path, e = new Entry(app, f, row.values)) }
    return e
  }
  r.groupedData = ctx.rows.groups.map((g) => new BasesEntryGroup(g.name === null ? null : new StringValue(g.name), g.rows.map(of).filter((e): e is Entry => !!e)))
  r.data = r.groupedData.flatMap((g) => g.entries)
  r.properties = config.getOrder()
  return r
}

/** Every property a view could show: the files' frontmatter keys and Bases' file ones. */
function allProperties(app: any) {
  const keys = new Set<string>()
  for (const f of app.vault.getMarkdownFiles()) for (const k of Object.keys(app.metadataCache.getFileCache(f)?.frontmatter ?? {})) keys.add(`note.${k}`)
  return [...["name", "path", "folder", "ext", "size", "ctime", "mtime", "tags", "links"].map((k) => `file.${k}`), ...[...keys].sort()]
}

/** Register a plugin's Bases view with the app's bases; false when it can't be drawn here (an app without plugin
 *  layouts) or the app draws that type itself. Unregistered with the plugin. */
export function registerBasesView(app: any, plugin: string, type: string, reg: Registration, onUnload: (fn: () => void) => void) {
  const register = (vaultite as any).registerBaseLayout as typeof vaultite.registerBaseLayout | undefined
  if (OWN.has(type.toLowerCase())) return false
  if (typeof register !== "function" || typeof reg?.factory !== "function") return null
  basesViews.set(type, { ...reg, plugin })
  const off = register({
    type, name: reg.name || type,
    mount: (el, first) => {
      const controller = new QueryController()
      controller.load()
      let view: any = null
      const fill = (ctx: BaseLayoutCtx) => {
        const config = configOf(ctx.view, ctx.name)
        // (the base as Obsidian's controller has it: its views' YAML and the one shown, which plugins read its groupBy from)
        Object.assign(controller, { query: { ...ctx.base, views: Array.isArray(ctx.base?.views) ? ctx.base.views : [ctx.view] }, viewName: ctx.name })
        Object.assign(view, { app, config, allProperties: allProperties(app), data: resultOf(app, ctx, config) })
        view.onDataUpdated?.()
      }
      view = reg.factory(controller, el)
      if (!view) return
      fill(first)
      view.load?.()
      return { update: fill, destroy: () => { view.unload?.(); controller.unload() } }
    },
  })
  onUnload(() => { off(); if (basesViews.get(type)?.factory === reg.factory) basesViews.delete(type) })
  return true
}
