// The thread as turns, T3 Code's way: your message on the right; the agent's work while it runs, then folded behind
// "Worked for 12s" once it's done; its answer as plain Markdown; and the files the turn changed, a click from the diff.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronRight, CircleAlert, Copy, FileDiff, FileText, Folder, ShieldCheck, ShieldX, Undo2 } from "lucide-react"
import { cn, confirmDialog, copyText, Markdown, notify, notifyError, post } from "@vaultite"
import { TINT } from "./harness"
import { openDiff } from "./panel"
import type { Entry, Harness } from "./types"
import { Counts, describe, Diff, diffLines, EDITS, FileLink, KIND_ICON, kindOf, noteName, summarize, timeOf, took, useNow } from "./ui"

type Tool = Extract<Entry, { kind: "tool" }>
type Ask = Extract<Entry, { kind: "ask" }>
type User = Extract<Entry, { kind: "user" }>
type At<E> = { e: E; i: number }

// ---------- a tool call, a line

function ToolRow({ t, cwd }: { t: Tool; cwd: string }) {
  const [open, setOpen] = useState(false)
  const d = describe(t.name, t.input, cwd, t.file, t.path)
  const diff = EDITS.test(t.name) && !t.error ? diffLines(t.name, t.input, t.patch) : []
  const Icon = KIND_ICON[kindOf(t.name)]
  const running = t.result === undefined && !t.error
  return (
    <div data-tool={t.name} data-tool-file={t.file} data-tool-state={running ? "running" : t.error ? "failed" : "done"}>
      <div role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(!open) }} aria-expanded={open}
        className="group/tool flex min-h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-[5px] px-1 text-[13px] hover:bg-foreground/[0.04] max-md:min-h-9 max-md:text-[15px]">
        <span className="grid size-5 shrink-0 place-items-center">
          <Icon className={cn("size-3.5", t.error ? "text-[var(--red)]" : "text-tertiary", running && "animate-pulse text-muted-foreground")} strokeWidth={2} />
        </span>
        <span className={cn("shrink-0", running ? "text-foreground" : "text-muted-foreground")}>{running ? `${d.verb.replace(/^Ran$/, "Running").replace(/^Read$/, "Reading").replace(/^Edited$/, "Editing")}` : t.error ? `Failed: ${d.verb.toLowerCase()}` : d.verb}</span>
        {d.file ? <FileLink file={d.file}>{d.what}</FileLink> : <span className="min-w-0 truncate font-mono text-[12px] text-tertiary max-md:text-[13px]">{d.what}</span>}
        {diff.length > 0 && <Counts lines={diff} />}
        {t.error && <CircleAlert className="size-3.5 shrink-0 text-[var(--red)]" strokeWidth={2.25} aria-label="Tool call failed" />}
        <span className="flex-1" />
        <ChevronRight className={cn("size-3 shrink-0 text-tertiary opacity-0 transition group-hover/tool:opacity-100", open && "rotate-90 opacity-100")} strokeWidth={2.5} />
      </div>
      {open && (
        <div className="mt-0.5 mb-2 ms-7 space-y-1.5">
          {diff.length ? <Diff lines={diff} /> : (
            <pre className="max-h-96 overflow-auto rounded-[8px] bg-muted px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words select-text">{typeof t.input.command === "string" ? t.input.command : JSON.stringify(t.input, null, 2)}</pre>
          )}
          {t.result !== undefined && !diff.length && (
            <pre className={cn("max-h-96 overflow-auto rounded-[8px] border-[0.5px] border-border px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words select-text",
              t.error ? "text-[var(--red)]" : "text-muted-foreground")}>{t.result || "(no output)"}</pre>
          )}
        </div>
      )}
    </div>
  )
}

const ASK_VERB: Record<string, string> = { Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Write: "write", Bash: "run", Read: "read", WebFetch: "read", WebSearch: "search the web for" }
/** A question answered (or not): a line in the work log. */
function AskRow({ a, cwd }: { a: Ask; cwd: string }) {
  const d = describe(a.tool, a.input, cwd, a.file, a.path)
  const yes = a.answer === "allow"
  const Icon = yes ? ShieldCheck : ShieldX
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1.5 px-1 text-[13px] text-muted-foreground max-md:min-h-9 max-md:text-[15px]" data-ask={a.answer ?? "waiting"} data-ask-tool={a.tool}>
      <span className="grid size-5 shrink-0 place-items-center"><Icon className={cn("size-3.5", yes ? "text-[var(--green)]" : "text-tertiary")} /></span>
      <span className="shrink-0">{!a.answer ? "Waiting for approval to" : yes ? "Approved:" : a.answer === "deny" ? "Declined:" : "Not answered:"}</span>
      <span className="min-w-0 truncate">{ASK_VERB[a.tool] ?? "use"} {d.what || a.tool}</span>
    </div>
  )
}

/** Tool calls in a row: one phrase for them all ("Read 3 files and ran 2 commands"), each a line when opened. */
function WorkGroup({ items, cwd, live }: { items: At<Tool | Ask>[]; cwd: string; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const tools = items.filter((x) => x.e.kind === "tool") as At<Tool>[]
  if (items.length === 1) return items[0].e.kind === "tool" ? <ToolRow t={items[0].e} cwd={cwd} /> : <AskRow a={items[0].e as Ask} cwd={cwd} />
  const s = summarize(tools.map(({ e }) => ({ name: e.name, key: e.path ?? e.file ?? e.id })))
  const Icon = KIND_ICON[s.kind]
  const failed = tools.some((x) => x.e.error)
  // (the group the agent is working in stays open; a done one folds to its phrase)
  const shown = open ?? live
  const rows = items.map(({ e, i }) => e.kind === "tool" ? <ToolRow key={i} t={e} cwd={cwd} /> : <AskRow key={i} a={e} cwd={cwd} />)
  return (
    <div data-work-group={items.length}>
      <div role="button" tabIndex={0} onClick={() => setOpen(!shown)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(!shown) }} aria-expanded={shown}
        className="group/head flex min-h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-[5px] px-1 text-[13px] text-muted-foreground hover:bg-foreground/[0.04] max-md:min-h-9 max-md:text-[15px]">
        <span className="grid size-5 shrink-0 place-items-center"><Icon className="size-3.5 text-tertiary" /></span>
        <span className="min-w-0 truncate">{s.text}</span>
        {failed && <CircleAlert className="size-3.5 shrink-0 text-[var(--red)]" strokeWidth={2.25} aria-label="A tool call failed" />}
        <ChevronRight className={cn("size-3 shrink-0 text-tertiary transition", shown && "rotate-90")} strokeWidth={2.5} />
      </div>
      {shown && <div className="ms-3 max-h-[min(18rem,50dvh)] overflow-y-auto border-s-[0.5px] border-border ps-1" data-work-rows>{rows}</div>}
    </div>
  )
}

/** A turn's work, in order: tool calls grouped, what the agent said on the way, notes. */
function Work({ items, cwd, running }: { items: At<Entry>[]; cwd: string; running: boolean }) {
  const blocks: ({ kind: "tools"; items: At<Tool | Ask>[] } | { kind: "one"; at: At<Entry> })[] = []
  for (const x of items) {
    const last = blocks.at(-1)
    if (x.e.kind === "tool" || x.e.kind === "ask") {
      if (last?.kind === "tools") last.items.push(x as At<Tool | Ask>)
      else blocks.push({ kind: "tools", items: [x as At<Tool | Ask>] })
    } else blocks.push({ kind: "one", at: x })
  }
  return (
    <div className="flex flex-col gap-1" data-work>
      {blocks.map((b, n) => {
        if (b.kind === "tools") return <WorkGroup key={b.items[0].i} items={b.items} cwd={cwd} live={running && n === blocks.length - 1} />
        const { e, i } = b.at
        if (e.kind === "assistant") return <Markdown key={i} text={e.text || " "} className="min-w-0 px-1 text-muted-foreground break-words [&_p]:my-1" />
        if (e.kind === "note") return <div key={i} data-note="info" className="px-1 text-[12px] leading-[17px] text-tertiary max-md:text-[15px]">{e.text}</div>
        return null
      })}
    </div>
  )
}

// ---------- messages

function UserMessage({ u, i, id, canRevert }: { u: User; i: number; id: string; canRevert: boolean }) {
  const revert = async () => {
    if (!(await confirmDialog({ title: "Revert the files?", body: "The files go back to how they were before this message: what the agent changed since is undone. The conversation stays as it is.", confirm: "Revert files", danger: true }))) return
    try {
      const r = await post<{ files: number }>(`agents/threads/${id}/revert`, { turn: i })
      notify(r.files ? `Reverted ${r.files === 1 ? "1 file" : `${r.files} files`}` : "Nothing to revert")
    } catch (e) { notifyError(e, "Couldn't revert") }
  }
  return (
    <div className="group/user flex flex-col items-end" data-entry="user">
      <div className="max-w-[80%] min-w-0 rounded-[16px] bg-muted px-3 py-2 max-md:max-w-[88%]">
        <div className="text-[13px] leading-[19px] whitespace-pre-wrap break-words max-md:text-[17px] max-md:leading-[23px]">{u.text}</div>
        {(u.file || u.images?.length) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {u.images?.map((im) => <img key={im} src={`api/agents/image/${id}/${im}`} alt="" className="h-12 rounded-[4px] border-[0.5px] border-border object-cover" />)}
            {u.file && <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground"><FileText className="size-3 shrink-0" /><FileLink file={u.file}>{noteName(u.file)}</FileLink></span>}
          </div>
        )}
      </div>
      <div className="mt-0.5 flex h-6 items-center gap-0.5 pe-1 text-[11px] text-tertiary opacity-0 transition-opacity group-hover/user:opacity-100 max-md:opacity-100">
        <span className="me-1 tabular-nums">{timeOf(u.at)}</span>
        {canRevert && u.before && (
          <button type="button" onClick={() => void revert()} aria-label="Revert files to before this message" data-tip="Revert files to before this message" data-revert={i}
            className="grid size-5 cursor-pointer place-items-center rounded-[4px] hover:bg-foreground/[0.08] hover:text-foreground"><Undo2 className="size-3" /></button>
        )}
        <button type="button" onClick={() => { void copyText(u.text); notify("Copied") }} aria-label="Copy" data-tip="Copy"
          className="grid size-5 cursor-pointer place-items-center rounded-[4px] hover:bg-foreground/[0.08] hover:text-foreground"><Copy className="size-3" /></button>
      </div>
    </div>
  )
}

function Answer({ e }: { e: Extract<Entry, { kind: "assistant" }> }) {
  return (
    <div className="group/answer" data-entry="assistant">
      <Markdown text={e.text || "(empty response)"} className="min-w-0 px-1 break-words" />
      {!e.open && (
        <div className="flex h-6 items-center gap-0.5 px-1 text-[11px] text-tertiary opacity-0 transition-opacity group-hover/answer:opacity-100 max-md:opacity-100">
          <button type="button" onClick={() => { void copyText(e.text); notify("Copied") }} aria-label="Copy" data-tip="Copy"
            className="grid size-5 cursor-pointer place-items-center rounded-[4px] hover:bg-foreground/[0.08] hover:text-foreground"><Copy className="size-3" /></button>
          <span className="ms-1 tabular-nums">{timeOf(e.at)}</span>
        </div>
      )}
    </div>
  )
}

/** A plan the agent proposes (Claude's plan mode): a card in the thread; it's answered above the box to write in. */
function PlanCard({ a }: { a: Ask }) {
  const [open, setOpen] = useState(!a.answer)
  return (
    <div className="rounded-[14px] border-[0.5px] border-border bg-card/70 p-3" data-plan={a.answer ?? "waiting"}>
      <button type="button" onClick={() => setOpen(!open)} className="mb-1 flex w-full cursor-pointer items-center gap-1.5 text-left text-[13px] font-medium">
        <span className="rounded-[4px] bg-[color-mix(in_srgb,var(--blue)_16%,transparent)] px-1.5 text-[11px] font-semibold text-[var(--blue)]">Plan</span>
        <span className="flex-1 text-muted-foreground">{a.answer === "allow" ? "Implemented" : a.answer === "deny" ? "Kept planning" : a.answer ? "Not answered" : "Ready"}</span>
        <ChevronRight className={cn("size-3.5 text-tertiary transition", open && "rotate-90")} />
      </button>
      {open ? <Markdown text={String(a.input.plan ?? "")} className="text-[13px]" /> : <p className="line-clamp-2 text-[12px] text-muted-foreground">{String(a.input.plan ?? "").replace(/[#*_`>]/g, "")}</p>}
    </div>
  )
}

/** The files a turn changed: a card with each one's counts, folder by folder; a click opens it in the diff panel. */
function ChangedFiles({ id, turn, changes }: { id: string; turn: number; changes: NonNullable<User["changes"]> }) {
  const added = changes.reduce((n, f) => n + f.added, 0), removed = changes.reduce((n, f) => n + f.removed, 0)
  const folders = new Map<string, typeof changes>()
  for (const f of changes) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""
    folders.set(dir, [...(folders.get(dir) ?? []), f])
  }
  return (
    <div className="mt-1 rounded-[10px] bg-muted/70" data-changed-files={changes.length}>
      <div className="flex h-8 items-center gap-1.5 border-b-[0.5px] border-border/60 ps-2.5 pe-1 text-[12px] max-md:h-10 max-md:text-[14px]">
        <span className="font-medium">{changes.length === 1 ? "1 changed file" : `${changes.length} changed files`}</span>
        <Counts added={added} removed={removed} />
        <span className="flex-1" />
        <button type="button" onClick={() => openDiff(id, turn)} data-tip="Open the full diff" data-open-diff={turn}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:h-9">
          <FileDiff className="size-3.5" />Open diff
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto py-1">
        {[...folders].map(([dir, files]) => (
          <div key={dir}>
            {dir && <div className="flex h-6 items-center gap-1.5 px-2.5 text-[12px] text-tertiary max-md:h-8"><Folder className="size-3 shrink-0" /><span className="truncate">{dir}</span></div>}
            {files.map((f) => (
              <button key={f.path} type="button" onClick={() => openDiff(id, turn, f.path)} data-changed-file={f.path}
                className={cn("flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 pe-2.5 text-left text-[12px] hover:bg-foreground/[0.04] max-md:h-9 max-md:text-[14px]", dir ? "ps-7" : "ps-2.5")}>
                <span className={cn("min-w-0 flex-1 truncate font-mono", f.status === "deleted" && "line-through text-muted-foreground")}>{f.path.split("/").pop()}</span>
                {f.status === "added" && <span className="text-[10px] font-semibold text-[var(--green)]">NEW</span>}
                <Counts added={f.added} removed={f.removed} />
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** "Worked for 12s": a done turn's work, folded. */
function Fold({ label, at, open, onToggle }: { label: string; at?: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} data-turn-fold={label}
      className="group/fold flex h-7 w-full cursor-pointer items-center gap-1 border-b-[0.5px] border-border/70 px-1 text-left text-[12px] text-muted-foreground hover:text-foreground max-md:h-10 max-md:text-[15px]">
      <span>{label}</span>
      <ChevronRight className={cn("size-3.5 transition", open && "rotate-90")} strokeWidth={2.25} />
      <span className="flex-1" />
      {at && <span className="text-[11px] text-tertiary tabular-nums opacity-0 group-hover/fold:opacity-100">{timeOf(at)}</span>}
    </button>
  )
}

/** While it works: "Working for 12s", ticking. */
function Working({ since, status, harness }: { since: string; status: string; harness: Harness }) {
  const now = useNow(true, 200)
  const label = status === "preparing" ? "Setting up worktree" : status === "waiting" ? "Waiting for your approval" : `Working for ${took(now - Date.parse(since))}`
  return (
    <div className="flex h-7 items-center gap-1.5 border-b-[0.5px] border-border/70 px-1 text-[12px] text-muted-foreground max-md:h-10 max-md:text-[15px]" data-agents-status={status} data-working>
      <span className="size-1.5 animate-pulse rounded-full" style={{ background: status === "waiting" ? "var(--yellow)" : TINT[harness] ?? "var(--foreground)" }} />
      <span>{label}{status === "preparing" ? "…" : ""}</span>
    </div>
  )
}

// ---------- a turn

type TurnData = { user: At<User> | null; items: At<Entry>[] }
/** The thread in turns: each of your messages and what came after it. */
export function turnsOf(entries: Entry[]): TurnData[] {
  const out: TurnData[] = []
  entries.forEach((e, i) => {
    if (e.kind === "user") out.push({ user: { e, i }, items: [] })
    else { if (!out.length) out.push({ user: null, items: [] }); out.at(-1)!.items.push({ e, i }) }
  })
  return out
}

function Turn({ id, turn, cwd, harness, running, status, canRevert }: { id: string; turn: TurnData; cwd: string; harness: Harness; running: boolean; status: string; canRevert: boolean }) {
  const [open, setOpen] = useState(false)
  const { user, items } = turn
  // Its answer: the last thing it said after its last tool call. Errors and plans stay out of the fold too.
  const lastWork = items.findLastIndex((x) => x.e.kind === "tool" || x.e.kind === "ask")
  const answerAt = items.findLastIndex((x, n) => n > lastWork && x.e.kind === "assistant")
  const outside = (x: At<Entry>, n: number) => n === answerAt || (x.e.kind === "note" && x.e.error) || (x.e.kind === "ask" && x.e.tool === "ExitPlanMode")
  const work = items.filter((x, n) => !outside(x, n))
  const stopped = items.some((x) => x.e.kind === "note" && x.e.text === "Stopped.")
  const ms = user?.e.end ? Date.parse(user.e.end) - Date.parse(user.e.at) : 0
  const label = stopped ? `You stopped after ${took(ms)}` : `Worked for ${took(ms)}`
  return (
    <div className="flex flex-col gap-2" data-turn={user?.i ?? "start"} data-turn-state={running ? "running" : "done"}>
      {user && <UserMessage u={user.e} i={user.i} id={id} canRevert={canRevert && !running} />}
      {running ? (
        <>
          {user && <Working since={user.e.at} status={status} harness={harness} />}
          {work.length > 0 && <Work items={work} cwd={cwd} running />}
        </>
      ) : work.length > 0 && (
        <div>
          {user?.e.end ? <Fold label={label} at={user.e.end} open={open} onToggle={() => setOpen(!open)} /> : null}
          {(open || !user?.e.end) && <div className="pt-1.5"><Work items={work.filter((x) => x.e.kind !== "note" || x.e.text !== "Stopped.")} cwd={cwd} running={false} /></div>}
        </div>
      )}
      {items.filter((x, n) => outside(x, n)).map((x) => {
        if (x.e.kind === "assistant") return <Answer key={x.i} e={x.e} />
        if (x.e.kind === "ask") return <PlanCard key={x.i} a={x.e} />
        return <div key={x.i} data-note="error" className="flex items-start gap-1.5 px-1 text-[12px] leading-[17px] text-[var(--red)] max-md:text-[15px] max-md:leading-[21px]"><CircleAlert className="mt-px size-3.5 shrink-0" />{(x.e as { text: string }).text}</div>
      })}
      {!running && user?.e.changes && user.e.changes.length > 0 && <ChangedFiles id={id} turn={user.i} changes={user.e.changes} />}
    </div>
  )
}

export function Timeline({ id, entries, harness, cwd, running, status, problem, empty, canRevert, hero }: {
  id: string; entries: Entry[]; harness: Harness; cwd: string; running: boolean; status: string; problem: ReactNode; empty: ReactNode; canRevert: boolean; hero?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [entries, running, status])
  useLayoutEffect(() => { stick.current = true }, [id])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }
    el.addEventListener("scroll", on, { passive: true })
    return () => el.removeEventListener("scroll", on)
  }, [])
  const turns = useMemo(() => turnsOf(entries), [entries])
  return (
    <div ref={ref} className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", hero && "flex flex-col justify-end")} data-agents-messages aria-live="polite">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
        {problem}
        {!entries.length && !problem && empty}
        {turns.map((t, n) => (
          <Turn key={t.user?.i ?? "start"} id={id} turn={t} cwd={cwd} harness={harness} running={running && n === turns.length - 1} status={status} canRevert={canRevert} />
        ))}
      </div>
    </div>
  )
}
