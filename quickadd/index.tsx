// Quick add: each choice a palette command (so a new tab's button too), "Quick add" to pick one, and its settings sheet.
// Running one is the server's `quickadd.run`, which asks what a format needs in this window.
import { useState } from "react"
import { ChevronDown, ChevronRight, FilePlus2, Layers, Plus, SquarePlus, TextCursorInput } from "lucide-react"
import {
  choose, currentFile, definePlugin, getStore, Group, notify, notifyError, op, openFile, openPluginSettings, Section, SettingField,
  SettingRow, stem, useCommands, useLive, usePluginSettings, type SettingDecl, type Store,
} from "@vaultite"
import type { Choice } from "./choices"
import "./types"

const KINDS = { capture: { icon: TextCursorInput, label: "Capture" }, template: { icon: FilePlus2, label: "Template" }, multi: { icon: Layers, label: "Group" } }

async function run(id: string) {
  try {
    const r = await op<{ path: string; open: boolean }>("quickadd.run", { choice: id, file: currentFile() ?? undefined, ask: true })
    if (r.open) openFile(r.path)
    else notify(`Added to ${stem(r.path)}`, { action: { label: "Open", run: () => openFile(r.path) } })
  } catch (e) { if (!/Cancelled/.test(String(e))) notifyError(e, "Quick add couldn't run it") }
}

/** The choices to pick from: those not in a group (a group offers them). */
function pick() {
  const list = getStore()?.quickadd?.choices ?? []
  const grouped = new Set(list.flatMap((c) => (c.type === "multi" ? c.choices ?? [] : [])))
  choose({
    title: "Quick add", placeholder: list.length ? "Quick add…" : "No choices yet",
    items: list.filter((c) => !grouped.has(c.name)).map((c) => ({ id: c.id, label: c.name, detail: KINDS[c.type].label, icon: KINDS[c.type].icon })),
    onPick: (it) => void run(it.id),
    empty: (
      <button type="button" onClick={() => { choose(null); openPluginSettings("quickadd") }}
        className="mx-auto my-5 block cursor-pointer rounded-[8px] bg-foreground/[0.07] px-3 py-1.5 text-[14px] hover:bg-foreground/[0.11]">Set up choices</button>
    ),
  })
}

function Commands({ store }: { store: Store }) {
  const list = store.quickadd?.choices
  useCommands(() => (list ?? []).filter((c) => c.command).map((c) => ({
    id: `quickadd:${c.id}`, name: `Quick add: ${c.name}`, run: () => void run(c.id), icon: KINDS[c.type].icon, label: c.name,
  })), [list])
  return null
}

// ---------- the settings sheet: each choice a row that unfolds into its fields (the app's settings form)

const S = (label: string, description: string, more: Partial<SettingDecl> = {}) => ({ type: "string", label, description, ...more }) as SettingDecl
const B = (label: string, description: string, more: Partial<SettingDecl> = {}) => ({ type: "boolean", label, description, ...more }) as SettingDecl
const ASKS = "{{VALUE}} asks, {{VALUE:Topic}} asks for that, {{DATE}}, {{DATE:YYYY-MM-DD}}, {{TIME}}, {{LINKCURRENT}}"

function fields(c: Choice, others: string[], templates: string[]): Record<string, SettingDecl> {
  const common = { name: S("Name", "what the palette and a new tab's button call it"),
    command: B("In the palette", "a command of its own: a new tab's buttons can show it too") }
  if (c.type === "multi") return { ...common, choices: { type: "list", values: others, label: "Choices", description: "the ones it offers" } as SettingDecl }
  if (c.type === "template") return { ...common,
    template: { type: "enum", values: templates, label: "Template", description: "the note it starts from" } as SettingDecl,
    nameFormat: S("File name", `the new note's name: ${ASKS}`, { default: "{{VALUE}}" }),
    folder: S("Folder", "where the note goes ({{DATE}} works); empty: the vault's top"),
    open: B("Open it", "open the new note", { default: true }) }
  return { ...common,
    file: S("Note", "the note it adds to, by path (Daily/{{DATE}} works); empty: the open note"),
    format: S("Text", `what it adds: ${ASKS}`, { default: "{{VALUE}}" }),
    heading: S("Under heading", "the section it adds to, made at the end when missing; empty: the whole note"),
    prepend: B("At the top", "at the top of the note or the section, not at its end"),
    open: B("Open it", "open the note after") }
}

const about = (c: Choice) => c.type === "multi" ? `Group: ${(c.choices ?? []).join(", ") || "empty"}`
  : c.type === "template" ? `Template: ${c.template || "none yet"}` : `Capture to ${c.file || "the open note"}${c.heading ? `, under ${c.heading}` : ""}`

function ChoicesPanel({ store }: { store: Store }) {
  const [, set] = usePluginSettings("quickadd")
  const { data: tpl } = useLive<{ folder: string }>("templates")
  const [open, setOpen] = useState<string | null>(null)
  const { choices: list = [], from = null } = store.quickadd ?? {}
  const templates = store.files.files.filter((f) => tpl && f.path.startsWith(`${tpl.folder}/`)).map((f) => f.path.slice(tpl!.folder.length + 1, -3))
  const save = (next: Choice[]) => void set({ choices: next }).catch((e) => notifyError(e, "Couldn't save it"))
  const put = (c: Choice, patch: Partial<Choice>) => save(list.map((x) => x.id === c.id ? { ...x, ...patch }
    // (a renamed choice stays in its groups)
    : patch.name && x.choices?.includes(c.name) ? { ...x, choices: x.choices.map((n) => (n === c.name ? patch.name! : n)) } : x))
  const add = (type: Choice["type"]) => {
    const c: Choice = { id: Math.random().toString(36).slice(2, 10), name: `New ${KINDS[type].label.toLowerCase()}`, type, command: type !== "multi" }
    save([...list, c]); setOpen(c.id)
  }
  const remove = (c: Choice) => { save(list.filter((x) => x.id !== c.id)); notify(`Deleted ${c.name}`, { action: { label: "Undo", run: () => save(list) } }) }
  return (
    <div className="space-y-5" data-quickadd-settings>
      <Section title={from === "quickadd" ? "Choices, from Obsidian's QuickAdd" : "Choices"}>
        <Group>
          {list.map((c) => {
            const Icon = KINDS[c.type].icon
            return (
              <div key={c.id} data-choice={c.name}>
                <SettingRow label={<span className="flex items-center gap-2"><Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />{c.name}</span>}
                  sub={about(c)} onClick={() => setOpen(open === c.id ? null : c.id)} chevron={open === c.id ? ChevronDown : ChevronRight} aria-expanded={open === c.id} />
                {open === c.id && (
                  <div className="pb-2 pl-6">
                    {Object.entries(fields(c, list.filter((x) => x.id !== c.id).map((x) => x.name), templates)).map(([k, d]) => (
                      <SettingField key={k} k={k} d={d} value={c[k as keyof Choice]} set={(v) => put(c, { [k]: v ?? undefined })} />
                    ))}
                    <button type="button" onClick={() => remove(c)} className="min-h-11 cursor-pointer text-[15px] text-destructive md:min-h-9 md:text-[14px]">Delete choice</button>
                  </div>
                )}
              </div>
            )
          })}
          {(["capture", "template", "multi"] as const).map((t) => (
            <button key={t} type="button" onClick={() => add(t)} data-quickadd-add={t}
              className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-[15px] text-primary md:min-h-9 md:text-[14px]">
              <Plus className="size-4" strokeWidth={2.25} /> Add a {t === "multi" ? "group" : t}
            </button>
          ))}
        </Group>
      </Section>
    </div>
  )
}

export default definePlugin({
  commands: [{ id: "quickadd:run", name: "Quick add", run: pick, icon: SquarePlus }],
  background: ({ store }) => <Commands store={store} />,
  settingsPanel: ({ store }) => <ChoicesPanel store={store} />,
  settingsSearch: [{ label: "Choices", description: "captures, templates and groups to run from the palette" }],
})
