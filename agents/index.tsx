// Agents in the app: the threads in a sidebar panel (Threads.tsx), each in a tab, view:agents/<id> ("" a new one: Chat.tsx).
// ⌃1-9 open the sidebar's first nine threads (⌘1-9 are the app's tabs); holding ⌃ shows which is which.
import { useEffect } from "react"
import { FileDiff, GitPullRequest, Hash, MessageSquarePlus } from "lucide-react"
import { definePlugin, get, isMac, openView, Panel } from "@vaultite"
import { Dialogs } from "./actions"
import { Chat, chatKeys, checkoutPr } from "./Chat"
import { AgentsIcon, ICON, TINT } from "./harness"
import { summaryOf, titleOf } from "./live"
import { lastThread, toggleDiff } from "./panel"
import { jumpTo, setJumpHeld, step, ThreadsPanel } from "./Threads"
import type { Project } from "./types"

const JUMP = isMac ? "Ctrl" : "Alt"
function Background() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => setJumpHeld(e.key === (isMac ? "Control" : "Alt") && !e.metaKey && !e.shiftKey)
    const up = () => setJumpHeld(false)
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", up)
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", up) }
  }, [])
  return <Dialogs />
}

function Preview() {
  return (
    <Panel title="Agents" icon={AgentsIcon} tint="var(--gray)">
      <p className="text-[15px] leading-[20px] text-muted-foreground">
        Claude Code and Codex side by side, laid out like T3 Code: every thread in the sidebar, pinned and active ones on
        top, snoozed and settled ones below, marked working, waiting for your approval or done. In a thread, each turn's
        work folds behind how long it took; questions, plans and the task list sit on the box to write in; a message sent
        while it works is queued or steers it; Edit from here goes back to any message, and any answer forks a thread.
        The diff panel is ⌘D away, and git is per thread, the model writing commit messages, pull requests and branch
        names. It runs your own CLIs on the server's machine; a thread can go on in a terminal whenever you want.
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
      render: ({ store }) => <div className="pb-10" data-agents-threads-view><div className="size-up-bleed"><div data-size-up><ThreadsPanel store={store} open tab="" file="" inView /></div></div></div>,
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
  background: () => <Background />,
  commands: [
    { id: "agents:new", name: "New agent thread", icon: MessageSquarePlus, keys: ["Mod+Shift+O"], run: () => openView("agents/", { newTab: true }) },
    { id: "agents:previous", name: "Previous agent thread", keys: ["Mod+Shift+["], when: () => !!document.querySelector("[data-agents-thread]"), run: () => step(lastThread, -1) },
    { id: "agents:next", name: "Next agent thread", keys: ["Mod+Shift+]"], when: () => !!document.querySelector("[data-agents-thread]"), run: () => step(lastThread, 1) },
    { id: "agents:checkout-pr", name: "Check out a pull request into an agent thread", icon: GitPullRequest,
      run: () => void get<{ list: Project[] }>("agents/projects").then((r) => checkoutPr(r.list, "")) },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `agents:thread-${n}`, name: `Go to agent thread #${n}`, keys: [`${JUMP}+${n}`], icon: Hash, run: () => jumpTo(n) })),
    // T3 Code's chat keys, on the agent thread used last while it's on screen.
    ...([["m", "Pick the agent thread's model"], ["a", "Pick the agent thread's access mode"], ["e", "Pick how hard the agent thread's model thinks"], ["g", "Pick the agent thread's branch"], ["x", "Switch a new agent thread's workspace"],
      ["s", "Settle or un-settle the agent thread"], ["p", "Pin or unpin the agent thread"], ["k", "Copy the agent thread's pull request number"]] as const).map(([k, name]) => ({
      id: `agents:key-${k}`, name, keys: [`Mod+Shift+${k.toUpperCase()}`], when: () => !!chatKeys.current?.[k] && !!document.querySelector("[data-agents-thread]"), run: () => chatKeys.current?.[k]?.() })),
    { id: "agents:diff", name: "Toggle the agent thread's diff panel", icon: FileDiff, when: () => !!lastThread, run: () => toggleDiff(lastThread) },
    { id: "agents:split", desktop: true, name: "Open a new agent thread in right split", icon: AgentsIcon, run: () => openView("agents/", { split: true }) },
  ],
  preview: () => <Preview />,
  mockLive: () => ({ "agents/projects": { list: [{ label: "Vault", path: "/Users/you/Vault", vault: true }, { label: "Lighthouse", path: "/Users/you/Projects/lighthouse" }] } }),
})
