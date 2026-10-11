// The sidebar as T3 Code's: pinned and active threads as cards, the Snoozed and Settled shelves below, a project filter
// and a search; grouped by project is the setting for its legacy sidebar. ⌃1-9 open the first nine.
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import {
  AlarmClock, AlarmClockOff, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleDashed, Folder, FolderGit2, GitPullRequest, ListFilter,
  MessageCircleQuestion, Pin, PinOff, Plus, Search, ShieldQuestion, SquarePen, Undo2, X,
} from "lucide-react"
import { choose, cn, isMac, isViewOpen, menuBelow, menuFor, openView, patch, SidebarRow, useEnabled, useLive, usePluginSettings, useScopedState, useTick, type SidebarCtx } from "@vaultite"
import { ago, setState, settle, snoozePresets, threadActions, wakeLabel, whenSettled } from "./actions"
import { lastThread } from "./panel"
import { chooseProject, checkoutPr, useHasDraft } from "./Chat"
import { AgentsIcon, HARNESSES, ICON, MODES, NAME, STATUS, TINT } from "./harness"
import { useList, useSocket } from "./live"
import type { Harness, Project, Summary } from "./types"
import { took, tildeOf, useNow } from "./ui"

const PER_PROJECT = 6
const HOVER_MS = 350
const plain = (s: string) => s.replace(/[*_`#>]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

/** Open a new thread's tab, its agent and folder picked already when given. */
export function newThread(set: { harness?: Harness; cwd?: string } = {}, setHarness?: (h: string) => void, setCwd?: (c: string | undefined) => void) {
  if (set.harness) setHarness?.(set.harness)
  if (set.cwd !== undefined) setCwd?.(set.cwd || undefined)
  openView("agents/", { newTab: true })
}

// ---------- the order rows are in (⌃1-9), and whether ⌃ is held (their hints show)

let order: string[] = []
let held = false
const heldSubs = new Set<() => void>()
export const setJumpHeld = (on: boolean) => { if (held !== on) { held = on; heldSubs.forEach((f) => f()) } }
function useHeld() {
  const [, tick] = useState(0)
  useEffect(() => { const f = () => tick((n) => n + 1); heldSubs.add(f); return () => { heldSubs.delete(f) } }, [])
  return held
}
/** The nth thread as the sidebar shows them (1-9). */
export function jumpTo(n: number) {
  const id = order[n - 1]
  if (id) openView(`agents/${id}`, { newTab: !isViewOpen(`agents/${id}`) })
}
/** The thread before or after `from` in the sidebar (⌘⇧[ and ⌘⇧]). */
export function step(from: string, by: 1 | -1) {
  const i = order.indexOf(from)
  const id = order[i < 0 ? 0 : (i + by + order.length) % order.length]
  if (id) openView(`agents/${id}`, { newTab: !isViewOpen(`agents/${id}`) })
}

/** Settling the thread in use moves its tab to the next one still active (T3 Code's), or to a new thread. */
let live: string[] = []
whenSettled((id) => {
  if (lastThread !== id) return
  const i = live.indexOf(id)
  const next = [...live.slice(i + 1), ...live.slice(0, Math.max(0, i))].find((x) => x !== id)
  openView(next ? `agents/${next}` : "agents/")
})

// ---------- a thread's status, by T3 Code's rules

type Status = { label: string; icon: typeof CircleDashed | null; color: string; kind: string }
function statusOf(s: Summary): Status | null {
  if (s.waiting && s.input) return { label: "Input", icon: MessageCircleQuestion, color: "text-[var(--indigo)]", kind: "input" }
  if (s.waiting) return { label: "Approval", icon: ShieldQuestion, color: "text-[var(--orange)]", kind: "approval" }
  if (s.running) return { label: "Working", icon: CircleDashed, color: "text-[var(--blue)]", kind: "working" }
  if (s.failed) return { label: "Failed", icon: CircleAlert, color: "text-[var(--red)]", kind: "failed" }
  if (s.woke) return { label: "Woke", icon: AlarmClock, color: "text-[var(--orange)]", kind: "woke" }
  if (s.unread) return { label: "Done", icon: CircleCheck, color: "text-[var(--green)]", kind: "done" }
  return null
}

function Working({ since }: { since?: string }) {
  const now = useNow(!!since, 1000)
  return since ? <span className="tabular-nums">{took(now - Date.parse(since)).replace(/\.\ds$/, "s")}</span> : null
}

function StatusMark({ s }: { s: Summary }) {
  const st = statusOf(s)
  if (!st) return <span className="text-[11px] text-tertiary tabular-nums max-md:text-[13px]" data-thread-time>{ago(s.askedAt)}</span>
  const I = st.icon
  const wake = (e: MouseEvent) => { e.stopPropagation(); void setState(s.id, { snoozedUntil: null }) }
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium max-md:text-[13px]", st.color)} data-thread-state={st.kind}
      {...(st.kind === "woke" ? { role: "button", onClick: wake, "data-tip": "Dismiss Woke notification" } : {})}>
      {I && <I className={cn("size-3.5 shrink-0", st.kind === "working" && "animate-spin [animation-duration:3s]")} />}
      <span>{st.label}</span>
      {st.kind === "working" && <Working since={s.since} />}
    </span>
  )
}

/** What a hover shows: the agent, the folder, what's going on, the last thing asked and answered, and the changes. */
function HoverCard({ s, at }: { s: Summary; at: DOMRect }) {
  const width = 340
  const right = at.right + 8 + width < window.innerWidth
  const left = right ? at.right + 8 : Math.max(8, at.left - 8 - width)
  const top = Math.max(8, Math.min(at.top - 6, window.innerHeight - 320))
  const I = ICON[s.harness]
  const mode = MODES.find((m) => m.id === s.mode)
  return createPortal(
    <div role="tooltip" data-thread-card={s.id} style={{ left, top, width }}
      className="glass-strong pointer-events-none fixed z-[61] rounded-[10px] p-3 text-[12px] leading-[17px] text-popover-foreground">
      <div className="mb-1 flex min-w-0 items-center gap-1.5">
        <I className="size-3.5 shrink-0" style={{ color: TINT[s.harness] }} />
        <span className="min-w-0 truncate text-[13px] font-semibold">{s.title}</span>
      </div>
      <div className="mb-2 truncate text-muted-foreground">
        {NAME[s.harness]}{s.model ? ` · ${s.model}` : ""}{s.plan ? " · Plan" : mode ? ` · ${mode.label}` : ""}
      </div>
      <div className="mb-2 flex min-w-0 items-center gap-1 text-muted-foreground"><Folder className="size-3 shrink-0" /><span className="truncate">{tildeOf(s.home)}</span></div>
      {s.branch && <div className="-mt-1.5 mb-2 flex min-w-0 items-center gap-1 text-muted-foreground"><FolderGit2 className="size-3 shrink-0" /><span className="truncate font-mono">{s.branch}</span></div>}
      <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
        <span>{s.waiting ? "Waiting for your answer" : s.running ? `${STATUS[s.status] ?? "Working"}…` : s.settledAt ? `Settled ${ago(s.settledAt)} ago` : s.snoozedUntil ? `Snoozed until ${wakeLabel(s.snoozedUntil)}` : `Last message ${ago(s.askedAt)} ago`}</span>
      </div>
      {s.asked && <p className="mb-1.5 line-clamp-2 text-muted-foreground"><span className="font-medium text-foreground">You: </span>{s.asked}</p>}
      {s.last && <p className="mb-2 line-clamp-5 whitespace-pre-line">{plain(s.last)}</p>}
      {s.changes.files.length > 0 && (
        <div className="border-t-[0.5px] border-border pt-2">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <span>{s.changes.files.length === 1 ? "1 file changed" : `${s.changes.files.length} files changed`}</span>
            <Counts a={s.changes.added} r={s.changes.removed} />
          </div>
          {s.changes.files.slice(0, 5).map((f) => (
            <div key={f.path} className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{f.path.split("/").slice(-2).join("/")}</span>
              <Counts a={f.added} r={f.removed} />
            </div>
          ))}
          {s.changes.files.length > 5 && <div className="text-tertiary">and {s.changes.files.length - 5} more</div>}
        </div>
      )}
    </div>,
    document.body,
  )
}
const Counts = ({ a, r }: { a: number; r: number }) => <span className="shrink-0 font-mono text-[11px]"><span className="text-[var(--green)]">+{a}</span> <span className="text-[var(--red)]">−{r}</span></span>

/** Hovering a row a moment shows its card (not on touch screens, where a press opens it). */
function useHover() {
  const [hover, setHover] = useState<{ id: string; at: DOMRect } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const enter = (id: string) => (e: MouseEvent<HTMLElement>) => {
    if (matchMedia("(pointer: coarse)").matches) return
    const el = e.currentTarget
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setHover({ id, at: el.getBoundingClientRect() }), hover ? 60 : HOVER_MS)
  }
  const leave = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setHover(null) }
  return { hover, enter, leave }
}
type Hover = ReturnType<typeof useHover>

// ---------- a row

type RowProps = { s: Summary; active: boolean; hover: Hover; jump?: number; renaming: boolean; setRenaming: (id: string) => void; menu: (s: Summary) => ReturnType<typeof threadActions>
  onDrag: (s: Summary | null) => void }
/** A row dragged to another section (T3 Code's): its id, for the drop. */
const dragged = (p: RowProps) => ({ draggable: !p.renaming, onDragStart: (e: React.DragEvent) => { p.hover.leave(); e.dataTransfer.setData("text/plain", p.s.title); e.dataTransfer.effectAllowed = "move"; p.onDrag(p.s) },
  onDragEnd: () => p.onDrag(null) })

function useRow({ s, hover }: RowProps) {
  const to = `agents/${s.id}`
  const go = (e: MouseEvent) => { if ((e.target as HTMLElement).closest("button, input")) return; hover.leave(); openView(to, { newTab: !isViewOpen(to) || e.metaKey || e.ctrlKey || e.button === 1 }) }
  return { to, go }
}

function Rename({ s, done }: { s: Summary; done: () => void }) {
  const commit = (v: string) => { done(); if (v.trim() && v.trim() !== s.title) void patch(`agents/threads/${s.id}`, { title: v.trim() }).catch(() => {}) }
  return (
    <input autoFocus defaultValue={s.title} aria-label="Thread title" data-thread-rename onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commit(e.currentTarget.value); if (e.key === "Escape") done() }}
      onBlur={(e) => commit(e.currentTarget.value)}
      className="h-5 min-w-0 flex-1 rounded-[4px] border-[0.5px] border-primary bg-background px-1 text-[13px] font-medium outline-none" />
  )
}

const Jump = ({ n }: { n?: number }) => (n ? <span className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 rounded-[4px] bg-foreground px-1 font-mono text-[10px] leading-[16px] text-background" data-jump-hint={n}>{isMac ? "⌃" : "Alt+"}{n}</span> : null)

/** A pinned or active thread: its project, title and branch, a card as T3 Code's. */
function CardRow(p: RowProps) {
  const { s, active, hover } = p
  const { to, go } = useRow(p)
  const I = ICON[s.harness]
  const held = useHeld()
  const snooze = (e: MouseEvent) => menuBelow(e, snoozePresets().map((x) => ({ label: x.label, hint: x.hint, run: () => void setState(s.id, { snoozedUntil: x.when.toISOString() }) })))
  const draft = useHasDraft(s.id)
  return (
    <div role="button" tabIndex={0} data-thread-row={s.id} data-section={s.pinnedAt ? "pinned" : "active"} data-harness={s.harness} data-state={statusOf(s)?.kind ?? "idle"} {...dragged(p)}
      onClick={go} onAuxClick={(e) => { if (e.button === 1) go(e) }} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openView(to, { newTab: !isViewOpen(to) }) }}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) p.setRenaming(s.id) }}
      onMouseEnter={hover.enter(s.id)} onMouseLeave={hover.leave} onContextMenu={(e) => { hover.leave(); menuFor(() => p.menu(s))(e) }}
      className={cn("group/row relative flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-[7px] px-2 py-1.5 max-md:py-2",
        active ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.04]", statusOf(s) === null && !active && "text-muted-foreground")}>
      <div className="flex h-4 min-w-0 items-center gap-1.5 max-md:h-5">
        {draft && <SquarePen className="size-3 shrink-0 text-[var(--blue)]" aria-label="Unsent draft" data-tip="Unsent draft" />}
        <I className={cn("size-3.5 shrink-0 max-md:size-4", !TINT[s.harness] && "text-muted-foreground")} style={{ color: TINT[s.harness] }} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-tertiary max-md:text-[13px]">{s.project}</span>
        {s.pinnedAt && (
          <button type="button" aria-label="Unpin thread" data-tip="Unpin thread" onClick={(e) => { e.stopPropagation(); void setState(s.id, { pinned: false }) }} className="group/pin grid cursor-pointer text-tertiary hover:text-foreground">
            <Pin className="size-3 group-hover/pin:hidden" /><PinOff className="hidden size-3 group-hover/pin:block" />
          </button>
        )}
        <span className="relative flex h-4 shrink-0 items-center justify-end max-md:h-5">
          <span className={cn("flex items-center", s.woke ? "" : "group-hover/row:invisible max-md:group-hover/row:visible")}><StatusMark s={s} /></span>
          <span className="absolute inset-y-0 right-0 hidden items-center gap-0.5 group-hover/row:flex max-md:hidden">
            {!s.running && !s.waiting && (
              <button type="button" aria-label="Snooze" data-tip="Snooze" data-snooze onClick={(e) => { e.stopPropagation(); snooze(e) }}
                className="grid h-5 cursor-pointer place-items-center rounded-[4px] px-1 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"><AlarmClock className="size-3.5" /></button>
            )}
            <button type="button" aria-label="Settle thread" data-tip="Settle thread" data-settle onClick={(e) => { e.stopPropagation(); void settle(s.id, true) }}
              className="inline-flex h-5 cursor-pointer items-center gap-0.5 rounded-[4px] px-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"><Check className="size-3.5" />Settle</button>
          </span>
        </span>
      </div>
      <div className="flex min-w-0 items-center">
        {p.renaming ? <Rename s={s} done={() => p.setRenaming("")} />
          : <span className={cn("min-w-0 flex-1 truncate text-[13px] max-md:text-[16px]", statusOf(s) || active ? "font-medium text-foreground" : "text-foreground/80")} data-thread-title>{s.title}</span>}
      </div>
      {(s.branch || s.pr || s.changes.files.length > 0 || s.queued) && (
        <div className="flex h-4 min-w-0 items-center gap-1.5 text-[11px] text-tertiary max-md:h-5 max-md:text-[13px]">
          {s.branch ? <><FolderGit2 className="size-3 shrink-0" /><span className="min-w-0 flex-1 truncate font-mono">{s.branch}</span></> : <span className="flex-1" />}
          {s.queued ? <span data-tip="Queued messages">{s.queued} queued</span> : null}
          {s.pr && <span className="inline-flex shrink-0 items-center gap-0.5" data-tip={`Pull request #${s.pr.number}: ${s.pr.state.toLowerCase()}`}><GitPullRequest className={cn("size-3", s.pr.state === "MERGED" ? "text-[var(--purple)]" : s.pr.state === "OPEN" ? "text-[var(--green)]" : "")} />#{s.pr.number}</span>}
          {s.changes.files.length > 0 && <Counts a={s.changes.added} r={s.changes.removed} />}
        </div>
      )}
      {held && <Jump n={p.jump} />}
    </div>
  )
}

/** A snoozed or settled thread, a line: its title and when it settled or comes back; a hover undoes it. */
function SlimRow(p: RowProps & { shelf: "snoozed" | "settled" | "grouped" }) {
  const { s, active, hover, shelf } = p
  const { to, go } = useRow(p)
  const I = ICON[s.harness]
  const held = useHeld()
  return (
    <div role="button" tabIndex={0} data-thread-row={s.id} data-section={shelf} data-harness={s.harness} data-state={statusOf(s)?.kind ?? "idle"} {...dragged(p)}
      onClick={go} onAuxClick={(e) => { if (e.button === 1) go(e) }} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openView(to, { newTab: !isViewOpen(to) }) }}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) p.setRenaming(s.id) }}
      onMouseEnter={hover.enter(s.id)} onMouseLeave={hover.leave} onContextMenu={(e) => { hover.leave(); menuFor(() => p.menu(s))(e) }}
      className={cn("group/row relative flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-[5px] px-1.5 text-[13px] max-md:h-11 max-md:text-[16px]",
        active ? "bg-foreground/[0.08] font-medium" : "hover:bg-foreground/[0.04]", shelf !== "grouped" && !active && "text-muted-foreground")}>
      <I className={cn("size-3.5 shrink-0 max-md:size-5", shelf !== "grouped" && "opacity-50 grayscale group-hover/row:opacity-100 group-hover/row:grayscale-0", !TINT[s.harness] && "text-muted-foreground")} style={{ color: TINT[s.harness] }} />
      {p.renaming ? <Rename s={s} done={() => p.setRenaming("")} /> : <span className="min-w-0 flex-1 truncate">{s.title}</span>}
      {s.pinnedAt && <Pin className="size-3 shrink-0 text-tertiary" aria-label="Pinned" />}
      {s.pr && <span className="shrink-0 text-[11px] text-tertiary">#{s.pr.number}</span>}
      {shelf === "grouped" ? <StatusMark s={s} /> : (
        <span className="relative flex h-5 shrink-0 items-center">
          <span className="text-[11px] text-tertiary tabular-nums group-hover/row:invisible max-md:text-[13px]" data-thread-time>
            {shelf === "snoozed" && s.snoozedUntil ? <span className="text-[var(--blue)]">{wakeLabel(s.snoozedUntil)}</span> : ago(s.settledAt ?? s.askedAt)}
          </span>
          <button type="button" aria-label={shelf === "snoozed" ? "Wake thread now" : "Un-settle thread"} data-tip={shelf === "snoozed" ? "Wake thread now" : "Un-settle thread"} data-unsettle={shelf === "settled" || undefined}
            onClick={(e) => { e.stopPropagation(); void (shelf === "snoozed" ? setState(s.id, { snoozedUntil: null }) : settle(s.id, false)) }}
            className="absolute inset-y-0 right-0 hidden cursor-pointer place-items-center rounded-[4px] px-1 text-muted-foreground group-hover/row:grid hover:bg-foreground/[0.08] hover:text-foreground">
            {shelf === "snoozed" ? <AlarmClockOff className="size-3.5" /> : <Undo2 className="size-3.5" />}
          </button>
        </span>
      )}
      {held && <Jump n={p.jump} />}
    </div>
  )
}

/** Where a dragged row can land: the drop does what the section is (pin, settle, back to active). */
function Drop({ on, label, onDrop, children }: { on: boolean; label?: string; onDrop: () => void; children?: ReactNode }) {
  const [over, setOver] = useState(false)
  // (always the same element: a row dragged from inside stays mounted, or the browser drops the drag)
  return (
    <div className={cn(on && "rounded-[7px] outline-dashed outline-1 -outline-offset-1", on && (over ? "bg-primary/10 outline-primary" : "outline-border"))} data-drop={on ? label : undefined}
      onDragOver={(e) => { if (!on) return; e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={(e) => { if (!on) return; e.preventDefault(); setOver(false); onDrop() }}>
      {children}
      {on && !children && <div className="grid h-8 place-items-center text-[11px] text-tertiary">{label}</div>}
    </div>
  )
}

function Shelf({ name, count, open, toggle, children }: { name: string; count: number; open: boolean; toggle: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-px" data-shelf={name.toLowerCase()}>
      <button type="button" onClick={toggle} aria-expanded={open} data-shelf-toggle={name.toLowerCase()}
        className="flex h-6 cursor-pointer items-center gap-1 px-1.5 text-left text-[11px] font-medium text-tertiary hover:text-foreground max-md:h-9 max-md:text-[13px]">
        <span>{open ? name : `${name} (${count})`}</span>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>
      {children}
    </div>
  )
}

/** The legacy view: threads under each project, the projects in order of their newest thread. */
function Group({ name, path, threads, onNew, row }: { name: string; path: string; threads: Summary[]; onNew: () => void; row: (s: Summary) => ReactNode }) {
  const [all, setAll] = useState(false)
  const shown = all ? threads : threads.filter((s, i) => i < PER_PROJECT || s.running || s.waiting)
  return (
    <div className="flex flex-col gap-px" data-thread-group={name}>
      <div className="group/head flex h-6 items-end pr-1 pl-1.5 text-[11px] font-medium text-tertiary max-md:h-8 max-md:text-[13px]" data-tip={path}>
        <span className="min-w-0 flex-1 truncate pb-0.5">{name}</span>
        <button type="button" aria-label={`New thread in ${name}`} data-tip={`New thread in ${name}`} onClick={onNew}
          className="mb-px hidden size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-muted-foreground group-hover/head:grid hover:bg-foreground/[0.08] hover:text-foreground max-md:grid max-md:size-8">
          <Plus className="size-3.5" />
        </button>
      </div>
      {shown.map(row)}
      {shown.length < threads.length && (
        <button type="button" onClick={() => setAll(true)} className="flex h-6 cursor-pointer items-center gap-1 pl-1.5 text-left text-[12px] text-tertiary hover:text-foreground max-md:h-9 max-md:text-[15px]">
          <ChevronDown className="size-3" />{threads.length - shown.length} more
        </button>
      )}
    </div>
  )
}

const newest = (a: Summary, b: Summary) => b.askedAt.localeCompare(a.askedAt)

export function ThreadsPanel({ open, tab, inView }: SidebarCtx & { inView?: boolean }) {
  useSocket()
  useTick(30_000)
  const list = useList()
  const hover = useHover()
  const on = useEnabled()
  const [settings] = usePluginSettings("agents")
  const [, setHarness] = useScopedState<string>("agents:harness", "", "workspace")
  const [, setCwd] = useScopedState<string>("agents:cwd", "", "workspace")
  const [filter, setFilter] = useScopedState<string>("agents:filter", "", "workspace")
  const [settledOpen, setSettledOpen] = useScopedState<boolean>("agents:settled-open", false, "workspace")
  const [snoozedOpen, setSnoozedOpen] = useScopedState<boolean>("agents:snoozed-open", false, "workspace")
  const [archived, setArchived] = useState(false)
  const [query, setQuery] = useState("")
  const [renaming, setRenaming] = useState("")
  const [drag, setDrag] = useState<Summary | null>(null)
  const { data: projects } = useLive<{ list: Project[] }>("agents/projects")
  const start = (set: { harness?: Harness; cwd?: string }) => newThread(set, setHarness, setCwd)
  const isOpen = (s: Summary) => tab === `view:agents/${s.id}`
  const grouped = settings?.groupByProject === true

  const all = useMemo(() => list ?? [], [list])
  const projectOf = (home: string) => (projects?.list ?? []).find((p) => p.path === home)
  const filtered = all.filter((s) => (!filter || s.home === filter) && (archived ? s.archived : !s.archived))
  const q = query.trim().toLowerCase()
  const found = q ? filtered.filter((s) => [s.title, s.asked, s.last, s.project, s.branch ?? ""].some((x) => x.toLowerCase().includes(q))) : filtered
  const pinned = found.filter((s) => s.pinnedAt && !s.settledAt && !s.snoozedUntil).sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))
  const active = found.filter((s) => !s.pinnedAt && !s.settledAt && !s.snoozedUntil).sort(newest)
  const snoozedList = found.filter((s) => s.snoozedUntil && !s.settledAt).sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!))
  const settledList = found.filter((s) => s.settledAt).sort((a, b) => b.settledAt!.localeCompare(a.settledAt!))
  // (a closed shelf still shows the thread that's open)
  const shownSnoozed = snoozedOpen || q ? snoozedList : snoozedList.filter(isOpen)
  const shownSettled = settledOpen || q ? settledList : settledList.filter(isOpen)
  order = grouped ? found.map((s) => s.id) : [...pinned, ...active, ...shownSnoozed, ...shownSettled].map((s) => s.id)
  live = [...pinned, ...active].map((s) => s.id)
  const jump = (s: Summary) => { const n = order.indexOf(s.id) + 1; return n > 0 && n <= 9 ? n : undefined }

  const filterItem = (s: Summary) => ({ label: s.project, active: filter === s.home, toggle: () => setFilter(filter === s.home ? undefined : s.home) })
  const menu = (s: Summary) => threadActions(s, { on, started: true, rename: () => setRenaming(s.id), filter: filterItem(s),
    newOnBranch: s.branch ? () => start({ cwd: s.cwd, harness: s.harness }) : undefined,
    extra: [{ label: "Open in new tab", icon: Plus, run: () => openView(`agents/${s.id}`, { newTab: true }) }] })
  const rowProps = (s: Summary) => ({ s, active: isOpen(s), hover, jump: jump(s), renaming: renaming === s.id, setRenaming, menu, onDrag: setDrag })
  // (dropped on a section: pinned, settled, or back with the active ones)
  const dropTo = (where: "pinned" | "active" | "settled") => {
    const s = drag
    setDrag(null)
    if (!s) return
    if (where === "pinned" && !s.pinnedAt) void setState(s.id, { pinned: true })
    if (where === "settled" && !s.settledAt) void settle(s.id, true)
    if (where === "active") {
      if (s.pinnedAt) void setState(s.id, { pinned: false })
      if (s.settledAt) void settle(s.id, false)
      if (s.snoozedUntil) void setState(s.id, { snoozedUntil: null })
    }
  }
  const card = hover.hover ? all.find((s) => s.id === hover.hover!.id) : null

  if (!open) return <div className="flex flex-col gap-px">{all.filter((s) => (s.running || s.waiting) && !s.archived).map((s) => (
    <SidebarRow key={s.id} icon={ICON[s.harness]} tint={TINT[s.harness]} badge={s.waiting} iconClassName={s.running && !s.waiting ? "animate-pulse" : undefined}
      label={s.title} open={false} active={isOpen(s)} tip={`${s.title} (${NAME[s.harness]}, ${s.project})`} onClick={() => openView(`agents/${s.id}`, { newTab: !isViewOpen(`agents/${s.id}`) })} />
  ))}</div>

  const scoped = filter ? projectOf(filter)?.label ?? tildeOf(filter).split("/").pop() : ""
  const pickFilter = () => choose({
    title: "Filter threads by project", placeholder: "Search projects...", current: filter || "all", empty: "No matching projects.",
    items: [{ id: "all", label: "All projects", icon: Folder }, ...(projects?.list ?? []).filter((p) => all.some((s) => s.home === p.path)).map((p) => ({ id: p.path, label: p.label, detail: tildeOf(p.path), icon: Folder }))],
    onPick: (p) => setFilter(p.id === "all" ? undefined : p.id),
  })
  const newMenu = (e: MouseEvent) => menuBelow(e, [
    ...HARNESSES.map((h) => ({ label: `New ${NAME[h]} thread`, icon: ICON[h], run: () => start({ harness: h }) })),
    { label: "New thread in a project…", icon: Folder, run: () => chooseProject(projects?.list ?? [], "", (cwd) => start({ cwd })) },
    { label: "Check out a pull request…", icon: GitPullRequest, run: () => void checkoutPr(projects?.list ?? [], filter || "") },
    { label: archived ? "Back to threads" : "Show archived threads", sep: true, run: () => setArchived(!archived) },
  ])
  const empty = found.length === 0
  return (
    <div className="flex shrink-0 flex-col" data-agents-panel data-grouped={grouped || undefined}>
      <div className="group/heading flex h-7 items-center gap-0.5 pr-1 pl-1.5 max-md:h-10">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted-foreground max-md:text-[15px]">{archived ? "Archived threads" : inView ? "" : "Agents"}</span>
        <button type="button" aria-label={scoped ? `Filter threads by project: ${scoped}` : "Filter threads by project"} data-tip={scoped ? `Filter threads by project: ${scoped}` : "Filter threads by project"} data-agents-filter={filter || "all"} onClick={pickFilter}
          className={cn("grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] hover:bg-foreground/[0.08] hover:text-foreground max-md:size-9", filter ? "text-primary" : "text-muted-foreground")}>
          {filter ? <Folder className="size-3.5 max-md:size-5" /> : <ListFilter className="size-3.5 max-md:size-5" />}
        </button>
        <button type="button" aria-label="New thread" data-tip="New thread" data-agents-new onClick={() => start(filter ? { cwd: filter } : {})} onContextMenu={(e) => { e.preventDefault(); newMenu(e) }}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground max-md:size-9">
          <Plus className="size-3.5 max-md:size-5" />
        </button>
        <button type="button" aria-label="New thread in…" data-tip="New thread in…" onClick={newMenu}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground max-md:size-9">
          <ChevronDown className="size-3.5 max-md:size-5" />
        </button>
      </div>
      {all.length > 0 && (
        <label className="mx-1 mb-1 flex h-7 items-center gap-1.5 rounded-[6px] bg-foreground/[0.04] px-2 text-[12px] text-muted-foreground focus-within:bg-foreground/[0.06] max-md:h-10 max-md:text-[16px]">
          <Search className="size-3.5 shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search threads" data-agents-search data-keeps-keys
            onKeyDown={(e) => { if (e.key === "Escape") setQuery("") }} className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-tertiary" />
          {query && <button type="button" aria-label="Clear thread search" onClick={() => setQuery("")} className="grid cursor-pointer place-items-center hover:text-foreground"><X className="size-3.5" /></button>}
        </label>
      )}
      {grouped ? (
        <div className="flex flex-col gap-1">
          {[...new Map(found.map((s) => [s.home, s])).values()].map((g) => (
            <Group key={g.home} name={g.project} path={tildeOf(g.home)} threads={found.filter((s) => s.home === g.home)} onNew={() => start({ cwd: g.home })}
              row={(s) => <SlimRow key={s.id} {...rowProps(s)} shelf="grouped" />} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Drop on={!!drag && !drag.pinnedAt} label="Pinned" onDrop={() => dropTo("pinned")}>
            {pinned.length > 0 && <div className="flex flex-col gap-px" data-section-list="pinned">{pinned.map((s) => <CardRow key={s.id} {...rowProps(s)} />)}</div>}
          </Drop>
          {pinned.length > 0 && active.length > 0 && <div className={cn("mx-2 my-0.5 border-t-[0.5px] border-border", drag && "invisible")} />}
          <Drop on={!!drag && !!(drag.pinnedAt || drag.settledAt || drag.snoozedUntil)} label="Active" onDrop={() => dropTo("active")}>
            {active.length > 0 && <div className="flex flex-col gap-px" data-section-list="active">{active.map((s) => <CardRow key={s.id} {...rowProps(s)} />)}</div>}
          </Drop>
          {snoozedList.length > 0 && <Shelf name="Snoozed" count={snoozedList.length} open={snoozedOpen || !!q} toggle={() => setSnoozedOpen(!snoozedOpen)}>{shownSnoozed.map((s) => <SlimRow key={s.id} {...rowProps(s)} shelf="snoozed" />)}</Shelf>}
          <Drop on={!!drag && !drag.settledAt} label="Settled" onDrop={() => dropTo("settled")}>
            {settledList.length > 0 && <Shelf name="Settled" count={settledList.length} open={settledOpen || !!q} toggle={() => setSettledOpen(!settledOpen)}>{shownSettled.map((s) => <SlimRow key={s.id} {...rowProps(s)} shelf="settled" />)}</Shelf>}
          </Drop>
        </div>
      )}
      {list && empty && (
        q ? <p className="px-1.5 py-1 text-[12px] text-tertiary max-md:text-[15px]" data-agents-empty>No threads found</p>
          : archived ? <p className="px-1.5 py-1 text-[12px] text-tertiary max-md:text-[15px]" data-agents-empty>No archived threads</p>
          : (
            <button type="button" onClick={() => start(filter ? { cwd: filter } : {})} data-agents-empty
              className="flex h-7 cursor-pointer items-center gap-2 rounded-[5px] pl-1.5 text-left text-[13px] text-tertiary hover:bg-foreground/[0.04] hover:text-foreground max-md:h-11 max-md:text-[17px]">
              <AgentsIcon className="size-3.5" />{scoped ? `No threads in ${scoped} yet` : "No threads yet"}
            </button>
          )
      )}
      {card && <HoverCard s={card} at={hover.hover!.at} />}
    </div>
  )
}
