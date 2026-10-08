// A view's header actions (addAction), which the app shows where its own views have buttons: a tab's bar, a panel's
// heading, a note's header. Copies of the plugin's buttons; a click goes to the plugin's own.
import { useEffect, useReducer, useRef, useState } from "react"
import { Ellipsis } from "lucide-react"
import { appOf } from "./runtime/host.ts"
import { Menu } from "./runtime/ui.ts"
import { MarkdownView, type WorkspaceLeaf } from "./runtime/workspace.ts"

function Copy({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLSpanElement>(null)
  // (copied again only when the plugin's button changed)
  useEffect(() => {
    const box = ref.current
    if (box && box.dataset.from !== el.innerHTML) { box.dataset.from = el.innerHTML; box.replaceChildren(...[...el.childNodes].map((n) => n.cloneNode(true))) }
  })
  return <span ref={ref} className="grid place-items-center [&_svg]:size-4" />
}

const button = "grid size-7 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"

/** The buttons a leaf's view added, kept in step with its actions element; `more`: its pane menu after them. */
export function ViewActions({ leaf, more = false }: { leaf: WorkspaceLeaf | null; more?: boolean }) {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const actions: HTMLElement | undefined = leaf?.view?.actionsEl
  useEffect(() => {
    if (!actions) return
    const ob = new MutationObserver(bump)
    ob.observe(actions, { subtree: true, childList: true, attributes: true })
    return () => ob.disconnect()
  }, [actions])
  if (!leaf || !actions) return null
  const items = [...actions.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.style.display !== "none")
  const menu = (e: React.MouseEvent) => {
    const m = new Menu()
    leaf.view.onPaneMenu?.(m, "more-options")
    if (m.items.length) m.showAtMouseEvent(e.nativeEvent)
  }
  if (!items.length && !more) return null
  return (
    <div className="flex items-center gap-0.5" data-obsidian-actions={leaf.view.getViewType()}>
      {items.map((el, i) => {
        const label = el.getAttribute("aria-label") ?? ""
        return (
          <button key={i} type="button" aria-label={label} data-tip={label} className={`${button} ${el.classList.contains("is-active") ? "text-foreground" : ""}`}
            onClick={(e) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey }))}>
            <Copy el={el} />
          </button>
        )
      })}
      {more && <button type="button" aria-label="More options" data-tip="More options" className={button} onClick={menu}><Ellipsis className="size-4" /></button>}
    </div>
  )
}

/** A note's view's actions (MarkdownView.addAction), for its header: its leaf is made as plugins ask for it. */
export function NoteActions({ path }: { path: string }) {
  const [leaf, setLeaf] = useState<WorkspaceLeaf | null>(null)
  useEffect(() => {
    const ws = appOf().workspace
    const find = () => setLeaf(ws.allLeaves().find((l) => l.view instanceof MarkdownView && l.view.file?.path === path) ?? null)
    find()
    const refs = ["layout-change", "active-leaf-change", "file-open"].map((k) => ws.on(k, () => setTimeout(find, 0)))
    return () => { for (const r of refs) ws.offref(r) }
  }, [path])
  return <ViewActions leaf={leaf} />
}

/** What plugins put in Obsidian's status bar themselves (app.statusBar.containerEl), not through addStatusBarItem. */
export function LooseStatus() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = appOf().statusBar.containerEl as HTMLElement
    box.classList.add("status-bar", "plugin-compat-status", "flex", "items-center", "gap-2")
    ref.current?.append(box)
    return () => { box.remove() }
  }, [])
  return <div ref={ref} className="contents" />
}
