// A thread in its tab (view:agents/<id>), laid out as T3 Code's: a header with the project, the title and the branch's
// git actions; the turns (Timeline.tsx); the diff panel beside them (⌘D, DiffPanel.tsx); questions to approve above the
// box to write in. A new thread ("" id) picks its agent, project, workspace and branch in that box first.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react"
import { ArrowUp, AtSign, FileDiff, FileText, Folder, Pencil, ShieldAlert, Square, SquareTerminal, Trash2, X } from "lucide-react"
import {
  choose, cn, confirmDialog, del, getStore, Markdown, menuAbove, menuBelow, notify, notifyError, openAgent, patch, post, useEnabled, useFocusedFile,
  useLive, usePluginSettings, useScopedState, type MenuItem,
} from "@vaultite"
import { DiffPanel, useDiffWidth } from "./DiffPanel"
import { BranchChip, BranchToolbar, GitActions, useGit, type Workspace } from "./GitBar"
import { HARNESSES, ICON, MODES, NAME, SHORT, TINT } from "./harness"
import { useRefused, useSocket, useThread } from "./live"
import { setPanel, toggleDiff, usedThread, usePanel } from "./panel"
import { Timeline } from "./Timeline"
import type { Entry, Harness, Mode, Project, Status } from "./types"
import { button, describe, Diff, diffLines, EDITS, FileLink, noteName, pill, tildeOf } from "./ui"

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

// ---------- a question to approve: above the box to write in, one at a time

function Approval({ asks, id, harness, cwd }: { asks: Ask[]; id: string; harness: Harness; cwd: string }) {
  const [busy, setBusy] = useState(false)
  const a = asks[0]
  const plan = a.tool === "ExitPlanMode"
  const edit = EDITS.test(a.tool)
  const d = describe(a.tool, a.input, cwd, a.file, a.path)
  const answer = async (allow: boolean) => {
    setBusy(true)
    try { await post(`agents/threads/${id}/answer`, { ask: a.id, allow }) } catch (e) { notifyError(e, "Couldn't answer") } finally { setBusy(false) }
  }
  const head = plan ? "Plan ready" : edit ? "File change approval" : a.tool === "Bash" ? "Command approval" : a.tool === "WebFetch" ? "Web page approval" : "Tool approval"
  return (
    <div className="border-b-[0.5px] border-[color-mix(in_srgb,var(--yellow)_45%,transparent)] bg-[color-mix(in_srgb,var(--yellow)_10%,transparent)] px-3 pt-2.5 pb-2" data-ask="waiting" data-ask-tool={a.tool} data-approval>
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[13px] font-medium max-md:text-[16px]">
        <ShieldAlert className="size-4 shrink-0 text-[var(--orange)]" />
        <span className="shrink-0">{head}</span>
        {asks.length > 1 && <span className="shrink-0 text-[12px] font-normal text-muted-foreground tabular-nums">1/{asks.length}</span>}
        {edit && (a.file ? <FileLink file={a.file} className="text-[12px]">{noteName(a.file)}</FileLink> : <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">{d.what}</span>)}
        {!plan && !edit && a.tool !== "Bash" && <span className="min-w-0 truncate text-[12px] font-normal text-muted-foreground">{SHORT[harness]} wants to {d.verb.toLowerCase()} {d.what}</span>}
      </div>
      {plan ? <div className="mb-2 max-h-60 overflow-y-auto"><Markdown text={String(a.input.plan ?? "")} className="text-[13px]" /></div>
        : edit ? <div className="mb-2 space-y-1">{a.text && <p className="text-[12px] text-muted-foreground max-md:text-[14px]">{a.text}</p>}<Diff lines={diffLines(a.tool, a.input, a.patch)} /></div>
        : a.tool === "Bash" ? (
          <div className="mb-2 space-y-1">
            {typeof a.input.description === "string" && <p className="text-[12px] text-muted-foreground max-md:text-[14px]">{a.input.description}</p>}
            <pre className="max-h-20 overflow-auto rounded-[8px] bg-background/70 px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{String(a.input.command ?? "")}</pre>
          </div>
        ) : <pre className="mb-2 max-h-20 overflow-auto rounded-[8px] bg-background/70 px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{a.input.url ? String(a.input.url) : JSON.stringify(a.input, null, 2)}</pre>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => void answer(false)} data-answer="deny"
          className="inline-flex h-7 cursor-pointer items-center rounded-[6px] border-[0.5px] border-border bg-background px-3 text-[13px] font-medium hover:bg-foreground/[0.06] disabled:opacity-50 max-md:h-11 max-md:px-4 max-md:text-[16px]">
          {plan ? "Keep planning" : "Decline"}
        </button>
        <button type="button" disabled={busy} onClick={() => void answer(true)} data-answer="allow"
          className="inline-flex h-7 cursor-pointer items-center rounded-[6px] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 max-md:h-11 max-md:px-4 max-md:text-[16px]">
          {plan ? "Implement" : "Approve"}
        </button>
      </div>
    </div>
  )
}

// ---------- writing a message

type Draft = { harness: Harness; cwd: string; model: string; mode: Mode }

/** Pick a project to work in: the vault, project files with a checkout here, folders threads ran in, or one typed. */
export function chooseProject(list: Project[], current: string, onPick: (p: string) => void) {
  choose({
    title: "Work in", placeholder: "Find a project, or type a folder's path", current,
    items: list.map((p) => ({ id: p.path, label: p.label, detail: tildeOf(p.path), icon: Folder })),
    other: (typed) => (/^[~/]/.test(typed.trim()) ? { id: typed.trim(), label: `Folder ${typed.trim()}`, icon: Folder } : null),
    onPick: (p) => onPick(p.id),
  })
}

/** The box to write in: questions to approve on top, the open note as a chip (in the vault), @ to point at a note, pasted
 *  images; Enter sends, Esc interrupts. */
function Composer({ id, draft, setDraft, workspace, running, status, projects, asks, onSent }: {
  id: string; draft: Draft; setDraft: (d: Partial<Draft>) => void; workspace: Workspace; running: boolean; status: Status | null; projects: Project[]; asks: Ask[]; onSent: (id: string) => void
}) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<Image[]>([])
  const [sending, setSending] = useState(false)
  const focused = useFocusedFile().path
  const [dropped, setDropped] = useState("")
  const area = useRef<HTMLTextAreaElement>(null)
  const h = draft.harness
  const st = status?.[h]
  const ready = !!st?.installed && !!st.loggedIn
  const mode = MODES.find((m) => m.id === draft.mode) ?? MODES[0]
  const models = st?.models ?? []
  const modelLabel = draft.model ? models.find((m) => m.value === draft.model)?.label ?? draft.model : "Default model"
  const project = projects.find((p) => p.path === draft.cwd)
  const inVault = !!project?.vault
  const note = inVault && focused && dropped !== focused ? focused : ""
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  useEffect(() => { area.current?.focus() }, [id])

  const send = async () => {
    const said = text.trim()
    if ((!said && !images.length) || sending || running || !ready) return
    setSending(true)
    try {
      const to = id || (await post<{ id: string }>("agents/threads", { harness: h, cwd: draft.cwd, model: draft.model, mode: draft.mode,
        ...(workspace.worktree ? { worktree: true, base: workspace.branch } : workspace.branch ? { branch: workspace.branch } : {}) })).id
      await post(`agents/threads/${to}/send`, { text: said, file: note || undefined, images: images.map(({ type, data }) => ({ type, data })) })
      setText(""); setImages([])
      onSent(to)
    } catch (e) {
      notifyError(e, "Couldn't send it")
    } finally {
      setSending(false)
    }
  }
  const stop = () => void post(`agents/threads/${id}/stop`, {}).catch((e) => notifyError(e, "Couldn't stop it"))

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
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const phone = matchMedia("(pointer: coarse)").matches
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (!phone || e.metaKey)) { e.preventDefault(); void send() }
    if (e.key === "Escape" && running) { e.preventDefault(); stop() }
  }
  const onInput = (v: string, caret: number) => {
    setText(v)
    if (inVault && v[caret - 1] === "@" && (caret === 1 || /\s/.test(v[caret - 2])) && v.length > text.length) mention(caret - 1)
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type))
    if (!files.length) return
    e.preventDefault()
    for (const f of files.slice(0, 6)) {
      const r = new FileReader()
      r.onload = () => { const url = String(r.result); setImages((xs) => [...xs, { type: f.type, data: url.slice(url.indexOf(",") + 1), url }].slice(0, 6)) }
      r.readAsDataURL(f)
    }
  }
  const harnessMenu = (): MenuItem[] => HARNESSES.map((x) => ({ label: NAME[x], icon: ICON[x], checked: h === x, run: () => setDraft({ harness: x, model: "" }) }))
  const modelMenu = (): MenuItem[] => [
    { label: "Default model", checked: !draft.model, hint: `${SHORT[h]}'s`, run: () => setDraft({ model: "" }) },
    ...models.map((m) => ({ label: m.label, checked: draft.model === m.value, run: () => setDraft({ model: m.value }) })),
  ]
  const modeMenu = (): MenuItem[] => MODES.map((m) => ({ label: m.label(h), icon: m.icon, hint: m.hint, checked: mode.id === m.id, run: () => setDraft({ mode: m.id }) }))
  const HIcon = ICON[h]
  const MIcon = mode.icon
  const placeholder = !ready ? `${NAME[h]} isn't ready` : asks.length ? "Resolve this approval request to continue" : inVault ? "Ask anything, @ to point at a note" : "Ask anything"
  return (
    <div className="mx-auto w-full max-w-[760px] overflow-hidden rounded-[20px] border-[0.5px] border-border bg-background shadow-[0_4px_18px_rgb(0_0_0/0.06)] focus-within:border-primary/70" data-composer>
      {asks.length > 0 && <Approval asks={asks} id={id} harness={h} cwd={draft.cwd} />}
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
      <textarea ref={area} value={text} rows={2} placeholder={placeholder}
        aria-label={`Message to ${NAME[h]}`} onChange={(e) => onInput(e.target.value, e.target.selectionStart)} onKeyDown={onKey} onPaste={onPaste} data-agents-input data-keeps-keys
        className="block max-h-[240px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-[20px] outline-none placeholder:text-tertiary max-md:text-[17px] max-md:leading-[23px]" />
      <div className="flex items-center gap-0.5 px-2 pb-2">
        {id ? (
          <span className={cn(pill, "cursor-default hover:bg-transparent hover:text-muted-foreground")} data-agents-harness={h}><HIcon className="size-3.5 shrink-0" style={{ color: TINT[h] }} />{SHORT[h]}</span>
        ) : (
          <button type="button" className={pill} data-tip="The agent" data-agents-harness={h} onClick={(e) => menuAbove(e, harnessMenu())}>
            <HIcon className="size-3.5 shrink-0" style={{ color: TINT[h] }} />{SHORT[h]}
          </button>
        )}
        <button type="button" className={cn(pill, "min-w-0 shrink")} data-tip="The model it uses" data-agents-model={draft.model || "default"} onClick={(e) => menuAbove(e, modelMenu())}><span className="truncate">{modelLabel}</span></button>
        <button type="button" className={cn(pill, "min-w-0 shrink")} data-tip={mode.tip(h)} data-agents-mode={mode.id} onClick={(e) => menuAbove(e, modeMenu())}>
          <MIcon className="size-3.5 shrink-0" /><span className="truncate">{mode.label(h)}</span>
        </button>
        {inVault && <button type="button" className={button} aria-label="Point the agent at a note" data-tip="Point the agent at a note (@)" onClick={() => mention()}><AtSign className="size-3.5 max-md:size-5" /></button>}
        <span className="flex-1" />
        {running ? (
          <button type="button" onClick={stop} aria-label="Interrupt" data-tip="Interrupt (Esc)" data-agents-stop
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-[var(--red)] text-white hover:opacity-85 max-md:size-11">
            <Square className="size-3 fill-current max-md:size-4" />
          </button>
        ) : (
          <button type="button" onClick={() => void send()} disabled={(!text.trim() && !images.length) || sending || !ready} aria-label="Send" data-tip="Send (↩)" data-agents-send
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-40 max-md:size-11">
            <ArrowUp className="size-4 max-md:size-5" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
}

// ---------- a thread's menu, shared with the sidebar's rows

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

export function threadMenu(id: string, title: string, harness: Harness, started: boolean, on: (id: string) => boolean, opts: { rename?: () => void; gone?: () => void; extra?: MenuItem[] } = {}): MenuItem[] {
  return [
    ...(opts.extra ?? []),
    ...(opts.rename ? [{ label: "Rename", icon: Pencil, run: opts.rename }] : []),
    ...(started && on("terminal") && on(harness === "claude" ? "claude-code" : "codex") ? [{ label: "Open in terminal", icon: SquareTerminal, run: () => void openInTerminal(id) }] : []),
    { label: "Delete", icon: Trash2, danger: true, run: () => void removeThread(id, title, opts.gone) },
  ]
}

// ---------- the whole thread

/** The draft a new thread starts from: the agent and folder last picked here (a project's + sets the folder). */
export function useDraft(): [Draft, (d: Partial<Draft>) => void] {
  const [settings] = usePluginSettings("agents")
  const [harness, setHarness] = useScopedState<string>("agents:harness", "", "workspace")
  const [cwd, setCwd] = useScopedState<string>("agents:cwd", "", "workspace")
  const [model, setModel] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const h: Harness = HARNESSES.includes(harness as Harness) ? harness as Harness : settings?.harness === "codex" ? "codex" : "claude"
  const own = h === "claude" ? settings?.claudeModel : settings?.codexModel
  const draft: Draft = { harness: h, cwd, model: model ?? (typeof own === "string" ? own : ""),
    mode: mode ?? (MODES.some((m) => m.id === settings?.mode) ? settings!.mode as Mode : "ask") }
  const set = (d: Partial<Draft>) => {
    if (d.harness) { setHarness(d.harness); setModel(null) }
    if (d.cwd !== undefined) setCwd(d.cwd || undefined)
    if (d.model !== undefined) setModel(d.model)
    if (d.mode) setMode(d.mode)
  }
  return [draft, set]
}

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
  useEffect(() => { if (shown?.gone) setId("") }, [shown?.gone]) // eslint-disable-line react-hooks/exhaustive-deps

  const t = shown?.thread ?? null
  const entries = useMemo(() => t?.entries ?? [], [t])
  const live = shown?.live ?? { running: false, status: "" }
  const turnsDone = entries.filter((e) => e.kind === "user" && (e as { end?: string }).end).length
  const { git, reload } = useGit(t ? id : "", `${turnsDone}|${live.running}|${entries.filter((e) => e.kind === "note").length}|${t?.cwd ?? ""}`)
  // A new thread's draft folder is the vault until one is picked.
  const cwd = t?.cwd ?? (draft.cwd || projects.find((p) => p.vault)?.path || "")
  useEffect(() => { setWorkspace({ worktree: false, branch: "" }) }, [cwd])
  const d: Draft = t ? { harness: t.harness, cwd: t.cwd, model: t.model, mode: t.mode } : { ...draft, cwd }
  const setD = (x: Partial<Draft>) => {
    if (!t) return setDraft(x)
    const body: Record<string, string> = {}
    if (x.model !== undefined) body.model = x.model
    if (x.mode) body.mode = x.mode
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
  const menu = (e: React.MouseEvent) => t && menuBelow(e, threadMenu(id, t.title, t.harness, t.started, on, { rename: () => setRenameOn(true), gone: () => setId("") }))
  // ⌘D: the diff panel, from anywhere in the thread (the box to write in has the focus most of the time).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (id && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") { e.preventDefault(); e.stopPropagation(); toggleDiff(id) }
  }

  return (
    <div className="flex min-h-0 flex-1" data-agents-thread={id || "new"} data-harness={h} data-running={live.running || undefined}
      onKeyDownCapture={onKeyDown} onFocusCapture={() => usedThread(id)} onPointerDownCapture={() => usedThread(id)}>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", diffOpen && "max-md:hidden")}>
        <div className="flex h-10 shrink-0 items-center gap-1 border-b-[0.5px] border-border pr-2 pl-3 max-md:h-12 max-md:pl-2" data-agents-head>
          <span className="inline-flex min-w-0 shrink items-center gap-1 text-[13px] text-muted-foreground max-md:hidden" data-tip={tildeOf(home)} data-agents-project-name>
            <Folder className="size-3.5 shrink-0" /><span className="truncate">{projectName}</span><span className="text-tertiary">/</span>
          </span>
          {renameOn && t ? (
            <input autoFocus defaultValue={t.title} aria-label="Thread's name" data-agents-rename
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
            <button type="button" className="min-w-0 cursor-pointer truncate rounded-[5px] px-1 text-left text-[14px] font-semibold hover:bg-foreground/[0.06] max-md:hidden" data-agents-title
              onClick={menu} onDoubleClick={() => t && setRenameOn(true)} data-tip={t ? "Thread actions (double-click to rename)" : undefined}>{title}</button>
          )}
          {git && <BranchChip g={git} />}
          <span className="flex-1" />
          {git && t && <GitActions id={id} g={git} title={t.title} running={live.running} reload={reload} />}
          {id && (
            <button type="button" className={cn(button, panel.open && "bg-foreground/[0.08] text-foreground")} aria-pressed={panel.open} aria-label="Toggle diff" data-tip="Toggle diff (⌘D)" data-agents-diff-toggle
              onClick={() => toggleDiff(id)}><FileDiff className="size-4" /></button>
          )}
        </div>
        <Timeline id={id} entries={entries} harness={h} cwd={cwd} running={live.running} status={live.status} canRevert={!!git} hero={!id && !entries.length}
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
          <Composer id={id} draft={d} setDraft={setD} workspace={workspace} running={live.running} status={status ?? null} projects={projects} asks={asks}
            onSent={(to) => { if (to !== id) setId(to) }} />
          {!id && <BranchToolbar cwd={cwd} value={workspace} onChange={setWorkspace} />}
          {id && git && (
            <div className="mx-auto flex w-full max-w-[760px] items-center gap-1 px-2.5 pt-1.5 text-[11px] text-tertiary max-md:text-[13px]" data-agents-context>
              <span>{git.worktree ? "Worktree" : "Local checkout"}</span><span>·</span><span className="truncate font-mono">{git.branch}</span>
              {git.files > 0 && <><span>·</span><span>{git.files === 1 ? "1 uncommitted file" : `${git.files} uncommitted files`}</span></>}
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
