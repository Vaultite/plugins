// Git in the app: the Source control panel (and its tab), a file's diff and its git history as tabs, the status bar's
// item, commands, a file's menu and the file tree's mark on a file in conflict.
import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, History, Loader2, RefreshCw } from "lucide-react"
import { AmbientButton, currentFile, definePlugin, isHidden, openView, Panel, stem, useTick } from "@vaultite"
import { commit, commitAndSync, currentSnap, pull, push, stage, unstage, useGit } from "./client"
import { DiffView } from "./Diff"
import { ago, HistoryView } from "./History"
import { SourceControl } from "./Panel"
import { GitSettings } from "./Settings"

declare module "@vaultite" {
  /** /api/state's `git`: the files a merge left in conflict (the file tree's marks). */
  interface PluginState { git?: { conflicts: string[] } }
}

const name = (p: string) => stem(p.split("/").pop()!)

/** The status bar: changes pending, ahead and behind, the last commit's age; red while a merge waits. */
function GitStatus() {
  const { snap: s, running } = useGit()
  useTick()
  if (!s?.repo) return null
  const n = s.total ?? 0
  const busy = running ?? s.busy
  const text = [n ? String(n) : "", s.ahead ? `↑${s.ahead}` : "", s.behind ? `↓${s.behind}` : "", s.lastCommit ? ago(s.lastCommit.t).replace(" ago", "").replace("Just now", "now") : ""].filter(Boolean).join(" ")
  const tip = [
    `Git: ${s.branch ?? "detached"}`,
    busy ? `${busy}…` : s.merging ? "a merge waits for its conflicts" : n ? `${n} change${n === 1 ? "" : "s"} to commit` : "nothing to commit",
    s.ahead ? `${s.ahead} to push` : "", s.behind ? `${s.behind} to pull` : "",
    s.lastCommit ? `last commit ${ago(s.lastCommit.t).toLowerCase()}` : "no commits yet",
  ].filter(Boolean).join(", ")
  return <AmbientButton icon={busy ? Loader2 : GitBranch} className={busy ? "[&_svg]:animate-spin" : undefined} text={text || undefined} tip={tip}
    tint={s.merging ? "var(--red)" : undefined} onClick={() => openView("git")} />
}

function GitPage() {
  return (
    <div className="mt-3" data-git-page>
      <h1 className="mb-1 text-[22px] leading-[28px] font-bold max-md:hidden">Source control</h1>
      <div className="size-up-bleed"><div data-size-up><SourceControl page /></div></div>
    </div>
  )
}

function Preview() {
  return (
    <Panel title="Git" icon={GitBranch} tint="var(--orange)">
      <p className="text-[15px] leading-[20px] text-muted-foreground">
        Your vault as a git repository. The Source control panel lists what changed since the last commit, to stage, commit,
        pull and push, or Commit and sync in one go; a file's changes and its history of commits open as tabs, and any
        version can be restored. It can commit and sync every few minutes, or once you stop editing; a merge conflict stops
        it without losing anything, and says so in your Inbox. Agents commit their own work with a message saying what
        they did.
      </p>
    </Panel>
  )
}

const changed = (p: string) => !!p && !!currentSnap()?.files?.some((f) => f.path === p)
/** Keeps the state fresh for the commands' `when` and the file menu, whatever is on screen. */
function Background() {
  useGit()
  return null
}

export default definePlugin({
  sidebar: {
    "source-control": {
      title: "Source control", names: ["git", "source control", "version control"], heading: false, sort: 37, view: "git",
      flyout: { icon: GitBranch }, render: (ctx) => <SourceControl {...ctx} />,
    },
  },
  views: {
    git: { icon: GitBranch, title: () => "Source control", render: () => <GitPage /> },
    "git-diff": { icon: GitCommitHorizontal, title: (p) => `${name(p)} changes`, render: ({ arg }) => <DiffView key={arg} path={arg} /> },
    "git-history": { icon: History, title: (p) => `${name(p)} git history`, render: ({ arg }) => <HistoryView key={arg} path={arg} /> },
  },
  ambient: { status: { title: "Git", sort: 40, render: () => <GitStatus /> } },
  background: () => <Background />,
  fileMenu: (path) => (isHidden(path) ? [] : [
    { label: "Git history", icon: History, section: "more", run: () => openView(`git-history/${path}`) },
    ...(changed(path) ? [{ label: "Open changes", icon: GitCommitHorizontal, section: "more", run: () => openView(`git-diff/${path}`) }] : []),
  ]),
  fileMarks: (store) => Object.fromEntries((store.git?.conflicts ?? []).map((p) => [p, { text: "C", tip: "Merge conflict: keep what you want between <<<<<<< and >>>>>>>, then Commit", tone: "red" as const }])),
  commands: [
    { id: "git:open", name: "Open source control", run: () => openView("git"), icon: GitBranch },
    { id: "git:commit-and-sync", name: "Git: commit and sync", run: () => void commitAndSync(""), icon: RefreshCw, label: "Commit and sync" },
    { id: "git:commit", name: "Git: commit all changes", run: () => void commit(""), icon: GitCommitHorizontal },
    { id: "git:pull", name: "Git: pull", run: () => void pull(), icon: ArrowDown },
    { id: "git:push", name: "Git: push", run: () => void push(), icon: ArrowUp },
    { id: "git:diff", name: "Git: open changes of the current file", when: () => changed(currentFile()), run: () => openView(`git-diff/${currentFile()}`) },
    { id: "git:history", name: "Git: open history of the current file", when: () => !!currentFile() && !isHidden(currentFile()), run: () => openView(`git-history/${currentFile()}`), icon: History },
    { id: "git:stage", name: "Git: stage the current file", when: () => changed(currentFile()), run: () => void stage([currentFile()]) },
    { id: "git:unstage", name: "Git: unstage the current file", when: () => !!currentSnap()?.files?.some((f) => f.path === currentFile() && f.staged), run: () => void unstage([currentFile()]) },
  ],
  settingsPanel: () => <GitSettings />,
  settingsSearch: [{ label: "Access token for HTTPS remotes", description: "a GitHub or GitLab token, kept on the server's machine", key: "token" }],
  preview: () => <Preview />,
})
