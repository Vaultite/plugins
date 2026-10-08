// The chat: a conversation's messages (Claude's as Markdown, its tool calls a line each with the files as links and a
// diff for edits, its permission questions with Allow and Deny), and the box to write in. Drawn in the sidebar panel
// and in a tab (view:claude-chat/<id>), the same component.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react"
import {
  ArrowUp, AtSign, Bot, ChevronRight, CircleAlert, FileText, History, MessageSquarePlus, MoreHorizontal, Pencil, Square,
  SquareArrowOutUpRight, SquareTerminal, Trash2, X, type LucideIcon,
} from "lucide-react"
import {
  choose, cn, confirmDialog, del, fmtAgo, getStore, iconNamed, Markdown, menuAbove, menuBelow, menuFor, notifyError, openAgent, openFile,
  openView, patch, post, useEnabled, useFocusedFile, useLive, usePluginSettings, type MenuItem,
} from "@vaultite"
import { useConv, useList, useRefused, useSocket, type Entry } from "./live"

type Status = { installed: boolean; loggedIn: boolean; cli: string | null; version: string; models: { value: string; label: string; description: string }[] }
type Tool = Extract<Entry, { kind: "tool" }>
type Ask = Extract<Entry, { kind: "ask" }>
type Image = { type: string; data: string; url: string }

export const TINT = "var(--orange)"
/** Claude's mark when Claude Code's plugin is on (it brings it), else a plain one. */
export const ChatIcon = ((props) => {
  const I = iconNamed("claude") ?? Bot
  return <I {...props} />
}) as LucideIcon

const MODES = [
  { id: "default", label: "Ask before edits", tip: "Claude asks before it changes a file or runs a command" },
  { id: "acceptEdits", label: "Accept edits", tip: "Claude edits notes without asking; it still asks before commands" },
  { id: "plan", label: "Plan only", tip: "Claude reads and plans, and changes nothing" },
]
const STATUS: Record<string, string> = { thinking: "Thinking", working: "Working", writing: "Writing", waiting: "Waiting for you", delegating: "Working with an agent" }
const button = "grid size-6 shrink-0 cursor-pointer place-items-center rounded-[5px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground max-md:size-11"
const pill = "inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:h-9 max-md:text-[15px]"
const noteName = (p: string) => p.replace(/\.md$/i, "")
const firstLine = (s: unknown) => (typeof s === "string" ? s.split("\n")[0] : "")

// ---------- what was done: a line per tool call

/** A tool call in words: its verb and what it acted on (a vault file is a link). */
function describe(name: string, input: Record<string, unknown>, file?: string): { verb: string; what: string; file?: string } {
  const p = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : ""
  const on = file ? noteName(file) : p ? p.replace(/^\/Users\/[^/]+/, "~") : ""
  switch (name) {
    case "Read": return { verb: "Read", what: on, file }
    case "Write": return { verb: "Wrote", what: on, file }
    case "Edit": case "MultiEdit": case "NotebookEdit": return { verb: "Edited", what: on, file }
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

/** A diff's lines: a structured patch's (what the edit did), else old against new (what it asks to do). */
function diffLines(name: string, input: Record<string, unknown>, patchOf?: Tool["patch"]): { kind: "add" | "del" | "same"; text: string }[] {
  if (patchOf?.length) return patchOf.flatMap((h) => h.lines.filter((l) => !l.startsWith("\\")).map((l) => ({ kind: l[0] === "+" ? "add" as const : l[0] === "-" ? "del" as const : "same" as const, text: l.slice(1) })))
  const lines = (s: unknown) => (typeof s === "string" ? s.split("\n") : [])
  if (name === "Write") return lines(input.content).slice(0, 60).map((text) => ({ kind: "add", text }))
  if (name === "Edit") return [...lines(input.old_string).map((text) => ({ kind: "del" as const, text })), ...lines(input.new_string).map((text) => ({ kind: "add" as const, text }))]
  if (name === "MultiEdit" && Array.isArray(input.edits)) return (input.edits as Record<string, unknown>[]).flatMap((e) => diffLines("Edit", e))
  return []
}

function Diff({ lines }: { lines: ReturnType<typeof diffLines> }) {
  if (!lines.length) return null
  return (
    <div className="max-h-72 overflow-auto rounded-[8px] border-[0.5px] border-border bg-card py-1 font-mono text-[12px] leading-[18px]" data-diff-view>
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

function ToolLine({ t }: { t: Tool }) {
  const edit = /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t.name)
  const [open, setOpen] = useState(false)
  const d = describe(t.name, t.input, t.file)
  const diff = edit && !t.error ? diffLines(t.name, t.input, t.patch) : []
  return (
    <div data-tool={t.name} data-tool-file={t.file}>
      <div role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(!open) }} aria-expanded={open}
        className="flex h-6.5 min-w-0 cursor-pointer items-center gap-1 rounded-[5px] px-1 text-[13px] hover:bg-foreground/[0.04] max-md:h-9 max-md:text-[15px]">
        <ChevronRight className={cn("size-3.5 shrink-0 text-tertiary transition-transform", open && "rotate-90")} strokeWidth={2.5} />
        <span className="shrink-0 text-muted-foreground">{d.verb}</span>
        {d.file ? <FileLink file={d.file}>{d.what}</FileLink> : <span className="min-w-0 truncate font-mono text-[12px] text-tertiary max-md:text-[13px]">{d.what}</span>}
        {t.result === undefined && !t.error && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--orange)]" aria-label="Running" />}
        {t.error && <CircleAlert className="size-3.5 shrink-0 text-[var(--red)]" strokeWidth={2.25} aria-label="Failed" />}
      </div>
      {open && (
        <div className="mt-0.5 mb-2 ml-5 space-y-1.5">
          {diff.length ? <Diff lines={diff} /> : (
            <pre className="max-h-60 overflow-auto rounded-[8px] bg-muted px-2.5 py-1.5 font-mono text-[12px] leading-[17px] whitespace-pre-wrap break-words">{t.name === "Bash" ? String(t.input.command ?? "") : JSON.stringify(t.input, null, 2)}</pre>
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

// ---------- a permission question

function AskCard({ a, conv }: { a: Ask; conv: string }) {
  const [busy, setBusy] = useState(false)
  const plan = a.tool === "ExitPlanMode"
  const d = describe(a.tool, a.input, a.file)
  const edit = /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(a.tool)
  const answer = async (allow: boolean) => {
    setBusy(true)
    try { await post(`claude-chat/conversations/${conv}/answer`, { ask: a.id, allow }) } catch (e) { notifyError(e, "Couldn't answer") } finally { setBusy(false) }
  }
  if (a.answer) {
    const said = a.answer === "allow" ? (plan ? "Plan approved" : "Allowed") : a.answer === "deny" ? (plan ? "Kept planning" : "Denied") : "Not answered"
    if (!plan) return <div className="px-1 text-[12px] text-tertiary max-md:text-[14px]" data-ask={a.answer}>{said}: {d.verb.toLowerCase()} {d.what}</div>
  }
  const head = plan ? "Claude's plan is ready" : edit ? "Claude wants to edit" : a.tool === "Bash" ? "Claude wants to run a command" : a.tool === "WebFetch" ? "Claude wants to read a web page" : `Claude wants to use ${d.what || a.tool}`
  return (
    <div className="rounded-[10px] border-[0.5px] border-border bg-card p-2.5 shadow-xs" data-ask={a.answer ?? "waiting"} data-ask-tool={a.tool}>
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[13px] font-medium max-md:text-[16px]">
        <span className="shrink-0">{head}</span>
        {edit && (a.file ? <FileLink file={a.file}>{noteName(a.file)}</FileLink> : <span className="truncate font-mono text-[12px]">{d.what}</span>)}
      </div>
      {plan ? <Markdown text={String(a.input.plan ?? "")} className="mb-2 text-[13px]" />
        : edit ? <div className="mb-2"><Diff lines={diffLines(a.tool, a.input)} /></div>
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

// ---------- the conversation

function UserMessage({ e, conv }: { e: Extract<Entry, { kind: "user" }>; conv: string }) {
  return (
    <div className="ml-6 min-w-0 rounded-[10px] bg-muted px-2.5 py-1.5 max-md:ml-10" data-entry="user">
      <div className="text-[13px] leading-[19px] whitespace-pre-wrap break-words max-md:text-[17px] max-md:leading-[23px]">{e.text}</div>
      {(e.file || e.images?.length) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {e.images?.map((im) => <img key={im} src={`api/claude-chat/image/${conv}/${im}`} alt="" className="h-12 rounded-[4px] border-[0.5px] border-border object-cover" />)}
          {e.file && <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground"><FileText className="size-3 shrink-0" /><FileLink file={e.file}>{noteName(e.file)}</FileLink></span>}
        </div>
      )}
    </div>
  )
}

function SignIn({ status, refresh }: { status: "missing" | "signed-out"; refresh: () => void }) {
  const on = useEnabled()
  const terminal = on("terminal") && on("claude-code")
  return (
    <div className="space-y-2 rounded-[10px] border-[0.5px] border-border bg-card p-3 text-[13px] leading-[19px] max-md:text-[16px] max-md:leading-[22px]" data-chat-problem={status}>
      {status === "missing" ? (
        <p>Claude Code isn't installed on the server's machine. Install it from <a className="text-primary hover:underline" href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a>, sign in, then check again.</p>
      ) : (
        <p>Claude Code isn't signed in on the server's machine. Run <code>claude</code> there and sign in with <code>/login</code>, then check again.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {status === "signed-out" && terminal && (
          <button type="button" onClick={() => openAgent("claude")} className={cn(pill, "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground hover:opacity-90")}>
            <SquareTerminal className="size-3.5" />Open Claude Code to sign in
          </button>
        )}
        <button type="button" onClick={refresh} className={cn(pill, "border-[0.5px] border-border")}>Check again</button>
      </div>
    </div>
  )
}

/** What scrolls the messages: their own box when the chat fills one, else the nearest scroller around them (the
 *  sidebar panel's box, the phone's drawer). */
function scrollerOf(el: HTMLElement | null, fill: boolean): HTMLElement | null {
  if (fill) return el
  for (let p = el?.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p
  return null
}

function Messages({ id, entries, running, status, problem, fill, compact }: { id: string; entries: Entry[]; running: boolean; status: string; problem: ReactNode; fill: boolean; compact: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => { const el = scrollerOf(ref.current, fill); if (el && stick.current) el.scrollTop = el.scrollHeight }, [entries, running, status, fill])
  useLayoutEffect(() => { stick.current = true }, [id])
  useEffect(() => {
    const el = scrollerOf(ref.current, fill)
    if (!el) return
    const on = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }
    el.addEventListener("scroll", on, { passive: true })
    return () => el.removeEventListener("scroll", on)
  }, [fill])
  // Tool calls in a row are drawn together, tight; messages get room around them.
  const groups: { at: number; entries: Entry[] }[] = []
  entries.forEach((e, i) => {
    const last = groups[groups.length - 1]
    if (e.kind === "tool" && last?.entries[0].kind === "tool") last.entries.push(e)
    else groups.push({ at: i, entries: [e] })
  })
  return (
    <div ref={ref} className={cn("px-2 py-2", fill ? "min-h-0 flex-1 overflow-y-auto" : "min-h-[160px]")} data-chat-messages aria-live="polite">
      <div className="flex flex-col gap-2.5">
        {problem}
        {!entries.length && !problem && (
          <p className="px-1 pt-1 text-[13px] leading-[19px] text-muted-foreground max-md:text-[17px] max-md:leading-[23px]">
            Ask Claude about your notes, or to change them: it works in this vault and asks before it edits anything. Type @ to point it at a note.
          </p>
        )}
        {groups.map(({ at, entries: g }) => {
          const e = g[0]
          if (e.kind === "tool") return <div key={at} className="-mx-1 flex flex-col">{(g as Tool[]).map((t) => <ToolLine key={t.id} t={t} />)}</div>
          if (e.kind === "user") return <UserMessage key={at} e={e} conv={id} />
          if (e.kind === "assistant") return <Markdown key={at} text={e.text || " "} className={cn("min-w-0 px-1 break-words", compact && "!text-[13px] !leading-[19px] max-md:!text-[17px] max-md:!leading-[24px]")} />
          if (e.kind === "ask") return <AskCard key={at} a={e} conv={id} />
          return (
            <div key={at} data-note={e.error ? "error" : "info"} className={cn("px-1 text-[12px] leading-[17px] max-md:text-[15px] max-md:leading-[21px]", e.error ? "text-[var(--red)]" : "text-tertiary")}>
              {e.text}
            </div>
          )
        })}
        {running && (
          <div className="flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground max-md:text-[15px]" data-chat-status={status}>
            <span className="size-1.5 animate-pulse rounded-full" style={{ background: status === "waiting" ? "var(--yellow)" : TINT }} />
            {STATUS[status] ?? "Working"}…
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- writing a message

/** The box to write in: the open note as a chip, @ to point at a note, pasted images; Enter sends (⇧↩ a new line). */
function Composer({ id, running, ready, onSent, status, fill }: { id: string; running: boolean; ready: boolean; onSent: (id: string) => void; status: Status | null; fill: boolean }) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<Image[]>([])
  const [sending, setSending] = useState(false)
  const [settings, setSettings] = usePluginSettings("claude-chat")
  const focused = useFocusedFile().path
  const [dropped, setDropped] = useState("")
  const area = useRef<HTMLTextAreaElement>(null)
  const mode = MODES.find((m) => m.id === settings?.mode) ?? MODES[0]
  const model = typeof settings?.model === "string" ? settings.model : ""
  const models = status?.models ?? []
  const modelLabel = model ? models.find((m) => m.value === model)?.label ?? model : "Default model"
  const note = settings?.currentNote !== false && focused && dropped !== focused ? focused : ""
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const send = async () => {
    const said = text.trim()
    if ((!said && !images.length) || sending || running || !ready) return
    setSending(true)
    try {
      const to = id || (await post<{ id: string }>("claude-chat/conversations", {})).id
      await post(`claude-chat/conversations/${to}/send`, { text: said, file: note || undefined, images: images.map(({ type, data }) => ({ type, data })) })
      setText(""); setImages([])
      onSent(to)
    } catch (e) {
      notifyError(e, "Couldn't send it")
    } finally {
      setSending(false)
    }
  }
  const stop = () => void post(`claude-chat/conversations/${id}/stop`, {}).catch((e) => notifyError(e, "Couldn't stop it"))

  /** @: a note picked from the vault, put in as its path. */
  const mention = (replaceAt = -1) => {
    const files = [...getStore()?.files.files ?? []].sort((a, b) => b.mtime - a.mtime)
    choose({
      title: "Point Claude at a note", placeholder: "Find a note", items: files.slice(0, 3000).map((f) => ({ id: f.path, label: f.title || noteName(f.path), detail: f.path, icon: FileText })),
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
    // An @ typed at a word's start asks which note.
    if (v[caret - 1] === "@" && (caret === 1 || /\s/.test(v[caret - 2])) && v.length > text.length) mention(caret - 1)
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
  const modelMenu = (): MenuItem[] => [
    { label: "Default model", checked: !model, hint: "Claude Code's", run: () => void setSettings({ model: null }) },
    ...models.filter((m) => m.value !== "default").map((m) => ({ label: m.label, checked: model === m.value, run: () => void setSettings({ model: m.value }) })),
  ]
  const modeMenu = (): MenuItem[] => MODES.map((m) => ({ label: m.label, checked: mode.id === m.id, run: () => void setSettings({ mode: m.id === "default" ? null : m.id }) }))
  return (
    <div className={cn("shrink-0 px-2 pb-2", !fill && "sticky bottom-0 z-[2] bg-sidebar pt-1")} data-composer>
      <div className="rounded-[10px] border-[0.5px] border-border bg-background focus-within:border-primary">
        {(note || images.length > 0) && (
          <div className="flex flex-wrap items-center gap-1 px-1.5 pt-1.5">
            {note && (
              <span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-[5px] bg-muted pr-0.5 pl-1.5 text-[12px] text-muted-foreground max-md:h-8 max-md:text-[14px]" data-note-chip={note}
                data-tip="Sent with your message: the note open beside the chat">
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
        <textarea ref={area} value={text} rows={1} placeholder={ready ? "Ask Claude about your notes" : "Claude Code isn't ready"} aria-label="Message to Claude"
          onChange={(e) => onInput(e.target.value, e.target.selectionStart)} onKeyDown={onKey} onPaste={onPaste} data-chat-input data-keeps-keys
          className="block max-h-[200px] w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-[13px] leading-[19px] outline-none placeholder:text-tertiary max-md:text-[17px] max-md:leading-[23px]" />
        <div className="flex items-center gap-0.5 px-1 pb-1">
          <button type="button" className={button} aria-label="Point Claude at a note" data-tip="Point Claude at a note (@)" onClick={() => mention()}><AtSign className="size-3.5 max-md:size-5" /></button>
          <button type="button" className={cn(pill, "min-w-0 shrink")} data-tip={mode.tip} data-chat-mode={mode.id} onClick={(e) => menuAbove(e, modeMenu())}><span className="truncate">{mode.label}</span></button>
          <button type="button" className={cn(pill, "min-w-0 shrink")} data-tip="The model it uses" data-chat-model={model || "default"} onClick={(e) => menuAbove(e, modelMenu())}><span className="truncate">{modelLabel}</span></button>
          <span className="flex-1" />
          {running ? (
            <button type="button" onClick={stop} aria-label="Stop" data-tip="Stop (Esc)" data-chat-stop
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full bg-foreground text-background hover:opacity-85 max-md:size-11">
              <Square className="size-3 fill-current max-md:size-4" />
            </button>
          ) : (
            <button type="button" onClick={() => void send()} disabled={(!text.trim() && !images.length) || sending || !ready} aria-label="Send" data-tip="Send (↩)" data-chat-send
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-40 max-md:size-11">
              <ArrowUp className="size-4 max-md:size-5" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- the list of conversations

function Conversations({ current, pick, onNew, fill }: { current: string; pick: (id: string) => void; onNew: () => void; fill: boolean }) {
  const list = useList()
  return (
    <div className={cn("px-1.5 py-1", fill && "min-h-0 flex-1 overflow-y-auto")} data-chat-list>
      <button type="button" onClick={onNew} className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-[5px] pl-1.5 text-left text-[13px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground max-md:h-11 max-md:text-[17px]">
        <MessageSquarePlus className="size-4 shrink-0" />New chat
      </button>
      {list?.map((c) => (
        <div key={c.id} data-chat-row={c.id} onClick={() => pick(c.id)} onContextMenu={menuFor(() => convMenu(c.id, c.title, () => pick(""), current === c.id))}
          className={cn("group/row flex h-7 cursor-pointer items-center gap-2 rounded-[5px] pr-1 pl-1.5 text-[13px] max-md:h-11 max-md:text-[17px]",
            c.id === current ? "bg-foreground/[0.08] font-medium" : "hover:bg-foreground/[0.04]")}>
          <span className={cn("size-1.5 shrink-0 rounded-full", c.waiting ? "bg-[var(--yellow)]" : c.running ? "animate-pulse bg-[var(--orange)]" : "bg-transparent")} />
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
          <span className="shrink-0 text-[11px] text-tertiary group-hover/row:hidden max-md:text-[13px]">{fmtAgo(c.updated).replace(" ago", "")}</span>
          <button type="button" aria-label="Delete" data-tip="Delete" onClick={(e) => { e.stopPropagation(); void remove(c.id, c.title, current === c.id ? () => pick("") : undefined) }}
            className="hidden size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-muted-foreground group-hover/row:grid hover:bg-foreground/[0.08] hover:text-foreground">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      {list && !list.length && <p className="px-1.5 pt-1 text-[13px] text-tertiary">No conversations yet.</p>}
    </div>
  )
}

async function remove(id: string, title: string, after?: () => void) {
  if (!(await confirmDialog({ title: `Delete “${title}”?`, body: "The conversation goes from this list for good. Claude Code keeps its own record of the session.", confirm: "Delete", danger: true }))) return
  try { await del(`claude-chat/conversations/${id}`); after?.() } catch (e) { notifyError(e, "Couldn't delete it") }
}

let renaming: ((id: string) => void) | null = null
function convMenu(id: string, title: string, gone: () => void, here: boolean, extra: MenuItem[] = []): MenuItem[] {
  return [
    ...extra,
    ...(here && renaming ? [{ label: "Rename", icon: Pencil, run: () => renaming?.(id) }] : []),
    { label: "Delete", icon: Trash2, danger: true, run: () => void remove(id, title, gone) },
  ]
}

// ---------- the whole chat

/** A chat: `id` the conversation shown ("" for a new one), `setId` to show another. `tab`: drawn in its own tab. `fill`:
 *  it has a box of its own height to fill (a tab, a flyout); else it flows, its head and box to write in stuck to the
 *  edges of what scrolls it (a sidebar panel measures what it draws, so it can't be told a height). */
export function Chat({ id, setId, tab, fill = !!tab }: { id: string; setId: (id: string) => void; tab?: boolean; fill?: boolean }) {
  useSocket()
  const refused = useRefused()
  const shown = useConv(id)
  const [listing, setListing] = useState(false)
  const [renameOn, setRenameOn] = useState(false)
  const [check, setCheck] = useState(0)
  const { data: status } = useLive<Status>(check ? `claude-chat/status?fresh=${check}` : "claude-chat/status", check)
  const on = useEnabled()
  useEffect(() => { if (shown?.gone) setId("") }, [shown?.gone]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { renaming = (x) => { if (x === id) setRenameOn(true) }; return () => { renaming = null } }, [id])

  const conv = shown?.conv ?? null
  const entries = useMemo(() => conv?.entries ?? [], [conv])
  const live = shown?.live ?? { running: false, status: "" }
  const title = conv?.title ?? (id ? "" : "New chat")
  const problem = refused ? <p className="px-1 text-[13px] text-muted-foreground">{refused}</p>
    : status && !status.installed ? <SignIn status="missing" refresh={() => setCheck(Date.now())} />
    : status && !status.loggedIn ? <SignIn status="signed-out" refresh={() => setCheck(Date.now())} /> : null
  const lastSignIn = entries.at(-1)?.kind === "note" && (entries.at(-1) as { signIn?: boolean }).signIn
  const ready = !!status?.installed && !!status.loggedIn && !refused

  const handOff = async () => {
    try {
      const { session } = await post<{ session: string }>(`claude-chat/conversations/${id}/handoff`, {})
      openAgent("claude", { resume: session, newTab: true })
    } catch (e) { notifyError(e, "Couldn't open it in a terminal") }
  }
  const more = (): MenuItem[] => {
    const own: MenuItem[] = [
      ...(!tab ? [{ label: "Open in a tab", icon: SquareArrowOutUpRight, run: () => openView(`claude-chat/${id}`, { newTab: true }) }] : []),
      ...(conv?.started && on("terminal") && on("claude-code") ? [{ label: "Open in terminal", icon: SquareTerminal, run: () => void handOff() }] : []),
    ]
    return id ? convMenu(id, title, () => setId(""), true, own) : own
  }
  const newChat = () => { setListing(false); setId("") }

  return (
    <div className={cn("flex flex-col", fill && "min-h-0 flex-1", tab && "mx-auto w-full max-w-[760px]")} data-claude-chat={id || "new"} data-running={live.running || undefined}>
      <div className={cn("flex shrink-0 items-center gap-0.5 pr-1.5 pl-2", tab ? "h-10" : "h-8 max-md:h-12", !fill && "sticky top-0 z-[2] bg-sidebar")} data-chat-head>
        {renameOn && conv ? (
          <input autoFocus defaultValue={conv.title} aria-label="Conversation's name" data-chat-rename
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenameOn(false)
              if (e.key !== "Enter") return
              const v = e.currentTarget.value.trim()
              setRenameOn(false)
              if (v && v !== conv.title) void patch(`claude-chat/conversations/${id}`, { title: v }).catch((x) => notifyError(x, "Couldn't rename it"))
            }}
            onBlur={() => setRenameOn(false)}
            className="h-6 min-w-0 flex-1 rounded-[5px] border-[0.5px] border-primary bg-background px-1.5 text-[13px] outline-none max-md:h-9 max-md:text-[17px]" />
        ) : (
          // (a phone's header names the tab already)
          <button type="button" onClick={() => setListing(!listing)} onDoubleClick={() => id && setRenameOn(true)} data-tip="Conversations"
            className={cn("flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-[5px] px-1 text-left hover:bg-foreground/[0.05] max-md:h-11", tab && !listing && "max-md:invisible")}>
            <ChatIcon className="size-3.5 shrink-0 max-md:size-5" style={{ color: TINT }} />
            <span className={cn("truncate font-semibold", tab ? "text-[14px]" : "text-[12px] text-muted-foreground", "max-md:text-[17px] max-md:text-foreground")}>{listing ? "Conversations" : title || "Claude chat"}</span>
          </button>
        )}
        <button type="button" className={cn(button, listing && "bg-foreground/[0.08] text-foreground")} aria-label="Conversations" data-tip="Conversations" data-chat-history onClick={() => setListing(!listing)}>
          <History className="size-3.5 max-md:size-5" />
        </button>
        <button type="button" className={button} aria-label="New chat" data-tip="New chat" data-chat-new onClick={newChat}><MessageSquarePlus className="size-3.5 max-md:size-5" /></button>
        {id && <button type="button" className={button} aria-label="More" data-tip="More" data-chat-more onClick={(e) => menuBelow(e, more())}><MoreHorizontal className="size-3.5 max-md:size-5" /></button>}
      </div>
      {listing ? <Conversations fill={fill} current={id} pick={(x) => { setId(x); setListing(false) }} onNew={newChat} /> : (
        <>
          <Messages id={id} entries={entries} running={live.running} status={live.status} fill={fill} compact={!tab}
            problem={problem ?? (lastSignIn ? <SignIn status="signed-out" refresh={() => setCheck(Date.now())} /> : null)} />
          <Composer id={id} running={live.running} ready={ready} status={status} fill={fill} onSent={(to) => { if (to !== id) setId(to) }} />
        </>
      )}
    </div>
  )
}
