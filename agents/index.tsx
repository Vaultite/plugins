// Agents in the app: the threads in a sidebar panel (Threads.tsx), each in a tab, view:agents/<id> ("" a new one: Chat.tsx).
import { FileDiff, MessageSquarePlus } from "lucide-react"
import { definePlugin, openView, Panel } from "@vaultite"
import { Chat } from "./Chat"
import { AgentsIcon, ICON, TINT } from "./harness"
import { summaryOf, titleOf } from "./live"
import { lastThread, toggleDiff } from "./panel"
import { ThreadsPanel } from "./Threads"

function Preview() {
  return (
    <Panel title="Agents" icon={AgentsIcon} tint="var(--gray)">
      <p className="text-[15px] leading-[20px] text-muted-foreground">
        Claude Code and Codex side by side, laid out like T3 Code: every thread in the sidebar, grouped by project, marked
        working or waiting for your approval. In a thread, each turn's work folds behind how long it took, the files it
        changed are a click from the diff panel (⌘D, per turn or the whole thread), and git is per thread: work in the
        checkout or a worktree of its own, then commit, push and open a pull request from the header. It runs your own
        CLIs on the server's machine; a thread can go on in a terminal whenever you want the full thing.
      </p>
    </Panel>
  )
}

export default definePlugin({
  sidebar: {
    threads: { title: "Agents", names: ["agents", "threads", "claude", "codex"], heading: false, sort: 30, view: "agents-threads", render: (ctx) => <ThreadsPanel {...ctx} /> },
  },
  views: {
    "agents-threads": {
      icon: AgentsIcon,
      title: () => "Agents",
      render: ({ store }) => <div className="pb-10" data-agents-threads-view><div className="size-up-bleed"><div data-size-up><ThreadsPanel store={store} open tab="" file="" /></div></div></div>,
    },
    agents: {
      icon: AgentsIcon,
      iconFor: (arg) => { const s = summaryOf(arg); return s ? ICON[s.harness] : AgentsIcon },
      iconTint: (arg) => { const s = summaryOf(arg); return s ? TINT[s.harness] : undefined },
      iconBadge: (arg) => !!summaryOf(arg)?.waiting,
      iconClass: (arg) => { const s = summaryOf(arg); return s?.running && !s.waiting ? "animate-pulse" : undefined },
      title: (arg) => titleOf(arg) || (arg ? "Thread" : "New thread"),
      argState: true,
      full: true,
      keepsTab: true,
      render: ({ arg, setArg }) => <div className="flex h-full min-h-0 flex-col" data-agents-tab><Chat id={arg} setId={setArg} /></div>,
    },
  },
  commands: [
    { id: "agents:new", name: "New agent thread", icon: MessageSquarePlus, run: () => openView("agents/", { newTab: true }) },
    { id: "agents:diff", name: "Toggle the agent thread's diff panel", icon: FileDiff, when: () => !!lastThread, run: () => toggleDiff(lastThread) },
    { id: "agents:split", desktop: true, name: "Open a new agent thread in right split", icon: AgentsIcon, run: () => openView("agents/", { split: true }) },
  ],
  preview: () => <Preview />,
  mockLive: () => ({ "agents/projects": { list: [{ label: "Vault", path: "/Users/you/Vault", vault: true }, { label: "Lighthouse", path: "/Users/you/Projects/lighthouse" }] } }),
})
