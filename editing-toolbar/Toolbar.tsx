// The bar: the chosen buttons in order, those whose command isn't there (its plugin off) left out. On a computer what
// doesn't fit goes under More at the end; on a phone it scrolls sideways, at 44px targets.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react"
import type { EditorView } from "@codemirror/view"
import { Ellipsis } from "lucide-react"
import { cn, isDesktop, keyHint, keysOf, menuAbove, menuBelow, runCommandById, useCommandList, type MenuItem } from "@vaultite"
import { BUTTON, SEPARATOR, type Button } from "./buttons"
import { current, subscribe } from "./settings"

export type Place = "top" | "floating" | "keyboard"
type Item = Button | typeof SEPARATOR

// Desktop sizes: 28px buttons 2px apart, a separator 9px.
const SIZE = 30, SEP = 9

/** Run a button's command in its note (commands act on the editor with the keyboard). */
function run(view: EditorView, command: string) { view.focus(); runCommandById(command) }

export function useDesktop() {
  const [desktop, setDesktop] = useState(isDesktop)
  useEffect(() => {
    const f = () => setDesktop(isDesktop())
    addEventListener("resize", f)
    return () => removeEventListener("resize", f)
  }, [])
  return desktop
}

function useItems(): Item[] {
  const { buttons } = useSyncExternalStore(subscribe, current)
  const have = new Set(useCommandList().map((c) => c.id))
  const there = (b: Button) => (b.command ? have.has(b.command) : b.menu ? b.menu.some((m) => have.has(m.command)) : true)
  const list: Item[] = []
  for (const id of buttons) {
    if (id === SEPARATOR) { if (list.length && list[list.length - 1] !== SEPARATOR) list.push(SEPARATOR); continue }
    const b = BUTTON.get(id)
    if (b && there(b)) list.push(b)
  }
  if (list[list.length - 1] === SEPARATOR) list.pop()
  return list
}

export function Toolbar({ view, place }: { view: EditorView; place: Place }) {
  const items = useItems()
  const commands = useCommandList()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const phone = !useDesktop()
  useLayoutEffect(() => {
    // (a floating bar is as wide as its buttons: it may take the note's width)
    const el = place === "floating" ? view.contentDOM : box.current?.parentElement
    if (!el || phone) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [phone, place, view])

  /** Its keys as a menu shows them: its command's in effect (rebound ones too), or the editor's own. */
  const hint = (command?: string, own?: string) => {
    const c = command ? commands.find((x) => x.id === command) : undefined
    const keys = c ? keysOf(c)[0] : own
    return keys ? keyHint(keys) : undefined
  }
  const tip = (b: Button) => { const h = hint(b.command, b.keys); return h ? `${b.label} ${h}` : b.label }
  const menuOf = (b: Button): MenuItem[] => b.menu!.map((m) => ({ label: m.label, icon: m.icon, hint: hint(m.command), run: () => run(view, m.command) }))
  const open = (e: MouseEvent, list: MenuItem[]) => (place === "keyboard" ? menuAbove(e, list) : menuBelow(e, list))
  const press = (b: Button, e: MouseEvent) => {
    if (b.menu) return open(e, menuOf(b))
    if (b.run) { view.focus(); b.run(view) } else if (b.command) run(view, b.command)
  }

  // What fits (a computer): the items up to the room left, the rest in More.
  let shown = items, more: Button[] = []
  const room = place === "floating" ? Math.min(width, 640) : width
  if (!phone && room) {
    const need = items.reduce((n, it) => n + (it === SEPARATOR ? SEP : SIZE), 8)
    if (need > room) {
      let used = 8 + SIZE, cut = 0
      while (cut < items.length && used + (items[cut] === SEPARATOR ? SEP : SIZE) <= room) used += items[cut++] === SEPARATOR ? SEP : SIZE
      shown = items.slice(0, cut)
      while (shown[shown.length - 1] === SEPARATOR) shown = shown.slice(0, -1)
      more = items.slice(cut).filter((it): it is Button => it !== SEPARATOR)
    }
  }
  const moreItems = (): MenuItem[] => more.flatMap((b, i): MenuItem[] => {
    const sep = i > 0 && items.indexOf(more[i - 1]) !== items.indexOf(b) - 1
    if (b.menu) return [{ label: b.label, icon: b.icon, sep, run: () => {}, items: menuOf(b) }]
    return [{ label: b.label, icon: b.icon, sep, hint: hint(b.command, b.keys), run: () => (b.run ? (view.focus(), b.run(view)) : run(view, b.command!)) }]
  })

  const btn = cn("grid shrink-0 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
    "active:bg-foreground/[0.1]", phone ? "size-11" : "size-7")
  const icon = phone ? "size-5" : "size-4"
  return (
    <div ref={box} role="toolbar" aria-label="Formatting" data-editing-toolbar={place}
      // (a press never takes the keyboard from the note, so the selection stays and a phone's keyboard stays up)
      onMouseDown={(e) => e.preventDefault()}
      className={cn("flex items-center", phone ? "h-11 gap-0 overflow-x-auto [scrollbar-width:none]" : "gap-0.5", place !== "top" && "px-1",
        place === "top" && !phone && "h-10", place === "floating" && cn("glass-strong mb-1.5 rounded-[10px]", phone ? "max-w-[calc(100vw-2rem)]" : "h-9"))}>
      {shown.map((it, i) => it === SEPARATOR
        ? <span key={`sep-${i}`} aria-hidden className={cn("mx-[3.5px] w-px shrink-0 bg-border", phone ? "h-6" : "h-4")} />
        : (
          <button key={it.id} type="button" className={btn} aria-label={it.label} data-tip={phone ? undefined : tip(it)}
            data-toolbar-button={it.id} aria-haspopup={it.menu ? "menu" : undefined} onClick={(e) => press(it, e)}>
            <it.icon className={icon} strokeWidth={2} />
          </button>
        ))}
      {!!more.length && (
        <button type="button" className={btn} aria-label="More formatting" data-tip="More" data-toolbar-button="more" aria-haspopup="menu"
          onClick={(e) => open(e, moreItems())}>
          <Ellipsis className={icon} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
