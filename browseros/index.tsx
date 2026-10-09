// BrowserOS: a web page handed from the Web viewer to BrowserOS (a real browser: passkeys, its own logins), opened in its
// window, which App windows keeps behind a tab; and BrowserOS neo's agent sessions, a click showing the tab one works in.
import { useEffect, useState, useSyncExternalStore } from "react"
import { Compass } from "lucide-react"
import {
  appWindows, definePlugin, Empty, get, isViewOpen, List, Loading, notify, notifyError, openMenu, openView, Panel, panelMenu, pluginOn, post,
  SidebarHeading, SidebarRow, type SidebarCtx,
} from "@vaultite"
import type { Live, Session } from "./types"

const NEO = "com.browseros.BrowserClaw"

/** BrowserOS as installed on this Mac (BrowserOS neo first), or null. */
async function browserOS() {
  const { installed } = await appWindows!.list()
  const ids = installed.map((a) => a.bundle).filter((b) => b.startsWith("com.browseros."))
  return ids.includes(NEO) ? NEO : ids[0] ?? null
}

async function openIn(url: string) {
  const api = appWindows
  if (!api?.open) return notify("Opening pages in BrowserOS needs a newer desktop app", { kind: "error" })
  try {
    const bundle = await browserOS()
    if (!bundle) return notify("BrowserOS isn't installed on this Mac", { kind: "error" })
    const r = await api.open(bundle, url)
    // (no window found, or no Accessibility permission yet: the app's tab takes one, or asks for it)
    const to = r.ok && r.wid ? `${bundle}:${r.wid}` : bundle
    openView(`app/${to}`, { newTab: !isViewOpen(`view:app/${to}`) })
  } catch (e) { notifyError(e, "Couldn't open the page in BrowserOS") }
}

// --- agent sessions, asked every 3 s while something shows them
let live: Live | null = null
const subs = new Set<() => void>()
async function refresh() {
  try { live = await get<Live>("browseros/sessions") } catch { live = { running: false, sessions: [] } }
  subs.forEach((f) => f())
}
let tick: ReturnType<typeof setInterval> | null = null
function subscribe(f: () => void) {
  subs.add(f)
  if (subs.size === 1) { void refresh(); tick = setInterval(() => { if (!document.hidden) void refresh() }, 3000) }
  return () => { subs.delete(f); if (!subs.size && tick) { clearInterval(tick); tick = null } }
}
const useSessions = () => useSyncExternalStore(subscribe, () => live)

// (App windows shows the tab holding BrowserOS's window when it comes in front)
async function show(s: Session) {
  if (!s.tab) return
  try { await post("browseros/focus", { tab: s.tab.id }) } catch (e) { notifyError(e, "Couldn't show the tab in BrowserOS") }
}

const labelOf = (s: Session) => s.name || s.site || s.agent
const about = (s: Session) => [s.agent, s.help ? `needs you${s.help.reason ? `: ${s.help.reason}` : ""}` : s.active ? "working" : "idle", s.tab?.title]
  .filter(Boolean).join(" · ")

function SessionsPanel({ open, panel }: SidebarCtx) {
  const l = useSessions()
  const rows = (l?.sessions ?? []).map((s) => (
    <SidebarRow key={s.id} icon={Compass} iconClassName={s.active ? "animate-pulse" : undefined} tint={s.help ? "var(--orange)" : s.active ? "var(--browseros)" : undefined}
      badge={!!s.help} label={labelOf(s)} open={open} tip={`${labelOf(s)}: ${about(s)}`} data-browseros-session={s.id}
      onClick={() => void show(s)} onContextMenu={panel ? (e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, panelMenu(panel)) } : undefined}>
      {open && <span className="mr-1 truncate text-[11px] text-tertiary">{s.agent}</span>}
    </SidebarRow>
  ))
  if (!open) return rows.length ? <div className="flex flex-col gap-px">{rows}</div> : null
  return (
    <div className="flex shrink-0 flex-col" data-browseros-panel>
      <SidebarHeading title="Browser agents" open={open} />
      <div className="flex flex-col gap-px">
        {rows}
        {l && !rows.length && <p className="h-7 truncate pl-1.5 text-[13px] leading-7 text-tertiary">{l.running ? "No agents browsing" : "BrowserOS neo isn't running"}</p>}
      </div>
    </div>
  )
}

/** A session's tab as it is now, asked again every 3 s while it works. */
function Shot({ s }: { s: Session }) {
  const [n, setN] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!s.active) return
    const id = setInterval(() => { if (!document.hidden) setN((x) => x + 1) }, 3000)
    return () => clearInterval(id)
  }, [s.active])
  if (!s.tab || failed) return null
  return <img alt="" className="mt-2 aspect-[16/10] w-full max-w-[520px] rounded-[8px] border border-border object-cover object-top" onError={() => setFailed(true)}
    src={`api/browseros/preview/${encodeURIComponent(s.id)}?tab=${s.tab.id}&n=${n}`} />
}

function SessionsView() {
  const l = useSessions()
  return (
    <div className="pt-2 pb-10">
      <Panel title="Browser agents" icon={Compass} tint="var(--browseros)">
        {!l ? <Loading /> : !l.sessions.length ? <Empty>{l.running ? "No agent is browsing in BrowserOS neo right now." : "BrowserOS neo isn't running on this machine."}</Empty> : (
          <List>{l.sessions.map((s) => (
            <button key={s.id} type="button" onClick={() => void show(s)} data-browseros-session={s.id}
              className="relative isolate block w-full cursor-pointer py-3 text-left before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-[8px] hover:before:bg-foreground/[0.04]">
              <div className="truncate text-[15px] leading-[20px]">{labelOf(s)}</div>
              <div className="truncate text-[13px] text-muted-foreground" style={s.help ? { color: "var(--orange)" } : undefined}>{about(s)}</div>
              <Shot s={s} />
            </button>
          ))}</List>
        )}
      </Panel>
    </div>
  )
}

export default definePlugin({
  webPageActions: ({ url }) => appWindows && pluginOn("app-windows") ? [{ label: "Open in BrowserOS", icon: Compass, run: () => void openIn(url) }] : [],
  sidebar: {
    agents: {
      title: "Browser agents", names: ["browseros", "neo", "browser agents", "agent browser"], heading: false, sort: 31, view: "browseros",
      render: (ctx) => <SessionsPanel {...ctx} />,
    },
  },
  views: { browseros: { icon: Compass, title: () => "Browser agents", render: () => <SessionsView /> } },
})
