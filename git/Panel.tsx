// Source control: the changed files (staged, not, in conflict) with their status, a commit message box, Commit and
// Commit and sync, Pull and Push on the heading. A sidebar panel, and the same a size up in its tab (view:git).
import { useState, type MouseEvent, type ReactNode } from "react"
import {
  AlertTriangle, ArrowDown, ArrowUp, CloudOff, FileText, GitBranch, GitCommitHorizontal, History, Loader2, Minus, MoreHorizontal, Plus, RefreshCw,
  SquareArrowOutUpRight, Undo2,
} from "lucide-react"
import { cn, confirmDialog, menuBelow, menuFor, openFile, openPluginSettings, openView, panelMenu, SidebarHeading, stem, useTick, type MenuItem, type SidebarCtx } from "@vaultite"
import { abortMerge, commit, commitAndSync, discard, init, pull, push, refresh, setRemote, stage, unstage, useGit } from "./client"
import { ago } from "./History"
import { LETTER_TINT, LETTER_WORD, letter, type FileStatus, type Snapshot } from "./types"

const openDiff = (p: string) => openView(`git-diff/${p}`)
const openHistory = (p: string) => openView(`git-history/${p}`)

function HeadButton({ label, icon: Icon, onClick, disabled }: { label: string; icon: typeof Plus; onClick: (e: MouseEvent) => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-tip={label} aria-label={label}
      className="grid size-6 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40">
      <Icon className="size-[15px]" strokeWidth={2} />
    </button>
  )
}

function fileMenu(f: FileStatus, side: "staged" | "unstaged"): MenuItem[] {
  const name = stem(f.path.split("/").pop()!)
  return [
    { label: "Open changes", icon: GitCommitHorizontal, run: () => openDiff(f.path) },
    { label: "Open file", icon: FileText, run: () => openFile(f.path) },
    { label: "Git history", icon: History, run: () => openHistory(f.path) },
    side === "staged" ? { label: "Unstage", icon: Minus, sep: true, run: () => void unstage([f.path]) }
      : { label: f.conflict ? "Mark resolved" : "Stage", icon: Plus, sep: true, run: () => void stage([f.path]) },
    ...(!f.untracked && !f.conflict && !f.from && f.x !== "A" ? [{
      label: "Discard changes", icon: Undo2, danger: true, run: async () => {
        if (await confirmDialog({ title: `Discard the changes to ${name}?`, body: "It goes back to its last commit. File history keeps what it has now.", confirm: "Discard", danger: true })) void discard([f.path])
      },
    }] : []),
  ]
}

function FileRow({ f, side, phone }: { f: FileStatus; side: "staged" | "unstaged"; phone?: boolean }) {
  const parts = f.path.split("/")
  const name = parts.pop()!
  const l = letter(f, side)
  const toggle = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); void (side === "staged" ? unstage([f.path]) : stage([f.path])) }
  return (
    <a href="#" data-keyrow data-git-file={f.path} data-side={side} aria-label={`${name}, ${LETTER_WORD[l]?.toLowerCase() ?? l}`}
      onClick={(e) => { e.preventDefault(); openDiff(f.path) }}
      onContextMenu={menuFor(() => fileMenu(f, side))}
      className="group/row flex h-7 items-center gap-1.5 rounded-[5px] pr-1 pl-1.5 text-[13px] whitespace-nowrap hover:bg-foreground/[0.04]">
      <span className={cn("min-w-0 truncate", l === "D" && "line-through decoration-[color-mix(in_srgb,var(--red)_60%,transparent)]")}>{name.replace(/\.md$/i, "")}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-tertiary">{parts.join("/")}</span>
      <span className={cn("flex gap-0.5", !phone && "hidden group-hover/row:flex")}>
        <button type="button" data-tip="Open file" aria-label="Open file" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openFile(f.path) }}
          className="grid size-5 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground">
          <FileText className="size-3.5" strokeWidth={2} />
        </button>
        <button type="button" data-tip={side === "staged" ? "Unstage" : f.conflict ? "Mark resolved" : "Stage"} aria-label={side === "staged" ? "Unstage" : "Stage"} onClick={toggle}
          className="grid size-5 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground">
          {side === "staged" ? <Minus className="size-3.5" strokeWidth={2} /> : <Plus className="size-3.5" strokeWidth={2} />}
        </button>
      </span>
      <span className="w-3.5 shrink-0 text-center font-mono text-[11.5px] font-semibold" style={{ color: LETTER_TINT[l] }} data-tip={LETTER_WORD[l]}>{l}</span>
    </a>
  )
}

function Section({ title, files, side, action, phone }: { title: string; files: FileStatus[]; side: "staged" | "unstaged"; action?: { label: string; icon: typeof Plus; run: () => void }; phone?: boolean }) {
  const [shut, setShut] = useState(false)
  if (!files.length) return null
  return (
    <div data-git-section={title}>
      <div className="group/sec flex h-7 items-center gap-1 pr-1 pl-1.5">
        <button type="button" onClick={() => setShut(!shut)} aria-expanded={!shut}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[12px] font-semibold text-muted-foreground hover:text-foreground">
          <span className="truncate">{title}</span>
          <span className="rounded-full bg-foreground/[0.07] px-1.5 text-[11px] leading-[16px] font-medium tabular-nums">{files.length}</span>
        </button>
        {action && (
          <button type="button" onClick={action.run} data-tip={action.label} aria-label={action.label}
            className={cn("grid size-5 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground", !phone && "opacity-0 group-hover/sec:opacity-100 focus-visible:opacity-100")}>
            <action.icon className="size-3.5" strokeWidth={2} />
          </button>
        )}
      </div>
      {!shut && <div className="flex flex-col gap-px">{files.map((f) => <FileRow key={`${side}:${f.path}`} f={f} side={side} phone={phone} />)}</div>}
    </div>
  )
}

const NOTE = "rounded-[8px] px-2.5 py-2 text-[12.5px] leading-[17px]"

function Setup({ s }: { s: Snapshot }) {
  const [busy, setBusy] = useState(false)
  if (!s.git) return <p className={cn(NOTE, "bg-foreground/[0.04] text-muted-foreground")}>Git isn't installed on the server's machine. On a Mac: xcode-select --install, or brew install git.</p>
  const make = async () => {
    if (s.cloud && !(await confirmDialog({ title: `Make a repository in ${s.cloud.name}?`, body: s.cloud.warning, confirm: "Make it anyway", danger: true }))) return
    setBusy(true)
    await init(!!s.cloud)
    setBusy(false)
  }
  return (
    <div className="flex flex-col gap-2 px-1.5 pt-1">
      <p className="text-[13px] leading-[18px] text-muted-foreground">The vault isn't a git repository. Make it one to commit its changes, see each file's history and sync it with a remote.</p>
      {s.cloud && <CloudNote s={s} />}
      <button type="button" disabled={busy} onClick={make} data-git-init
        className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        <GitBranch className="size-3.5" strokeWidth={2.25} />Make a repository
      </button>
    </div>
  )
}

function CloudNote({ s }: { s: Snapshot }) {
  const [open, setOpen] = useState(false)
  if (!s.cloud) return null
  return (
    <div className={cn(NOTE, "bg-[color-mix(in_srgb,var(--orange)_12%,transparent)]")} data-git-cloud>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-start gap-1.5 text-left">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-[var(--orange)]" strokeWidth={2.25} />
        <span><span className="font-medium">{s.cloud.sure ? `In ${s.cloud.name}` : `Maybe in ${s.cloud.name}`}:</span> it and git can fight. {open ? "" : <span className="text-muted-foreground">Why?</span>}</span>
      </button>
      {open && <p className="mt-1 pl-5 text-muted-foreground">{s.cloud.warning.replace(/^[^.]*\.\s*/, "")}</p>}
    </div>
  )
}

function RemoteSetup() {
  const [url, setUrl] = useState("")
  return (
    <form className="flex gap-1 px-1.5" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void setRemote(url.trim()).then(() => setUrl("")) }}>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Remote address (git@…, https://…)" aria-label="Remote address" spellCheck={false}
        className="h-7 min-w-0 flex-1 rounded-[6px] border-[0.5px] border-border bg-background/60 px-2 text-[12.5px] outline-none focus:border-ring" />
      <button type="submit" disabled={!url.trim()} className="h-7 cursor-pointer rounded-[6px] bg-foreground/[0.06] px-2.5 text-[12.5px] font-medium hover:bg-foreground/[0.1] disabled:opacity-40">Add</button>
    </form>
  )
}

/** The branch, ahead and behind, the last commit. */
function BranchLine({ s }: { s: Snapshot }) {
  useTick()
  return (
    <div className="flex h-6 items-center gap-1.5 pr-1 pl-1.5 text-[12px] whitespace-nowrap text-muted-foreground" data-git-branch>
      <GitBranch className="size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 truncate font-medium text-foreground/80">{s.branch ?? "detached"}</span>
      {!!s.ahead && <span className="flex items-center tabular-nums" data-tip={`${s.ahead} commit${s.ahead === 1 ? "" : "s"} to push`}><ArrowUp className="size-3" strokeWidth={2.25} />{s.ahead}</span>}
      {!!s.behind && <span className="flex items-center tabular-nums" data-tip={`${s.behind} commit${s.behind === 1 ? "" : "s"} to pull`}><ArrowDown className="size-3" strokeWidth={2.25} />{s.behind}</span>}
      {!s.remotes?.length && <span className="flex items-center gap-0.5" data-tip="No remote: commits stay here"><CloudOff className="size-3" strokeWidth={2.25} /></span>}
      <span className="flex-1" />
      {s.lastCommit && <span className="truncate text-tertiary" data-tip={`Last commit: ${s.lastCommit.subject}`}>{ago(s.lastCommit.t).toLowerCase()}</span>}
    </div>
  )
}

export function SourceControl({ open, panel, phone, page }: Partial<SidebarCtx> & { page?: boolean }) {
  const { snap: s, error, running } = useGit()
  const [message, setMessage] = useState("")
  if (open === false) return null
  const busy = running ?? s?.busy ?? null
  const can = !!s?.repo && !busy
  const head: ReactNode = (
    <>
      <HeadButton label="Pull" icon={ArrowDown} disabled={!can || !s?.remotes?.length} onClick={() => void pull()} />
      <HeadButton label="Push" icon={ArrowUp} disabled={!can || !s?.remotes?.length} onClick={() => void push()} />
      <HeadButton label="Refresh" icon={RefreshCw} onClick={() => void refresh()} />
      <HeadButton label="More" icon={MoreHorizontal} onClick={(e) => menuBelow(e, [
        ...(page ? [] : [{ label: "Open in a tab", icon: SquareArrowOutUpRight, run: () => openView("git", { newTab: true }) }]),
        { label: "Stage all", icon: Plus, disabled: !can, run: () => void stage() },
        { label: "Unstage all", icon: Minus, disabled: !can, run: () => void unstage() },
        ...(s?.merging ? [{ label: "Abort merge", icon: Undo2, sep: true, run: async () => {
          if (await confirmDialog({ title: "Abort the merge?", body: "The vault goes back to how it was before the pull: your commits stay, the remote's wait for the next pull.", confirm: "Abort merge" })) void abortMerge()
        } }] : []),
        { label: "Git settings", sep: true, run: () => openPluginSettings("git") },
        ...(panel ? panelMenu(panel).map((it, i) => (i ? it : { ...it, sep: true })) : []),
      ])} />
    </>
  )
  const files = s?.files ?? []
  const conflicts = files.filter((f) => f.conflict)
  const staged = files.filter((f) => f.staged)
  const changed = files.filter((f) => f.unstaged && !f.conflict)
  const template = "Message (empty: the template in Git's settings)"
  const run = (fn: (m: string) => Promise<unknown>) => () => { void fn(message).then((r) => { if (r) setMessage("") }) }
  return (
    <div className={cn("flex shrink-0 flex-col pb-1", page && "pb-10")} data-git-panel>
      {page ? null : <SidebarHeading title="Source control" open>{head}</SidebarHeading>}
      {page && <div className="mb-1 flex items-center justify-end gap-0.5">{head}</div>}
      {!s ? <p className="h-7 pl-1.5 text-[13px] leading-7 text-tertiary">{error ? `Couldn't ask git: ${error}` : "Loading…"}</p>
        : !s.repo ? <Setup s={s} />
        : (
          <div className="flex flex-col gap-1.5">
            <BranchLine s={s} />
            {s.cloud && <div className="px-1.5"><CloudNote s={s} /></div>}
            {!s.remotes?.length && <RemoteSetup />}
            {s.merging && (
              <div className={cn(NOTE, "mx-1.5 bg-[color-mix(in_srgb,var(--red)_12%,transparent)]")} data-git-merge>
                <p><span className="font-medium">{conflicts.length ? `Merge conflicts in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}.` : "A merge is ready to commit."}</span>{" "}
                  {conflicts.length ? "Nothing was lost: in each file, keep what you want between <<<<<<< and >>>>>>>, then Commit." : "Commit finishes it."}</p>
                <button type="button" className="mt-1 cursor-pointer font-medium text-[var(--red)] hover:underline" onClick={async () => {
                  if (await confirmDialog({ title: "Abort the merge?", body: "The vault goes back to how it was before the pull: your commits stay, the remote's wait for the next pull.", confirm: "Abort merge" })) void abortMerge()
                }}>Abort merge</button>
              </div>
            )}
            <div className="flex flex-col gap-1.5 px-1.5">
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder={template} aria-label="Commit message" data-git-message
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(commit)() } }}
                className="max-h-40 min-h-[52px] w-full resize-y rounded-[6px] border-[0.5px] border-border bg-background/60 px-2 py-1.5 text-[13px] leading-[18px] outline-none placeholder:text-tertiary focus:border-ring" />
              <div className="flex gap-1.5">
                <button type="button" disabled={!can || (!files.length && !s.merging)} onClick={run(commit)} data-git-commit
                  className="h-7 min-w-0 shrink-0 cursor-pointer truncate rounded-[6px] bg-foreground/[0.07] px-3 text-[13px] font-medium hover:bg-foreground/[0.11] disabled:opacity-40">
                  Commit
                </button>
                <button type="button" disabled={!can || (!!s.merging && !!conflicts.length)} onClick={run(commitAndSync)} data-git-sync
                  className="h-7 min-w-0 flex-1 cursor-pointer truncate rounded-[6px] bg-primary px-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
                  Commit and sync
                </button>
              </div>
              {busy && <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground" aria-busy data-git-busy><Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />{busy}…</p>}
              {!busy && s.lastSync && !s.lastSync.ok && s.lastSync.error && (
                <p className="text-[12px] leading-[16px] text-[var(--red)]" data-git-error>{s.lastSync.auto ? "The last automatic sync failed" : "The last sync failed"}: {s.lastSync.error}</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Section title="Merge conflicts" files={conflicts} side="unstaged" phone={phone} />
              <Section title="Staged changes" files={staged} side="staged" phone={phone} action={{ label: "Unstage all", icon: Minus, run: () => void unstage(staged.map((f) => f.path)) }} />
              <Section title="Changes" files={changed} side="unstaged" phone={phone} action={{ label: "Stage all", icon: Plus, run: () => void stage(changed.map((f) => f.path)) }} />
              {(s.total ?? 0) > files.length && <p className="h-7 pl-1.5 text-[12px] leading-7 text-tertiary">and {(s.total ?? 0) - files.length} more</p>}
              {!files.length && !s.merging && <p className="h-7 pl-1.5 text-[13px] leading-7 text-tertiary" data-git-clean>Nothing changed since the last commit</p>}
            </div>
          </div>
        )}
    </div>
  )
}
