// Git per thread, as T3 Code's: the branch and one button for what's next (commit, push, a pull request) in the header,
// and below a new thread's box its workspace (the checkout or a new worktree) and branch.
import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, CloudUpload, ExternalLink, Folder, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, LoaderCircle, TriangleAlert } from "lucide-react"
import { choose, cn, confirmDialog, copyText, get, menuAbove, menuBelow, notify, notifyError, openWebLink, post, type MenuItem } from "@vaultite"
import { checkoutPr } from "./Chat"
import type { FileDiff, GitState, Project } from "./types"
import { Counts, pill } from "./ui"

type Action = "commit" | "push" | "pr" | "commit-push" | "commit-push-pr"
const LABEL: Record<Action, string> = { commit: "Commit", push: "Push", pr: "Create PR", "commit-push": "Commit & push", "commit-push-pr": "Commit, push & PR" }
const DOING: Record<Action, string> = { commit: "Committing…", push: "Pushing…", pr: "Creating pull request…", "commit-push": "Committing & pushing…", "commit-push-pr": "Committing, pushing & opening a PR…" }
/** A pull request's reference as T3 Code reads one: its URL, `gh pr checkout 42`, or #42. */
export function prRef(typed: string) {
  const s = typed.trim().replace(/^gh\s+pr\s+checkout\s+/, "")
  if (/^https?:\/\/\S+\/pull\/\d+/.test(s)) return s
  return /^#?(\d+)$/.exec(s)?.[1] ?? null
}

/** The thread's checkout, fetched now and again whenever `key` changes (a turn ended), with its PR every so often. */
export function useGit(id: string, key: string) {
  const [git, setGit] = useState<GitState | null | undefined>(undefined)
  const prAt = useRef(0)
  const load = useCallback(async (pr = false) => {
    if (!id) return setGit(undefined)
    const ask = pr || Date.now() - prAt.current > 60_000
    try {
      const r = await get<{ git: GitState | null }>(`agents/threads/${id}/git${ask ? "?pr=1" : ""}`)
      if (ask) prAt.current = Date.now()
      setGit((was) => (r.git && !ask && was?.pr !== undefined ? { ...r.git, pr: was.pr } : r.git))
    } catch { setGit(null) }
  }, [id])
  useEffect(() => { void load() }, [load, key])
  return { git, reload: load }
}

/** What the one button does next: commit what's changed (and push, and open a PR when it can), or push what's committed. */
export function quickAction(g: GitState): { action: Action | "view"; label: string } | null {
  const pr = g.pr && g.pr.state === "OPEN" ? g.pr : null
  if (g.files) return g.remote ? { action: g.gh && !pr && g.branch !== g.base ? "commit-push-pr" : "commit-push", label: "" } : { action: "commit", label: "" }
  if (g.ahead && g.remote) return g.gh && !pr && g.branch !== g.base ? { action: "commit-push-pr", label: "Push & create PR" } : { action: "push", label: "Push" }
  if (pr) return { action: "view", label: `View PR #${pr.number}` }
  return null
}

function CommitBox({ id, g, action, onDone, onClose }: { id: string; g: GitState; action: Action; onDone: (r: Done) => void; onClose: () => void }) {
  const [message, setMessage] = useState("")
  const [files, setFiles] = useState<FileDiff[] | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { get<{ files: FileDiff[] }>(`agents/threads/${id}/diff?scope=uncommitted`).then((r) => setFiles(r.files)).catch(() => setFiles([])) }, [id])
  useEffect(() => {
    const out = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[role=dialog]")) onClose() }
    setTimeout(() => window.addEventListener("pointerdown", out), 0)
    return () => window.removeEventListener("pointerdown", out)
  }, [onClose])
  const go = async () => {
    if (action !== "commit" && g.branch === g.base && !(await confirmDialog({ title: `Commit & push to ${g.base}?`, body: `${g.base} is the default branch: this pushes straight to it.`, confirm: `Commit & push to ${g.base}` }))) return
    setBusy(true)
    try { onDone(await run(id, action, { message: message.trim() })) } catch (e) { notifyError(e, "Couldn't commit") } finally { setBusy(false) }
  }
  return (
    <div ref={box} className="glass-strong absolute top-full right-0 z-[60] mt-1 w-[min(360px,calc(100vw-1.5rem))] rounded-[12px] p-3 text-[13px] shadow-xl" data-commit-box={action}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose() } }}>
      <div className="mb-0.5 font-semibold">Commit changes</div>
      <p className="mb-2 text-[12px] text-muted-foreground">Review and confirm your commit. Leave the message blank to auto-generate one.</p>
      <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[12px]">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate font-mono">{g.branch || "(no branch)"}</span>
        {g.branch === g.base && <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-[color-mix(in_srgb,var(--yellow)_22%,transparent)] px-1 text-[11px]"><TriangleAlert className="size-3" />Default branch</span>}
      </div>
      <div className="mb-2 max-h-36 overflow-y-auto rounded-[8px] border-[0.5px] border-border py-0.5" data-commit-files>
        {!files ? <div className="px-2 py-1 text-[12px] text-tertiary">Loading…</div> : files.map((f) => (
          <div key={f.path} className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span><Counts added={f.added} removed={f.removed} />
          </div>
        ))}
      </div>
      <div className="mb-1 text-[12px] font-medium">Commit message (optional)</div>
      <textarea autoFocus value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Leave empty to auto-generate" aria-label="Commit message" data-commit-message data-keeps-keys
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go() } }}
        className="mb-2 block w-full resize-none rounded-[8px] border-[0.5px] border-border bg-background px-2 py-1.5 text-[13px] outline-none focus:border-primary" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-7 cursor-pointer rounded-[6px] px-3 text-[13px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">Cancel</button>
        <button type="button" disabled={busy} onClick={() => void go()} data-commit-go
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[6px] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {busy && <LoaderCircle className="size-3.5 animate-spin" />}{busy ? (message.trim() ? DOING[action] : "Writing the message…") : LABEL[action]}
        </button>
      </div>
    </div>
  )
}

type Done = { commit?: string; pushed?: boolean; pr?: string }
const run = (id: string, action: Action, body: Record<string, string> = {}) => post<Done>(`agents/threads/${id}/git`, { action, ...body })

/** The header's git: the branch, and the button for what's next with the rest in its menu. */
export function GitActions({ id, g, running, reload }: { id: string; g: GitState; running: boolean; reload: (pr?: boolean) => void }) {
  const [committing, setCommitting] = useState<Action | null>(null)
  const [doing, setDoing] = useState<Action | null>(null)
  const q = quickAction(g)
  const pr = g.pr && g.pr.state === "OPEN" ? g.pr : null
  const done = (r: Done) => {
    setCommitting(null)
    reload(true)
    const said = r.pr ? "Created the pull request" : r.pushed ? `Pushed${r.commit ? ` ${r.commit}` : ""} to origin/${g.branch}` : r.commit ? `Committed ${r.commit}` : "Done"
    notify(said, r.pr ? { action: { label: "View PR", run: () => openWebLink(r.pr!) } } : undefined)
  }
  const act = async (a: Action) => {
    if (a === "commit" || ((a === "commit-push" || a === "commit-push-pr") && g.files)) return setCommitting(a)
    if (g.branch === g.base && a !== "pr" && !(await confirmDialog({ title: `Push to ${g.base}?`, body: `${g.base} is the default branch.`, confirm: `Push to ${g.base}` }))) return
    setDoing(a)
    try { done(await run(id, a)) } catch (e) { notifyError(e, a === "pr" ? "Couldn't create the pull request" : "Couldn't push") } finally { setDoing(null) }
  }
  const menu = (): MenuItem[] => [
    { label: "Commit…", icon: GitCommitHorizontal, disabled: !g.files || running, run: () => void act("commit") },
    { label: "Push", icon: CloudUpload, disabled: !g.remote || (!g.ahead && !!g.upstream) || running, run: () => void act("push") },
    ...(!pr ? [{ label: "Create PR", icon: GitPullRequest, disabled: !g.gh || !g.remote || g.branch === g.base, hint: !g.gh ? "needs gh" : undefined, run: () => void act("pr") }] : []),
    ...(pr ? [{ label: `View PR #${pr.number}`, icon: ExternalLink, run: () => openWebLink(pr.url) }] : []),
    { label: "Copy branch name", sep: true, run: () => { void copyText(g.branch); notify("Copied") } },
  ]
  const busy = doing ?? null
  const primary = q?.action === "view" ? `View PR #${pr?.number}` : q ? (q.label || LABEL[q.action as Action]) : g.upstream || !g.remote ? "Up to date" : "Push"
  return (
    <div className="relative flex shrink-0 items-center" data-git-actions={q?.action ?? "none"}>
      <div className="flex h-7 items-center rounded-[7px] border-[0.5px] border-border max-md:h-9">
        <button type="button" disabled={!!busy || running || !q} data-git-primary data-tip={running ? "Wait for the agent to finish" : !q ? "Nothing to commit or push" : undefined}
          onClick={() => q && (q.action === "view" ? openWebLink(pr!.url) : void act(q.action))}
          className="inline-flex h-full cursor-pointer items-center gap-1.5 rounded-s-[7px] ps-2 pe-2 text-[12px] font-medium hover:bg-foreground/[0.06] disabled:cursor-default disabled:text-tertiary disabled:hover:bg-transparent max-md:text-[14px]">
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : q?.action === "view" ? <GitPullRequest className="size-3.5" /> : <GitCommitHorizontal className="size-3.5" />}
          {busy ? DOING[busy] : primary}
        </button>
        <button type="button" aria-label="Git actions" data-git-menu onClick={(e) => menuBelow(e, menu())}
          className="grid h-full w-6 cursor-pointer place-items-center rounded-e-[7px] border-s-[0.5px] border-border text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:w-9">
          <ChevronDown className="size-3.5" />
        </button>
      </div>
      {committing && <CommitBox id={id} g={g} action={committing} onDone={done} onClose={() => setCommitting(null)} />}
    </div>
  )
}

/** The branch as the header shows it: a worktree's mark or the checkout's, the name, how far ahead it is. */
export function BranchChip({ g }: { g: GitState }) {
  const I = g.worktree ? FolderGit2 : GitBranch
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-[5px] px-1 text-[12px] text-muted-foreground" data-branch={g.branch}
      data-tip={`${g.worktree ? "Its own worktree" : "The checkout"}: ${g.top}${g.files ? ` · ${g.files} changed ${g.files === 1 ? "file" : "files"}` : ""}`}>
      <I className="size-3.5 shrink-0" /><span className="min-w-0 truncate font-mono">{g.branch || "detached"}</span>
      {g.ahead > 0 && <span className="shrink-0 tabular-nums">↑{g.ahead}</span>}
      {g.behind > 0 && <span className="shrink-0 tabular-nums">↓{g.behind}</span>}
    </span>
  )
}

// ---------- a new thread: where it works

export type Workspace = { worktree: boolean; branch: string; create?: boolean }
type Branch = { name: string; current: boolean; worktree: string }

/** The branch picker (⌘⇧G): the checkout's branches; typing a new name offers to create it, a pull request's reference to
 *  check it out into a thread (T3 Code's). `current` is the branch the thread is on. */
export function pickBranch(cwd: string, value: Workspace, onChange: (w: Workspace & { create?: boolean }) => void, projects: Project[], current = "") {
  void get<{ git: boolean; list: Branch[] }>(`agents/branches?cwd=${encodeURIComponent(cwd)}`).then((r) => {
    if (!r.git) return notify("Not a git checkout")
    const here = current || r.list.find((b) => b.current)?.name || ""
    choose({
      title: value.worktree ? "Start the worktree from" : "Work on the branch", placeholder: "Search branches, or a pull request (#42, its URL)", current: value.branch || here,
      items: r.list.filter((b) => value.worktree || !b.worktree || b.current).map((b) => ({ id: b.name, label: b.name, detail: b.current ? "current" : b.worktree ? "in a worktree" : "", icon: GitBranch })),
      other: (typed) => {
        const pr = prRef(typed)
        if (pr) return { id: `pr:${pr}`, label: "Checkout Pull Request", detail: typed.trim(), icon: GitPullRequest }
        const name = typed.trim().replace(/\s+/g, "-")
        return !value.worktree && /^[\w./-]+$/.test(name) && !r.list.some((b) => b.name === name) ? { id: `new:${name}`, label: `Create new ref "${name}"`, icon: GitBranch } : null
      },
      onPick: (b) => {
        if (b.id.startsWith("pr:")) return void checkoutPr(projects, cwd, b.id.slice(3))
        if (b.id.startsWith("new:")) return onChange({ ...value, branch: b.id.slice(4), create: true })
        onChange({ ...value, branch: b.id === here && !current ? "" : b.id })
      },
    })
  }).catch((e) => notifyError(e, "Couldn't list the branches"))
}

/** Below the box to write in: the workspace (this checkout, or a new worktree) and the branch. Nothing outside git. */
export function BranchToolbar({ cwd, value, onChange, projects }: { cwd: string; value: Workspace; onChange: (w: Workspace) => void; projects: Project[] }) {
  const [list, setList] = useState<Branch[] | null>(null)
  useEffect(() => {
    let gone = false
    setList(null)
    if (cwd) get<{ git: boolean; list: Branch[] }>(`agents/branches?cwd=${encodeURIComponent(cwd)}`).then((r) => { if (!gone) setList(r.git ? r.list : []) }).catch(() => { if (!gone) setList([]) })
    return () => { gone = true }
  }, [cwd])
  if (!list?.length) return null
  const current = list.find((b) => b.current)?.name ?? ""
  const branch = value.branch || current
  const W = value.worktree ? FolderGit2 : Folder
  return (
    <div className="mx-auto flex w-full max-w-[760px] items-center gap-0.5 px-1 pt-1" data-branch-toolbar>
      <button type="button" className={pill} aria-label="Workspace" data-tip="Workspace (⌘⇧X)" data-workspace={value.worktree ? "worktree" : "local"} onClick={(e) => menuAbove(e, [
        { label: "Current checkout", icon: Folder, checked: !value.worktree, run: () => onChange({ worktree: false, branch: "" }) },
        { label: "New worktree", icon: FolderGit2, checked: value.worktree, hint: "its own branch", run: () => onChange({ worktree: true, branch: "" }) },
      ])}>
        <W className="size-3.5 shrink-0" />{value.worktree ? "New worktree" : "Current checkout"}
      </button>
      <button type="button" className={cn(pill, "min-w-0 shrink")} aria-label="Branch" data-tip="Branch (⌘⇧G)" data-workspace-branch={branch} onClick={() => pickBranch(cwd, value, onChange, projects)}>
        <GitBranch className="size-3.5 shrink-0" /><span className="truncate font-mono">{value.worktree ? `From ${branch}` : branch}</span>
      </button>
      <span className="flex-1" />
      <button type="button" className={cn(pill, "shrink-0")} data-tip="Check out a pull request into a thread" data-checkout-pr onClick={() => void checkoutPr(projects, cwd)}>
        <GitPullRequest className="size-3.5 shrink-0" /><span className="max-md:hidden">Checkout PR</span>
      </button>
    </div>
  )
}
