// T3 Code's thread menu, shared by the sidebar's rows and the chat's header: pin, settle, snooze, rename, mark unread,
// filter, auto-settle, copy, archive, delete; and the small dialogs they need.
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Archive, ArchiveRestore, CircleCheck, Clock, Copy, Folder, FolderTree, GitBranch, Hash, MailOpen, MessageSquarePlus, Pencil, Pin, PinOff, RefreshCw, SquareTerminal, Timer, Trash2 } from "lucide-react"
import { choose, cn, confirmDialog, copyText, del, notify, notifyError, openAgent, post, type MenuItem } from "@vaultite"
import type { Harness, Summary } from "./types"
import { tildeOf } from "./ui"

// ---------- times, as T3 Code writes them

/** "now", "5m", "2h", "3d", "4w": how long ago, for a row. */
export function ago(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  if (s < 365 * 86400) return `${Math.floor(s / (7 * 86400))}w`
  return `${Math.floor(s / (365 * 86400))}y`
}
const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
/** When a snoozed thread comes back: "17:30" today, "tomorrow 9:00", "Mon 9:00", else its date. */
export function wakeLabel(iso: string, now = new Date()) {
  const d = new Date(iso), start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const days = Math.floor((d.getTime() - start.getTime()) / 86_400_000)
  if (days === 0) return clock(d)
  if (days === 1) return `tomorrow ${clock(d)}`
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${clock(d)}`
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(d)}`
}
/** T3 Code's snooze choices: in 1 and 3 hours, this evening (6pm, when it's an hour away), tomorrow and next week at 9. */
export function snoozePresets(now = new Date()) {
  const at = (days: number, hour: number) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d }
  const out: { label: string; when: Date }[] = [
    { label: "In 1 hour", when: new Date(now.getTime() + 3_600_000) },
    { label: "In 3 hours", when: new Date(now.getTime() + 3 * 3_600_000) },
  ]
  const evening = at(0, 18)
  if (evening.getTime() - now.getTime() > 3_600_000) out.push({ label: "This evening", when: evening })
  const tomorrow = at(1, 9)
  out.push({ label: "Tomorrow", when: tomorrow })
  const week = at((1 - now.getDay() + 7) % 7 || 7, 9)
  if (week.getTime() !== tomorrow.getTime()) out.push({ label: "Next week", when: week })
  return out.map((p) => ({ ...p, hint: p.label === "Next week" ? `${p.when.toLocaleDateString([], { weekday: "short" })} ${clock(p.when)}` : clock(p.when) }))
}
/** A typed snooze: "2h", "3d", "45m", or a date and time. */
export function parseWhen(typed: string, now = Date.now()) {
  const m = /^\s*(\d+)\s*(m|min|h|d|w)\s*$/i.exec(typed)
  if (m) return new Date(now + Number(m[1]) * { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2].toLowerCase() as "m"]!)
  const d = Date.parse(typed)
  return Number.isFinite(d) && d > now ? new Date(d) : null
}

// ---------- doing it

export const setState = (id: string, body: Record<string, unknown>) => post(`agents/threads/${id}/state`, body).catch((e) => notifyError(e, "Couldn't change it"))
export const settle = (id: string, settled: boolean) => post(`agents/threads/${id}/settle`, { settled }).catch((e) => notifyError(e, settled ? "Couldn't settle it" : "Couldn't un-settle it"))
export function snoozeCustom(id: string) {
  choose({
    title: "Snooze until", placeholder: "When it comes back: 2h, 3d, or a date and time", items: snoozePresets().map((p) => ({ id: p.when.toISOString(), label: p.label, detail: p.hint, icon: Clock })),
    other: (typed) => { const d = parseWhen(typed); return d ? { id: d.toISOString(), label: `Until ${wakeLabel(d.toISOString())}`, icon: Clock } : null },
    onPick: (p) => void setState(id, { snoozedUntil: p.id }),
  })
}
export async function regenerateTitle(id: string) {
  try { await post(`agents/threads/${id}/title`, {}) } catch (e) { notifyError(e, "Couldn't regenerate the title") }
}

export async function removeThread(id: string, title: string, after?: () => void) {
  if (!(await confirmDialog({ title: `Delete “${title}”?`, body: "The thread goes from Agents for good, and its worktree too when nothing in it is left uncommitted (its branch stays). The agent keeps its own record of the session.", confirm: "Delete", danger: true }))) return
  try {
    const r = await del<{ kept?: string }>(`agents/threads/${id}`)
    if (r?.kept) notify(`Its worktree has changes not committed, so it stays: ${tildeOf(r.kept)}`)
    after?.()
  } catch (e) { notifyError(e, "Couldn't delete it") }
}

export async function openInTerminal(id: string) {
  try {
    const { harness, session } = await post<{ harness: Harness; session: string }>(`agents/threads/${id}/handoff`, {})
    openAgent(harness, { resume: session, newTab: true })
  } catch (e) { notifyError(e, "Couldn't open it in a terminal") }
}

/** The thread menu, in T3 Code's order. `s` is the thread as the list has it; the rest says what this surface can do. */
export function threadActions(s: Summary, opts: {
  on: (plugin: string) => boolean; started: boolean; rename?: () => void; gone?: () => void; newOnBranch?: () => void
  filter?: { label: string; active: boolean; toggle: () => void }; extra?: MenuItem[]
}): MenuItem[] {
  const id = s.id
  const settled = !!s.settledAt
  const presets = snoozePresets()
  return [
    ...(opts.extra ?? []),
    ...(s.branch && opts.newOnBranch ? [{ label: `New thread on ${s.branch}`, icon: MessageSquarePlus, run: opts.newOnBranch }] : []),
    s.pinnedAt ? { label: "Unpin thread", icon: PinOff, run: () => void setState(id, { pinned: false }) } : { label: "Pin thread", icon: Pin, run: () => void setState(id, { pinned: true }) },
    settled ? { label: "Un-settle thread", icon: CircleCheck, run: () => void settle(id, false) } : { label: "Settle thread", icon: CircleCheck, run: () => void settle(id, true) },
    s.snoozedUntil ? { label: "Wake thread", icon: Clock, run: () => void setState(id, { snoozedUntil: null }) } : {
      label: "Snooze", icon: Clock, disabled: s.running || s.waiting, run: () => {},
      items: [...presets.map((p) => ({ label: p.label, hint: p.hint, run: () => void setState(id, { snoozedUntil: p.when.toISOString() }) })),
        { label: "Custom…", sep: true, run: () => snoozeCustom(id) }],
    },
    ...(opts.rename ? [{ label: "Rename thread", icon: Pencil, sep: true, run: opts.rename }] : []),
    { label: "Regenerate title", icon: RefreshCw, disabled: !opts.started, sep: !opts.rename, run: () => void regenerateTitle(id) },
    { label: "Mark unread", icon: MailOpen, run: () => void setState(id, { unread: true }) },
    ...(opts.filter ? [{ label: opts.filter.active ? "Show all projects" : `Filter by ${opts.filter.label}`, icon: FolderTree, run: opts.filter.toggle }] : []),
    { label: "Auto-settle behavior", icon: Timer, run: () => {}, items: [
      { label: "Enabled", checked: !s.autoSettleOff, run: () => void setState(id, { autoSettle: true }) },
      { label: "Disabled", checked: !!s.autoSettleOff, run: () => void setState(id, { autoSettle: false }) },
    ] },
    { label: "Copy", icon: Copy, sep: true, run: () => {}, items: [
      { label: "Path", icon: Folder, run: () => { void copyText(s.cwd); notify("Copied") } },
      ...(s.branch ? [{ label: "Branch", icon: GitBranch, run: () => { void copyText(s.branch!); notify("Copied") } }] : []),
      { label: "Thread ID", icon: Hash, run: () => { void copyText(id); notify("Copied") } },
    ] },
    ...(opts.started && opts.on("terminal") && opts.on(s.harness === "claude" ? "claude-code" : "codex") ? [{ label: "Open in terminal", icon: SquareTerminal, run: () => void openInTerminal(id) }] : []),
    s.archived ? { label: "Unarchive thread", icon: ArchiveRestore, sep: true, run: () => void setState(id, { archived: false }) }
      : { label: "Archive thread", icon: Archive, sep: true, disabled: s.running, run: () => void setState(id, { archived: true }).then(() => opts.gone?.()) },
    { label: "Delete", icon: Trash2, danger: true, run: () => void removeThread(id, s.title, opts.gone) },
  ]
}

// ---------- a dialog with more than one way forward (Edit from here's)

type Choice<T> = { label: string; value: T; danger?: boolean; primary?: boolean }
type Asking = { title: string; body?: string; choices: Choice<unknown>[]; done: (v: unknown) => void; field?: { label: string; placeholder: string; value?: string } }
let asking: Asking | null = null
const subs = new Set<() => void>()
const show = (a: Asking | null) => { asking = a; subs.forEach((f) => f()) }

/** Asks, with a button per choice (and Cancel): the choice's value, null when cancelled. With `field`, the text typed. */
export function choiceDialog<T>(o: { title: string; body?: string; choices: Choice<T>[]; field?: Asking["field"] }): Promise<{ value: T; text: string } | null> {
  asking?.done(null)
  return new Promise((resolve) => show({ ...o, choices: o.choices as Choice<unknown>[], done: (v) => resolve(v as { value: T; text: string } | null) }))
}

export function Dialogs() {
  const [, tick] = useState(0)
  useEffect(() => { const f = () => tick((n) => n + 1); subs.add(f); return () => { subs.delete(f) } }, [])
  return asking ? createPortal(<ChoiceDialog key={asking.title} a={asking} />, document.body) : null
}

function ChoiceDialog({ a }: { a: Asking }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(a.field?.value ?? "")
  const finish = (v: unknown) => { if (asking === a) show(null); a.done(v === null ? null : { value: v, text }) }
  useEffect(() => {
    const d = ref.current
    if (!d) return
    const back = document.activeElement as HTMLElement | null
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "")
    ;(d.querySelector("input, [data-primary]") as HTMLElement | null)?.focus()
    return () => { if (d.open && typeof d.close === "function") d.close(); back?.focus?.({ preventScroll: true }) }
  }, [])
  const primary = a.choices.find((c) => c.primary) ?? a.choices.at(-1)!
  return (
    <dialog ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="agents-dialog-title" data-agents-dialog
      onCancel={(e) => { e.preventDefault(); finish(null) }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); finish(primary.value) } }}
      onClick={(e) => { if (e.target === e.currentTarget) finish(null) }}
      className="m-auto w-[calc(100%-3rem)] max-w-[440px] overflow-hidden rounded-[14px] border-[0.5px] border-border bg-card p-0 text-foreground shadow-2xl outline-none backdrop:bg-black/30 open:animate-in open:fade-in open:zoom-in-95 open:duration-150">
      <div className="px-5 pt-5 pb-4">
        <h2 id="agents-dialog-title" className="text-[15px] leading-[20px] font-semibold max-md:text-[17px]">{a.title}</h2>
        {a.body && <p className="mt-1.5 text-[13px] leading-[18px] whitespace-pre-line text-muted-foreground max-md:text-[15px] max-md:leading-[20px]">{a.body}</p>}
        {a.field && (
          <label className="mt-3 grid gap-1.5">
            <span className="text-[12px] font-medium">{a.field.label}</span>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={a.field.placeholder} data-dialog-field data-keeps-keys
              className="h-8 w-full rounded-[8px] border-[0.5px] border-border bg-background px-2.5 text-[13px] outline-none focus:border-primary max-md:h-11 max-md:text-[16px]" />
          </label>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 px-5 pb-4">
        <button type="button" onClick={() => finish(null)} data-dialog-cancel
          className="h-7 cursor-pointer rounded-[6px] bg-foreground/[0.06] px-3 text-[13px] font-medium hover:bg-foreground/[0.1] max-md:h-11 max-md:flex-1 max-md:text-[16px]">Cancel</button>
        {a.choices.map((c) => (
          <button key={c.label} type="button" onClick={() => finish(c.value)} data-dialog-choice={c.label} data-primary={c === primary || undefined}
            disabled={!!a.field && !text.trim()}
            className={cn("h-7 cursor-pointer rounded-[6px] px-3 text-[13px] font-medium disabled:cursor-default disabled:opacity-50 max-md:h-11 max-md:flex-1 max-md:text-[16px]",
              c.danger ? "bg-destructive text-white hover:bg-destructive/90" : c === primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border-[0.5px] border-border hover:bg-foreground/[0.06]")}>
            {c.label}
          </button>
        ))}
      </div>
    </dialog>
  )
}
