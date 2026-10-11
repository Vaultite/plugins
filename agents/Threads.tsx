// The sidebar: threads grouped by project, newest first, each marked working or waiting for you; a hover shows its
// last answer and what it changed. A click opens it in a tab (view:agents/<id>); a project's + starts one there.
import { useEffect, useRef, useState, type MouseEvent } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Folder, Plus, SquareArrowOutUpRight } from "lucide-react"
import { cn, fmtAgo, isViewOpen, menuBelow, menuFor, openView, SidebarRow, useEnabled, useLive, useScopedState, useTick, type SidebarCtx } from "@vaultite"
import { chooseProject, threadMenu, tildeOf } from "./Chat"
import { AgentsIcon, HARNESSES, ICON, MODES, NAME, STATUS, TINT } from "./harness"
import { useList, useSocket } from "./live"
import type { Harness, Project, Summary } from "./types"

const PER_PROJECT = 6
const HOVER_MS = 350
const plain = (s: string) => s.replace(/[*_`#>]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

/** Open a new thread's tab, its agent and folder picked already when given. */
export function newThread(set: { harness?: Harness; cwd?: string } = {}, setHarness?: (h: string) => void, setCwd?: (c: string | undefined) => void) {
  if (set.harness) setHarness?.(set.harness)
  if (set.cwd !== undefined) setCwd?.(set.cwd || undefined)
  openView("agents/", { newTab: true })
}

function StatusMark({ s }: { s: Summary }) {
  if (s.waiting) return <span className="shrink-0 rounded-[4px] bg-[color-mix(in_srgb,var(--yellow)_22%,transparent)] px-1 text-[11px] font-medium text-foreground max-md:text-[13px]" data-thread-state="waiting">Needs you</span>
  if (s.running) return <span className="size-1.5 shrink-0 animate-pulse rounded-full" style={{ background: TINT[s.harness] ?? "var(--foreground)" }} data-thread-state="working" aria-label="Working" />
  return <span className="shrink-0 text-[11px] text-tertiary tabular-nums max-md:text-[13px]">{fmtAgo(s.updated).replace(" ago", "")}</span>
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
        {NAME[s.harness]}{s.model ? ` · ${s.model}` : ""}{mode ? ` · ${mode.label(s.harness)}` : ""}
      </div>
      <div className="mb-2 flex min-w-0 items-center gap-1 text-muted-foreground"><Folder className="size-3 shrink-0" /><span className="truncate">{tildeOf(s.cwd)}</span></div>
      <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
        {(s.waiting || s.running) && <span className={cn("size-1.5 shrink-0 rounded-full", s.waiting ? "bg-[var(--yellow)]" : "animate-pulse")}
          style={s.running && !s.waiting ? { background: TINT[s.harness] ?? "var(--foreground)" } : undefined} />}
        <span>{s.waiting ? "Waiting for your answer" : s.running ? `${STATUS[s.status] ?? "Working"}…` : `Updated ${fmtAgo(s.updated)}`}</span>
      </div>
      {s.asked && <p className="mb-1.5 line-clamp-2 text-muted-foreground"><span className="font-medium text-foreground">You: </span>{s.asked}</p>}
      {s.last && <p className="mb-2 line-clamp-5 whitespace-pre-line">{plain(s.last)}</p>}
      {s.changes.files.length > 0 && (
        <div className="border-t-[0.5px] border-border pt-2">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <span>{s.changes.files.length === 1 ? "1 file changed" : `${s.changes.files.length} files changed`}</span>
            <span className="font-mono text-[11px]"><span className="text-[var(--green)]">+{s.changes.added}</span> <span className="text-[var(--red)]">−{s.changes.removed}</span></span>
          </div>
          {s.changes.files.slice(0, 5).map((f) => (
            <div key={f.path} className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{f.path.split("/").slice(-2).join("/")}</span>
              <span className="shrink-0 font-mono text-[11px]"><span className="text-[var(--green)]">+{f.added}</span> <span className="text-[var(--red)]">−{f.removed}</span></span>
            </div>
          ))}
          {s.changes.files.length > 5 && <div className="text-tertiary">and {s.changes.files.length - 5} more</div>}
        </div>
      )}
    </div>,
    document.body,
  )
}

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

function Row({ s, active, open, hover }: { s: Summary; active: boolean; open: boolean; hover: ReturnType<typeof useHover> }) {
  const on = useEnabled()
  const to = `agents/${s.id}`
  const go = (e: MouseEvent) => { hover.leave(); openView(to, { newTab: !isViewOpen(to) || e.metaKey || e.ctrlKey || e.button === 1 }) }
  const menu = () => threadMenu(s.id, s.title, s.harness, true, on, { extra: [{ label: "Open in new tab", icon: SquareArrowOutUpRight, run: () => openView(to, { newTab: true }) }] })
  const I = ICON[s.harness]
  if (!open) return (
    <SidebarRow icon={I} tint={TINT[s.harness]} badge={s.waiting} iconClassName={s.running && !s.waiting ? "animate-pulse" : undefined}
      label={s.title} open={false} active={active} tip={`${s.title} (${NAME[s.harness]}, ${s.project})`} onClick={go} />
  )
  return (
    <div role="button" tabIndex={0} data-thread-row={s.id} data-harness={s.harness} data-state={s.waiting ? "waiting" : s.running ? "working" : "idle"}
      onClick={go} onAuxClick={(e) => { if (e.button === 1) go(e) }} onKeyDown={(e) => { if (e.key === "Enter") openView(to, { newTab: !isViewOpen(to) }) }}
      onMouseEnter={hover.enter(s.id)} onMouseLeave={hover.leave} onContextMenu={(e) => { hover.leave(); menuFor(menu)(e) }}
      className={cn("group/row flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-[5px] pr-1.5 pl-1.5 text-[13px] max-md:h-11 max-md:text-[17px]",
        active ? "bg-foreground/[0.08] font-medium" : "hover:bg-foreground/[0.04]")}>
      <I className={cn("size-3.5 shrink-0 max-md:size-5", !TINT[s.harness] && "text-muted-foreground")} style={{ color: TINT[s.harness] }} />
      <span className="min-w-0 flex-1 truncate">{s.title}</span>
      {s.changes.files.length > 0 && !s.running && !s.waiting && (
        <span className="hidden shrink-0 font-mono text-[11px] group-hover/row:inline max-md:text-[13px]"><span className="text-[var(--green)]">+{s.changes.added}</span> <span className="text-[var(--red)]">−{s.changes.removed}</span></span>
      )}
      <StatusMark s={s} />
    </div>
  )
}

function Group({ name, path, threads, tab, open, hover, onNew }: { name: string; path: string; threads: Summary[]; tab: string; open: boolean; hover: ReturnType<typeof useHover>; onNew: () => void }) {
  const [all, setAll] = useState(false)
  // (one that works or waits always shows, however far down)
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
      {shown.map((s) => <Row key={s.id} s={s} active={tab === `view:agents/${s.id}`} open={open} hover={hover} />)}
      {shown.length < threads.length && (
        <button type="button" onClick={() => setAll(true)} className="flex h-6 cursor-pointer items-center gap-1 pl-1.5 text-left text-[12px] text-tertiary hover:text-foreground max-md:h-9 max-md:text-[15px]">
          <ChevronDown className="size-3" />{threads.length - shown.length} more
        </button>
      )}
    </div>
  )
}

/** Threads by project: the projects in order of their newest thread. */
function grouped(list: Summary[]) {
  const groups = new Map<string, { name: string; path: string; threads: Summary[] }>()
  for (const s of list) {
    const g = groups.get(s.cwd) ?? { name: s.project, path: s.cwd, threads: [] }
    g.threads.push(s)
    groups.set(s.cwd, g)
  }
  return [...groups.values()]
}

export function ThreadsPanel({ open, tab }: SidebarCtx) {
  useSocket()
  useTick(30_000)
  const list = useList()
  const hover = useHover()
  const [, setHarness] = useScopedState<string>("agents:harness", "", "workspace")
  const [, setCwd] = useScopedState<string>("agents:cwd", "", "workspace")
  const { data: projects } = useLive<{ list: Project[] }>("agents/projects")
  const start = (set: { harness?: Harness; cwd?: string }) => newThread(set, setHarness, setCwd)
  const card = hover.hover ? list?.find((s) => s.id === hover.hover!.id) : null
  if (!open) return <div className="flex flex-col gap-px">{list?.filter((s) => s.running || s.waiting).map((s) => <Row key={s.id} s={s} active={tab === `view:agents/${s.id}`} open={false} hover={hover} />)}</div>
  const newMenu = (e: MouseEvent) => menuBelow(e, [
    ...HARNESSES.map((h) => ({ label: `New ${NAME[h]} thread`, icon: ICON[h], run: () => start({ harness: h }) })),
    { label: "New thread in a project…", icon: Folder, run: () => chooseProject(projects?.list ?? [], "", (cwd) => start({ cwd })) },
  ])
  const groups = grouped(list ?? [])
  return (
    <div className="flex shrink-0 flex-col" data-agents-panel>
      <div className="group/heading flex h-7 items-center gap-1 pr-1 pl-1.5 max-md:h-10">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted-foreground max-md:text-[15px]">Agents</span>
        <button type="button" aria-label="New thread" data-tip="New thread" data-agents-new onClick={() => start({})} onContextMenu={(e) => { e.preventDefault(); newMenu(e) }}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground max-md:size-9">
          <Plus className="size-3.5 max-md:size-5" />
        </button>
        <button type="button" aria-label="New thread in…" data-tip="New thread in…" onClick={newMenu}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground max-md:size-9">
          <ChevronDown className="size-3.5 max-md:size-5" />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {groups.map((g) => <Group key={g.path} name={g.name} path={tildeOf(g.path)} threads={g.threads} tab={tab} open hover={hover}
          onNew={() => start({ cwd: g.path })} />)}
        {list && !list.length && (
          <button type="button" onClick={() => start({})} className="flex h-7 cursor-pointer items-center gap-2 rounded-[5px] pl-1.5 text-left text-[13px] text-tertiary hover:bg-foreground/[0.04] hover:text-foreground max-md:h-11 max-md:text-[17px]">
            <AgentsIcon className="size-3.5" />Start a thread with Claude Code or Codex
          </button>
        )}
      </div>
      {card && <HoverCard s={card} at={hover.hover!.at} />}
    </div>
  )
}
