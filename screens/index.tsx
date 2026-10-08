import { lazy, Suspense, useEffect, useState } from "react"
import { AppWindow, Monitor, MonitorSmartphone, Unplug } from "lucide-react"
import { choose, cn, definePlugin, Empty, fmtAgo, isViewOpen, List, Loading, menuFor, openView, Panel, panelMenu, SidebarHeading, SidebarRow, type MenuItem, type SidebarCtx } from "@vaultite"
import { disconnect, stateOf, useLive, type Live } from "./live"
import { allScreens, argOf, parseArg, titleOf, type ScreenRow } from "./screens"

// Screen sharing: another computer's screen in a tab (`view:screen/<screen>[/<app>]`), listed by `view:screens` and a
// hidden sidebar panel, both showing which screens this page is connected to (live.ts) and able to disconnect them.

// noVNC is its own chunk: loaded when a screen tab opens.
const ScreenView = lazy(() => import("./Screen"))

const openScreen = (id: string, app = "") => {
  const to = `screen/${argOf(id, app)}`
  openView(to, { newTab: !isViewOpen(`view:${to}`) })
}

/** The screens, asked again every 20 s while shown (null until the first answer). */
function useScreens() {
  const [list, setList] = useState<ScreenRow[] | null>(null)
  useEffect(() => {
    let gone = false
    const load = () => allScreens().then((l) => { if (!gone) setList(l) }, () => { if (!gone) setList([]) })
    load()
    const t = setInterval(load, 20000)
    return () => { gone = true; clearInterval(t) }
  }, [])
  return list
}

const NONE = "No screens yet. Turn on Screen Sharing on a Mac running Vaultite (System Settings > General > Sharing), or list a VNC server in .vaultite/plugins/screens/data.json."

/** A screen's connection in a few words: "Connected for 5 min", "Connected for 5 min · in the background", "Connecting". */
function connText(live: Live[], id: string) {
  const st = stateOf(live, id)
  if (st.state === "none") return ""
  if (st.state === "connecting") return "Connecting"
  const ago = fmtAgo(new Date(st.since).toISOString())
  return `${ago === "just now" ? "Connected just now" : `Connected for ${ago.replace(/ ago$/, "")}`}${st.shown ? "" : " · in the background"}`
}

/** A screen's row's menu (right-click): open it, show one app's window (a Mac), disconnect while connected. */
function screenMenu(s: ScreenRow, live: Live[]): MenuItem[] {
  return [
    { label: "Open", icon: Monitor, run: () => openScreen(s.id) },
    ...(s.mac ? [{ label: "Show one app…", icon: AppWindow, run: () => void pickApp(s) }] : []),
    ...(stateOf(live, s.id).state !== "none" ? [{ label: "Disconnect", icon: Unplug, sep: true, run: () => disconnect(s.id) }] : []),
  ]
}

const disconnectButton = "grid size-8 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:size-11"

function ScreenRowView({ s, live }: { s: ScreenRow; live: Live[] }) {
  const conn = connText(live, s.id)
  const on = stateOf(live, s.id).state === "connected"
  return (
    <div className="flex min-h-11 items-center gap-3 py-2" data-screen-row={s.id} data-connected={on || undefined} onContextMenu={menuFor(() => screenMenu(s, live))}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: on ? "var(--green)" : s.online ? "var(--gray)" : "transparent", boxShadow: on || s.online ? undefined : "inset 0 0 0 1.5px var(--gray)" }}
        data-tip={on ? "Connected" : s.online ? "Answering, not connected" : "Not answering"} />
      <button type="button" onClick={() => openScreen(s.id)} className="min-w-0 flex-1 cursor-pointer text-left">
        <div className="truncate text-[15px] leading-[20px]">{s.label}</div>
        <div className="truncate text-[13px] text-muted-foreground">{conn || (s.online ? s.detail : `${s.detail} · ${s.mac ? "Screen Sharing is off" : "not answering"}`)}</div>
      </button>
      {conn && (
        <button type="button" onClick={() => disconnect(s.id)} data-tip="Disconnect" aria-label={`Disconnect from ${s.label}`} className={disconnectButton}>
          <Unplug className="size-4" strokeWidth={2} />
        </button>
      )}
      {s.mac && (
        <button type="button" onClick={() => void pickApp(s)} data-tip="Show one app" aria-label={`Show one app of ${s.label}`}
          className="grid size-8 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground max-md:size-11">
          <AppWindow className="size-4" strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

/** Ask which app to show: typed, since the list is on the screen's Mac (the tab's own menu lists them once it's open). */
function pickApp(s: ScreenRow) {
  choose({ title: "Show one app", placeholder: `An app on ${s.label}…`, items: [],
    empty: <p className="px-3 py-6 text-center text-[15px] text-muted-foreground">Type an app's name, as in its menu bar.</p>,
    other: (typed) => ({ id: typed.trim(), label: `Show ${typed.trim()}` }),
    onPick: (it) => openScreen(s.id, it.id) })
}

function ScreensBlock() {
  const list = useScreens()
  const live = useLive()
  return (
    <Panel title="Screens" icon={MonitorSmartphone} tint="var(--screens)">
      {!list ? <Loading /> : !list.length ? <Empty>{NONE}</Empty> : (
        <div data-screens-block><List>{list.map((s) => <ScreenRowView key={s.id} s={s} live={live} />)}</List></div>
      )}
    </Panel>
  )
}

function ScreensPanel({ open, panel }: SidebarCtx) {
  const list = useScreens()
  const live = useLive()
  const rows = (list ?? []).map((s) => {
    const st = stateOf(live, s.id)
    const conn = connText(live, s.id)
    return (
      <SidebarRow key={s.id} icon={Monitor} tint={s.online || st.state !== "none" ? "var(--screens)" : undefined} label={s.label} open={open}
        badge={st.state === "connected"} iconClassName={st.state === "connecting" ? "animate-pulse" : undefined}
        tip={`${s.label}: ${conn || s.detail}`} data-screen-row={s.id}
        swipe={() => (st.state === "none" ? [] : [{ label: "Disconnect", icon: Unplug, run: () => disconnect(s.id) }])} data-connected={st.state === "connected" || undefined} onClick={() => openScreen(s.id)}
        // Right-clicked: the screen's own items, then the panel's menu (as anywhere else in the sidebar).
        onContextMenu={menuFor(() => [...screenMenu(s, live), ...(panel ? panelMenu(panel).map((it, i) => (i ? it : { ...it, sep: true })) : [])])}>
        {/* Connected (in a tab, or in the background: dimmer), connecting, or the screen doesn't answer; x disconnects. */}
        {st.state === "connected" && <span className={cn("mr-1 text-[11px] group-hover/row:hidden", st.shown ? "text-[var(--green)]" : "text-tertiary")}>{st.shown ? "connected" : "background"}</span>}
        {st.state === "connecting" && <span className="mr-1 text-[11px] text-tertiary group-hover/row:hidden">connecting</span>}
        {st.state === "none" && !s.online && <span className="mr-1 text-[11px] text-tertiary">off</span>}
        {st.state !== "none" && (
          <button type="button" className="hidden size-5 cursor-pointer place-items-center rounded-[4px] text-muted-foreground group-hover/row:grid hover:bg-foreground/[0.08] hover:text-foreground"
            aria-label={`Disconnect from ${s.label}`} data-tip="Disconnect" onClick={(e) => { e.preventDefault(); e.stopPropagation(); disconnect(s.id) }}>
            <Unplug className="size-3.5" strokeWidth={2.25} />
          </button>
        )}
      </SidebarRow>
    )
  })
  if (!open) return rows.length ? <div className="flex flex-col gap-px">{rows}</div> : null
  return (
    <div className="flex shrink-0 flex-col" data-screens-panel>
      <SidebarHeading title="Screens" open={open} />
      <div className="flex flex-col gap-px">
        {rows}
        {list && !list.length && <p className="h-7 truncate pl-1.5 text-[13px] leading-7 text-tertiary">No screens yet</p>}
      </div>
    </div>
  )
}

/** Open a screen: pick one (with one, it opens). */
async function chooseScreen() {
  const list = await allScreens()
  if (list.length === 1) return openScreen(list[0].id)
  choose({ title: "Open a screen", placeholder: "Which screen?", items: list.map((s) => ({ id: s.id, label: s.label, detail: s.online ? s.detail : "not answering" })),
    empty: <p className="px-3 py-6 text-center text-[15px] text-muted-foreground">{NONE}</p>, onPick: (it) => openScreen(it.id) })
}

function Preview() {
  return (
    <Panel title="Screen sharing" icon={MonitorSmartphone} tint="var(--screens)">
      <p className="text-[15px] leading-[20px] text-muted-foreground">
        A Mac's screen in a tab, from any of your devices: your other Mac from this one, or any Mac from your phone. Show
        the whole screen, or just one app's window, and use it as if you were there. It goes through Vaultite's own
        server over your tailnet, to the Mac's Screen Sharing (or any VNC server), and only you can open it.
      </p>
    </Panel>
  )
}

export default definePlugin({
  views: {
    screen: {
      icon: Monitor,
      iconFor: (arg) => (parseArg(arg).app ? AppWindow : Monitor),
      title: (arg) => titleOf(arg),
      full: true,
      keepsTab: true,
      // The tab's arg is what it shows (the whole screen or one app): switching keeps the connection.
      argState: true,
      render: ({ arg, focused, setArg }) => (
        <Suspense fallback={null}>
          <ScreenView key={parseArg(arg).screen} arg={arg} focused={focused} setArg={setArg} />
        </Suspense>
      ),
    },
    screens: { icon: MonitorSmartphone, title: () => "Screens", render: () => <div className="pt-2 pb-10"><ScreensBlock /></div> },
  },
  blocks: { screens: () => <ScreensBlock /> },
  sidebar: { screens: { title: "Screens", heading: false, sort: 33, hidden: true, view: "screens", render: (ctx) => <ScreensPanel {...ctx} /> } },
  commands: [
    { id: "screens:open", name: "Open a screen…", run: () => void chooseScreen() },
    { id: "screens:open-tab", name: "Open screens in a tab", run: () => openView("screens", { newTab: !isViewOpen("view:screens") }) },
  ],
  mockLive: () => ({ screens: [{ id: "local", label: "Studio", host: "127.0.0.1", port: 5900, online: true }] }),
  preview: () => <Preview />,
})
