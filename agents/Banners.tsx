// What sits on top of the box to write in, as T3 Code stacks it: the agent's questions (one at a time, options by
// number), a permission to approve, the plan that's ready, the task list, and the messages queued while it works.
import { useEffect, useState, type ReactNode } from "react"
import { Check, ChevronDown, ChevronUp, Circle, CircleDot, CornerUpRight, Ellipsis, FileText, GripVertical, ListOrdered, ListTodo, MessageCircleQuestion, Pencil, ShieldAlert, X } from "lucide-react"
import { cn, menuAbove, notifyError, post } from "@vaultite"
import { SHORT } from "./harness"
import type { Entry, Harness, Queued } from "./types"
import { describe, Diff, diffLines, EDITS, FileLink, noteName } from "./ui"

type Ask = Extract<Entry, { kind: "ask" }>
export type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect?: boolean; id?: string; other?: boolean }

// ---------- the parts every banner is made of

export function Banner({ children, tone, ...rest }: { children: ReactNode; tone?: "warn" } & Record<`data-${string}`, unknown>) {
  return <div className={cn("border-b-[0.5px] border-border/70", tone === "warn" && "bg-[color-mix(in_srgb,var(--yellow)_9%,transparent)]")} {...rest}>{children}</div>
}
export function Row({ icon, children, actions, onClick, expanded, ...rest }: { icon?: ReactNode; children: ReactNode; actions?: ReactNode; onClick?: () => void; expanded?: boolean } & Record<string, unknown>) {
  const Tag = onClick ? "button" : "div"
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} aria-expanded={expanded} {...rest}
      className={cn("flex min-h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-[12px] max-md:min-h-11 max-md:text-[15px]", onClick && "cursor-pointer hover:bg-foreground/[0.03]")}>
      {icon && <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&>svg]:size-3.5">{icon}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </Tag>
  )
}
const Toggle = ({ open }: { open: boolean }) => (open ? <ChevronDown className="size-3.5 text-tertiary" /> : <ChevronUp className="size-3.5 text-tertiary" />)
const small = "inline-flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-40 max-md:h-9 max-md:text-[14px]"

// ---------- a permission to approve

export function Approval({ asks, id, harness, cwd }: { asks: Ask[]; id: string; harness: Harness; cwd: string }) {
  const [busy, setBusy] = useState(false)
  const a = asks[0]
  const edit = EDITS.test(a.tool)
  const d = describe(a.tool, a.input, cwd, a.file, a.path)
  const answer = async (allow: boolean, scope?: "session" | "cancel") => {
    setBusy(true)
    try { await post(`agents/threads/${id}/answer`, { ask: a.id, allow, ...(scope ? { scope } : {}) }) } catch (e) { notifyError(e, "Couldn't answer") } finally { setBusy(false) }
  }
  const head = edit ? "File change approval" : a.tool === "Bash" ? "Command approval" : a.tool === "WebFetch" ? "Web page approval" : "Tool approval"
  return (
    <Banner tone="warn" data-ask="waiting" data-ask-tool={a.tool} data-approval>
      <div className="px-3 pt-2.5 pb-2">
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[13px] font-medium max-md:text-[16px]">
          <ShieldAlert className="size-4 shrink-0 text-[var(--orange)]" />
          <span className="shrink-0">{head}</span>
          {asks.length > 1 && <span className="shrink-0 text-[12px] font-normal text-muted-foreground tabular-nums">1/{asks.length}</span>}
          {edit && (a.file ? <FileLink file={a.file} className="text-[12px]">{noteName(a.file)}</FileLink> : <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">{d.what}</span>)}
          {!edit && a.tool !== "Bash" && <span className="min-w-0 truncate text-[12px] font-normal text-muted-foreground">{SHORT[harness]} wants to {d.verb.toLowerCase()} {d.what}</span>}
        </div>
        {edit ? <div className="mb-2 space-y-1">{a.text && <p className="text-[12px] text-muted-foreground max-md:text-[14px]">{a.text}</p>}<Diff lines={diffLines(a.tool, a.input, a.patch)} /></div>
          : a.tool === "Bash" ? (
            <div className="mb-2 space-y-1">
              {typeof a.input.description === "string" && <p className="text-[12px] text-muted-foreground max-md:text-[14px]">{a.input.description}</p>}
              <pre className="max-h-20 overflow-auto rounded-[8px] bg-background/70 px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{String(a.input.command ?? "")}</pre>
            </div>
          ) : <pre className="mb-2 max-h-20 overflow-auto rounded-[8px] bg-background/70 px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{a.input.url ? String(a.input.url) : JSON.stringify(a.input, null, 2)}</pre>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} aria-label="More approval options" data-answer-more
            onClick={(e) => menuAbove(e, [{ label: "Always allow this session", run: () => void answer(true, "session") }, { label: "Cancel", run: () => void answer(false, "cancel") }])}
            className="grid size-7 cursor-pointer place-items-center rounded-[6px] border-[0.5px] border-border bg-background text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50 max-md:size-11"><Ellipsis className="size-3.5" /></button>
          <button type="button" disabled={busy} onClick={() => void answer(false)} data-answer="deny"
            className="inline-flex h-7 cursor-pointer items-center rounded-[6px] border-[0.5px] border-border bg-background px-3 text-[13px] font-medium hover:bg-foreground/[0.06] disabled:opacity-50 max-md:h-11 max-md:px-4 max-md:text-[16px]">Decline</button>
          <button type="button" disabled={busy} onClick={() => void answer(true)} data-answer="allow"
            className="inline-flex h-7 cursor-pointer items-center rounded-[6px] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 max-md:h-11 max-md:px-4 max-md:text-[16px]">Approve</button>
        </div>
      </div>
    </Banner>
  )
}

// ---------- the agent's questions (Claude's AskUserQuestion, Codex's request for input)

export type Answering = { ask: Ask; index: number; picked: Record<string, string[]>; set: (q: string, labels: string[]) => void; go: (n: number) => void; open: boolean; toggle: () => void }

export const questionsOf = (a: Ask) => (Array.isArray(a.input.questions) ? a.input.questions : []) as Question[]

/** The state of answering one ask's questions: which one is shown, and what's picked for each. */
export function useAnswering(ask: Ask | undefined): Answering | null {
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [open, setOpen] = useState(true)
  useEffect(() => { setIndex(0); setPicked({}); setOpen(true) }, [ask?.id])
  if (!ask) return null
  return { ask, index, picked, set: (q, labels) => setPicked((p) => ({ ...p, [q]: labels })), go: setIndex, open, toggle: () => setOpen((o) => !o) }
}

export function Questions({ a, id, busy }: { a: Answering; id: string; busy: boolean }) {
  const qs = questionsOf(a.ask)
  const q = qs[a.index]
  // Keys 1-9 pick an option (outside the box to write in): one alone moves on, as T3 Code does.
  useEffect(() => {
    if (!q || !a.open) return
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) return
      const n = Number(e.key)
      if (!(n >= 1 && n <= Math.min(9, q.options.length))) return
      e.preventDefault()
      pick(q.options[n - 1].label)
    }
    document.addEventListener("keydown", on)
    return () => document.removeEventListener("keydown", on)
  })
  if (!q) return null
  const chosen = a.picked[q.question] ?? []
  const pick = (label: string) => {
    if (q.multiSelect) return a.set(q.question, chosen.includes(label) ? chosen.filter((x) => x !== label) : [...chosen, label])
    a.set(q.question, [label])
    if (a.index < qs.length - 1) setTimeout(() => a.go(a.index + 1), 120)
  }
  const dismiss = () => void post(`agents/threads/${id}/answer`, { ask: a.ask.id, allow: false }).catch((e) => notifyError(e, "Couldn't dismiss it"))
  return (
    <Banner data-questions={a.ask.id} data-question={a.index}>
      <Row icon={<MessageCircleQuestion />} onClick={a.toggle} expanded={a.open} data-questions-toggle
        actions={<>
          {qs.length > 1 && <span className="text-[11px] font-medium text-muted-foreground tabular-nums">{a.index + 1}/{qs.length}</span>}
          <Toggle open={a.open} />
          <span role="button" tabIndex={0} aria-label="Dismiss question without answering" data-tip="Dismiss question without answering" data-questions-dismiss
            onClick={(e) => { e.stopPropagation(); if (!busy) dismiss() }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); dismiss() } }}
            className="grid size-5 cursor-pointer place-items-center rounded-[4px] text-tertiary hover:bg-foreground/[0.08] hover:text-foreground"><X className="size-3.5" /></span>
        </>}>
        <span className="shrink-0 font-medium text-muted-foreground">{q.header || "Question"}</span>
        {!a.open && <span className="min-w-0 flex-1 truncate text-tertiary">{q.question}</span>}
      </Row>
      {a.open && (
        <div className="max-h-[min(22rem,45dvh)] overflow-y-auto px-3 pb-2">
          <p className="text-[13px] text-foreground/85 max-md:text-[16px]">{q.question}</p>
          {q.multiSelect && <p className="mt-0.5 text-[11px] text-tertiary max-md:text-[13px]">Select one or more options.</p>}
          <div className="mt-1.5 space-y-0.5">
            {q.options.map((o, i) => {
              const on = chosen.includes(o.label)
              return (
                <button key={o.label} type="button" disabled={busy} onClick={() => pick(o.label)} data-option={o.label} aria-pressed={on}
                  className={cn("flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left disabled:cursor-default disabled:opacity-50 max-md:py-2.5",
                    on ? "bg-foreground/[0.07] text-foreground" : "text-foreground/85 hover:bg-foreground/[0.04]")}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[13px] font-medium max-md:text-[16px]">{o.label}</span>
                    {o.description && o.description !== o.label && <span className="text-[11px] text-tertiary max-md:text-[13px]">{o.description}</span>}
                  </span>
                  {on ? <Check className="size-3.5 shrink-0 text-primary" /> : i < 9 && <kbd className="grid size-5 shrink-0 place-items-center text-[10px] font-medium text-muted-foreground tabular-nums">{i + 1}</kbd>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Banner>
  )
}

// ---------- the plan that's ready, and the task list

export function PlanReady({ title }: { title: string }) {
  return (
    <Banner data-plan-ready>
      <Row icon={<ListTodo />}><span className="shrink-0 font-medium text-muted-foreground">Plan ready</span>{title && <span className="min-w-0 flex-1 truncate text-foreground/85">{title}</span>}</Row>
    </Banner>
  )
}

export type Task = { content: string; status: string; activeForm?: string }
export function Tasks({ tasks }: { tasks: Task[]; since?: string }) {
  const [open, setOpen] = useState(false)
  const done = tasks.filter((x) => x.status === "completed").length
  const current = tasks.find((x) => x.status === "in_progress") ?? tasks.find((x) => x.status === "pending") ?? tasks.at(-1)!
  return (
    <Banner data-tasks={`${done}/${tasks.length}`}>
      <Row icon={<ListTodo />} onClick={() => setOpen(!open)} expanded={open} aria-label={`${open ? "Collapse tasks" : "Tasks"}: ${done} of ${tasks.length} complete. Current task: ${current.content}`}
        actions={<>
          <span className={cn("text-[11px] font-medium tabular-nums", done === tasks.length ? "text-[var(--green)]" : "text-muted-foreground")} data-tasks-progress>{done}/{tasks.length}</span>
          {tasks.length > 1 && tasks.length <= 12 && (
            <span aria-hidden className="flex w-16 items-center gap-0.5 max-md:hidden">
              {tasks.map((x, i) => <span key={i} className={cn("h-[3px] min-w-0 flex-1 rounded-full", x.status === "completed" ? "bg-[var(--green)]" : x.status === "in_progress" ? "bg-primary" : "bg-foreground/15")} />)}
            </span>
          )}
          <Toggle open={open} />
        </>}>
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/80" data-task-current>{current.status === "in_progress" ? current.activeForm || current.content : current.content}</span>
      </Row>
      {open && (
        <ul className="max-h-48 overflow-y-auto pb-1.5" aria-label={`Task list. ${done} of ${tasks.length} complete.`} data-tasks-list>
          {tasks.map((x, i) => (
            <li key={i} className="flex min-w-0 items-start gap-2 px-3 py-0.5 text-[12px] max-md:text-[15px]" data-task={x.status}>
              <span className={cn("grid h-4 shrink-0 place-items-center [&>svg]:size-3.5", x.status === "completed" ? "text-[var(--green)]" : x.status === "in_progress" ? "text-primary" : "text-tertiary")}>
                {x.status === "completed" ? <Check /> : x.status === "in_progress" ? <CircleDot /> : <Circle />}
              </span>
              <span className={cn("min-w-0 flex-1 break-words", x.status === "completed" ? "text-tertiary" : x.status === "in_progress" ? "text-foreground/90" : "text-muted-foreground")}>{x.content}</span>
              <span className="w-10 shrink-0 text-right text-[10px] text-tertiary tabular-nums">{x.status === "in_progress" ? "now" : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

// ---------- messages queued while it works

export function QueuedMessages({ id, queue, running, onEdit }: { id: string; queue: Queued[]; running: boolean; onEdit: (q: Queued) => void }) {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState("")
  const [drag, setDrag] = useState("")
  const act = async (q: Queued, action: "remove" | "steer" | "move", to?: number) => {
    setBusy(q.id)
    try { return await post<{ text?: string; file?: string }>(`agents/threads/${id}/queue/${q.id}`, { action, ...(to !== undefined ? { to } : {}) }) } catch (e) { notifyError(e, action === "steer" ? "Couldn't steer with it" : "Couldn't change the queue") } finally { setBusy("") }
  }
  return (
    <Banner data-queued={queue.length}>
      <Row icon={<ListOrdered />} onClick={() => setOpen(!open)} expanded={open} aria-label={open ? "Collapse queued messages" : "Expand queued messages"}
        actions={<><span className="text-[11px] font-medium text-muted-foreground tabular-nums">{queue.length}</span><Toggle open={open} /></>}>
        <span className="text-muted-foreground">Queued</span>
      </Row>
      {open && (
        <ol className="max-h-32 overflow-y-auto pb-1">
          {queue.map((q, i) => (
            <li key={q.id} data-queued-message={q.id} draggable={!busy} onDragStart={(e) => { setDrag(q.id); e.dataTransfer.effectAllowed = "move" }} onDragEnd={() => setDrag("")}
              onDragOver={(e) => { if (drag) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); const from = queue.find((x) => x.id === drag); if (from && from.id !== q.id) void act(from, "move", i); setDrag("") }}
              className={cn("group/q flex min-h-7 min-w-0 items-center gap-1.5 px-2 text-[12px] max-md:min-h-10 max-md:text-[15px]", drag === q.id && "opacity-50")}>
              <button type="button" aria-label="Reorder queued message (drag, or press the arrow keys)" disabled={!!busy} className="grid size-5 shrink-0 cursor-grab place-items-center rounded-[4px] text-tertiary hover:text-foreground"
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); void act(q, "move", i - 1) }
                  if (e.key === "ArrowDown" && i < queue.length - 1) { e.preventDefault(); void act(q, "move", i + 1) }
                }}><GripVertical className="size-3.5" /></button>
              {q.file && <FileText className="size-3 shrink-0 text-tertiary" />}
              <span className="min-w-0 flex-1 truncate text-foreground/80" data-tip={q.text}>{q.text}</span>
              <button type="button" aria-label="Edit queued message" data-tip={i === queue.length - 1 ? "Edit in the composer (⌥↑)" : "Edit in the composer"} disabled={!!busy} data-queued-edit
                onClick={() => void act(q, "remove").then((r) => { if (r) onEdit(q) })} className={cn(small, "w-6 justify-center px-0")}><Pencil className="size-3" /></button>
              <button type="button" disabled={!!busy} data-queued-steer data-tip={running ? `Send as a steer instead${i === 0 ? " (⌘⇧↩)" : ""}` : "Nothing is running: send it now"}
                onClick={() => void act(q, "steer")} className={small}><CornerUpRight className="size-3" /><span className="max-md:hidden">{running ? "Steer" : "Send now"}</span></button>
              <button type="button" aria-label="Remove queued message" data-tip="Remove from queue" disabled={!!busy} data-queued-remove
                onClick={() => void act(q, "remove")} className={cn(small, "w-6 justify-center px-0")}><X className="size-3.5" /></button>
            </li>
          ))}
        </ol>
      )}
    </Banner>
  )
}

/** A plan's title: its first heading (T3 Code's proposedPlanTitle). */
export const planTitle = (md: string) => /^#{1,3}\s+(.+)$/m.exec(md)?.[1]?.replace(/[*_`]/g, "").trim() ?? ""
