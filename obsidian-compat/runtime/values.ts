// Bases' value types (1.10's API) and its view classes: plugins subclass BasesView and render Values. This app draws
// .base files itself, so a plugin's Bases views register but have no query results to show.
/* eslint-disable @typescript-eslint/no-explicit-any */
import moment from "../lib/moment.js"
import { Component } from "./core.ts"

export abstract class Value {
  static type = "value"
  static equals(a: Value | null, b: Value | null) { return a === b || (!!a && !!b && a.equals(b)) }
  static looseEquals(a: Value | null, b: Value | null) { return a === b || (!!a && !!b && a.looseEquals(b)) }
  abstract toString(): string
  abstract isTruthy(): boolean
  equals(o: Value) { return this.constructor === o.constructor && this.toString() === o.toString() }
  looseEquals(o: Value) { return this.toString() === o.toString() }
  renderTo(el: HTMLElement, _ctx?: any) { el.setText(this.toString()) }
}
export abstract class NotNullValue extends Value {}
export class NullValue extends Value {
  static value = new NullValue()
  toString() { return "" }
  isTruthy() { return false }
}
export abstract class PrimitiveValue<T> extends NotNullValue {
  value: T
  constructor(v: T) { super(); this.value = v }
  toString() { return String(this.value) }
  isTruthy() { return !!this.value }
}
export class StringValue extends PrimitiveValue<string> { static type = "string" }
export class NumberValue extends PrimitiveValue<number> { static type = "number" }
export class BooleanValue extends PrimitiveValue<boolean> { static type = "boolean" }
export class LinkValue extends StringValue { static parseFromString(s: string) { const m = /^\[\[([^\]]+)\]\]$/.exec(s.trim()); return m ? new LinkValue(m[1]) : null } }
export class TagValue extends StringValue {}
export class UrlValue extends StringValue {}
export class HTMLValue extends StringValue { renderTo(el: HTMLElement) { el.innerHTML = this.value } }
export class IconValue extends StringValue {}
export class ImageValue extends StringValue {}
export class DateValue extends NotNullValue {
  date: Date; time: boolean
  constructor(d: Date, time = true) { super(); this.date = d; this.time = time }
  static parseFromString(s: string) { const m = moment(s, moment.ISO_8601, true); return m.isValid() ? new DateValue(m.toDate(), s.includes("T")) : null }
  toString() { return moment(this.date).format(this.time ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD") }
  dateOnly() { return new DateValue(this.date, false) }
  relative() { return moment(this.date).fromNow() }
  isTruthy() { return !Number.isNaN(this.date.getTime()) }
}
export class RelativeDateValue extends DateValue { toString() { return this.relative() } }
export class DurationValue extends NotNullValue {
  ms: number
  constructor(ms: number) { super(); this.ms = ms }
  static fromMilliseconds(ms: number) { return new DurationValue(ms) }
  static parseFromString(s: string) { const d = moment.duration(s); return d.isValid() && d.asMilliseconds() ? new DurationValue(d.asMilliseconds()) : null }
  toString() { return moment.duration(this.ms).humanize() }
  isTruthy() { return this.ms !== 0 }
  addToDate(d: Date) { return new Date(d.getTime() + this.ms) }
  getMilliseconds() { return this.ms }
}
export class FileValue extends NotNullValue {
  file: any
  constructor(f: any) { super(); this.file = f }
  toString() { return this.file?.path ?? "" }
  isTruthy() { return !!this.file }
}
export class ListValue extends NotNullValue {
  static type = "list"
  items: Value[]
  constructor(items: Value[]) { super(); this.items = items }
  toString() { return this.items.map(String).join(", ") }
  isTruthy() { return this.items.length > 0 }
  includes(v: Value) { return this.items.some((x) => x.looseEquals(v)) }
  length() { return this.items.length }
  get(i: number) { return this.items[i] ?? NullValue.value }
  concat(o: ListValue) { return new ListValue([...this.items, ...o.items]) }
}
export class ObjectValue extends NotNullValue {
  static type = "object"
  data: Record<string, Value>
  constructor(d: Record<string, Value>) { super(); this.data = d }
  toString() { return JSON.stringify(Object.fromEntries(Object.entries(this.data).map(([k, v]) => [k, String(v)]))) }
  isTruthy() { return !this.isEmpty() }
  isEmpty() { return Object.keys(this.data).length === 0 }
  get(k: string) { return this.data[k] ?? NullValue.value }
}
export class RegExpValue extends NotNullValue {
  re: RegExp
  constructor(r: RegExp) { super(); this.re = r }
  toString() { return String(this.re) }
  isTruthy() { return true }
}

export const parsePropertyId = (id: string) => { const i = id.indexOf("."); return i < 0 ? { type: "note", name: id } : { type: id.slice(0, i), name: id.slice(i + 1) } }

export class RenderContext { hoverPopover: any = null }
export class QueryController extends Component {}
export class BasesEntry {
  file: any; private values: Record<string, Value>
  constructor(file: any, values: Record<string, Value> = {}) { this.file = file; this.values = values }
  getValue(id: string) { return this.values[id] ?? NullValue.value }
}
export class BasesEntryGroup {
  key: Value | null; entries: BasesEntry[]
  constructor(key: Value | null, entries: BasesEntry[]) { this.key = key; this.entries = entries }
  hasKey() { return !!this.key && !(this.key instanceof NullValue) }
}
export class BasesQueryResult {
  data: BasesEntry[] = []; groupedData: BasesEntryGroup[] = []; properties: string[] = []
  getSummaryValue() { return NullValue.value }
}
export class BasesViewConfig {
  name = ""; private values: Record<string, unknown> = {}
  get(k: string) { return this.values[k] }
  getAsPropertyId(k: string) { return typeof this.values[k] === "string" ? this.values[k] : null }
  getEvaluatedFormula() { return NullValue.value }
  set(k: string, v: unknown) { this.values[k] = v }
  getOrder() { return [] as string[] }
  getSort() { return [] as unknown[] }
  getDisplayName(id: string) { return parsePropertyId(id).name }
}
export class BasesView extends Component {
  app: any; config = new BasesViewConfig(); allProperties: string[] = []; data = new BasesQueryResult(); controller: QueryController
  constructor(controller: QueryController) { super(); this.controller = controller; this.app = (window as any).app }
  async createFileForView() { return null }
}
export class DisplayValueComponent {
  valueEl: HTMLElement
  constructor(el: HTMLElement) { this.valueEl = el.createDiv({ cls: "setting-display-value" }) }
  setValue(v: string | Value | null) { this.valueEl.setText(v === null ? "" : String(v)); return this }
  setStatus(s: string | null) { if (s) this.valueEl.dataset.status = s; else delete this.valueEl.dataset.status; return this }
}

/** Promises a plugin hands over to be waited for together (Tasks). */
export class Tasks {
  private list: Promise<unknown>[] = []
  add(fn: () => Promise<unknown>) { this.list.push(fn()) }
  addPromise(p: Promise<unknown>) { this.list.push(p) }
  isEmpty() { return this.list.length === 0 }
  promise() { return Promise.all(this.list) }
}
