// A screen in a tab (noVNC, its own chunk), borrowing its connection from connection.ts while on screen, so moving the
// tab only moves the picture. App mode (`/<app>`) shows one window cut out of it; phones read fingers in touch.ts.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react"
import { createPortal } from "react-dom"
import {
  AppWindow, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Ellipsis, Gauge, Hand, Keyboard, Maximize2, Minimize2, Monitor,
  MousePointer2, RotateCw, Unplug, ZoomOut,
} from "lucide-react"
import { choose, cn, devicePref, menuBelow, notify, runShortcut, type MenuItem } from "@vaultite"
import { acquire, REFUSED, UNREACHABLE, type Conn, type Crop } from "./connection"
import { allScreens, argOf, parseArg, titleOf } from "./screens"
import { touchInput, type TouchMode } from "./touch"

type Win = { id: number; pid: number; app: string; title: string; x: number; y: number; w: number; h: number }
type OnScreen = {
  unsupported?: boolean
  screens?: { x: number; y: number; w: number; h: number; scale: number }[]
  windows?: Win[]
  apps?: { name: string; bundle: string; pid: number; active: boolean }[]
  installed?: { name: string; path: string }[]
}

const wsUrl = (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/${path}`

/** What's on a Mac's screen, followed while `on` (the windows socket), and a way to bring an app to the front. */
function useOnScreen(screen: string, on: boolean) {
  const [data, setData] = useState<OnScreen | null>(null)
  const sock = useRef<WebSocket | null>(null)
  useEffect(() => {
    if (!on) return
    let ws: WebSocket | null = null, timer = 0, tries = 0, gone = false
    const connect = () => {
      ws = new WebSocket(wsUrl(`screens/windows/${encodeURIComponent(screen)}`))
      sock.current = ws
      ws.onmessage = (e) => {
        let msg: OnScreen & { t?: string; reason?: string }
        try { msg = JSON.parse(String(e.data)) } catch { return }
        if (msg.t === "windows") { tries = 0; setData(msg) } else if (msg.t === "error" && msg.reason) notify(msg.reason)
      }
      ws.onclose = (e) => {
        if (gone || e.code === REFUSED || e.code === UNREACHABLE) return
        timer = window.setTimeout(connect, Math.min(10000, 500 * 2 ** Math.min(tries++, 5)))
      }
    }
    connect()
    return () => { gone = true; clearTimeout(timer); ws?.close(); sock.current = null }
  }, [screen, on])
  const open = useCallback((app: string) => {
    if (sock.current?.readyState === WebSocket.OPEN) sock.current.send(JSON.stringify({ t: "open", app }))
  }, [])
  return { data: on ? data : null, open }
}

/** The app's front window, as part of the picture (fbW: the picture's width in pixels), and whether another window is
 *  in front of it. Screens are in points, the first one the main one (Cocoa's y goes up; windows' goes down). */
function cropOf(data: OnScreen | null, app: string, fbW: number, fbH: number): { crop: Crop; covered: boolean } | null {
  const screens = data?.screens, windows = data?.windows
  if (!app || !screens?.length || !windows || !fbW) return null
  const i = windows.findIndex((w) => w.app === app)
  if (i < 0) return null
  const win = windows[i], main = screens[0]
  const rects = screens.map((s) => ({ x: s.x, y: main.h - (s.y + s.h), w: s.w, h: s.h }))
  const minX = Math.min(...rects.map((r) => r.x)), minY = Math.min(...rects.map((r) => r.y))
  const k = fbW / (Math.max(...rects.map((r) => r.x + r.w)) - minX)
  const x = Math.max(0, (win.x - minX) * k), y = Math.max(0, (win.y - minY) * k)
  const crop = { x, y, w: Math.min(fbW - x, win.w * k), h: Math.min(fbH - y, win.h * k), perPoint: k }
  const covered = windows.slice(0, i).some((o) => o.app !== app && o.x < win.x + win.w && o.x + o.w > win.x && o.y < win.y + win.h && o.y + o.h > win.y)
  return { crop, covered }
}

/** A character as an X keysym (what VNC sends for a key): Latin-1 as itself, the rest as Unicode. */
const keysym = (ch: string) => { const c = ch.codePointAt(0) ?? 0; return c < 0x100 ? c : 0x01000000 + c }
const KEYS: Record<string, number> = { Backspace: 0xff08, Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54 }
/** The modifiers the key row holds down. A Mac's Screen Sharing takes Alt for Command and Meta for Option (as RealVNC
 *  sends them for a PC's Alt and a Mac's Option); other VNC servers get Alt and Super. */
type Mod = { id: string; label: string; sym: number }
const MAC_MODS: Mod[] = [{ id: "ctrl", label: "ctrl", sym: 0xffe3 }, { id: "opt", label: "opt", sym: 0xffe7 }, { id: "cmd", label: "cmd", sym: 0xffe9 }, { id: "shift", label: "shift", sym: 0xffe1 }]
const PC_MODS: Mod[] = [{ id: "ctrl", label: "ctrl", sym: 0xffe3 }, { id: "alt", label: "alt", sym: 0xffe9 }, { id: "super", label: "super", sym: 0xffeb }, { id: "shift", label: "shift", sym: 0xffe1 }]

const touchScreen = () => matchMedia("(pointer: coarse)").matches
const touchMode = devicePref<TouchMode>("screens:touch", "trackpad")
const statsPref = devicePref<boolean>("screens:stats", false)

const bar = "flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2 max-md:h-11"
const tool = "grid size-7 shrink-0 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-40 max-md:size-11"
const key = "flex h-9 min-w-9 shrink-0 cursor-pointer items-center justify-center rounded-[6px] bg-foreground/[0.06] px-2 text-[13px] font-medium text-foreground select-none active:bg-foreground/[0.14]"
const field = "h-9 w-full rounded-[8px] border border-border bg-background px-3 text-[15px] outline-none focus:border-primary max-md:h-11 max-md:text-[17px]"
const button = "flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[8px] bg-primary px-4 text-[15px] font-medium text-primary-foreground hover:opacity-90 max-md:h-11 max-md:text-[17px]"
const quiet = "flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] bg-foreground/[0.06] px-3 text-[13px] font-medium text-foreground hover:bg-foreground/[0.1] max-md:h-11 max-md:text-[15px]"

/** Redraw when the connection changes. */
function useConn(conn: Conn | null) {
  useSyncExternalStore(conn?.subscribe ?? noSub, conn?.snapshot ?? zero)
}
const noSub = () => () => {}
const zero = () => 0

export default function Screen({ arg, focused, setArg }: { arg: string; focused: boolean; setArg: (arg: string) => void }) {
  const { screen, app } = parseArg(arg)
  const [conn, setConn] = useState<Conn | null>(null)
  useConn(conn)
  // Borrow this screen's connection while the tab is on screen.
  useEffect(() => {
    const c = acquire(screen)
    setConn(c)
    return () => { c.release() }
  }, [screen])
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!conn || !box) return
    conn.attach(box)
    return () => conn.detach(box)
  }, [conn, box])

  const typing = useRef<HTMLTextAreaElement>(null)
  const [user, setUser] = useState("") // the user name typed last (the form shows it again)
  // What to call it: the machine's label (Machines), once the list has come (it fills tab titles too).
  const [, labelsCame] = useState(0)
  useEffect(() => { allScreens().then(() => labelsCame((n) => n + 1), () => {}) }, [])
  const label = titleOf(screen)
  const status = conn?.status ?? { kind: "connecting" as const }
  const connected = status.kind === "connected"
  const touch = touchScreen()
  const [mode, setMode] = useState<TouchMode>(touchMode.get)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [full, setFull] = useState(false)
  const [keysOn, setKeysOn] = useState(false)
  const [mods, setMods] = useState<string[]>([])
  const [statsOn, setStatsOn] = useState(statsPref.get)
  const toggleStats = () => { statsPref.set(!statsOn); setStatsOn(!statsOn) }

  // What's on the Mac's screen: for app mode, and for the app menu.
  const macScreen = screen.startsWith("local")
  const [menuWanted, setMenuWanted] = useState(macScreen)
  const { data: onScreen, open } = useOnScreen(screen, !!app || menuWanted)
  const found = cropOf(onScreen, app, conn?.fb.w ?? 0, conn?.fb.h ?? 0)
  const crop = app ? found?.crop ?? null : null
  const cropKey = crop ? `${Math.round(crop.x)},${Math.round(crop.y)},${Math.round(crop.w)},${Math.round(crop.h)}` : ""
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the crop's rounded box is what changes it
  useEffect(() => { conn?.setCrop(crop) }, [conn, cropKey, connected])

  // App mode: bring the app to the front once it's asked for (and start it if it isn't running).
  const brought = useRef("")
  useEffect(() => {
    if (!app || !onScreen || onScreen.unsupported || brought.current === app) return
    brought.current = app
    if (!onScreen.windows?.[0] || onScreen.windows[0].app !== app) open(app)
  }, [app, onScreen, open])

  // The picture follows its size, which noVNC reports as it changes (a Mac's resolution switched).
  useEffect(() => {
    if (!connected || !conn) return
    const t = setInterval(() => conn.sized(), 1000)
    return () => clearInterval(t)
  }, [connected, conn])

  // Fingers (phones, tablets): read here, not by noVNC; the trackpad's pointer is drawn where it is.
  useEffect(() => {
    if (!touch || !box || !conn) return
    return touchInput(box, () => conn, () => modeRef.current)
  }, [touch, box, conn])
  useEffect(() => {
    if (!touch || !box || !conn || !connected) return
    const show = () => requestAnimationFrame(() => { if (modeRef.current === "trackpad") conn.showPointer() })
    show()
    const ro = new ResizeObserver(show)
    ro.observe(box)
    return () => { ro.disconnect(); conn.hidePointer() }
  }, [touch, box, conn, connected, mode])

  // Keys go to the screen while it has the focus (`data-keeps-keys`: a key that types is the screen's, Vim's too); the
  // app's shortcuts with ⌘, ⌃ or ⌥ still win (the palette, switching tabs).
  useEffect(() => {
    if (!box) return
    const down = (e: KeyboardEvent) => { if (runShortcut(e)) e.stopPropagation() }
    box.addEventListener("keydown", down, true)
    return () => box.removeEventListener("keydown", down, true)
  }, [box])
  useEffect(() => { if (focused && connected && !touch) conn?.focus() }, [focused, connected, touch, conn, box])

  // Full screen: the screen over the whole window (and the browser's own full screen, where it has one: not iPhones).
  const fullBox = useRef<HTMLDivElement>(null)
  const goFull = (on: boolean) => {
    setFull(on)
    if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }
  useEffect(() => {
    if (!full) return
    const el = fullBox.current
    // Esc goes to the screen while it's full (Chromium's keyboard lock: holding Esc still leaves), as do ⇧Esc.
    const kb = (navigator as Navigator & { keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void } }).keyboard
    if (el?.requestFullscreen && !touch) el.requestFullscreen().then(() => kb?.lock?.(["Escape"])).catch(() => {})
    const left = () => { if (!document.fullscreenElement && !touch) setFull(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && e.shiftKey) { e.preventDefault(); setFull(false) } }
    document.addEventListener("fullscreenchange", left)
    window.addEventListener("keydown", esc, true)
    return () => {
      document.removeEventListener("fullscreenchange", left)
      window.removeEventListener("keydown", esc, true)
      kb?.unlock?.()
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [full, touch])

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const login = { username: String(f.get("username") ?? ""), password: String(f.get("password") ?? "") }
    setUser(login.username)
    conn?.submit(login, f.get("remember") === "on")
  }

  // A phone's keyboard: typing into a hidden field, sent as keys, with the key row's modifiers held.
  const modList = macScreen ? MAC_MODS : PC_MODS
  const withMods = (send: () => void) => {
    const held = modList.filter((m) => mods.includes(m.id))
    for (const m of held) conn?.sendKey(m.sym, null, true)
    send()
    for (const m of held.reverse()) conn?.sendKey(m.sym, null, false)
    if (held.length) setMods([])
  }
  const onType = (e: FormEvent<HTMLTextAreaElement>) => {
    const text = e.currentTarget.value
    e.currentTarget.value = ""
    for (const ch of text) withMods(() => conn?.sendKey(ch === "\n" ? KEYS.Enter : keysym(ch), null))
  }
  const onTypeKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const k = KEYS[e.key]
    if (!k || e.key === "Enter" && e.nativeEvent.isComposing) return
    e.preventDefault()
    withMods(() => conn?.sendKey(k, null))
  }
  const pressKey = (k: number) => withMods(() => conn?.sendKey(k, null))
  const toggleMod = (id: string) => setMods((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]))

  const sendClipboard = async () => {
    let text = ""
    try { text = await navigator.clipboard.readText() } catch { /* not allowed */ }
    if (!text) return notify("Nothing to send: the clipboard has no text")
    conn?.paste(text)
    notify("Sent to the screen's clipboard: paste it there")
  }
  const switchMode = () => {
    const next: TouchMode = mode === "trackpad" ? "touch" : "trackpad"
    touchMode.set(next)
    setMode(next)
    if (next === "touch") conn?.hidePointer()
    notify(next === "trackpad" ? "Trackpad: drag to move the pointer, tap to click" : "Touch: tap where you want to click")
  }

  const appItems = (): MenuItem[] => {
    const running = (onScreen?.apps ?? []).map((a) => a.name).filter(Boolean).sort((a, b) => a.localeCompare(b))
    return [
      { label: "Whole screen", icon: Monitor, run: () => setArg(argOf(screen)) },
      ...running.map((name, i) => ({ label: name, icon: AppWindow, sep: i === 0, run: () => { brought.current = ""; setArg(argOf(screen, name)) } })),
      { label: "Another app…", sep: true, run: () => pickApp() },
    ]
  }
  const appMenu = (e: React.MouseEvent) => {
    setMenuWanted(true)
    menuBelow(e, appItems())
  }
  const pickApp = () => {
    const names = [...new Set([...(onScreen?.apps ?? []).map((a) => a.name), ...(onScreen?.installed ?? []).map((a) => a.name)])].filter(Boolean)
    choose({ title: "Show one app", placeholder: "An app on the screen's Mac…", items: names.map((n) => ({ id: n, label: n })),
      onPick: (it) => { brought.current = ""; setArg(argOf(screen, it.id)) } })
  }
  const live = status.kind === "connected" || status.kind === "connecting" || status.kind === "login"
  // Phones: what doesn't fit in the bar.
  const more = (e: React.MouseEvent) => {
    setMenuWanted(true)
    const items: MenuItem[] = [
      ...(macScreen ? [{ label: "Show one app…", icon: AppWindow, run: () => pickApp() }, ...(app ? [{ label: "Whole screen", icon: Monitor, run: () => setArg(argOf(screen)) }] : [])] : []),
      { label: "Send the clipboard's text", icon: ClipboardPaste, run: () => void sendClipboard() },
      { label: mode === "trackpad" ? "Touch: tap where you click" : "Trackpad: drag the pointer", icon: mode === "trackpad" ? Hand : MousePointer2, run: switchMode },
      { label: statsOn ? "Hide speed stats" : "Show speed stats", icon: Gauge, run: toggleStats },
      { label: "Reconnect", icon: RotateCw, sep: true, run: () => conn?.connect() },
      ...(live ? [{ label: "Disconnect", icon: Unplug, run: () => conn?.end() }] : []),
    ]
    menuBelow(e, items)
  }

  const missing = connected && app && onScreen && !onScreen.unsupported && !found
  const zoomed = (conn?.zoom ?? 1) > 1.01
  const dot = connected ? "Connected" : status.kind === "connecting" ? "Connecting" : status.kind === "login" ? "Waiting for a login" : "Not connected"
  const toolbar = (
    <div className={bar}>
      <span className="size-2 shrink-0 rounded-full" data-tip={dot} data-screen-state={status.kind}
        style={{ background: connected ? "var(--green)" : status.kind === "connecting" || status.kind === "login" ? "var(--yellow)" : "var(--gray)" }} />
      <span className="ml-1 min-w-0 flex-1 truncate text-[13px] text-muted-foreground max-md:text-[15px]">
        {[app || "Whole screen", label].filter(Boolean).join(" · ")}
      </span>
      {zoomed && (
        <button type="button" className={tool} data-tip="Fit to the pane" aria-label="Fit to the pane" onClick={() => conn?.resetZoom()}>
          <ZoomOut className="size-4" strokeWidth={2} />
        </button>
      )}
      {touch ? <>
        <button type="button" className={tool} aria-label="Keyboard" disabled={!connected} onClick={() => typing.current?.focus({ preventScroll: true })}>
          <Keyboard className="size-4" strokeWidth={2} />
        </button>
        <button type="button" className={tool} aria-label={full ? "Leave full screen" : "Full screen"} onClick={() => goFull(!full)}>
          {full ? <Minimize2 className="size-4" strokeWidth={2} /> : <Maximize2 className="size-4" strokeWidth={2} />}
        </button>
        <button type="button" className={tool} aria-label="Screen options" onClick={more}>
          <Ellipsis className="size-4" strokeWidth={2} />
        </button>
      </> : <>
        {macScreen && (
          <button type="button" className={tool} data-tip="Show one app" aria-label="Show one app" onClick={appMenu}>
            <AppWindow className="size-4" strokeWidth={2} />
          </button>
        )}
        <button type="button" className={tool} data-tip="Send the clipboard's text" aria-label="Send the clipboard's text" disabled={!connected} onClick={() => void sendClipboard()}>
          <ClipboardPaste className="size-4" strokeWidth={2} />
        </button>
        <button type="button" className={tool} data-tip={full ? "Leave full screen (⇧Esc, or hold Esc)" : "Full screen"} aria-label={full ? "Leave full screen" : "Full screen"} onClick={() => goFull(!full)}>
          {full ? <Minimize2 className="size-4" strokeWidth={2} /> : <Maximize2 className="size-4" strokeWidth={2} />}
        </button>
        <button type="button" className={cn(tool, statsOn && "text-foreground")} data-tip={statsOn ? "Hide speed stats" : "Speed stats"} aria-label="Speed stats"
          aria-pressed={statsOn} onClick={toggleStats}>
          <Gauge className="size-4" strokeWidth={2} />
        </button>
        <button type="button" className={tool} data-tip="Reconnect" aria-label="Reconnect" onClick={() => conn?.connect()}>
          <RotateCw className="size-4" strokeWidth={2} />
        </button>
        {live && (
          <button type="button" className={tool} data-tip="Disconnect" aria-label="Disconnect" onClick={() => conn?.end()}>
            <Unplug className="size-4" strokeWidth={2} />
          </button>
        )}
      </>}
    </div>
  )

  // The phone's extra keys, while its keyboard is up: kept from taking the focus, so the keyboard stays.
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault()
  const keyRow = touch && keysOn && connected && (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2 py-1" data-screen-keys onPointerDown={keep} onMouseDown={keep}>
      <button type="button" className={key} onClick={() => pressKey(KEYS.Escape)}>esc</button>
      <button type="button" className={key} onClick={() => pressKey(KEYS.Tab)}>tab</button>
      {modList.map((m) => (
        <button key={m.id} type="button" aria-pressed={mods.includes(m.id)} onClick={() => toggleMod(m.id)}
          className={cn(key, mods.includes(m.id) && "bg-primary text-primary-foreground active:bg-primary")}>{m.label}</button>
      ))}
      {([[ArrowLeft, KEYS.ArrowLeft, "Left"], [ArrowUp, KEYS.ArrowUp, "Up"], [ArrowDown, KEYS.ArrowDown, "Down"], [ArrowRight, KEYS.ArrowRight, "Right"]] as const).map(([Icon, k, name]) => (
        <button key={name} type="button" className={key} aria-label={name} onClick={() => pressKey(k)}><Icon className="size-4" strokeWidth={2} /></button>
      ))}
    </div>
  )

  const body = (
    <div className="relative min-h-0 flex-1">
      <div ref={setBox} className={cn("absolute inset-0 touch-none select-none [-webkit-touch-callout:none]", !connected && "invisible")} data-screen-canvas data-keeps-keys />
      <textarea ref={typing} aria-label="Type on the screen" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onFocus={() => setKeysOn(true)} onBlur={() => { setKeysOn(false); setMods([]) }}
        className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0 text-[16px]" onInput={onType} onKeyDown={onTypeKey} />
      {connected && app && found?.covered && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2">
          <button type="button" className={quiet} onClick={() => open(app)}>Another window covers {app}: bring it to the front</button>
        </div>
      )}
      {missing && (
        <Centered>
          <p className="text-muted-foreground">{app} has no window on the screen.</p>
          <button type="button" className={quiet} onClick={() => open(app)}>Open {app}</button>
        </Centered>
      )}
      {statsOn && connected && conn && <Stats conn={conn} />}
      {status.kind === "connecting" && <Centered><p className="text-muted-foreground">Connecting…</p></Centered>}
      {status.kind === "login" && (
        <Centered>
          <form onSubmit={submit} className="flex w-full max-w-[300px] flex-col gap-2 text-left" data-screen-login>
            <p className="mb-1 text-center text-muted-foreground">
              {status.types.includes("username") ? `Sign in to ${label || "the screen"} with a user of that Mac.` : `The screen's VNC password.`}
            </p>
            {status.types.includes("username") && (
              <input name="username" className={field} placeholder="User name" autoComplete="username" autoCapitalize="off" autoCorrect="off" defaultValue={user} autoFocus />
            )}
            <input name="password" type="password" className={field} placeholder="Password" autoComplete="current-password" autoFocus={!status.types.includes("username")} />
            <label className="flex cursor-pointer items-center gap-2 py-1 text-[13px] text-muted-foreground max-md:text-[15px]">
              <input type="checkbox" name="remember" className="size-4" />Remember on that machine
            </label>
            {status.error && <p className="text-[13px] text-[var(--red)] max-md:text-[15px]">{status.error}</p>}
            <button type="submit" className={button}>Connect</button>
          </form>
        </Centered>
      )}
      {status.kind === "off" && (
        <Centered>
          <p className="text-muted-foreground">Disconnected from {label || "the screen"}.</p>
          <button type="button" className={quiet} onClick={() => conn?.connect()} data-screen-connect><RotateCw className="size-3.5" strokeWidth={2} />Connect</button>
        </Centered>
      )}
      {(status.kind === "error" || status.kind === "closed" || status.kind === "refused") && (
        <Centered>
          <p className="text-muted-foreground">
            {status.kind === "refused" ? `This device can't see this screen: ${status.reason || "the server refused it"}.` : `No screen: ${status.reason}.`}
          </p>
          {status.kind !== "refused" && <button type="button" className={quiet} onClick={() => conn?.connect()}><RotateCw className="size-3.5" strokeWidth={2} />Try again</button>}
        </Centered>
      )}
    </div>
  )

  const view = (
    <div ref={full ? fullBox : undefined} className={cn("flex min-h-0 flex-col", full ? "fixed inset-0 z-[60] bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" : "h-full")}
      data-screen={screen} data-screen-full={full || undefined}>
      {toolbar}
      {keyRow}
      {body}
    </div>
  )
  return full ? <>{createPortal(view, document.body)}<div className="h-full" /></> : view
}

/** How fast the screen is now (meter.ts), over the picture: updates a second, the round trip, the bytes. */
function Stats({ conn }: { conn: Conn }) {
  const [, tick] = useState(0)
  useEffect(() => {
    conn.wantStats(true)
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => { clearInterval(t); conn.wantStats(false) }
  }, [conn])
  const s = conn.stats(), relay = s.relay
  const ms = (q: [number, number] | null) => (q ? `${q[0]} ms (95%: ${q[1]})` : "–")
  const rows: [string, string][] = [
    ["Updates", `${s.fps}/s`],
    ["Between", ms(s.gap)],
    ["Waiting", ms(s.wait)],
    ["Arriving", ms(s.span)],
    ["Decoding", `${s.js} ms`],
    ["Input to update", ms(s.input)],
    ["Data", `${s.kbps} KB/s, ${s.frameKb} KB each`],
    ["Encoding", s.encodings || "–"],
    ["Pipeline", relay ? (relay.pipeline ? `on, ${relay.inflight} on the way, screen ${relay.serverMs} ms` : `off: ${relay.why}`) : "–"],
  ]
  return (
    <div className="pointer-events-none absolute top-2 right-2 rounded-[8px] bg-background/85 px-2.5 py-2 font-mono text-[11px] leading-[16px] text-foreground shadow-sm" data-screen-stats>
      {rows.map(([k, v]) => <div key={k} className="flex gap-3"><span className="w-[104px] shrink-0 text-muted-foreground">{k}</span><span>{v}</span></div>)}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[15px] max-md:text-[17px]">{children}</div>
}
