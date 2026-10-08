// The settings sheet: each section a group of rows (headings fold), the app's own knobs first. Rows the app's form
// draws (switches, choices, numbers, text) are its SettingField; colours and sliders are drawn here.
import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react"
import { cn, Group, Markdown, runCommandById, SettingField, SettingRow, Switch } from "@vaultite"
import { keyOf, type Section, type Setting } from "./parse.ts"
import { parseColor, toHex, valueOf } from "./css.ts"
import { APP } from "./builtin.ts"
import { setValue, turnOn, useStyleState } from "./state.ts"

type Node = { s: Setting; children: Node[] }

/** The flat list as a tree: what follows a heading is under it until a heading of its level or higher. */
function tree(settings: Setting[]): Node[] {
  const root: Node[] = [], stack: { level: number; children: Node[] }[] = [{ level: 0, children: root }]
  for (const s of settings) {
    const node: Node = { s, children: [] }
    if (s.type === "heading") {
      const level = s.level ?? 1
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
      stack[stack.length - 1].children.push(node)
      stack.push({ level, children: node.children })
    } else stack[stack.length - 1].children.push(node)
  }
  return root
}

const isDefault = (v: unknown, d: unknown) => v === undefined || v === null || JSON.stringify(v) === JSON.stringify(d)

/** A small way back to the default, before the control; kept in place while unseen so the control never moves. */
function Reset({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={`Restore ${label}'s default`} data-tip={on ? "Restore default" : undefined} aria-hidden={!on || undefined}
      tabIndex={on ? undefined : -1} onClick={onClick}
      className={cn("grid size-8 shrink-0 cursor-pointer place-items-center rounded-[7px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground", !on && "invisible")}>
      <RotateCcw className="size-3.5" strokeWidth={2} />
    </button>
  )
}

/** A colour well: the system's picker, the colour shown; unset, the colour the page has now. */
function Swatch({ value, fallback, label, onPick }: { value: string | undefined; fallback: string; label: string; onPick: (hex: string, done: boolean) => void }) {
  const c = parseColor(value) ?? parseColor(fallback)
  const hex = c ? toHex(c) : "#888888"
  return (
    <label data-tip={label} className={cn("relative grid size-8 shrink-0 cursor-pointer place-items-center rounded-full border-[0.5px] border-border md:size-7",
      "after:absolute after:-inset-1.5 after:content-[''] md:after:-inset-2", !c && "border-dashed")}
      style={{ background: c ? `rgb(${c.r} ${c.g} ${c.b} / ${c.a})` : undefined }}>
      <input type="color" aria-label={label} value={hex} className="absolute inset-0 size-full cursor-pointer opacity-0"
        onInput={(e) => onPick(e.currentTarget.value, false)} onChange={(e) => onPick(e.currentTarget.value, true)} />
    </label>
  )
}

/** The colour a variable has on the page now, to show while a setting has none. */
const current = (id: string) => getComputedStyle(document.body).getPropertyValue(`--${id}`).trim()

function ColorRow({ sec, s, values }: { sec: Section; s: Setting; values: Record<string, unknown> }) {
  const themed = s.type === "variable-themed-color"
  const modes = themed ? (["light", "dark"] as const) : [undefined]
  const changed = modes.some((m) => values[keyOf(sec.id, s.id, m)] != null)
  const pick = (m: "light" | "dark" | undefined) => (hex: string, done: boolean) => {
    const old = parseColor(values[keyOf(sec.id, s.id, m)])
    // The picker has no alpha: an opacity already chosen is kept.
    const v = s.opacity && old && old.a < 1 ? toHex({ ...parseColor(hex)!, a: old.a }, true) : hex
    setValue(keyOf(sec.id, s.id, m), v, done ? 0 : 400)
  }
  return (
    <SettingRow label={s.title} sub={s.description || undefined} data-setting={keyOf(sec.id, s.id)}>
      <div className="flex shrink-0 items-center gap-2">
        <Reset on={changed} label={s.title} onClick={() => modes.forEach((m) => setValue(keyOf(sec.id, s.id, m), null))} />
        {modes.map((m) => {
          const v = valueOf(sec, s, values, m)
          return (
            <div key={m ?? "all"} className="flex items-center gap-1.5">
              {m && <span className="text-[13px] text-muted-foreground">{m === "light" ? "Light" : "Dark"}</span>}
              <Swatch value={typeof v === "string" && v ? v : undefined} fallback={current(s.id)} label={m ? `${s.title}, ${m}` : s.title} onPick={pick(m)} />
            </div>
          )
        })}
        {s.opacity && !themed && <Opacity sec={sec} s={s} values={values} />}
      </div>
    </SettingRow>
  )
}

function Opacity({ sec, s, values }: { sec: Section; s: Setting; values: Record<string, unknown> }) {
  const key = keyOf(sec.id, s.id)
  const c = parseColor(valueOf(sec, s, values)) ?? parseColor(current(s.id))
  if (!c) return null
  return (
    <input type="range" min={0} max={100} value={Math.round(c.a * 100)} aria-label={`${s.title} opacity`} data-tip="Opacity"
      onChange={(e) => setValue(key, toHex({ ...c, a: Number(e.currentTarget.value) / 100 }, true), 400)}
      className="h-8 w-16 cursor-pointer accent-[var(--primary)]" />
  )
}

function SliderRow({ sec, s, values }: { sec: Section; s: Setting; values: Record<string, unknown> }) {
  const key = keyOf(sec.id, s.id)
  const v = Number(valueOf(sec, s, values) ?? s.min ?? 0)
  return (
    <SettingRow stack label={s.title} sub={s.description || undefined} data-setting={key}>
      <div className="flex shrink-0 items-center gap-2">
        <Reset on={!isDefault(values[key], s.default)} label={s.title} onClick={() => setValue(key, null)} />
        <input type="range" min={s.min ?? 0} max={s.max ?? 100} step={s.step ?? 1} value={Number.isFinite(v) ? v : 0} aria-label={s.title}
          onChange={(e) => { const n = Number(e.currentTarget.value); setValue(key, n === s.default ? null : n, 400) }}
          className="h-8 min-w-0 flex-1 cursor-pointer accent-[var(--primary)] sm:w-40 sm:flex-none" />
        <span className="w-16 text-right text-[14px] text-muted-foreground tabular-nums">{Number.isFinite(v) ? v : ""}{s.format ?? ""}</span>
      </div>
    </SettingRow>
  )
}

/** What the app's own form draws, as its declaration. */
function FormRow({ sec, s, values }: { sec: Section; s: Setting; values: Record<string, unknown> }) {
  const key = keyOf(sec.id, s.id)
  const options = [...(s.allowEmpty ? [{ label: "None", value: "none" }] : []), ...(s.options ?? [])]
  const unit = s.format && s.type === "variable-number" ? (s.description ? ` (${s.format})` : `In ${s.format}`) : ""
  const base = { label: s.title, description: `${s.description}${unit}` }
  const d = s.type === "class-toggle" ? { ...base, type: "boolean" as const, default: s.default === true || s.default === "true" }
    : s.type === "class-select" || s.type === "variable-select"
      ? { ...base, type: "enum" as const, values: options.map((o) => o.value), labels: Object.fromEntries(options.map((o) => [o.value, o.label])), default: s.default ?? (s.allowEmpty ? "none" : undefined) }
      : s.type === "variable-number" ? { ...base, type: "number" as const, default: s.default, min: s.min, max: s.max }
        : { ...base, type: "string" as const, default: s.default }
  const save = (v: unknown) => setValue(key, isDefault(v, d.default) || v === "" ? null : v)
  return <SettingField k={key} d={d} value={values[key] ?? undefined} set={save} />
}

function Info({ s }: { s: Setting }) {
  return (
    <div className="py-2.5">
      <div className="text-[15px] leading-[20px]">{s.title}</div>
      {s.description && (s.markdown
        ? <Markdown className="text-[13px] leading-[18px] text-muted-foreground" text={s.description} />
        : <div className="text-[13px] leading-[18px] text-muted-foreground">{s.description}</div>)}
    </div>
  )
}

function Heading({ sec, node, values }: { sec: Section; node: Node; values: Record<string, unknown> }) {
  const [open, setOpen] = useState(!node.s.collapsed)
  return (
    <div data-setting={keyOf(sec.id, node.s.id)}>
      <SettingRow label={<span className="font-semibold">{node.s.title}</span>} sub={node.s.description || undefined} onClick={() => setOpen(!open)}
        chevron={open ? ChevronDown : ChevronRight} aria-expanded={open} />
      {open && <div className="hairline border-l-[0.5px] border-border pl-3">{rows(sec, node.children, values)}</div>}
    </div>
  )
}

function rows(sec: Section, nodes: Node[], values: Record<string, unknown>): ReactNode[] {
  return nodes.map(({ s, children }) => {
    const k = `${s.type}:${s.id}`
    switch (s.type) {
      case "heading": return <Heading key={k} sec={sec} node={{ s, children }} values={values} />
      case "info-text": return <Info key={k} s={s} />
      case "variable-color": case "variable-themed-color": return <ColorRow key={k} sec={sec} s={s} values={values} />
      case "variable-number-slider": return <SliderRow key={k} sec={sec} s={s} values={values} />
      default: return <FormRow key={k} sec={sec} s={s} values={values} />
    }
  })
}

function SectionGroup({ sec, values }: { sec: Section; values: Record<string, unknown> }) {
  const [open, setOpen] = useState(!sec.collapsed)
  const changed = sec.settings.some((s) => [undefined, "light", "dark"].some((m) => values[keyOf(sec.id, s.id, m as "light" | undefined)] != null))
  const reset = () => {
    for (const s of sec.settings) for (const m of [undefined, "light", "dark"] as const) if (values[keyOf(sec.id, s.id, m)] != null) setValue(keyOf(sec.id, s.id, m), null)
  }
  return (
    <section aria-label={sec.name} data-style-section={sec.id}>
      <div className="mb-1 flex min-h-11 items-center gap-2 md:min-h-8">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-1 text-left md:min-h-8 text-[13px] font-semibold text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-3.5 shrink-0" strokeWidth={2.5} /> : <ChevronRight className="size-3.5 shrink-0" strokeWidth={2.5} />}
          <span className="truncate">{sec.name}</span>
          {sec.source !== sec.name && <span className="truncate font-normal">{sec.source}</span>}
        </button>
        {changed && (
          <button type="button" onClick={reset} className="h-11 shrink-0 cursor-pointer rounded-[6px] px-2 text-[13px] text-primary hover:bg-foreground/[0.05] md:h-7">
            Restore defaults
          </button>
        )}
      </div>
      {open && (
        <Group>
          {rows(sec, tree(sec.settings), values)}
          {sec.id === APP && (
            <SettingRow label="Fonts and text sizes" sub="In Settings, Appearance" onClick={() => runCommandById("page:settings")} data-setting="fonts" />
          )}
        </Group>
      )}
    </section>
  )
}

export function StylePanel() {
  const st = useStyleState()
  if (!st.ready) return <Group><div className="min-h-12" aria-busy /></Group>
  const snippets = st.sections.filter((s) => s.id !== APP)
  return (
    <div className="space-y-5" data-style-settings>
      {st.sections.map((sec, i) => <SectionGroup key={`${sec.source}:${sec.id}:${i}`} sec={sec} values={st.values} />)}
      {!snippets.length && (
        <p className="text-[13px] leading-[18px] text-muted-foreground">
          No CSS snippet that's on has style settings. A snippet declares them in a <code className="text-[12px]">/* @settings */</code> comment;
          add one in Settings, Appearance, CSS snippets.
        </p>
      )}
      {st.off.length > 0 && (
        <section aria-label="Snippets that are off">
          <div className="mb-1 text-[13px] font-semibold text-muted-foreground">Snippets that are off</div>
          <Group>
            {st.off.map((o) => (
              <SettingRow key={o.name} label={o.name} sub={`${o.count} ${o.count === 1 ? "setting" : "settings"}, shown once it's on`}>
                <Switch on={false} onChange={() => turnOn(o.name)} label={`${o.name} snippet`} />
              </SettingRow>
            ))}
          </Group>
        </section>
      )}
      {st.theme && (
        <p className="text-[13px] leading-[18px] text-muted-foreground" data-style-theme>
          {st.theme.name} has {st.theme.count} style {st.theme.count === 1 ? "setting" : "settings"} of its own. Vaultite takes only a theme's colours, so they don't apply here.
        </p>
      )}
      {st.problems.map((p) => <p key={p} className="text-[13px] leading-[18px] text-[var(--red)]">{p}</p>)}
    </div>
  )
}
