// Work: focus and questions (Work.md's frontmatter), a log (logs in area `work`, data.kind: conversation | investigation
// | build | video | idea) and colleagues. Only the user's own short notes: no company credentials, code or client data.
import { Circle, Crosshair, Hammer, Lightbulb, MessagesSquare, NotebookPen, Search, Users, Video, type LucideIcon } from "lucide-react"
import {
  cn, detailPath, Empty, fmtAgo, fmtDay, fmtMin, List, openDetail, Panel, plain, resolver, Row, Section, SheetHead,
  snippet, type BlockCtx, type Store,
} from "@vaultite"
import { logsOf, type Log } from "@plugins/core/logs/types"

const TINT = "var(--work)"

export const WORK_KINDS: Record<string, { label: string; icon: LucideIcon }> = {
  conversation: { label: "Conversation", icon: MessagesSquare },
  investigation: { label: "Investigation", icon: Search },
  build: { label: "Build", icon: Hammer },
  video: { label: "Video", icon: Video },
  idea: { label: "Idea", icon: Lightbulb },
}
const kindOf = (k?: string) => WORK_KINDS[k ?? ""] ?? { label: "Note", icon: Circle }
const STATUS: Record<string, { label: string; color: string }> = {
  idea: { label: "Idea", color: "var(--muted-foreground)" },
  planned: { label: "Planned", color: "var(--primary)" },
  doing: { label: "In progress", color: "var(--orange)" },
  done: { label: "Done", color: "var(--green)" },
  dropped: { label: "Dropped", color: "var(--muted-foreground)" },
}
const statusOf = (s?: string) => STATUS[s ?? "idea"] ?? STATUS.idea
const ORDER = ["doing", "planned", "idea", "done", "dropped"]

/** A log entry with its kind symbol in front. */
function Entry({ l }: { l: Log }) {
  const k = kindOf(l.data?.kind)
  const meta = [k.label, l.data?.person && `with ${l.data.person}`, l.duration_min && fmtMin(l.duration_min)].filter(Boolean).join(" · ")
  return (
    <button type="button" onClick={() => openDetail(detailPath("log", l.id))}
      className={cn(
        "relative isolate flex min-h-11 w-full cursor-pointer gap-3 py-2.5 text-left",
        "before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-[8px] before:transition-colors",
        "hover:before:bg-foreground/[0.04] active:before:bg-foreground/[0.07]",
      )}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full"
        style={{ background: `color-mix(in srgb, ${TINT} 16%, transparent)`, color: TINT }}>
        <k.icon className="size-4" strokeWidth={2.25} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[15px] leading-[20px] font-medium">{plain(l.title) || k.label}</div>
        <div className="truncate text-[13px] text-muted-foreground">{meta}</div>
        {l.notes && <p className="mt-0.5 line-clamp-3 text-[15px] leading-[20px] text-foreground/80">{snippet(l.notes)}</p>}
      </div>
    </button>
  )
}

/** Entries grouped under day headings, newest first. */
function Timeline({ logs }: { logs: Log[] }) {
  const days: [string, Log[]][] = []
  for (const l of logs) {
    const last = days[days.length - 1]
    if (last && last[0] === l.date) last[1].push(l)
    else days.push([l.date, [l]])
  }
  return (
    <div className="space-y-4">
      {days.map(([d, ls]) => (
        <Section key={d} title={fmtDay(d)}>
          <List>{ls.map((l) => <Entry key={l.id} l={l} />)}</List>
        </Section>
      ))}
    </div>
  )
}

/** A colleague opens their People profile if they have one, else the colleague sheet (their work log entries). */
export const colleaguePath = (s: Store, name: string) => {
  const t = resolver(s)(name)
  return t?.kind === "person" ? t.detail : detailPath("colleague", name)
}

export function ColleagueDetail({ store, name }: { store: Store; name: string }) {
  const role = store.work?.colleagues.find((c) => c.name === name)?.role
  const logs = logsOf(store, "work").filter((l) => l.data?.person === name)
  return (
    <>
      <SheetHead icon={Users} tint={TINT} kicker="Colleague" title={name} sub={role} />
      <Section title="Work together">
        {!logs.length ? <Empty>Nothing logged with {name} yet.</Empty> : <Timeline logs={logs} />}
      </Section>
    </>
  )
}

function Pill({ status }: { status?: string }) {
  const s = statusOf(status)
  return (
    <span className="rounded-full px-2 py-0.5 text-[13px] font-medium"
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 14%, transparent)` }}>
      {s.label}
    </span>
  )
}

/** ```block-work-focus: what you're focusing on and open questions (Work.md's frontmatter). */
export function WorkFocus({ store }: BlockCtx) {
  const w = store.work
  const questions = w?.questions ?? []
  return (
    <Panel title="Focus" icon={Crosshair} tint={TINT}
      action={w ? <span className="text-[13px] text-muted-foreground">Updated {fmtAgo(w.modified)}</span> : null}>
      {!w?.focus && !questions.length ? (
        <Empty>Nothing set. Tell Claude what you're focusing on and what you're unsure about.</Empty>
      ) : (
        <div className="space-y-4">
          {w?.focus && <p className="text-[17px] leading-[22px] font-semibold">{w.focus}</p>}
          {!!questions.length && (
            <Section title="Open questions">
              <List>{questions.map((q, i) => <Row key={i} title={q} />)}</List>
            </Section>
          )}
        </div>
      )}
    </Panel>
  )
}

const entriesOf = (store: Store) => logsOf(store, "work").filter((l) => l.data?.kind !== "idea")

/** ```block-work-log: conversations, investigations, builds and videos, by day (option: limit, default 20). */
export function WorkLog({ store, options }: BlockCtx) {
  const entries = entriesOf(store)
  return (
    <Panel title="Log" icon={NotebookPen} tint={TINT}>
      {!entries.length ? (
        <Empty>Nothing logged yet. Tell Claude about a conversation, what you're investigating, what you built, or a video you recorded.</Empty>
      ) : (
        <Timeline logs={entries.slice(0, Number(options.limit) || 20)} />
      )}
    </Panel>
  )
}

/** ```block-work-ideas: ideas and plans, by status (in progress first). */
export function WorkIdeas({ store }: BlockCtx) {
  const ideas = logsOf(store, "work").filter((l) => l.data?.kind === "idea")
    .sort((a, b) => ORDER.indexOf(a.data?.status ?? "idea") - ORDER.indexOf(b.data?.status ?? "idea"))
  return (
    <Panel title="Ideas and plans" icon={Lightbulb} tint={TINT}>
      {!ideas.length ? (
        <Empty>No ideas yet. Tell Claude when you have one.</Empty>
      ) : (
        <List>
          {ideas.map((l) => (
            <Row key={l.id} title={l.title} meta={snippet(l.notes) || fmtDay(l.date)} onOpen={() => openDetail(detailPath("log", l.id))} wrap
              className={cn(["done", "dropped"].includes(l.data?.status) && "opacity-60")}
              right={<Pill status={l.data?.status} />} />
          ))}
        </List>
      )}
    </Panel>
  )
}

/** ```block-work-colleagues: Work.md's colleagues and anyone a log entry was with, and when you last worked together. */
export function WorkColleagues({ store }: BlockCtx) {
  const w = store.work
  const entries = entriesOf(store)
  const names = [...(w?.colleagues ?? []).map((c) => c.name), ...entries.map((l) => l.data?.person).filter(Boolean)]
  const colleagues = [...new Set<string>(names)].map((name) => ({
    name, role: w?.colleagues.find((c) => c.name === name)?.role,
    last: entries.find((l) => l.data?.person === name),
  }))
  if (!colleagues.length) return null
  return (
    <Panel title="Colleagues" icon={Users} tint={TINT}>
      <List>
        {colleagues.map((c) => (
          <Row key={c.name} title={c.name} meta={c.role} onOpen={() => openDetail(colleaguePath(store, c.name))}
            right={c.last ? fmtDay(c.last.date) : undefined} />
        ))}
      </List>
    </Panel>
  )
}
