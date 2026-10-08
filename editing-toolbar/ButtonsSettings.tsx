// Its settings sheet's own part: the buttons shown, dragged into order, and the ones left out; separators come and
// go here too. Position and phones are its declared settings, the form under this.
import { useSyncExternalStore } from "react"
import { GripVertical, Plus } from "lucide-react"
import { cn, Group, Section, SortableList, Switch } from "@vaultite"
import { BUTTON, BUTTONS, DEFAULT_BUTTONS, SEPARATOR, type Button } from "./buttons"
import { current, saveButtons, subscribe } from "./settings"

export function ButtonsSettings() {
  const { buttons } = useSyncExternalStore(subscribe, current)
  const list = buttons.filter((id) => id === SEPARATOR || BUTTON.has(id))
  // Separators repeat: each row's id is its place too.
  const ids = list.map((id, i) => `${i}:${id}`)
  const at = (key: string) => Number(key.slice(0, key.indexOf(":")))
  const save = (next: string[]) => saveButtons(JSON.stringify(next) === JSON.stringify(DEFAULT_BUTTONS) ? null : next)
  const move = (from: string, to: string) => {
    const next = [...list]
    const [x] = next.splice(at(from), 1)
    next.splice(at(to), 0, x)
    save(next)
  }
  const hidden = BUTTONS.filter((b) => !list.includes(b.id))
  const custom = JSON.stringify(list) !== JSON.stringify(DEFAULT_BUTTONS)

  const row = (b: Button | null, on: boolean, toggle: () => void, sortable: boolean) => (
    <div className="group/tb flex h-11 items-center gap-2.5 md:h-10" data-toolbar-setting={b?.id ?? SEPARATOR}>
      <GripVertical aria-hidden className={cn("-mx-1 size-4 shrink-0 text-tertiary transition-opacity",
        sortable ? "cursor-grab md:opacity-0 md:group-hover/tb:opacity-100" : "invisible")} strokeWidth={2} />
      <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-muted text-muted-foreground md:size-6 md:rounded-[6px]">
        {b ? <b.icon className="size-4 md:size-[15px]" strokeWidth={2} /> : <span className="h-4 w-px bg-current" />}
      </span>
      <div className={cn("min-w-0 flex-1 truncate text-[15px] md:text-[14px]", !b && "text-muted-foreground")}>{b ? b.label : "Separator"}</div>
      <Switch on={on} onChange={toggle} label={b ? `Show ${b.label}` : "Keep this separator"} />
    </div>
  )
  return (
    <div className="space-y-5" data-toolbar-settings>
      <Section title={`Shown, ${list.filter((id) => id !== SEPARATOR).length}`}>
        <Group>
          <SortableList ids={ids} onMove={move} className="hairline" lift="wide">
            {(key) => {
              const id = key.slice(key.indexOf(":") + 1)
              return row(id === SEPARATOR ? null : BUTTON.get(id)!, true, () => save(list.filter((_, i) => i !== at(key))), true)
            }}
          </SortableList>
          <button type="button" onClick={() => save([...list, SEPARATOR])} data-toolbar-add-separator
            className="flex min-h-11 w-full cursor-pointer items-center gap-2 text-[15px] text-primary md:min-h-9 md:text-[14px]">
            <Plus className="size-4" strokeWidth={2.25} /> Add a separator
          </button>
        </Group>
        <p className="mt-1.5 flex gap-3 px-1 text-[13px] leading-[18px] text-muted-foreground">
          <span className="flex-1">Drag to reorder. On a computer, what doesn't fit goes under More at the end of the bar.</span>
          {custom && <button type="button" onClick={() => saveButtons(null)} data-toolbar-reset className="shrink-0 cursor-pointer text-primary">Reset</button>}
        </p>
      </Section>
      {!!hidden.length && (
        <Section title="Not shown">
          <Group>{hidden.map((b) => <div key={b.id}>{row(b, false, () => save([...list, b.id]), false)}</div>)}</Group>
        </Section>
      )}
    </div>
  )
}
