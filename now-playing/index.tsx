// Now playing in the sidebar, in a tab (```block-now-playing on a page, a chip in the status bar): every app playing,
// the main one as a card (cover, track, how far in, controls) and the others as rows, then the volume, from GET
// /api/now-playing (this Mac's, through the server). plugin.ts says how.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Disc3, Music, Pause, Play, Shuffle, SkipBack, SkipForward, Volume, Volume1, Volume2, VolumeX } from "lucide-react"
import { AmbientButton, cn, definePlugin, openView, post, SidebarHeading, useLive, useTick, type SidebarCtx } from "@vaultite"
import { clock, position, type NowPlaying, type Player } from "./shared"

type Command = "play" | "pause" | "toggle" | "next" | "previous" | "shuffle" | "seek" | "volume"
type Send = (command: Command, value?: number, player?: string) => void
type Layout = "sidebar" | "page" | "tab"

/** The live state, asked every second while shown; a command's answer shows at once, until the next one comes. */
function useNowPlaying() {
  const tick = useTick(1000)
  const { data } = useLive<NowPlaying>("now-playing", tick)
  const [answer, setAnswer] = useState<{ n: NowPlaying; at: number } | null>(null)
  const shown = answer && Date.now() - answer.at < 1500 ? answer.n : data
  const send: Send = (command, value, player) =>
    post<NowPlaying>("now-playing/command", { command, value, player }).then((n) => setAnswer({ n, at: Date.now() })).catch(() => {})
  return { n: shown, send }
}

/** The player shown as the card (the main one, or one picked from the rows while it plays on) and the others. */
function useFocus(players: Player[]) {
  const [focus, setFocus] = useState<string | null>(null)
  const main = players.find((p) => p.app.bundle === focus) ?? players[0] ?? null
  return { main, others: players.filter((p) => p !== main), setFocus }
}

function Cover({ p, className }: { p: Player; className?: string }) {
  const id = p.track.artwork
  const [broken, setBroken] = useState<string | null>(null)
  return (
    <div className={cn("relative aspect-square overflow-hidden rounded-[10px] bg-foreground/[0.06]", className)}>
      {id && broken !== id
        ? <img src={`api/now-playing/artwork?id=${encodeURIComponent(id)}`} alt="" draggable={false} onError={() => setBroken(id)}
            className="absolute inset-0 size-full object-cover" />
        : <Disc3 className="absolute inset-0 m-auto size-1/3 text-tertiary" strokeWidth={1.5} />}
    </div>
  )
}

/** The track's bar: drag or click to seek; between answers it moves on by itself. */
function Progress({ p, send }: { p: Player; send: Send }) {
  useTick(250, p.playing)
  const [drag, setDrag] = useState<number | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const d = p.track.duration ?? 0
  const seekable = !!d && p.control
  const at = drag ?? position(p) ?? 0
  const frac = d ? Math.min(1, at / d) : 0
  const pick = (x: number) => {
    const r = bar.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * d
  }
  return (
    <div className="flex flex-col gap-1">
      <div ref={bar} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={d} aria-valuenow={Math.round(at)}
        className={cn("group relative flex h-3 items-center", seekable ? "cursor-pointer" : !d && "opacity-50")}
        onPointerDown={(e) => { if (!seekable) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag(pick(e.clientX)) }}
        onPointerMove={(e) => { if (drag !== null) setDrag(pick(e.clientX)) }}
        onPointerUp={(e) => { if (drag === null) return; send("seek", pick(e.clientX), p.app.bundle); setTimeout(() => setDrag(null), 600) }}>
        <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div className={cn("h-full rounded-full bg-foreground/70", seekable && "group-hover:bg-[var(--now-playing)]")} style={{ width: `${frac * 100}%` }} />
        </div>
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-tertiary">
        <span>{clock(at)}</span>
        <span>{d ? `-${clock(Math.max(0, d - at))}` : ""}</span>
      </div>
    </div>
  )
}

/** A round button; `off` when the app can't be controlled from here (macOS's rule, plugin.ts): the tip says so. */
function Button({ tip, onClick, active, big, off, children }: { tip: string; onClick: () => void; active?: boolean; big?: boolean; off?: string; children: ReactNode }) {
  return (
    <button type="button" aria-label={tip} aria-disabled={off ? true : undefined} data-tip={off ?? tip} onClick={off ? undefined : onClick}
      className={cn("flex items-center justify-center rounded-full",
        big ? "size-10 text-foreground" : "size-8 text-muted-foreground", off ? "cursor-default opacity-40" : "cursor-pointer hover:bg-foreground/[0.08]",
        !off && !big && "hover:text-foreground", active && "text-[var(--now-playing)] hover:text-[var(--now-playing)]")}>
      {children}
    </button>
  )
}

const offFor = (p: Player) => (p.control ? undefined : `Can't control ${p.app.name} from here`)

function Controls({ p, send, large }: { p: Player; send: Send; large?: boolean }) {
  const icon = large ? "size-[22px]" : "size-[18px]"
  const off = offFor(p)
  const go = (c: Command) => () => send(c, undefined, p.app.bundle)
  return (
    <div className={cn("flex items-center justify-between", large && "px-6")}>
      <Button tip={p.shuffle ? "Shuffle is on" : "Shuffle"} active={!!p.shuffle} off={off} onClick={go("shuffle")}><Shuffle className={icon} /></Button>
      <Button tip="Previous" off={off} onClick={go("previous")}><SkipBack className={icon} fill="currentColor" /></Button>
      <Button big tip={p.playing ? "Pause" : "Play"} off={off} onClick={go(p.playing ? "pause" : "play")}>
        {p.playing ? <Pause className={large ? "size-8" : "size-6"} fill="currentColor" strokeWidth={1} />
          : <Play className={cn(large ? "size-8" : "size-6", "translate-x-px")} fill="currentColor" strokeWidth={1} />}
      </Button>
      <Button tip="Next" off={off} onClick={go("next")}><SkipForward className={icon} fill="currentColor" /></Button>
      <span className="size-8" />
    </div>
  )
}

/** The output volume: sent as it moves (a few times a second at most). */
function VolumeRow({ n, send }: { n: NowPlaying; send: Send }) {
  const [held, setHeld] = useState<number | null>(null)
  const timer = useRef(0)
  const latest = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (n.volume == null) return null
  const v = held ?? (n.muted ? 0 : n.volume)
  const Icon = v === 0 ? VolumeX : v < 0.34 ? Volume : v < 0.67 ? Volume1 : Volume2
  const change = (x: number) => {
    setHeld(x)
    latest.current = x
    if (!timer.current) timer.current = window.setTimeout(() => { timer.current = 0; send("volume", latest.current) }, 120)
  }
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <button type="button" aria-label={v ? "Mute" : "Unmute"} className="cursor-pointer hover:text-foreground"
        onClick={() => send("volume", v ? 0 : Math.max(0.25, n.volume ?? 0.5))}><Icon className="size-4" /></button>
      <input type="range" min={0} max={1} step={0.01} value={v} aria-label="Volume"
        onChange={(e) => change(Number(e.currentTarget.value))}
        onPointerUp={() => setTimeout(() => setHeld(null), 800)} onKeyUp={() => setTimeout(() => setHeld(null), 800)}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--now-playing)]" />
      <span className="w-8 text-right text-[11px] tabular-nums text-tertiary">{Math.round(v * 100)}%</span>
    </div>
  )
}

const byline = (p: Player, album?: boolean) =>
  [p.track.artist, album && p.track.album !== p.track.title ? p.track.album : null].filter(Boolean).join(" · ") || p.app.name

/** The main player: in the sidebar a small cover beside the title; on a page the cover beside the rest; in a tab a
 *  big cover over it all, centered. */
function Card({ p, send, layout }: { p: Player; send: Send; layout: Layout }) {
  const t = p.track
  const big = layout === "tab"
  const title = (
    <div className={cn("min-w-0", big && "text-center")}>
      <div className={cn("truncate font-semibold", big ? "text-[20px] leading-7" : "text-[15px] leading-5")} data-tip={t.title} data-tip-trunc>{t.title}</div>
      <div className={cn("truncate text-muted-foreground", big ? "text-[15px] leading-6" : "text-[13px] leading-5")}>{byline(p, layout !== "sidebar")}</div>
      {big && <div className="truncate text-[12px] leading-5 text-tertiary">{p.app.name}</div>}
    </div>
  )
  const rest = <><Progress p={p} send={send} /><Controls p={p} send={send} large={big} /></>
  if (layout === "sidebar") return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5"><Cover p={p} className="w-14 shrink-0 rounded-[6px]" />{title}</div>
      {rest}
    </div>
  )
  if (big) return (
    <div className="flex flex-col gap-3">
      <Cover p={p} className="mx-auto w-full max-w-[22rem] rounded-[14px] shadow-lg" />
      <div className="mt-1">{title}</div>
      {rest}
    </div>
  )
  return (
    <div className="flex items-center gap-4 max-sm:flex-col max-sm:items-stretch">
      <Cover p={p} className="w-40 shrink-0 max-sm:w-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">{title}{rest}</div>
    </div>
  )
}

/** Another app playing: its cover, track and app, and play or pause; a click on it makes it the card. */
function Row({ p, send, onPick }: { p: Player; send: Send; onPick: () => void }) {
  return (
    <div className="relative isolate flex items-center gap-2 before:absolute before:inset-y-0 before:-inset-x-1 before:-z-10 before:rounded-[6px] hover:before:bg-foreground/[0.04]" data-player={p.app.bundle}>
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-left">
        <Cover p={p} className="w-8 shrink-0 rounded-[4px]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-4">{p.track.title}</div>
          <div className="truncate text-[11px] leading-4 text-tertiary">{p.app.name}</div>
        </div>
      </button>
      <Button tip={p.playing ? "Pause" : "Play"} off={offFor(p)} onClick={() => send(p.playing ? "pause" : "play", undefined, p.app.bundle)}>
        {p.playing ? <Pause className="size-4" fill="currentColor" strokeWidth={1} /> : <Play className="size-4 translate-x-px" fill="currentColor" strokeWidth={1} />}
      </Button>
    </div>
  )
}

/** Every player (the card, then the rows) and the volume, laid out for where it's drawn. */
function Sources({ n, send, layout, volume = true, focus }: { n: NowPlaying; send: Send; layout: Layout; volume?: boolean; focus: ReturnType<typeof useFocus> }) {
  const { main, others, setFocus } = focus
  if (!n.available) return <p className="text-[13px] text-tertiary">Now playing isn't available here: {n.reason}.</p>
  const rows = others.length > 0 && (
    <div className={cn("flex flex-col", layout === "tab" && "mt-2 border-t border-border pt-3")}>
      {others.map((p, i) => <Row key={`${p.app.bundle}-${i}`} p={p} send={send} onPick={() => setFocus(p.app.bundle)} />)}
    </div>
  )
  return (
    <div className={cn("flex flex-col", layout === "tab" ? "gap-4" : "gap-2")}>
      {main ? <Card p={main} send={send} layout={layout} /> : (
        <div className={cn("min-w-0", layout === "tab" && "py-10 text-center")}>
          <div className="text-[15px] font-semibold leading-5">Nothing playing</div>
          <div className="text-[13px] leading-5 text-muted-foreground">Play something on this Mac</div>
        </div>
      )}
      {rows}
      {volume && <VolumeRow n={n} send={send} />}
    </div>
  )
}

function NowPlayingPanel({ open }: SidebarCtx) {
  const { n, send } = useNowPlaying()
  const focus = useFocus(n?.players ?? [])
  if (!open || !n) return null
  return (
    <div className="flex shrink-0 flex-col" data-now-playing>
      <SidebarHeading title={focus.main ? `Now playing · ${focus.main.app.name}` : "Now playing"} open={open} />
      <div className="px-1.5 pb-2 pt-1"><Sources n={n} send={send} layout="sidebar" focus={focus} /></div>
    </div>
  )
}

/** Its own tab: a big player in a column centered in the pane, as wide as a phone at most. */
function NowPlayingTab() {
  const { n, send } = useNowPlaying()
  const focus = useFocus(n?.players ?? [])
  return (
    <div className="mx-auto flex w-full max-w-[26rem] flex-col pt-[6vh] pb-10" data-now-playing-tab>
      {n && <Sources n={n} send={send} layout="tab" focus={focus} />}
    </div>
  )
}

function Ambient() {
  const { n, send } = useNowPlaying()
  const p = n?.players[0]
  if (!p) return null
  const label = [p.track.title, p.track.artist].filter(Boolean).join(" · ")
  return <AmbientButton icon={Music} tint={p.playing ? "var(--now-playing)" : undefined} text={<span className="max-w-56 truncate">{label}</span>}
    tip={`${p.playing ? "Pause" : "Play"}: ${label}`} onClick={() => send(p.playing ? "pause" : "play", undefined, p.app.bundle)} />
}

function NowPlayingBlock({ options }: { options: Record<string, unknown> }) {
  const { n, send } = useNowPlaying()
  const focus = useFocus(n?.players ?? [])
  if (!n) return null
  return <Sources n={n} send={send} layout="page" volume={options.volume !== false} focus={focus} />
}

const MOCK: NowPlaying = {
  available: true, volume: 0.6, muted: false,
  players: [
    { app: { bundle: "com.spotify.client", name: "Spotify" }, playing: true, control: true, shuffle: true,
      track: { title: "Lighthouse Lights", artist: "Alice Park", album: "Harbour", duration: 214, elapsed: 83, rate: 1, at: Date.now(), artwork: null } },
    { app: { bundle: "com.example.browser", name: "Browser" }, playing: false, control: false, shuffle: null,
      track: { title: "Harbour walk at dawn", artist: "Lighthouse", album: null, duration: 612, elapsed: 140, rate: 0, at: Date.now(), artwork: null } },
  ],
}

export default definePlugin({
  sidebar: { "now-playing": { title: "Now playing", heading: false, sort: 45, view: "now-playing", flyout: { icon: Music, width: 280 }, render: (ctx) => <NowPlayingPanel {...ctx} /> } },
  views: { "now-playing": { icon: Music, title: () => "Now playing", render: () => <NowPlayingTab /> } },
  commands: [{ id: "now-playing:open-tab", name: "Open now playing in a tab", run: () => openView("now-playing", { newTab: true }) }],
  ambient: { "now-playing": { title: "Now playing", sort: 60, render: () => <Ambient /> } },
  blocks: { "now-playing": (ctx) => <NowPlayingBlock options={ctx.options} /> },
  mockLive: () => ({ "now-playing": MOCK }),
})
