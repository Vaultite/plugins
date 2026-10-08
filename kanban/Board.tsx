// The board: lanes side by side (one screen wide on a phone, snapping), cards dragged with the app's drag primitive
// (a held finger on phones), edited in place with the app's editor. Every change is an edit of the file (board.ts).
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Archive, CalendarDays, Check, ChevronsLeftRight, Clock, Ellipsis, Plus } from "lucide-react"
import {
  cn, dateText, edgeScroller, haptic, Markdown, menuBelow, menuFor, NoteEditor, notify, notifyError, parse, put, readFile, startDrag, today,
  useDrag, useDropHit, useDropTarget, type DragItem, type MenuItem, type PageCtx, type Store,
} from "@vaultite"
import {
  addCard, addLane, archiveCard, archiveDone, bitsOf, type Board as BoardT, BoardError, type Card, type CardRef, collapsed, isDone, type Lane,
  moveCard, moveLane, parseBoard, rawOf, removeCard, removeLane, renameLane, setCardText, setCollapsed, toggleCard,
} from "./format"

type Change = (text: string) => string
type Held = { kind: "card"; board: string; ref: CardRef } | { kind: "lane"; board: string; lane: number }
type Hit = { kind: "card"; lane: number; index: number } | { kind: "lane"; index: number }
type Pick = (e: React.PointerEvent<HTMLElement>, h: Held, label: string) => void

// What a drag holds: the app's DragItem has no room for a plugin's own, so it's looked up by the item itself.
const held = new WeakMap<DragItem, Held>()

/** `change` applied to the file as it is now and saved as a merge; one at a time, so each sees the last. With `undo`,
 *  a toast offers to put the file back (merged too: what changed since stays). */
const queues = new Map<string, Promise<unknown>>()
function edit(path: string, change: Change, undo?: string) {
  const run = async () => {
    const f = await readFile(path)
    const next = change(f.text)
    if (next === f.text) return
    await put("file", { path, text: next, base: f.text })
    if (undo) notify(undo, { action: { label: "Undo", run: () => put("file", { path, text: f.text, base: next }) } })
  }
  const p = (queues.get(path) ?? Promise.resolve()).then(run, run)
  queues.set(path, p.catch(() => {}))
  return p
}
const failed = (e: unknown) => notifyError(e instanceof BoardError ? new Error(e.message) : e, "Couldn't change the board")

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const countOf = (b: BoardT) => `${plural(b.lanes.length, "lane")} · ${plural(b.lanes.reduce((n, l) => n + l.cards.length, 0), "card")}`

/** The board's menu: what changes the whole board. */
function boardMenu(path: string, b: BoardT, addLane: () => void, archive: { shown: boolean; toggle: () => void }): MenuItem[] {
  const finished = b.lanes.reduce((n, l) => n + l.cards.filter((c) => l.complete || isDone(c)).length, 0)
  return [
    { label: "Add a lane", icon: Plus, run: addLane },
    { label: finished ? `Archive done cards (${finished})` : "Archive done cards", icon: Archive, disabled: !finished,
      run: () => void edit(path, (t) => archiveDone(t), `Archived ${plural(finished, "card")}`).catch(failed) },
    ...(b.archive?.cards.length ? [{ label: archive.shown ? "Hide the archive" : `Show the archive (${b.archive.cards.length})`, run: archive.toggle, sep: true }] : []),
  ]
}

export default function Board(ctx: PageCtx) {
  const { path, store } = ctx
  const editable = !!ctx.setProperty
  // What a change shows until the file comes back with it (or with something else).
  const [shown, setShown] = useState<string | null>(null)
  useEffect(() => setShown(null), [ctx.body])
  const text = shown ?? ctx.body
  const b = useMemo(() => parseBoard(text), [text])
  const [adding, setAdding] = useState<number | null>(null)
  const [newLane, setNewLane] = useState(false)
  const [archiveShown, setArchiveShown] = useState(false)
  const change = (c: Change, undo?: string) => {
    let next: string
    try { next = c(text) } catch (e) { failed(e); return }
    setShown(next)
    // (the file may come back as it was, changed again meanwhile: then the body the board has doesn't change)
    const drop = () => setShown((s) => (s === next ? null : s))
    edit(path, c, undo).then(() => setTimeout(drop, 1500), (e) => { drop(); failed(e) })
  }

  // Dragging: cards between and within lanes, lanes by their heading. The scroller follows the pointer to its edges
  // (not snapping meanwhile: a phone's lanes snap, which would undo each step).
  const id = `kanban:${useId()}`
  const box = useRef<HTMLDivElement>(null)
  const [edge] = useState(() => edgeScroller("x"))
  const drag = useDrag()
  const hit = useDropHit<Hit>(id)
  const holding = drag ? held.get(drag.item) : undefined
  const mine = holding?.board === path ? holding : undefined
  useDropTarget<Hit>(id, (item, x, y, el) => {
    const h = held.get(item)
    if (!h || h.board !== path || !box.current || !el || !box.current.contains(el)) { edge.stop(); return null }
    edge.near(box.current, x)
    if (h.kind === "lane") {
      const lanes = [...box.current.querySelectorAll<HTMLElement>("[data-kanban-lane]")].filter((l) => Number(l.dataset.kanbanLane) !== h.lane)
      const index = lanes.filter((l) => { const r = l.getBoundingClientRect(); return r.left + r.width / 2 < x }).length
      return index === h.lane ? null : { kind: "lane", index }
    }
    const laneEl = el.closest<HTMLElement>("[data-kanban-lane]")
    if (!laneEl) return null
    const lane = Number(laneEl.dataset.kanbanLane)
    const self = (i: number) => lane === h.ref.lane && i === h.ref.index
    const cards = [...laneEl.querySelectorAll<HTMLElement>("[data-kanban-card]")].filter((c) => !self(Number(c.dataset.kanbanCard)))
    const index = collapsed(b, lane) ? b.lanes[lane].cards.length - (lane === h.ref.lane ? 1 : 0)
      : cards.filter((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 < y }).length
    return self(index) ? null : { kind: "card", lane, index }
  }, (item, at) => {
    const h = held.get(item)
    if (h?.kind === "lane" && at.kind === "lane") change((t) => moveLane(t, h.lane, at.index))
    if (h?.kind === "card" && at.kind === "card") change((t) => moveCard(t, h.ref, at.lane, at.index))
  }, { end: edge.stop })

  const pick: Pick = (e, h, label) => {
    if (!editable) return
    const item: DragItem = { from: "row", label }
    held.set(item, h)
    startDrag(e, item, { touch: true })
  }
  // A lane is the board's lane-width on a computer (Obsidian's setting), the screen less a peek of the next on a phone.
  const width = { "--lane": `${Math.max(200, Math.min(600, Number(b.settings["lane-width"]) || 272))}px` } as React.CSSProperties
  const column = "shrink-0 w-[calc(100%-28px)] snap-start md:w-(--lane)"
  // Where a dragged lane would go: a line before the lane at that place among the others, or after the last.
  const laneAt = hit?.kind === "lane" && mine?.kind === "lane" ? hit.index : null
  const placeOf = (i: number) => i - (mine?.kind === "lane" && mine.lane < i ? 1 : 0)

  return (
    <div className="kanban-board" data-kanban-board={path}>
      <div ref={box} data-kanban-lanes
        className={cn("-mx-4 flex scroll-px-4 items-start gap-2.5 overflow-x-auto overscroll-x-contain px-4 pb-3 md:snap-none", mine ? "snap-none" : "snap-x snap-mandatory")}>
        {b.lanes.map((l, i) => (
          <LaneView key={`${i}:${l.title}`} b={b} lane={l} index={i} path={path} store={store} editable={editable} width={width} column={column}
            change={change} pick={pick} adding={adding === i} setAdding={(on) => setAdding(on ? i : null)}
            dragging={mine} hit={hit?.kind === "card" && hit.lane === i ? hit.index : null}
            barBefore={laneAt !== null && mine?.kind === "lane" && mine.lane !== i && placeOf(i) === laneAt} />
        ))}
        {laneAt !== null && laneAt >= b.lanes.length - 1 && <Bar vertical />}
        {archiveShown && b.archive && (
          <section data-kanban-archive style={width} className={cn(column, "flex flex-col rounded-[10px] p-1.5 ring-1 ring-border ring-inset")}>
            <div className="flex min-h-8 items-center gap-1.5 px-1.5 text-[13px] font-semibold text-muted-foreground pointer-coarse:text-[15px]">
              <Archive className="size-3.5" strokeWidth={2.25} />Archive<span className="font-normal tabular-nums">{b.archive.cards.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {b.archive.cards.map((c, j) => <div key={j} className="rounded-[8px] bg-card p-2.5 shadow-sm ring-[0.5px] ring-border"><CardBody card={c} store={store} path={path} /></div>)}
            </div>
          </section>
        )}
        {editable && (
          <div style={width} className={column}>
            {newLane
              ? <NameField placeholder="Lane name" onDone={(t) => { setNewLane(false); if (t) change((x) => addLane(x, t)) }} />
              : <button type="button" data-kanban-add-lane onClick={() => setNewLane(true)}
                className="flex h-9 w-full cursor-pointer items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground pointer-coarse:h-11 pointer-coarse:text-[15px]">
                <Plus className="size-4" strokeWidth={2.25} />Add a lane
              </button>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 text-[13px] text-muted-foreground pointer-coarse:text-[15px]">
        <span className="tabular-nums" data-kanban-count>{countOf(b)}</span>
        {editable && (
          <button type="button" aria-label="Board menu" data-kanban-board-menu
            onClick={(e) => menuBelow(e, boardMenu(path, b, () => setNewLane(true), { shown: archiveShown, toggle: () => setArchiveShown((v) => !v) }))}
            className="grid size-7 cursor-pointer place-items-center rounded-[6px] hover:bg-foreground/[0.06] hover:text-foreground pointer-coarse:size-11">
            <Ellipsis className="size-4" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  )
}

const Bar = ({ vertical }: { vertical?: boolean }) => (
  <div aria-hidden data-kanban-drop className={cn("shrink-0 rounded-full bg-primary", vertical ? "w-[3px] self-stretch" : "-my-[3px] h-[3px]")} />
)

function LaneView({ b, lane, index, path, store, editable, width, column, change, pick, adding, setAdding, dragging, hit, barBefore }: {
  b: BoardT; lane: Lane; index: number; path: string; store: Store; editable: boolean; width: React.CSSProperties; column: string
  change: (c: Change, undo?: string) => void; pick: Pick; adding: boolean; setAdding: (on: boolean) => void; dragging?: Held; hit: number | null; barBefore: boolean
}) {
  const [renaming, setRenaming] = useState(false)
  const shut = collapsed(b, index)
  const over = lane.max > 0 && lane.cards.length > lane.max
  const others = b.lanes.map((l, i) => ({ l, i })).filter(({ i }) => i !== index)
  const menu = (): MenuItem[] => editable ? [
    { label: "Add a card", icon: Plus, run: () => setAdding(true) },
    { label: "Rename", run: () => setRenaming(true) },
    { label: shut ? "Expand" : "Collapse", icon: ChevronsLeftRight, run: () => change((t) => setCollapsed(t, index, !shut)) },
    ...(index > 0 ? [{ label: "Move left", run: () => change((t) => moveLane(t, index, index - 1)) }] : []),
    ...(index < b.lanes.length - 1 ? [{ label: "Move right", run: () => change((t) => moveLane(t, index, index + 1)) }] : []),
    { label: "Archive done cards", icon: Archive, sep: true, disabled: !lane.cards.some((c) => lane.complete || isDone(c)),
      run: () => change((t) => archiveDone(t, index), `Archived the done cards of ${lane.title}`) },
    { label: "Delete lane", danger: true, run: () => change((t) => removeLane(t, index), `Deleted ${lane.title}${lane.cards.length ? ` and ${plural(lane.cards.length, "card")}` : ""}`) },
  ] : []
  const lifted = dragging?.kind === "lane" && dragging.lane === index
  const count = <span className={cn("font-normal tabular-nums", over && "text-[var(--red)]")} data-kanban-lane-count>{lane.max ? `${lane.cards.length}/${lane.max}` : lane.cards.length}</span>
  const lift = (e: React.PointerEvent<HTMLElement>) => pick(e, { kind: "lane", board: path, lane: index }, lane.title)
  if (shut) {
    return (
      <>
        {barBefore && <Bar vertical />}
        <section data-kanban-lane={index} data-collapsed onContextMenu={menuFor(menu)} onPointerDown={lift} data-tip={`Expand ${lane.title}`}
          onClick={() => editable && change((t) => setCollapsed(t, index, false))}
          className={cn("flex w-10 shrink-0 cursor-pointer flex-col items-center gap-2 rounded-[10px] bg-foreground/[0.035] py-2.5 text-[13px] font-semibold text-muted-foreground hover:bg-foreground/[0.06] pointer-coarse:w-12 pointer-coarse:text-[15px]",
            hit !== null && "ring-2 ring-primary", lifted && "opacity-40")}>
          {count}
          <span className="[writing-mode:vertical-rl]">{lane.title}</span>
        </section>
      </>
    )
  }
  let n = 0 // (cards drawn so far, without the one being dragged: where the drop line goes)
  return (
    <>
      {barBefore && <Bar vertical />}
      <section data-kanban-lane={index} style={width}
        className={cn(column, "flex flex-col rounded-[10px] bg-foreground/[0.035] p-1.5", lifted && "opacity-40", hit !== null && !lane.cards.length && "ring-2 ring-primary")}>
        <header onContextMenu={menuFor(menu)} onPointerDown={renaming ? undefined : lift} data-kanban-lane-head
          className="group flex min-h-8 items-center gap-1.5 pl-1.5 text-[13px] font-semibold text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:text-[15px]">
          {renaming
            ? <div className="min-w-0 flex-1" data-no-drag><NameField initial={lane.title} placeholder="Lane name" onDone={(t) => { setRenaming(false); if (t && t !== lane.title) change((x) => renameLane(x, index, t)) }} /></div>
            : <span className="min-w-0 flex-1 truncate" onDoubleClick={() => editable && setRenaming(true)} data-kanban-lane-title>{lane.title}</span>}
          {!renaming && count}
          {lane.complete && !renaming && <span className="grid place-items-center text-[var(--green)]" data-tip="Cards moved here are done"><Check className="size-3.5" strokeWidth={2.5} /></span>}
          {editable && !renaming && (
            <button type="button" data-no-drag aria-label={`${lane.title} menu`} data-kanban-lane-menu onClick={(e) => menuBelow(e, menu())}
              className="grid size-6 cursor-pointer place-items-center rounded-[5px] opacity-0 group-hover:opacity-100 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100">
              <Ellipsis className="size-4" strokeWidth={2} />
            </button>
          )}
        </header>
        <div className="flex flex-col gap-1.5" data-kanban-cards>
          {lane.cards.map((c, j) => {
            const lifting = dragging?.kind === "card" && dragging.ref.lane === index && dragging.ref.index === j
            const bar = hit !== null && !lifting && hit === n
            if (!lifting) n++
            return (
              <div key={`${j}:${c.start}`} className="contents">
                {bar && <Bar />}
                <CardView card={c} b={b} lane={lane} laneIndex={index} index={j} path={path} store={store} editable={editable} others={others}
                  change={change} pick={pick} lifted={lifting} />
              </div>
            )
          })}
          {hit !== null && hit >= n && n > 0 && <Bar />}
        </div>
        {editable && (adding
          ? <NewCard store={store} path={path} onAdd={(t) => change((x) => addCard(x, index, t, "bottom"))} onClose={() => setAdding(false)} />
          : <button type="button" data-kanban-add-card onClick={() => setAdding(true)}
            className={cn("flex h-8 cursor-pointer items-center gap-1.5 rounded-[7px] px-1.5 text-left text-[13px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground pointer-coarse:h-11 pointer-coarse:text-[15px]", lane.cards.length && "mt-1.5")}>
            <Plus className="size-4" strokeWidth={2.25} />Add a card
          </button>)}
      </section>
    </>
  )
}

function CardView({ card, b, lane, laneIndex, index, path, store, editable, others, change, pick, lifted }: {
  card: Card; b: BoardT; lane: Lane; laneIndex: number; index: number; path: string; store: Store; editable: boolean
  others: { l: Lane; i: number }[]; change: (c: Change, undo?: string) => void; pick: Pick; lifted: boolean
}) {
  const [editing, setEditing] = useState(false)
  const ref: CardRef = { lane: laneIndex, index, raw: rawOf(b, card) }
  const first = card.text.split("\n")[0] || "Card"
  const done = isDone(card)
  const menu = (): MenuItem[] => editable ? [
    { label: "Edit", run: () => setEditing(true) },
    { label: done ? "Mark as not done" : "Mark as done", icon: Check, run: () => change((t) => toggleCard(t, ref)) },
    ...(others.length ? [{ label: "Move to", items: others.map(({ l, i }) => ({ label: l.title, run: () => change((t) => moveCard(t, ref, i, l.cards.length)) })), run: () => {} }] : []),
    ...(index > 0 ? [{ label: "Move to top", run: () => change((t) => moveCard(t, ref, laneIndex, 0)) }] : []),
    ...(index < lane.cards.length - 1 ? [{ label: "Move to bottom", run: () => change((t) => moveCard(t, ref, laneIndex, lane.cards.length - 1)) }] : []),
    { label: "Archive", icon: Archive, sep: true, run: () => change((t) => archiveCard(t, ref), "Archived the card") },
    { label: "Delete", danger: true, run: () => change((t) => removeCard(t, ref), "Deleted the card") },
  ] : []
  if (editing) {
    return (
      <div data-kanban-card={index} data-editing className="rounded-[8px] bg-card p-2 shadow-sm ring-2 ring-primary">
        <CardEditor store={store} path={path} initial={card.text}
          onDone={(t) => { setEditing(false); if (t.trim() && t.trim() !== card.text) change((x) => setCardText(x, ref, t)) }} />
      </div>
    )
  }
  return (
    <div data-kanban-card={index} data-done={done || undefined} role="button" tabIndex={0} onContextMenu={menuFor(menu)}
      onPointerDown={(e) => pick(e, { kind: "card", board: path, ref }, first)}
      onDoubleClick={() => editable && setEditing(true)}
      onKeyDown={(e) => { if (e.key === "Enter" && editable && e.target === e.currentTarget) { e.preventDefault(); setEditing(true) } }}
      className={cn("group relative flex min-w-0 gap-2 rounded-[8px] bg-card p-2.5 text-left shadow-sm ring-[0.5px] ring-border hover:bg-background", lifted && "opacity-40")}>
      <button type="button" data-no-drag role="checkbox" aria-checked={done} aria-label={done ? "Mark as not done" : "Mark as done"} disabled={!editable}
        onClick={(e) => { e.stopPropagation(); haptic("light"); change((t) => toggleCard(t, ref)) }}
        className={cn("mt-[2px] grid size-4 shrink-0 cursor-pointer place-items-center rounded-[4px] ring-[1.5px] ring-inset pointer-coarse:size-5",
          done ? "bg-[var(--kanban)] text-background ring-[var(--kanban)]" : "ring-foreground/30 hover:ring-foreground/60")}>
        {done && <Check className="size-3" strokeWidth={3} />}
      </button>
      <CardBody card={card} store={store} path={path} onTap={editable ? () => setEditing(true) : undefined} />
      {editable && (
        <button type="button" data-no-drag aria-label="Card menu" data-kanban-card-menu onClick={(e) => { e.stopPropagation(); menuBelow(e, menu()) }}
          className="absolute top-1.5 right-1.5 grid size-6 cursor-pointer place-items-center rounded-[5px] bg-card text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 pointer-coarse:hidden">
          <Ellipsis className="size-4" strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

/** A card's Markdown, its date and time under it. A tap on a phone edits it (a link still opens). */
function CardBody({ card, store, path, onTap }: { card: Card; store: Store; path: string; onTap?: () => void }) {
  const bits = useMemo(() => bitsOf(card.text), [card.text])
  // A card's line breaks show as typed (Obsidian Kanban's way), but where a list or a blank line begins.
  const md = bits.text.replace(/([^\n])\n(?![ \t]*(?:[-*+]|\d+[.)])[ \t]|[ \t]*\n)/g, "$1  \n")
  const done = isDone(card)
  const late = !done && /^\d{4}-\d{2}-\d{2}$/.test(bits.date) && bits.date < today()
  return (
    <div className="min-w-0 flex-1" onClick={onTap ? (e) => { if (matchMedia("(pointer: coarse)").matches && !(e.target as Element).closest("a, [data-wiki], [data-tag], [data-url]")) onTap() } : undefined}>
      <Markdown text={md || "\u00a0"} store={store} from={path}
        className={cn("text-[14px] leading-[20px] break-words pointer-coarse:text-[16px] pointer-coarse:leading-[22px] [&_p]:m-0 [&_ul]:my-0.5 [&_ul]:pl-4", done && "text-muted-foreground")} />
      {(bits.date || bits.time) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground pointer-coarse:text-[14px]" data-kanban-date>
          {bits.date && <span className={cn("inline-flex items-center gap-1", late && "text-[var(--red)]")}><CalendarDays className="size-3.5" strokeWidth={2} />{dayOf(bits.date)}</span>}
          {bits.time && <span className="inline-flex items-center gap-1"><Clock className="size-3.5" strokeWidth={2} />{bits.time}</span>}
        </div>
      )}
    </div>
  )
}

const dayOf = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? dateText(parse(d), { day: "numeric", month: "short", ...(d.slice(0, 4) !== today().slice(0, 4) ? { year: "numeric" } : {}) }) : d)

/** The app's editor for a card's Markdown: Enter keeps it (Shift+Enter a new line), as do Escape and leaving it. */
function CardEditor({ store, path, initial, onDone, placeholder }: { store: Store; path: string; initial: string; onDone: (text: string) => void; placeholder?: string }) {
  const text = useRef(initial)
  const ended = useRef(false)
  const end = () => { if (!ended.current) { ended.current = true; onDone(text.current) } }
  return (
    <div data-no-drag data-kanban-editor className="text-[14px] pointer-coarse:text-[16px]"
      onKeyDownCapture={(e) => {
        // (Enter picks a suggestion while the editor's list is open)
        if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !document.querySelector(".cm-tooltip-autocomplete")) { e.preventDefault(); e.stopPropagation(); end() }
      }}>
      <NoteEditor text={initial} store={store} from={path} autoFocus placeholder={placeholder ?? "Card text"}
        onChange={(t) => { text.current = t }} onEscape={end} onBlur={end} />
    </div>
  )
}

/** A new card at the end of a lane: Enter adds it and opens the next, Escape or leaving it closes it. */
function NewCard({ store, path, onAdd, onClose }: { store: Store; path: string; onAdd: (text: string) => void; onClose: () => void }) {
  const [n, setN] = useState(0)
  return (
    <div className="mt-1.5 rounded-[8px] bg-card p-2 shadow-sm ring-2 ring-primary" data-kanban-new-card>
      <CardEditor key={n} store={store} path={path} initial="" placeholder="Card text"
        onDone={(t) => { if (t.trim()) { onAdd(t); setN((x) => x + 1) } else onClose() }} />
    </div>
  )
}

/** A one-line name (a lane's): Enter or leaving it keeps it, Escape keeps what it was. */
function NameField({ initial = "", placeholder, onDone }: { initial?: string; placeholder: string; onDone: (text: string) => void }) {
  const ended = useRef(false)
  const end = (t: string) => { if (!ended.current) { ended.current = true; onDone(t.trim()) } }
  return (
    <input autoFocus defaultValue={initial} placeholder={placeholder} data-kanban-name
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); end(e.currentTarget.value) }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(initial) }
      }}
      onBlur={(e) => end(e.currentTarget.value)}
      className="h-8 w-full rounded-[7px] bg-card px-2 text-[13px] font-semibold text-foreground ring-2 ring-primary outline-none pointer-coarse:h-11 pointer-coarse:text-[17px]" />
  )
}
