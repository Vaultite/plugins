// Now playing in the sidebar (and ```block-now-playing on a page, a chip in the status bar): the cover, the track, how far
// in, the controls and the volume, from GET /api/now-playing (this Mac's, through the server). plugin.ts says how.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Disc3, Music, Pause, Play, Shuffle, SkipBack, SkipForward, Volume, Volume1, Volume2, VolumeX } from "lucide-react"
import { AmbientButton, cn, definePlugin, post, SidebarHeading, useLive, useTick, type SidebarCtx } from "@vaultite"
import { clock, position, type NowPlaying } from "./shared"

type Command = "play" | "pause" | "toggle" | "next" | "previous" | "shuffle" | "seek" | "volume"

/** The live state, asked every second while shown; a command's answer shows at once, until the next one comes. */
function useNowPlaying() {
  const tick = useTick(1000)
  const { data } = useLive<NowPlaying>("now-playing", tick)
  const [answer, setAnswer] = useState<{ n: NowPlaying; at: number } | null>(null)
  const shown = answer && Date.now() - answer.at < 1500 ? answer.n : data
  const send = (command: Command, value?: number) =>
    post<NowPlaying>("now-playing/command", { command, value }).then((n) => setAnswer({ n, at: Date.now() })).catch(() => {})
  return { n: shown, send }
}

function Cover({ n, className }: { n: NowPlaying; className?: string }) {
  const id = n.track?.artwork
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
function Progress({ n, send }: { n: NowPlaying; send: (c: Command, v?: number) => void }) {
  useTick(250, n.playing)
  const [drag, setDrag] = useState<number | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const d = n.track?.duration ?? 0
  const at = drag ?? position(n) ?? 0
  const frac = d ? Math.min(1, at / d) : 0
  const pick = (x: number) => {
    const r = bar.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * d
  }
  return (
    <div className="flex flex-col gap-1">
      <div ref={bar} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={d} aria-valuenow={Math.round(at)}
        className={cn("group relative flex h-3 items-center", d ? "cursor-pointer" : "opacity-50")}
        onPointerDown={(e) => { if (!d) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag(pick(e.clientX)) }}
        onPointerMove={(e) => { if (drag !== null) setDrag(pick(e.clientX)) }}
        onPointerUp={(e) => { if (drag === null) return; send("seek", pick(e.clientX)); setTimeout(() => setDrag(null), 600) }}>
        <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div className="h-full rounded-full bg-foreground/70 group-hover:bg-[var(--now-playing)]" style={{ width: `${frac * 100}%` }} />
        </div>
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-tertiary">
        <span>{clock(at)}</span>
        <span>{d ? `-${clock(Math.max(0, d - at))}` : ""}</span>
      </div>
    </div>
  )
}

function Button({ tip, onClick, active, big, children }: { tip: string; onClick: () => void; active?: boolean; big?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={tip} data-tip={tip} onClick={onClick}
      className={cn("flex cursor-pointer items-center justify-center rounded-full hover:bg-foreground/[0.08]",
        big ? "size-10 text-foreground" : "size-8 text-muted-foreground hover:text-foreground", active && "text-[var(--now-playing)] hover:text-[var(--now-playing)]")}>
      {children}
    </button>
  )
}

function Controls({ n, send }: { n: NowPlaying; send: (c: Command, v?: number) => void }) {
  const icon = "size-[18px]"
  return (
    <div className="flex items-center justify-between">
      <Button tip={n.shuffle ? "Shuffle is on" : "Shuffle"} active={!!n.shuffle} onClick={() => send("shuffle")}><Shuffle className={icon} /></Button>
      <Button tip="Previous" onClick={() => send("previous")}><SkipBack className={icon} fill="currentColor" /></Button>
      <Button big tip={n.playing ? "Pause" : "Play"} onClick={() => send(n.playing ? "pause" : "play")}>
        {n.playing ? <Pause className="size-6" fill="currentColor" strokeWidth={1} /> : <Play className="size-6 translate-x-px" fill="currentColor" strokeWidth={1} />}
      </Button>
      <Button tip="Next" onClick={() => send("next")}><SkipForward className={icon} fill="currentColor" /></Button>
      <span className="size-8" />
    </div>
  )
}

/** The output volume: sent as it moves (a few times a second at most). */
function VolumeRow({ n, send }: { n: NowPlaying; send: (c: Command, v?: number) => void }) {
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

/** `wide`: the cover beside the rest (a page); else the sidebar's: a small cover beside the title, the rest under. */
function Player({ n, send, volume = true, wide }: { n: NowPlaying; send: (c: Command, v?: number) => void; volume?: boolean; wide?: boolean }) {
  const t = n.track
  if (!n.available) return <p className="text-[13px] text-tertiary">Now playing isn't available here: {n.reason}.</p>
  const title = (
    <div className="min-w-0">
      <div className="truncate text-[15px] font-semibold leading-5" title={t?.title}>{t?.title ?? "Nothing playing"}</div>
      <div className="truncate text-[13px] leading-5 text-muted-foreground" title={t?.artist ?? undefined}>
        {t ? [t.artist, wide && t.album !== t.title ? t.album : null].filter(Boolean).join(" · ") || n.app?.name : "Play something on this Mac"}
      </div>
    </div>
  )
  const rest = <>
    {t && <Progress n={n} send={send} />}
    {t && <Controls n={n} send={send} />}
    {volume && <VolumeRow n={n} send={send} />}
  </>
  if (!wide) return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">{t && <Cover n={n} className="w-14 shrink-0 rounded-[6px]" />}{title}</div>
      {rest}
    </div>
  )
  return (
    <div className="flex items-center gap-4 max-sm:flex-col max-sm:items-stretch">
      <Cover n={n} className="w-40 shrink-0 max-sm:w-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">{title}{rest}</div>
    </div>
  )
}

function NowPlayingPanel({ open }: SidebarCtx) {
  const { n, send } = useNowPlaying()
  if (!open || !n) return null
  return (
    <div className="flex shrink-0 flex-col" data-now-playing>
      <SidebarHeading title={n.app ? `Now playing · ${n.app.name}` : "Now playing"} open={open} />
      <div className="px-1.5 pb-2 pt-1"><Player n={n} send={send} /></div>
    </div>
  )
}

function Ambient() {
  const { n, send } = useNowPlaying()
  const t = n?.track
  if (!n || !t) return null
  const label = [t.title, t.artist].filter(Boolean).join(" · ")
  return <AmbientButton icon={Music} tint={n.playing ? "var(--now-playing)" : undefined} text={<span className="max-w-56 truncate">{label}</span>}
    tip={`${n.playing ? "Pause" : "Play"}: ${label}`} onClick={() => send(n.playing ? "pause" : "play")} />
}

function NowPlayingBlock({ options }: { options: Record<string, unknown> }) {
  const { n, send } = useNowPlaying()
  if (!n) return null
  return <Player n={n} send={send} volume={options.volume !== false} wide />
}

const MOCK: NowPlaying = {
  available: true, playing: true, app: { bundle: "com.spotify.client", name: "Spotify" }, shuffle: true, volume: 0.6, muted: false,
  track: { title: "Lighthouse Lights", artist: "Alice Park", album: "Harbour", duration: 214, elapsed: 83, rate: 1, at: Date.now(), artwork: null },
}

export default definePlugin({
  sidebar: { "now-playing": { title: "Now playing", heading: false, sort: 45, flyout: { icon: Music, width: 280 }, render: (ctx) => <NowPlayingPanel {...ctx} /> } },
  ambient: { "now-playing": { title: "Now playing", sort: 60, render: () => <Ambient /> } },
  blocks: { "now-playing": (ctx) => <NowPlayingBlock options={ctx.options} /> },
  mockLive: () => ({ "now-playing": MOCK }),
})
