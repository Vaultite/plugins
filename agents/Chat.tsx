// A thread in its tab (view:agents/<id>) as T3 Code's: the header (project, title, git), the turns (Timeline.tsx), the
// diff panel (⌘D) and the box to write in with what waits on you (Banners.tsx); a new thread ("" id) picks where first.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react"
import { AlarmClock, ArrowUp, AtSign, Check, ChevronDown, CircleCheck, FileDiff, FileText, Folder, GitBranch, GitPullRequest, ListTodo, Plus, Square, SquareTerminal, X } from "lucide-react"
import {
  choose, cn, getStore, menuAbove, menuBelow, notify, notifyError, openAgent, openMenu, openView, patch, post, useEnabled, useFocusedFile, useLive, usePluginSettings,
  useScopedState, type MenuItem,
} from "@vaultite"
import { ago, choiceDialog, setState, settle, threadActions, wakeLabel } from "./actions"
import { Approval, planTitle, PlanReady, QueuedMessages, Questions, questionsOf, Tasks, useAnswering, type Task } from "./Banners"
import { DiffPanel, useDiffWidth } from "./DiffPanel"
import { BranchChip, BranchToolbar, GitActions, pickBranch, useGit, type Workspace } from "./GitBar"
import { DEFAULT_MODE, EFFORTS, HARNESSES, ICON, MODES, NAME, SHORT, TINT } from "./harness"
import { summaryOf, useRefused, useSocket, useThread } from "./live"
import { setPanel, toggleDiff, usedThread, usePanel } from "./panel"
import { Timeline } from "./Timeline"
import type { Entry, Harness, Mode, Project, Queued, Status, Summary, Thread } from "./types"
import { button, noteName, pill, tildeOf } from "./ui"

export { tildeOf }
type Ask = Extract<Entry, { kind: "ask" }>
type Image = { type: string; data: string; url: string }

function SignIn({ harness, problem, refresh }: { harness: Harness; problem: "missing" | "signed-out"; refresh: () => void }) {
  const on = useEnabled()
  const terminal = on("terminal") && on(harness === "claude" ? "claude-code" : "codex")
  const site = harness === "claude" ? "https://claude.com/claude-code" : "https://developers.openai.com/codex/cli"
  return (
    <div className="space-y-2 rounded-[10px] border-[0.5px] border-border bg-card p-3 text-[13px] leading-[19px] max-md:text-[16px] max-md:leading-[22px]" data-agents-problem={problem}>
      {problem === "missing" ? (
        <p>{NAME[harness]} isn't installed on the server's machine. Install it from <a className="text-primary hover:underline" href={site} target="_blank" rel="noreferrer">{site.replace("https://", "")}</a>, sign in, then check again.</p>
      ) : harness === "claude" ? (
        <p>Claude Code isn't signed in on the server's machine. Run <code>claude</code> there and sign in with <code>/login</code>, then check again.</p>
      ) : (
        <p>Codex isn't signed in on the server's machine. Run <code>codex login</code> there, then check again.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {problem === "signed-out" && terminal && (
          <button type="button" onClick={() => openAgent(harness)} className={cn(pill, "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground hover:opacity-90")}>
            <SquareTerminal className="size-3.5" />Open {NAME[harness]} to sign in
          </button>
        )}
        <button type="button" onClick={refresh} className={cn(pill, "border-[0.5px] border-border")}>Check again</button>
      </div>
    </div>
  )
}

// ---------- each thread's text being written, kept while it's switched away from (T3 Code's composer drafts)

const drafts = new Map<string, string>()
const draftSubs = new Set<() => void>()
export const setDraftText = (id: string, v: string) => { drafts.set(id, v); draftSubs.forEach((f) => f()) }
const subscribeDrafts = (f: () => void) => { draftSubs.add(f); return () => { draftSubs.delete(f) } }
const useDraftText = (id: string): [string, (v: string) => void] => [useSyncExternalStore(subscribeDrafts, () => drafts.get(id) ?? ""), (v) => setDraftText(id, v)]
/** Whether a thread has text written and not sent (the sidebar's "Unsent draft"). */
export const useHasDraft = (id: string) => useSyncExternalStore(subscribeDrafts, () => !!drafts.get(id)?.trim())

// ---------- choosing where to work, and a pull request into a thread

type Draft = { harness: Harness; cwd: string; model: string; mode: Mode; plan: boolean; effort: string }

/** Pick a project to work in: the vault, project files with a checkout here, folders threads ran in, or one typed. */
export function chooseProject(list: Project[], current: string, onPick: (p: string) => void, title = "Work in") {
  choose({
    title, placeholder: "Find a project, or type a folder's path", current,
    items: list.map((p) => ({ id: p.path, label: p.label, detail: tildeOf(p.path), icon: Folder })),
    other: (typed) => (/^[~/]/.test(typed.trim()) ? { id: typed.trim(), label: `Folder ${typed.trim()}`, icon: Folder } : null),
    onPick: (p) => onPick(p.id),
  })
}

/** T3 Code's Checkout Pull Request: a URL, `gh pr checkout 42` or #42, into a thread on the project's checkout (Local) or
 *  a worktree of its own (Worktree). */
export async function checkoutPr(projects: Project[], cwd: string, ref = "") {
  if (!cwd) return chooseProject(projects.filter((p) => !p.vault), "", (p) => void checkoutPr(projects, p, ref), "Check out a pull request in")
  const got = await choiceDialog({
    title: "Checkout Pull Request", body: `Resolve a GitHub pull request, then create the thread in ${tildeOf(cwd).split("/").pop()}'s checkout or in a dedicated worktree.`,
    field: { label: "Pull request", placeholder: "Pull request URL, checkout command, or #42", value: ref },
    choices: [{ label: "Local", value: "local" as const }, { label: "Worktree", value: "worktree" as const, primary: true }],
  })
  if (!got) return
  try {
    const r = await post<{ id: string; number: number }>("agents/pr", { cwd, ref: got.text, mode: got.value })
    notify(`Checked out #${r.number}`)
    openView(`agents/${r.id}`, { newTab: true })
  } catch (e) { notifyError(e, "Couldn't check out the pull request") }
}

/** The draft a new thread starts from: the agent and folder last picked here (a project's + sets the folder). */
export function useDraft(): [Draft, (d: Partial<Draft>) => void] {
  const [settings] = usePluginSettings("agents")
  const [harness, setHarness] = useScopedState<string>("agents:harness", "", "workspace")
  const [cwd, setCwd] = useScopedState<string>("agents:cwd", "", "workspace")
  const [model, setModel] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const [plan, setPlan] = useState(false)
  const [effort, setEffort] = useState("")
  const h: Harness = HARNESSES.includes(harness as Harness) ? harness as Harness : settings?.harness === "codex" ? "codex" : "claude"
  const own = h === "claude" ? settings?.claudeModel : settings?.codexModel
  const draft: Draft = { harness: h, cwd, model: model ?? (typeof own === "string" ? own : ""), plan, effort,
    mode: mode ?? (MODES.some((m) => m.id === settings?.mode) ? settings!.mode as Mode : DEFAULT_MODE) }
  const set = (d: Partial<Draft>) => {
    if (d.harness) { setHarness(d.harness); setModel(null); setEffort("") }
    if (d.effort !== undefined) setEffort(d.effort)
    if (d.cwd !== undefined) setCwd(d.cwd || undefined)
    if (d.model !== undefined) setModel(d.model)
    if (d.mode) setMode(d.mode)
    if (d.plan !== undefined) setPlan(d.plan)
  }
  return [draft, set]
}

// ---------- writing a message

type ComposerProps = {
  id: string; t: Thread | null; draft: Draft; setDraft: (d: Partial<Draft>) => void; workspace: Workspace; running: boolean; status: Status | null; projects: Project[]
  asks: Ask[]; plan: { at: number; text: string } | null; tasks: { list: Task[]; since?: string } | null; queue: Queued[]; onSent: (id: string) => void; keys: (k: Keys) => void
}
/** What the chat's keys open, from wherever the focus is in it. */
export type Keys = { model: () => void; mode: () => void; effort: () => void; send: (steer: boolean) => void; steerFirst: () => void; editLast: () => void }
/** The chat used last, while it's on screen: the app's commands (⌘⇧M and the rest, index.tsx) act on it. */
export const chatKeys: { current: Record<string, () => void> | null } = { current: null }

/** The box to write in: what waits on you on top, the open note as a chip (in the vault), @ to point at a note, pasted
 *  images; Enter sends (queued while it works, or steered), Esc interrupts. */
function Composer(p: ComposerProps) {
  const { id, draft, setDraft, running, status, projects, asks, queue } = p
  const [text, setText] = useDraftText(id)
  const [images, setImages] = useState<Image[]>([])
  const [sending, setSending] = useState(false)
  const [settings] = usePluginSettings("agents")
  const focused = useFocusedFile().path
  const [dropped, setDropped] = useState("")
  const area = useRef<HTMLTextAreaElement>(null)
  const modelPill = useRef<HTMLButtonElement>(null), modePill = useRef<HTMLButtonElement>(null)
  const h = draft.harness
  const st = status?.[h]
  const ready = !!st?.installed && !!st.loggedIn
  const mode = MODES.find((m) => m.id === draft.mode) ?? MODES[3]
  const models = st?.models ?? []
  const effortLabel = EFFORTS[h].find((x) => x.id === draft.effort)?.label
  const modelLabel = `${draft.model ? models.find((m) => m.value === draft.model)?.label ?? draft.model : "Default model"}${effortLabel ? ` · ${effortLabel}` : ""}`
  const project = projects.find((x) => x.path === draft.cwd)
  const inVault = !!project?.vault
  const note = inVault && focused && dropped !== focused ? focused : ""
  const question = asks.find((a) => a.tool === "AskUserQuestion")
  const approval = asks.filter((a) => a.tool !== "AskUserQuestion")
  const answering = useAnswering(question)
  const qs = question ? questionsOf(question) : []
  const steerDefault = settings?.followUp === "steer"
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  useEffect(() => { area.current?.focus() }, [id])

  const send = async (steer = steerDefault, said = text.trim(), extra: Record<string, unknown> = {}) => {
    if ((!said && !images.length) || sending || !ready) return
    setSending(true)
    try {
      const to = id || (await post<{ id: string }>("agents/threads", { harness: h, cwd: draft.cwd, model: draft.model, mode: draft.mode, plan: draft.plan, effort: draft.effort,
        ...(p.workspace.worktree ? { worktree: true, base: p.workspace.branch } : p.workspace.branch ? { branch: p.workspace.branch, create: !!p.workspace.create } : {}) })).id
      await post(`agents/threads/${to}/send`, { text: said, file: note || undefined, images: images.map(({ type, data }) => ({ type, data })), ...(running ? { steer } : {}), ...extra })
      setText(""); setImages([])
      if (!id) setDraftText("", "")
      p.onSent(to)
    } catch (e) {
      notifyError(e, "Couldn't send it")
    } finally {
      setSending(false)
    }
  }
  const stop = () => void post(`agents/threads/${id}/stop`, {}).catch((e) => notifyError(e, "Couldn't stop it"))

  // The agent's questions: an option picked, or what's typed (its own answer), for each; then sent back together.
  const answerNow = async () => {
    if (!answering || !question) return
    const q = qs[answering.index]
    const typed = text.trim()
    const picked = { ...answering.picked, ...(typed ? { [q.question]: [typed] } : {}) }
    if (typed) { answering.set(q.question, [typed]); setText("") }
    if (answering.index < qs.length - 1) return answering.go(answering.index + 1)
    const answers = Object.fromEntries(qs.filter((x) => picked[x.question]?.length).map((x) => [x.question, picked[x.question].join(", ")]))
    setSending(true)
    try { await post(`agents/threads/${id}/answer`, { ask: question.id, allow: true, answers }) } catch (e) { notifyError(e, "Couldn't answer") } finally { setSending(false) }
  }
  const qDone = !!answering && qs.every((x, i) => (answering.picked[x.question]?.length ?? 0) > 0 || (i === answering.index && !!text.trim()))
  const qCanAdvance = !!answering && ((answering.picked[qs[answering.index]?.question]?.length ?? 0) > 0 || !!text.trim())

  // A plan that's ready: Implement (here, out of plan mode) or in a new thread; typing refines it instead.
  const implement = async (where: "here" | "thread") => {
    if (!p.plan) return
    setSending(true)
    try {
      const r = await post<{ id: string }>(`agents/threads/${id}/implement`, { at: p.plan.at, where })
      if (where === "thread") openView(`agents/${r.id}`, { newTab: true })
    } catch (e) { notifyError(e, "Couldn't implement it") } finally { setSending(false) }
  }

  /** @: a vault note, put in as its path. */
  const mention = (replaceAt = -1) => {
    const files = [...getStore()?.files.files ?? []].sort((a, b) => b.mtime - a.mtime)
    choose({
      title: "Point the agent at a note", placeholder: "Find a note", items: files.slice(0, 3000).map((f) => ({ id: f.path, label: f.title || noteName(f.path), detail: f.path, icon: FileText })),
      onPick: (f) => {
        const el = area.current
        const at = replaceAt >= 0 ? replaceAt : el?.selectionStart ?? text.length
        const before = text.slice(0, at), after = text.slice(replaceAt >= 0 ? at + 1 : at)
        const put = `@${f.id} `
        setText(before + put + after)
        requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(before.length + put.length, before.length + put.length) })
      },
      onDismiss: () => requestAnimationFrame(() => area.current?.focus()),
    })
  }
  const harnessMenu = (): MenuItem[] => HARNESSES.map((x) => ({ label: NAME[x], icon: ICON[x], checked: h === x, run: () => setDraft({ harness: x, model: "" }) }))
  const effortMenu = (): MenuItem[] => [
    { label: "Default effort", checked: !draft.effort, hint: `${SHORT[h]}'s`, run: () => setDraft({ effort: "" }) },
    ...EFFORTS[h].map((x) => ({ label: x.label, checked: draft.effort === x.id, run: () => setDraft({ effort: x.id }) })),
  ]
  const modelMenu = (): MenuItem[] => [
    { label: "Default model", checked: !draft.model, hint: `${SHORT[h]}'s`, run: () => setDraft({ model: "" }) },
    ...models.map((m) => ({ label: m.label, checked: draft.model === m.value, run: () => setDraft({ model: m.value }) })),
    { label: "Effort", sep: true, hint: effortLabel ?? "default", run: () => {}, items: effortMenu() },
  ]
  const modeMenu = (): MenuItem[] => [
    ...MODES.map((m) => ({ label: m.label, icon: m.icon, hint: m.hint, checked: mode.id === m.id, run: () => setDraft({ mode: m.id }) })),
    { label: "Plan mode", icon: ListTodo, checked: draft.plan, sep: true, hint: "plans first", run: () => setDraft({ plan: !draft.plan }) },
  ]
  const above = (el: HTMLElement | null, items: MenuItem[]) => { if (!el) return; const r = el.getBoundingClientRect(); openMenu({ x: r.left, y: r.top - 4 }, items, true) }
  const queuedEdit = (q: Queued) => { setText(q.text); requestAnimationFrame(() => area.current?.focus()) }
  const steerFirst = () => { const q = queue[0]; if (q && running) void post(`agents/threads/${id}/queue/${q.id}`, { action: "steer" }).catch((e) => notifyError(e, "Couldn't steer with it")) }
  const editLast = () => { const q = queue.at(-1); if (q && !text) void post(`agents/threads/${id}/queue/${q.id}`, { action: "remove" }).then(() => queuedEdit(q)).catch(() => {}) }
  p.keys({ model: () => above(modelPill.current, modelMenu()), mode: () => above(modePill.current, modeMenu()), effort: () => above(modelPill.current, effortMenu()), send: (steer) => void send(steer), steerFirst, editLast })

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const phone = matchMedia("(pointer: coarse)").matches
    const mod = e.metaKey || e.ctrlKey
    if (e.key === "Enter" && mod && e.shiftKey && running) { e.preventDefault(); return steerFirst() }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (!phone || mod)) {
      e.preventDefault()
      if (question) return void answerNow()
      if (planShown && !text.trim()) return void implement("here")
      return void send(running && mod ? !steerDefault : steerDefault)
    }
    if (e.key === "ArrowUp" && e.altKey && !text) { e.preventDefault(); return editLast() }
    if (e.key === "Escape" && running) { e.preventDefault(); stop() }
  }
  const onInput = (v: string, caret: number) => {
    setText(v)
    if (inVault && v[caret - 1] === "@" && (caret === 1 || /\s/.test(v[caret - 2])) && v.length > text.length) mention(caret - 1)
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => addImages([...e.clipboardData.files], () => e.preventDefault())
  /** Images pasted or dropped on the box: up to six, sent with the message. */
  const addImages = (all: File[], take: () => void) => {
    const files = all.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type))
    if (!files.length) return
    take()
    for (const f of files.slice(0, 6)) {
      const r = new FileReader()
      r.onload = () => { const url = String(r.result); setImages((xs) => [...xs, { type: f.type, data: url.slice(url.indexOf(",") + 1), url }].slice(0, 6)) }
      r.readAsDataURL(f)
    }
  }
  const planShown = !!p.plan && !running && !asks.length
  const HIcon = ICON[h]
  const MIcon = mode.icon
  const placeholder = !ready ? `${NAME[h]} isn't ready`
    : approval.length ? "Resolve this approval request to continue"
    : question ? (qs[answering?.index ?? 0]?.options.length && qs[answering?.index ?? 0]?.other === false ? "Choose an option above" : "Type your own answer, or leave this blank to use the selected option")
    : planShown ? "Add feedback to refine the plan, or leave this blank to implement it"
    : running ? (steerDefault ? "Steer the agent: this goes into what it's doing" : "Queue a follow-up for when it's done")
    : inVault ? "Ask anything, @ to point at a note" : "Ask anything"
  const primary = "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-40 max-md:h-11 max-md:px-4 max-md:text-[16px]"
  return (
    <div className="mx-auto w-full max-w-[760px] overflow-hidden rounded-[20px] border-[0.5px] border-border bg-background shadow-[0_4px_18px_rgb(0_0_0/0.06)] focus-within:border-primary/70" data-composer
      onDragOver={(e) => { if ([...e.dataTransfer.items].some((x) => x.type.startsWith("image/"))) e.preventDefault() }}
      onDrop={(e) => addImages([...e.dataTransfer.files], () => e.preventDefault())}>
      {queue.length > 0 && <QueuedMessages id={id} queue={queue} running={running} onEdit={queuedEdit} />}
      {p.tasks && <Tasks tasks={p.tasks.list} since={p.tasks.since} />}
      {answering && <Questions a={answering} id={id} busy={sending} />}
      {approval.length > 0 && <Approval asks={approval} id={id} harness={h} cwd={draft.cwd} />}
      {planShown && <PlanReady title={planTitle(p.plan!.text)} />}
      {(note || images.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2">
          {note && (
            <span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-[6px] bg-muted pr-0.5 pl-1.5 text-[12px] text-muted-foreground max-md:h-8 max-md:text-[14px]" data-note-chip={note}
              data-tip="Sent with your message: the note open beside the thread">
              <FileText className="size-3 shrink-0" /><span className="truncate">{noteName(note).split("/").pop()}</span>
              <button type="button" aria-label="Don't send this note" onClick={() => setDropped(note)} className="grid size-4.5 shrink-0 cursor-pointer place-items-center rounded-[4px] hover:bg-foreground/[0.08] hover:text-foreground max-md:size-7">
                <X className="size-3" strokeWidth={2.25} />
              </button>
            </span>
          )}
          {images.map((im, i) => (
            <span key={i} className="relative" data-image-chip>
              <img src={im.url} alt="Pasted image" className="h-10 rounded-[4px] border-[0.5px] border-border object-cover" />
              <button type="button" aria-label="Remove the image" onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 grid size-4 cursor-pointer place-items-center rounded-full bg-foreground text-background"><X className="size-2.5" strokeWidth={3} /></button>
            </span>
          ))}
        </div>
      )}
      <textarea ref={area} value={text} rows={2} placeholder={placeholder} disabled={approval.length > 0}
        aria-label={`Message to ${NAME[h]}`} onChange={(e) => onInput(e.target.value, e.target.selectionStart)} onKeyDown={onKey} onPaste={onPaste} data-agents-input data-keeps-keys
        className="block max-h-[240px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-[20px] outline-none placeholder:text-tertiary disabled:cursor-not-allowed max-md:text-[17px] max-md:leading-[23px]" />
      <div className="flex items-center gap-0.5 px-2 pb-2">
        {id ? (
          <span className={cn(pill, "shrink-0 cursor-default hover:bg-transparent hover:text-muted-foreground")} data-agents-harness={h} data-tip={NAME[h]}><HIcon className="size-3.5 shrink-0" style={{ color: TINT[h] }} /><span className="max-md:hidden">{SHORT[h]}</span></span>
        ) : (
          <button type="button" className={cn(pill, "shrink-0")} data-tip="The agent" data-agents-harness={h} onClick={(e) => menuAbove(e, harnessMenu())}>
            <HIcon className="size-3.5 shrink-0" style={{ color: TINT[h] }} /><span className="max-md:hidden">{SHORT[h]}</span>
          </button>
        )}
        <button ref={modelPill} type="button" className={cn(pill, "min-w-0 shrink")} data-tip="The model it uses and how hard it thinks (⌘⇧M, ⌘⇧E)" data-agents-model={draft.model || "default"} data-agents-effort={draft.effort || "default"} onClick={(e) => menuAbove(e, modelMenu())}><span className="truncate">{modelLabel}</span></button>
        <button ref={modePill} type="button" className={cn(pill, "min-w-0 shrink")} data-tip={`${mode.tip} (⌘⇧A)`} data-agents-mode={mode.id} onClick={(e) => menuAbove(e, modeMenu())}>
          <MIcon className="size-3.5 shrink-0" /><span className="truncate">{mode.label}</span>
        </button>
        <button type="button" className={cn(pill, "shrink-0", draft.plan && "bg-[color-mix(in_srgb,var(--blue)_14%,transparent)] text-[var(--blue)] hover:bg-[color-mix(in_srgb,var(--blue)_20%,transparent)] hover:text-[var(--blue)]")}
          aria-pressed={draft.plan} data-agents-plan={draft.plan || undefined} data-tip={draft.plan ? "Plan mode: it reads and proposes a plan, changing nothing. Click to leave it" : "Plan first: it reads and proposes a plan, changing nothing"}
          onClick={() => setDraft({ plan: !draft.plan })}><ListTodo className="size-3.5 shrink-0" /><span className="max-md:hidden">Plan</span></button>
        {inVault && <button type="button" className={button} aria-label="Point the agent at a note" data-tip="Point the agent at a note (@)" onClick={() => mention()}><AtSign className="size-3.5 max-md:size-5" /></button>}
        <span className="flex-1" />
        {p.t?.context && <ContextMeter c={p.t.context} />}
        {question ? (
          <span className="flex items-center gap-1.5">
            {answering && answering.index > 0 && <button type="button" className={cn(pill, "h-8")} onClick={() => answering.go(answering.index - 1)} data-question-back>Previous</button>}
            <button type="button" className={primary} disabled={sending || (answering!.index === qs.length - 1 ? !qDone : !qCanAdvance)} onClick={() => void answerNow()} data-question-submit>
              {sending ? "Submitting..." : answering!.index < qs.length - 1 ? <><span className="max-md:hidden">Next question</span><span className="md:hidden">Next</span></>
                : <><span className="max-md:hidden">{qs.length > 1 ? "Submit answers" : "Submit answer"}</span><span className="md:hidden">Submit</span></>}
            </button>
          </span>
        ) : planShown && !text.trim() ? (
          <span className="flex items-center" data-implement>
            <button type="button" className={cn(primary, "rounded-r-none pr-3")} disabled={sending} onClick={() => void implement("here")} data-implement-here>{sending ? "Sending..." : "Implement"}</button>
            <button type="button" aria-label="Implementation actions" className={cn(primary, "rounded-l-none border-l-[0.5px] border-primary-foreground/25 px-2")} disabled={sending}
              onClick={(e) => menuAbove(e, [{ label: "Implement in a new thread", icon: Plus, run: () => void implement("thread") }])}><ChevronDown className="size-3.5" /></button>
          </span>
        ) : planShown ? (
          <button type="button" className={primary} disabled={sending} onClick={() => void send()} data-refine>{sending ? "Sending..." : "Refine"}</button>
        ) : running && !text.trim() && !images.length ? (
          <button type="button" onClick={stop} aria-label="Interrupt" data-tip="Interrupt (Esc)" data-agents-stop
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-[var(--red)] text-white hover:opacity-85 max-md:size-11">
            <Square className="size-3 fill-current max-md:size-4" />
          </button>
        ) : (
          <button type="button" onClick={() => void send()} disabled={(!text.trim() && !images.length) || sending || !ready} aria-label={running ? (steerDefault ? "Steer" : "Queue") : "Send"}
            data-tip={running ? (steerDefault ? "Steer: into what it's doing (⌘↩ queues it instead)" : "Queue it for when it's done (⌘↩ steers instead)") : "Send (↩)"} data-agents-send
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-40 max-md:size-11">
            <ArrowUp className="size-4 max-md:size-5" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
}

/** How full its context is, as T3 Code's meter: a ring, the numbers on hover. */
function ContextMeter({ c }: { c: { used: number; max: number } }) {
  const f = Math.min(1, c.used / c.max), r = 6.5, len = 2 * Math.PI * r
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
  return (
    <span className="grid size-7 shrink-0 place-items-center" data-context={Math.round(f * 100)} data-tip={`Context window: ${k(c.used)} of ${k(c.max)} tokens (${Math.round(f * 100)}%)`}>
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-label={`Context ${Math.round(f * 100)}% full`}>
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" className="text-foreground/10" />
        <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${len * f} ${len}`}
          stroke={f > 0.85 ? "var(--red)" : f > 0.6 ? "var(--orange)" : "currentColor"} className="text-muted-foreground" />
      </svg>
    </span>
  )
}

// ---------- the line at the end of a settled or snoozed thread

function StatusLine({ s }: { s: Summary | null }) {
  if (!s) return null
  const line = (icon: ReactNode, label: string, action: string, run: () => void, kind: string) => (
    <div className="flex items-center justify-center gap-2 py-1 text-[12px] text-muted-foreground max-md:text-[15px]" data-status-line={kind}>
      <span className="grid place-items-center [&>svg]:size-3.5">{icon}</span><span>{label}</span>
      <button type="button" onClick={run} className="cursor-pointer rounded-[5px] px-1.5 py-0.5 font-medium text-foreground hover:bg-foreground/[0.06]" data-status-action>{action}</button>
    </div>
  )
  if (s.snoozedUntil) return line(<AlarmClock />, `Snoozed, until ${wakeLabel(s.snoozedUntil)}`, "Wake now", () => void setState(s.id, { snoozedUntil: null }), "snoozed")
  if (s.settledAt) return line(<CircleCheck />, `Settled ${ago(s.settledAt) === "now" ? "just now" : `${ago(s.settledAt)} ago`}`, "Un-settle", () => void settle(s.id, false), "settled")
  return null
}

// ---------- the whole thread

export function Chat({ id, setId }: { id: string; setId: (id: string) => void }) {
  useSocket()
  const refused = useRefused()
  const shown = useThread(id)
  const [check, setCheck] = useState(0)
  const { data: status } = useLive<Status>(check ? `agents/status?fresh=${check}` : "agents/status", check)
  const { data: projectList } = useLive<{ list: Project[] }>("agents/projects", shown?.thread?.cwd ?? "")
  const projects = useMemo(() => projectList?.list ?? [], [projectList])
  const [draft, setDraft] = useDraft()
  const [workspace, setWorkspace] = useState<Workspace>({ worktree: false, branch: "" })
  const [renameOn, setRenameOn] = useState(false)
  const on = useEnabled()
  const panel = usePanel(id)
  const width = useDiffWidth()
  const keys = useRef<Keys | null>(null)
  useEffect(() => { if (shown?.gone) setId("") }, [shown?.gone]) // eslint-disable-line react-hooks/exhaustive-deps

  const t = shown?.thread ?? null
  const entries = useMemo(() => t?.entries ?? [], [t])
  const live = shown?.live ?? { running: false, status: "" }
  const turnsDone = entries.filter((e) => e.kind === "user" && (e as { end?: string }).end).length
  const { git, reload } = useGit(t ? id : "", `${turnsDone}|${live.running}|${entries.filter((e) => e.kind === "note").length}|${t?.cwd ?? ""}`)
  // A new thread's draft folder is the vault until one is picked.
  const cwd = t?.cwd ?? (draft.cwd || projects.find((p) => p.vault)?.path || "")
  useEffect(() => { setWorkspace({ worktree: false, branch: "" }) }, [cwd])
  const d: Draft = t ? { harness: t.harness, cwd: t.cwd, model: t.model, mode: t.mode, plan: !!t.plan, effort: t.effort ?? "" } : { ...draft, cwd }
  const setD = (x: Partial<Draft>) => {
    if (!t) return setDraft(x)
    const body: Record<string, unknown> = {}
    if (x.model !== undefined) body.model = x.model
    if (x.mode) body.mode = x.mode
    if (x.plan !== undefined) body.plan = x.plan
    if (x.effort !== undefined) body.effort = x.effort
    void patch(`agents/threads/${id}`, body).catch((e) => notifyError(e, "Couldn't change it"))
  }
  const h = d.harness
  const st = status?.[h]
  const problem = refused ? <p className="px-1 text-[13px] text-muted-foreground">{refused}</p>
    : st && !st.installed ? <SignIn harness={h} problem="missing" refresh={() => setCheck(Date.now())} />
    : st && !st.loggedIn ? <SignIn harness={h} problem="signed-out" refresh={() => setCheck(Date.now())} /> : null
  const lastSignIn = entries.at(-1)?.kind === "note" && (entries.at(-1) as { signIn?: boolean }).signIn
  const home = t?.worktree?.from ?? cwd
  const project = projects.find((p) => p.path === home)
  const projectName = project?.label ?? tildeOf(home).split("/").pop()
  const title = t?.title ?? (id ? "" : "New thread")
  const asks = entries.filter((e) => e.kind === "ask" && !e.answer) as Ask[]
  const diffOpen = !!id && panel.open
  const summary = id ? summaryOf(id) : null
  // The plan waiting for Implement: the last thing a turn left, not acted on.
  const plan = useMemo(() => {
    const at = entries.findLastIndex((e) => e.kind === "plan")
    const e = entries[at]
    if (e?.kind !== "plan" || e.done || e.open || entries.slice(at + 1).some((x) => x.kind === "user")) return null
    return { at, text: e.text }
  }, [entries])
  // Its to-do list (Claude's TodoWrite, Codex's plan): the latest turn's, while it isn't all done or the turn goes on.
  const tasks = useMemo(() => {
    const from = entries.findLastIndex((e) => e.kind === "user" && !e.steer)
    const todo = entries.slice(from + 1).findLast((e) => e.kind === "tool" && e.name === "TodoWrite") as Extract<Entry, { kind: "tool" }> | undefined
    const list = Array.isArray(todo?.input.todos) ? (todo!.input.todos as Task[]).filter((x) => x && typeof x.content === "string") : []
    if (!list.length || (!live.running && list.every((x) => x.status === "completed"))) return null
    return { list, since: (entries.slice(from + 1).filter((e) => e.kind === "tool" && e.name === "TodoWrite").at(-1) as { at?: string } | undefined)?.at }
  }, [entries, live.running])
  const menuOf = (): MenuItem[] => summary && t ? threadActions(summary, { on, started: t.started, rename: () => setRenameOn(true), gone: () => setId(""),
    newOnBranch: summary.branch ? () => void post<{ id: string }>("agents/threads", { harness: t.harness, cwd: t.cwd, model: t.model, mode: t.mode, share: t.id }).then((r) => openView(`agents/${r.id}`, { newTab: true })).catch((e) => notifyError(e, "Couldn't start it")) : undefined }) : []
  const branch = () => {
    if (!id) return pickBranch(cwd, workspace, setWorkspace, projects)
    if (t?.worktree) return notify("A worktree thread keeps its own branch")
    if (live.running) return notify("Wait for the agent to finish, or stop it")
    pickBranch(t?.cwd ?? cwd, { worktree: false, branch: git?.branch ?? "" }, (w) => {
      if (w.branch) void post(`agents/threads/${id}/git`, { action: "switch", branch: w.branch, create: !!w.create }).then(() => { notify(`On ${w.branch}`); reload() }).catch((e) => notifyError(e, "Couldn't switch branch"))
    }, projects, git?.branch)
  }
  // T3 Code's keys: from anywhere in the thread here (the box to write in keeps its keys from the app), and as the app's
  // commands while this is the chat used last.
  const actions: Record<string, () => void> = {
    m: () => keys.current?.model(), a: () => keys.current?.mode(), e: () => keys.current?.effort(), g: branch,
    ...(!id ? { x: () => setWorkspace({ worktree: !workspace.worktree, branch: "" }) } : {}),
    ...(summary ? { s: () => void settle(id, !summary.settledAt), p: () => void setState(id, { pinned: !summary.pinnedAt }) } : {}),
    ...(git?.pr ? { k: () => { void navigator.clipboard?.writeText(`#${git.pr!.number}`); notify(`Copied #${git.pr!.number}`) } } : {}),
  }
  const mine = useRef(actions)
  mine.current = actions
  const here = useMemo(() => new Proxy({}, { get: (_, k: string) => mine.current[k] }) as Record<string, () => void>, [])
  useEffect(() => {
    chatKeys.current = here
    return () => { if (chatKeys.current === here) chatKeys.current = null }
  }, [here])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || e.altKey) return
    const k = e.key.toLowerCase()
    const run = (f: () => void) => { e.preventDefault(); e.stopPropagation(); f() }
    if (!e.shiftKey && k === "d" && id) return run(() => toggleDiff(id))
    if (e.shiftKey && actions[k]) return run(actions[k])
  }

  return (
    <div className="flex min-h-0 flex-1" data-agents-thread={id || "new"} data-harness={h} data-running={live.running || undefined}
      onKeyDownCapture={onKeyDown} onFocusCapture={() => { usedThread(id); chatKeys.current = here }} onPointerDownCapture={() => { usedThread(id); chatKeys.current = here }}>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", diffOpen && "max-md:hidden")}>
        <div className="flex h-10 shrink-0 items-center gap-1 border-b-[0.5px] border-border pr-2 pl-3 max-md:h-12 max-md:pl-2" data-agents-head>
          <button type="button" className="inline-flex min-w-0 shrink cursor-pointer items-center gap-1 rounded-[5px] px-0.5 text-[13px] text-muted-foreground hover:text-foreground max-md:hidden" data-tip={`New thread in ${projectName}`} data-agents-project-name
            onClick={() => { setDraft({ cwd: home, harness: h }); openView("agents/", { newTab: true }) }}>
            <Folder className="size-3.5 shrink-0" /><span className="truncate">{projectName}</span><span className="text-tertiary">/</span>
          </button>
          {renameOn && t ? (
            <input autoFocus defaultValue={t.title} aria-label="Thread title" data-agents-rename
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenameOn(false)
                if (e.key !== "Enter") return
                const v = e.currentTarget.value.trim()
                setRenameOn(false)
                if (v && v !== t.title) void patch(`agents/threads/${id}`, { title: v }).catch((x) => notifyError(x, "Couldn't rename it"))
              }}
              onBlur={() => setRenameOn(false)}
              className="h-6 min-w-0 flex-1 rounded-[5px] border-[0.5px] border-primary bg-background px-1.5 text-[14px] outline-none" />
          ) : (
            <button type="button" className="inline-flex min-w-0 cursor-pointer items-center gap-1 truncate rounded-[5px] px-1 text-left text-[14px] font-semibold hover:bg-foreground/[0.06] max-md:hidden" data-agents-title
              onClick={(e) => { const items = menuOf(); if (items.length) menuBelow(e, items) }} onDoubleClick={() => t && setRenameOn(true)} aria-label={t ? `Thread actions for ${t.title}` : undefined}>
              <span className="truncate">{title}</span>
              {summary?.settledAt && <Check className="size-3.5 shrink-0 text-[var(--green)]" aria-label="Settled" />}
            </button>
          )}
          {git && <BranchChip g={git} />}
          <span className="flex-1" />
          {git && t && <GitActions id={id} g={git} running={live.running} reload={reload} />}
          {id && (
            <button type="button" className={cn(button, panel.open && "bg-foreground/[0.08] text-foreground")} aria-pressed={panel.open} aria-label="Toggle diff" data-tip="Toggle diff (⌘D)" data-agents-diff-toggle
              onClick={() => toggleDiff(id)}><FileDiff className="size-4" /></button>
          )}
        </div>
        <Timeline id={id} entries={entries} harness={h} cwd={cwd} running={live.running} status={live.status} canRevert={!!git} hero={!id && !entries.length}
          onEdit={(text) => { setDraftText(id, text) }} footer={<StatusLine s={summary} />}
          problem={problem ?? (lastSignIn ? <SignIn harness={h} problem="signed-out" refresh={() => setCheck(Date.now())} /> : null)}
          empty={(
            <div className="pb-4 text-center" data-agents-hero>
              <h2 className="text-[22px] font-semibold tracking-[-0.01em] max-md:text-[24px]">{project?.vault ? "What should we work on in your vault?" : `What should we build in ${projectName}?`}</h2>
              <button type="button" className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground max-md:text-[16px]" data-agents-project={cwd}
                onClick={() => chooseProject(projects, cwd, (p) => setDraft({ cwd: p }))}>
                <Folder className="size-3.5" />{tildeOf(home)}
              </button>
            </div>
          )} />
        <div className="shrink-0 px-3 pb-3">
          <Composer id={id} t={t} draft={d} setDraft={setD} workspace={workspace} running={live.running} status={status ?? null} projects={projects} asks={asks}
            plan={plan} tasks={tasks} queue={t?.queue ?? []} keys={(k) => { keys.current = k }}
            onSent={(to) => { if (to !== id) setId(to) }} />
          {!id && <BranchToolbar cwd={cwd} value={workspace} onChange={setWorkspace} projects={projects} />}
          {id && git && (
            <div className="mx-auto flex w-full max-w-[760px] items-center gap-1 px-2.5 pt-1.5 text-[11px] text-tertiary max-md:text-[13px]" data-agents-context>
              <span>{git.worktree ? "Worktree" : "Local checkout"}</span><span>·</span>
              <button type="button" onClick={branch} className="inline-flex min-w-0 cursor-pointer items-center gap-0.5 truncate font-mono hover:text-foreground" data-tip="Branch (⌘⇧G)"><GitBranch className="size-3 shrink-0" />{git.branch}</button>
              {git.files > 0 && <><span>·</span><span>{git.files === 1 ? "1 uncommitted file" : `${git.files} uncommitted files`}</span></>}
              {git.pr && <><span>·</span><span className="inline-flex items-center gap-0.5"><GitPullRequest className="size-3" />#{git.pr.number}</span></>}
            </div>
          )}
        </div>
      </div>
      {diffOpen && (
        <div className="relative flex min-h-0 shrink-0 border-l-[0.5px] border-border max-md:fixed max-md:inset-0 max-md:z-[55] max-md:w-full! max-md:border-0" style={{ width: `${width.width * 100}%` }}>
          <div role="separator" aria-orientation="vertical" aria-label="Resize the diff panel" onPointerDown={width.start} onDoubleClick={width.reset}
            className="absolute inset-y-0 -left-1 z-[2] w-2 cursor-col-resize max-md:hidden" />
          <div className="min-w-0 flex-1"><DiffPanel id={id} entries={entries} running={live.running} git={!!git} onClose={() => setPanel(id, { open: false })} /></div>
        </div>
      )}
    </div>
  )
}

export type { Draft }
