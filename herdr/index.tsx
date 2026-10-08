// herdr in the sidebar: this machine's herdr workspaces (GET /api/herdr), each pane with what runs in it and whether its
// agent works or waits; a click opens it in a tab (view:terminal/<id>). Nothing while herdr isn't running.
import { PanelsTopLeft, SquareTerminal } from "lucide-react"
import { definePlugin, isViewOpen, openView, Panel, SidebarHeading, SidebarRow, useAgents, useLive, useTick, type Agent, type SidebarCtx } from "@vaultite"

type HerdrPane = { id: string; pane: string; tab: string; label: string | null; cwd: string | null; agent: string | null; agentLabel: string | null
  name: string | null; title: string | null; state: string | null; ours: boolean }
type Herdr = { running: boolean; version?: string | null; preferred?: boolean; workspaces: { id: string; label: string; panes: HerdrPane[] }[] }

const POLL_MS = 3000

const agentOf = (p: HerdrPane, agents: Agent[]) => (p.agent ? agents.find((a) => a.name === p.agent || a.process?.includes(p.agent!)) ?? null : null)
/** What a pane is called: its agent's session (title) or name, the program, else its folder. */
function labelOf(p: HerdrPane, a: Agent | null) {
  if (p.title) return p.title
  if (p.name) return p.name
  if (a) return a.label
  if (p.agentLabel || p.agent) return (p.agentLabel || p.agent)!
  return p.cwd ? p.cwd.split("/").filter(Boolean).pop() || p.cwd : p.pane
}
const stateTip = (s: string | null) => (s === "working" ? " (working)" : s === "waiting" ? " (waiting for you)" : "")

function Row({ p, ws, open, tab }: { p: HerdrPane; ws: string; open: boolean; tab: string }) {
  const agents = useAgents()
  const a = agentOf(p, agents)
  const to = `view:terminal/${p.id}`
  const label = labelOf(p, a)
  return (
    <SidebarRow icon={a?.icon ?? SquareTerminal} iconClassName={p.state === "working" ? "animate-pulse" : undefined} tint={a?.tint} badge={p.state === "waiting"}
      label={label} open={open} active={tab === to} tip={`${label}${stateTip(p.state)}, in herdr's ${ws}${p.tab ? ` tab ${p.tab}` : ""}`}
      data-herdr-pane={p.pane} data-state={p.state ?? undefined}
      onClick={(e) => openView(to, { newTab: !isViewOpen(to) || e.metaKey || e.ctrlKey || e.button === 1 })} />
  )
}

function HerdrPanel({ open, tab }: SidebarCtx) {
  const tick = useTick(POLL_MS)
  const { data } = useLive<Herdr>("herdr", tick)
  if (!data?.running) return null
  const workspaces = data.workspaces.filter((w) => w.panes.length)
  if (!open) return <div className="flex flex-col gap-px">{workspaces.flatMap((w) => w.panes.map((p) => <Row key={p.id} p={p} ws={w.label} open={false} tab={tab} />))}</div>
  return (
    <div className="flex shrink-0 flex-col" data-herdr>
      <SidebarHeading title="herdr" open={open} />
      <div className="flex flex-col gap-px">
        {workspaces.map((w, i) => (
          <div key={w.id} className="flex flex-col gap-px">
            <div className={`flex h-6 items-end px-1.5 pb-0.5 text-[11px] font-medium text-tertiary max-md:h-8 max-md:text-[13px] ${i ? "mt-1" : ""}`}>{w.label}</div>
            {w.panes.map((p) => <Row key={p.id} p={p} ws={w.label} open tab={tab} />)}
          </div>
        ))}
        {!workspaces.length && <div className="flex h-7 items-center pl-1.5 text-[13px] text-tertiary">No panes in herdr</div>}
      </div>
    </div>
  )
}

function Preview() {
  return (
    <Panel title="herdr" icon={PanelsTopLeft} tint="var(--gray)">
      <p className="text-[15px] leading-[20px] text-muted-foreground">
        The herdr running on this machine, in the sidebar: its workspaces and their panes, with each agent marked working or
        waiting for you. Click one to open it in a tab, and it's the same terminal in herdr and here. Its settings can start
        new terminals in herdr too, so herdr in any terminal picks them up.
      </p>
    </Panel>
  )
}

export default definePlugin({
  icon: PanelsTopLeft,
  sidebar: { agents: { title: "herdr", heading: false, sort: 31, render: (ctx) => <HerdrPanel {...ctx} /> } },
  preview: () => <Preview />,
  mockLive: () => ({
    herdr: { running: true, workspaces: [
      { id: "w1", label: "Lighthouse", panes: [
        { id: "herdr-1a2b", pane: "w1:p1", tab: "1", label: null, cwd: "/Users/you/Lighthouse", agent: "claude", agentLabel: "Claude", name: null, title: "Fixing the build", state: "working", ours: false },
        { id: "herdr-3c4d", pane: "w1:p2", tab: "1", label: null, cwd: "/Users/you/Lighthouse", agent: null, agentLabel: null, name: null, title: null, state: null, ours: false },
      ] },
    ] } satisfies Herdr,
  }),
})
