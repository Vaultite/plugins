// A thread in its tab (view:agents/<id>): the agent's messages as Markdown, its tool calls a line each (files as links,
// edits as diffs), its permission questions with Allow and Deny, what it changed, and the box to write in. A new
// thread ("" id) picks its agent and project in that box first.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react"
import {
  ArrowUp, AtSign, ChevronRight, CircleAlert, FileText, Folder, MoreHorizontal, Pencil, Square, SquareTerminal, Trash2, X,
} from "lucide-react"
import {
  choose, cn, confirmDialog, del, getStore, Markdown, menuAbove, menuBelow, notifyError, openAgent, openFile, patch, post, useEnabled, useFocusedFile,
  useLive, usePluginSettings, useScopedState, type MenuItem,
} from "@vaultite"
import { HARNESSES, ICON, MODES, NAME, SHORT, STATUS, TINT } from "./harness"
import { useRefused, useSocket, useThread } from "./live"
import type { Entry, Harness, Hunk, Mode, Project, Status } from "./types"

type Tool = Extract<Entry, { kind: "tool" }>
type Ask = Extract<Entry, { kind: "ask" }>
type Image = { type: string; data: string; url: string }

const button = "grid size-6 shrink-0 cursor-pointer place-items-center rounded-[5px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground max-md:size-11"
const pill = "inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:h-9 max-md:text-[15px]"
const noteName = (p: string) => p.replace(/\.md$/i, "")
const firstLine = (s: unknown) => (typeof s === "string" ? s.split("\n")[0] : "")
const EDITS = /^(Edit|MultiEdit|Write|NotebookEdit)$/
export const tildeOf = (p: string) => p.replace(/^\/Users\/[^/]+/, "~")
/** A path as the thread shows it: inside its folder, relative to it. */
const shortPath = (p: string, cwd: string) => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : tildeOf(p))

// ---------- what was done: a line per tool call

/** A tool call in words: its verb and what it acted on (a vault file is a link). */
function describe(name: string, input: Record<string, unknown>, cwd: string, file?: string, at?: string): { verb: string; what: string; file?: string } {
  const p = at ?? (typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "")
  const on = file ? noteName(file) : p ? shortPath(p, cwd) : ""
  switch (name) {
    case "Read": return { verb: "Read", what: on, file }
    case "Write": return { verb: "Wrote", what: on, file }
    case "Edit": case "MultiEdit": case "NotebookEdit": return { verb: "Edited", what: on, file }
    case "Delete": return { verb: "Deleted", what: on }
    case "Glob": case "Grep": return { verb: "Searched for", what: String(input.pattern ?? "") }
    case "Bash": return { verb: "Ran", what: firstLine(input.command) }
    case "WebFetch": return { verb: "Read", what: String(input.url ?? "") }
    case "WebSearch": return { verb: "Searched the web for", what: String(input.query ?? "") }
    case "Task": case "Agent": return { verb: "Asked an agent to", what: String(input.description ?? "").toLowerCase() }
    case "TodoWrite": return { verb: "Updated its to-do list", what: "" }
    case "Skill": return { verb: "Used the skill", what: String(input.skill ?? input.command ?? "") }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? { verb: "Used", what: `${mcp[1]} ${mcp[2].replaceAll("_", " ")}` } : { verb: "Used", what: name }
}

function FileLink({ file, children }: { file: string; children: ReactNode }) {
  return (
    <a href="#" data-file={file} onClick={(e) => { e.preventDefault(); e.stopPropagation(); openFile(file, { newTab: e.metaKey || e.ctrlKey }) }}
      className="min-w-0 truncate text-primary hover:underline">{children}</a>
  )
}

type Line = { kind: "add" | "del" | "same"; text: string }
/** A diff's lines: a patch's (what the edit did), else old against new (what it asks to do). */
function diffLines(name: string, input: Record<string, unknown>, hunks?: Hunk[]): Line[] {
  if (hunks?.length) return hunks.flatMap((h) => h.lines.filter((l) => !l.startsWith("\\")).map((l) => ({ kind: l[0] === "+" ? "add" as const : l[0] === "-" ? "del" as const : "same" as const, text: l.slice(1) })))
  const lines = (s: unknown) => (typeof s === "string" ? s.split("\n") : [])
  if (name === "Write") return lines(input.content).slice(0, 60).map((text) => ({ kind: "add", text }))
  if (name === "Edit") return [...lines(input.old_string).map((text) => ({ kind: "del" as const, text })), ...lines(input.new_string).map((text) => ({ kind: "add" as const, text }))]
  if (name === "MultiEdit" && Array.isArray(input.edits)) return (input.edits as Record<string, unknown>[]).flatMap((e) => diffLines("Edit", e))
  return []
}

function Diff({ lines, tall }: { lines: Line[]; tall?: boolean }) {
  if (!lines.length) return null
  return (
    <div className={cn("overflow-auto rounded-[8px] border-[0.5px] border-border bg-card py-1 font-mono text-[12px] leading-[18px]", tall ? "max-h-[28rem]" : "max-h-72")} data-diff-view>
      {lines.map((l, i) => (
        <div key={i} data-diff={l.kind} className={cn("flex min-w-max pr-3 whitespace-pre",
          l.kind === "add" && "bg-[color-mix(in_srgb,var(--green)_16%,transparent)]",
          l.kind === "del" && "bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-muted-foreground")}>
          <span aria-hidden className={cn("w-5 shrink-0 text-center select-none", l.kind === "add" ? "text-[var(--green)]" : l.kind === "del" ? "text-[var(--red)]" : "text-tertiary")}>
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
          </span>
          <span>{l.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

function ToolLine({ t, cwd }: { t: Tool; cwd: string }) {
  const [open, setOpen] = useState(false)
  const d = describe(t.name, t.input, cwd, t.file, t.path)
  const diff = EDITS.test(t.name) && !t.error ? diffLines(t.name, t.input, t.patch) : []
  return (
    <div data-tool={t.name} data-tool-file={t.file}>
      <div role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(!open) }} aria-expanded={open}
        className="flex h-6.5 min-w-0 cursor-pointer items-center gap-1 rounded-[5px] px-1 text-[13px] hover:bg-foreground/[0.04] max-md:h-9 max-md:text-[15px]">
        <ChevronRight className={cn("size-3.5 shrink-0 text-tertiary transition-transform", open && "rotate-90")} strokeWidth={2.5} />
        <span className="shrink-0 text-muted-foreground">{d.verb}</span>
        {d.file ? <FileLink file={d.file}>{d.what}</FileLink> : <span className="min-w-0 truncate font-mono text-[12px] text-tertiary max-md:text-[13px]">{d.what}</span>}
        {diff.length > 0 && <Counts lines={diff} />}
        {t.result === undefined && !t.error && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--orange)]" aria-label="Running" />}
        {t.error && <CircleAlert className="size-3.5 shrink-0 text-[var(--red)]" strokeWidth={2.25} aria-label="Failed" />}
      </div>
      {open && (
        <div className="mt-0.5 mb-2 ml-5 space-y-1.5">
          {diff.length ? <Diff lines={diff} /> : (
            <pre className="max-h-60 overflow-auto rounded-[8px] bg-muted px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{typeof t.input.command === "string" ? t.input.command : JSON.stringify(t.input, null, 2)}</pre>
          )}
          {t.result !== undefined && !diff.length && (
            <pre className={cn("max-h-60 overflow-auto rounded-[8px] border-[0.5px] border-border px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words",
              t.error ? "text-[var(--red)]" : "text-muted-foreground")}>{t.result || "(no output)"}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function Counts({ lines, added, removed }: { lines?: Line[]; added?: number; removed?: number }) {
  const a = added ?? lines?.filter((l) => l.kind === "add").length ?? 0
  const r = removed ?? lines?.filter((l) => l.kind === "del").length ?? 0
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums max-md:text-[13px]">
      {a > 0 && <span className="text-[var(--green)]">+{a}</span>}{a > 0 && r > 0 && " "}{r > 0 && <span className="text-[var(--red)]">−{r}</span>}
    </span>
  )
}

// ---------- a permission question

function AskCard({ a, id, harness, cwd }: { a: Ask; id: string; harness: Harness; cwd: string }) {
  const [busy, setBusy] = useState(false)
  const plan = a.tool === "ExitPlanMode"
  const d = describe(a.tool, a.input, cwd, a.file, a.path)
  const edit = EDITS.test(a.tool)
  const who = SHORT[harness]
  const answer = async (allow: boolean) => {
    setBusy(true)
    try { await post(`agents/threads/${id}/answer`, { ask: a.id, allow }) } catch (e) { notifyError(e, "Couldn't answer") } finally { setBusy(false) }
  }
  if (a.answer && !plan) {
    const said = a.answer === "allow" ? "Allowed" : a.answer === "deny" ? "Denied" : "Not answered"
    return <div className="px-1 text-[12px] text-tertiary max-md:text-[14px]" data-ask={a.answer}>{said}: {d.verb.toLowerCase()} {d.what}</div>
  }
  const head = plan ? `${who}'s plan is ready` : edit ? `${who} wants to edit` : a.tool === "Bash" ? `${who} wants to run a command` : a.tool === "WebFetch" ? `${who} wants to read a web page` : `${who} wants to use ${d.what || a.tool}`
  return (
    <div className="rounded-[10px] border-[0.5px] border-border bg-card p-2.5 shadow-xs" data-ask={a.answer ?? "waiting"} data-ask-tool={a.tool}>
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[13px] font-medium max-md:text-[16px]">
        <span className="shrink-0">{head}</span>
        {edit && (a.file ? <FileLink file={a.file}>{noteName(a.file)}</FileLink> : <span className="truncate font-mono text-[12px]">{d.what}</span>)}
      </div>
      {plan ? <Markdown text={String(a.input.plan ?? "")} className="mb-2 text-[13px]" />
        : edit ? <div className="mb-2 space-y-1">{a.text && <p className="text-[12px] text-muted-foreground max-md:text-[14px]">{a.text}</p>}<Diff lines={diffLines(a.tool, a.input, a.patch)} /></div>
        : a.tool === "Bash" ? (
          <div className="mb-2 space-y-1">
            {typeof a.input.description === "string" && <p className="text-[12px] text-muted-foreground max-md:text-[14px]">{a.input.description}</p>}
            <pre className="max-h-40 overflow-auto rounded-[8px] bg-muted px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{String(a.input.command ?? "")}</pre>
          </div>
        ) : <pre className="mb-2 max-h-40 overflow-auto rounded-[8px] bg-muted px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{a.input.url ? String(a.input.url) : JSON.stringify(a.input, null, 2)}</pre>}
      {a.answer ? <p className="text-[12px] text-tertiary">{a.answer === "allow" ? "Approved" : a.answer === "deny" ? "Kept planning" : "Not answered"}</p> : (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void answer(true)} data-answer="allow"
            className="inline-flex h-7 cursor-pointer items-center rounded-[6px] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 max-md:h-11 max-md:px-4 max-md:text-[16px]">
            {plan ? "Start" : "Allow"}
          </button>
          <button type="button" disabled={busy} onClick={() => void answer(false)} data-answer="deny"
            className="inline-flex h-7 cursor-pointer items-center rounded-[6px] px-3 text-[13px] font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50 max-md:h-11 max-md:px-4 max-md:text-[16px]">
            {plan ? "Keep planning" : "Deny"}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- what the thread changed: every file it edited, each with its diffs

type FileChange = { key: string; label: string; file?: string; lines: Line[] }
function fileChanges(entries: Entry[], cwd: string): FileChange[] {
  const out = new Map<string, FileChange>()
  for (const e of entries) {
    if (e.kind !== "tool" || !EDITS.test(e.name) || e.error || e.result === undefined) continue
    const key = e.path ?? e.file ?? String(e.input.file_path ?? "")
    if (!key) continue
    const f = out.get(key) ?? { key, label: e.file ? noteName(e.file) : shortPath(key, cwd), file: e.file, lines: [] }
    f.lines.push(...diffLines(e.name, e.input, e.patch))
    out.set(key, f)
  }
  return [...out.values()]
}

function Changes({ entries, cwd }: { entries: Entry[]; cwd: string }) {
  const files = useMemo(() => fileChanges(entries, cwd), [entries, cwd])
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  if (!files.length) return null
  const all = files.flatMap((f) => f.lines)
  return (
    <div className="mx-auto mb-1.5 w-[calc(100%-1.5rem)] max-w-[760px] rounded-[10px] border-[0.5px] border-border bg-card" data-changes>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-[10px] px-2 text-left text-[12px] text-muted-foreground hover:text-foreground max-md:h-10 max-md:text-[15px]">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} strokeWidth={2.5} />
        <span>{files.length === 1 ? "1 file changed" : `${files.length} files changed`}</span>
        <Counts lines={all} />
      </button>
      {open && (
        <div className="max-h-[40vh] overflow-y-auto px-1 pb-1">
          {files.map((f) => (
            <div key={f.key} data-changed-file={f.key}>
              <div role="button" tabIndex={0} onClick={() => setShown(shown === f.key ? null : f.key)} onKeyDown={(e) => { if (e.key === "Enter") setShown(shown === f.key ? null : f.key) }}
                className="flex h-6.5 min-w-0 cursor-pointer items-center gap-1 rounded-[5px] px-1 text-[13px] hover:bg-foreground/[0.04] max-md:h-9 max-md:text-[15px]">
                <ChevronRight className={cn("size-3.5 shrink-0 text-tertiary transition-transform", shown === f.key && "rotate-90")} strokeWidth={2.5} />
                {f.file ? <FileLink file={f.file}>{f.label}</FileLink> : <span className="min-w-0 truncate font-mono text-[12px]">{f.label}</span>}
                <span className="flex-1" />
                <Counts lines={f.lines} />
              </div>
              {shown === f.key && <div className="mt-0.5 mb-1.5 ml-5"><Diff lines={f.lines} tall /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- the thread

function UserMessage({ e, id }: { e: Extract<Entry, { kind: "user" }>; id: string }) {
  return (
    <div className="ml-6 min-w-0 rounded-[10px] bg-muted px-2.5 py-1.5 max-md:ml-10" data-entry="user">
      <div className="text-[13px] leading-[19px] whitespace-pre-wrap break-words max-md:text-[17px] max-md:leading-[23px]">{e.text}</div>
      {(e.file || e.images?.length) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {e.images?.map((im) => <img key={im} src={`api/agents/image/${id}/${im}`} alt="" className="h-12 rounded-[4px] border-[0.5px] border-border object-cover" />)}
          {e.file && <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground"><FileText className="size-3 shrink-0" /><FileLink file={e.file}>{noteName(e.file)}</FileLink></span>}
        </div>
      )}
    </div>
  )
}

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

function Messages({ id, entries, harness, cwd, running, status, problem, empty }: {
  id: string; entries: Entry[]; harness: Harness; cwd: string; running: boolean; status: string; problem: ReactNode; empty: ReactNode
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
  // Tool calls in a row are drawn together, tight; messages get room around them.
  const groups: { at: number; entries: Entry[] }[] = []
  entries.forEach((e, i) => {
    const last = groups[groups.length - 1]
    if (e.kind === "tool" && last?.entries[0].kind === "tool") last.entries.push(e)
    else groups.push({ at: i, entries: [e] })
  })
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-agents-messages aria-live="polite">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2.5">
        {problem}
        {!entries.length && !problem && empty}
        {groups.map(({ at, entries: g }) => {
          const e = g[0]
          if (e.kind === "tool") return <div key={at} className="-mx-1 flex flex-col">{(g as Tool[]).map((t) => <ToolLine key={t.id} t={t} cwd={cwd} />)}</div>
          if (e.kind === "user") return <UserMessage key={at} e={e} id={id} />
          if (e.kind === "assistant") return <Markdown key={at} text={e.text || " "} className="min-w-0 px-1 break-words" />
          if (e.kind === "ask") return <AskCard key={at} a={e} id={id} harness={harness} cwd={cwd} />
          return (
            <div key={at} data-note={e.error ? "error" : "info"} className={cn("px-1 text-[12px] leading-[17px] max-md:text-[15px] max-md:leading-[21px]", e.error ? "text-[var(--red)]" : "text-tertiary")}>
              {e.text}
            </div>
          )
        })}
        {running && (
          <div className="flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground max-md:text-[15px]" data-agents-status={status}>
            <span className="size-1.5 animate-pulse rounded-full" style={{ background: status === "waiting" ? "var(--yellow)" : TINT[harness] ?? "var(--foreground)" }} />
            {STATUS[status] ?? "Working"}…
          </div>
        )}
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

/** The box to write in: the open note as a chip (in the vault), @ to point at a note, pasted images; Enter sends. */
function Composer({ id, draft, setDraft, running, status, projects, onSent }: {
  id: string; draft: Draft; setDraft: (d: Partial<Draft>) => void; running: boolean; status: Status | null; projects: Project[]; onSent: (id: string) => void
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
      const to = id || (await post<{ id: string }>("agents/threads", { harness: h, cwd: draft.cwd, model: draft.model, mode: draft.mode })).id
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
  const modeMenu = (): MenuItem[] => MODES.map((m) => ({ label: m.label(h), checked: mode.id === m.id, run: () => setDraft({ mode: m.id }) }))
  const HIcon = ICON[h]
  return (
    <div className="shrink-0 px-3 pb-3" data-composer>
      <div className="mx-auto w-full max-w-[760px] rounded-[12px] border-[0.5px] border-border bg-background focus-within:border-primary">
        {(note || images.length > 0) && (
          <div className="flex flex-wrap items-center gap-1 px-1.5 pt-1.5">
            {note && (
              <span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-[5px] bg-muted pr-0.5 pl-1.5 text-[12px] text-muted-foreground max-md:h-8 max-md:text-[14px]" data-note-chip={note}
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
        <textarea ref={area} value={text} rows={2} placeholder={ready ? (id ? `Message ${SHORT[h]}` : `Ask ${SHORT[h]} to do something in ${project?.label ?? "this folder"}`) : `${NAME[h]} isn't ready`}
          aria-label={`Message to ${NAME[h]}`} onChange={(e) => onInput(e.target.value, e.target.selectionStart)} onKeyDown={onKey} onPaste={onPaste} data-agents-input data-keeps-keys
          className="block max-h-[240px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-[19px] outline-none placeholder:text-tertiary max-md:text-[17px] max-md:leading-[23px]" />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          {id ? (
            <span className={cn(pill, "cursor-default hover:bg-transparent hover:text-muted-foreground")} data-agents-harness={h}><HIcon className="size-3.5 shrink-0" style={{ color: TINT[h] }} />{SHORT[h]}</span>
          ) : (
            <button type="button" className={pill} data-tip="The agent" data-agents-harness={h} onClick={(e) => menuAbove(e, harnessMenu())}>
              <HIcon className="size-3.5 shrink-0" style={{ color: TINT[h] }} />{SHORT[h]}
            </button>
          )}
          {!id && (
            <button type="button" className={cn(pill, "min-w-0 shrink")} data-tip={tildeOf(draft.cwd)} data-agents-project={draft.cwd} onClick={() => chooseProject(projects, draft.cwd, (p) => setDraft({ cwd: p }))}>
              <Folder className="size-3.5 shrink-0" /><span className="truncate">{project?.label ?? tildeOf(draft.cwd).split("/").pop()}</span>
            </button>
          )}
          <button type="button" className={cn(pill, "min-w-0 shrink")} data-tip={mode.tip(h)} data-agents-mode={mode.id} onClick={(e) => menuAbove(e, modeMenu())}><span className="truncate">{mode.label(h)}</span></button>
          <button type="button" className={cn(pill, "min-w-0 shrink")} data-tip="The model it uses" data-agents-model={draft.model || "default"} onClick={(e) => menuAbove(e, modelMenu())}><span className="truncate">{modelLabel}</span></button>
          {inVault && <button type="button" className={button} aria-label="Point the agent at a note" data-tip="Point the agent at a note (@)" onClick={() => mention()}><AtSign className="size-3.5 max-md:size-5" /></button>}
          <span className="flex-1" />
          {running ? (
            <button type="button" onClick={stop} aria-label="Stop" data-tip="Stop (Esc)" data-agents-stop
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full bg-foreground text-background hover:opacity-85 max-md:size-11">
              <Square className="size-3 fill-current max-md:size-4" />
            </button>
          ) : (
            <button type="button" onClick={() => void send()} disabled={(!text.trim() && !images.length) || sending || !ready} aria-label="Send" data-tip="Send (↩)" data-agents-send
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-40 max-md:size-11">
              <ArrowUp className="size-4 max-md:size-5" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- a thread's menu, shared with the sidebar's rows

export async function removeThread(id: string, title: string, after?: () => void) {
  if (!(await confirmDialog({ title: `Delete “${title}”?`, body: "The thread goes from Agents for good. The agent keeps its own record of the session.", confirm: "Delete", danger: true }))) return
  try { await del(`agents/threads/${id}`); after?.() } catch (e) { notifyError(e, "Couldn't delete it") }
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
  const [renameOn, setRenameOn] = useState(false)
  const on = useEnabled()
  useEffect(() => { if (shown?.gone) setId("") }, [shown?.gone]) // eslint-disable-line react-hooks/exhaustive-deps

  const t = shown?.thread ?? null
  const entries = useMemo(() => t?.entries ?? [], [t])
  const live = shown?.live ?? { running: false, status: "" }
  // A new thread's draft folder is the vault until one is picked.
  const cwd = t?.cwd ?? (draft.cwd || projects.find((p) => p.vault)?.path || "")
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
  const project = projects.find((p) => p.path === cwd)
  const HIcon = ICON[h]
  const title = t?.title ?? (id ? "" : "New thread")

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agents-thread={id || "new"} data-harness={h} data-running={live.running || undefined}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b-[0.5px] border-border pr-2 pl-3 max-md:hidden" data-agents-head>
        <HIcon className="size-4 shrink-0" style={{ color: TINT[h] }} />
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
          <span className="min-w-0 truncate text-[14px] font-semibold" onDoubleClick={() => t && setRenameOn(true)}>{title}</span>
        )}
        {cwd && (
          <span className="ml-1 inline-flex min-w-0 shrink items-center gap-1 rounded-[5px] bg-muted px-1.5 py-0.5 text-[12px] text-muted-foreground" data-tip={tildeOf(cwd)}>
            <Folder className="size-3 shrink-0" /><span className="truncate">{project?.label ?? tildeOf(cwd).split("/").pop()}</span>
          </span>
        )}
        <span className="flex-1" />
        {t && <button type="button" className={button} aria-label="More" data-tip="More" data-agents-more
          onClick={(e) => menuBelow(e, threadMenu(id, t.title, t.harness, t.started, on, { rename: () => setRenameOn(true), gone: () => setId("") }))}><MoreHorizontal className="size-3.5" /></button>}
      </div>
      <Messages id={id} entries={entries} harness={h} cwd={cwd} running={live.running} status={live.status}
        problem={problem ?? (lastSignIn ? <SignIn harness={h} problem="signed-out" refresh={() => setCheck(Date.now())} /> : null)}
        empty={<p className="px-1 pt-1 text-[13px] leading-[19px] text-muted-foreground max-md:text-[17px] max-md:leading-[23px]">
          {NAME[h]} works in {project?.vault ? "your vault" : project?.label ?? tildeOf(cwd)} and asks before it changes anything, as its permissions say. Pick the agent and project below.
        </p>} />
      <Changes entries={entries} cwd={cwd} />
      <Composer id={id} draft={d} setDraft={setD} running={live.running} status={status ?? null} projects={projects} onSent={(to) => { if (to !== id) setId(to) }} />
    </div>
  )
}
