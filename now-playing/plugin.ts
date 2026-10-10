// Now playing: what this Mac plays (every app that tells macOS: Spotify, Music, a browser tab), and its output volume.
// macOS 15.4+ answers MediaRemote only for Apple's own binaries, so native/adapter.m is built here with clang and loaded
// into Apple's perl (native/adapter.pl): JSON lines out, commands in. It runs while someone looks, and stops after.
import { execFile, spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { HTTPError, Plugin, Text } from "@vaultite/core/plugins.ts"
import { clock, position, type NowPlaying, type Player } from "./shared.ts"

export const plugin = new Plugin(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IDLE_MS = 2 * 60_000

type Track = { title: string; artist: string | null; album: string | null; duration: number | null; elapsed: number | null
  rate: number | null; at: number | null; artwork: string | null; shuffle: number | null; repeat: number | null }
type Raw = { app: { bundle: string; name: string }; current: boolean; playing: boolean; track: Track }
type Line = { type: "state"; players: Raw[]; volume: number | null; muted: boolean }
  | { type: "artwork"; id: string; mime: string; data: string } | { type: "error"; error: string }

let child: ChildProcess | null = null
let starting: Promise<void> | null = null
let last: Extract<Line, { type: "state" }> | null = null
/** Covers by id, the latest few (more than the adapter remembers sending, so it sends a dropped one again). */
const artworks = new Map<string, { mime: string; data: Buffer }>()
let failed = ""
let asked = 0
const waiting = new Set<() => void>()
/** Shuffle as the app's own scripting says, by app: MediaRemote doesn't hear Spotify's. */
const shuffleOf = new Map<string, boolean>()
const titleOf = new Map<string, string>()

/** The adapter library for this source, built once into this machine's folder for the plugin. */
async function library() {
  const src = path.join(HERE, "native", "adapter.m")
  const hash = crypto.createHash("sha1").update(fs.readFileSync(src)).digest("hex").slice(0, 12)
  const out = path.join(plugin.localDir(), `adapter-${hash}.dylib`)
  if (fs.existsSync(out)) return out
  // /usr/bin/clang without the tools opens macOS's install dialog: ask first.
  await run("/usr/bin/xcode-select", ["-p"]).catch(() => { throw new Error("Needs Xcode's command line tools: run xcode-select --install") })
  await run("/usr/bin/clang", ["-dynamiclib", "-fobjc-arc", "-O2", "-framework", "Foundation", "-framework", "AppKit",
    "-framework", "CoreAudio", "-framework", "AudioToolbox", "-o", out + ".tmp", src], 120_000)
  fs.renameSync(out + ".tmp", out)
  return out
}

const run = (file: string, args: string[], timeout = 10_000) => new Promise<string>((ok, fail) =>
  execFile(file, args, { timeout }, (err, stdout, stderr) => (err ? fail(new Error(String(stderr || err.message).trim())) : ok(stdout))))

function take(raw: string) {
  let m: Line
  try { m = JSON.parse(raw) } catch { return }
  if (m.type === "artwork") {
    artworks.delete(m.id)
    artworks.set(m.id, { mime: m.mime, data: Buffer.from(m.data, "base64") })
    for (const id of artworks.keys()) if (artworks.size > 24) artworks.delete(id)
  } else if (m.type === "error") failed = m.error
  else if (m.type === "state") {
    last = m
    for (const p of m.players) {
      if (titleOf.get(p.app.bundle) !== p.track.title) void readShuffle(p.app.bundle)
      titleOf.set(p.app.bundle, p.track.title)
    }
    for (const fn of waiting) fn()
    waiting.clear()
  }
}

/** The adapter, started if it isn't running; waits a moment for its first answer. */
async function ensure() {
  asked = Date.now()
  if (process.platform !== "darwin") { failed = "Only on a Mac"; return }
  if (child) return
  starting ??= (async () => {
    try {
      const lib = await library()
      failed = ""
      const p = spawn("/usr/bin/perl", [path.join(HERE, "native", "adapter.pl"), lib], { stdio: ["pipe", "pipe", "pipe"] })
      child = p
      let err = ""
      p.stderr!.on("data", (d) => { err = (err + d).slice(-2000) })
      readline.createInterface({ input: p.stdout! }).on("line", take)
      p.on("exit", (code) => {
        if (child === p) { child = null; last = null }
        if (code) failed = err.trim() || `the adapter stopped (${code})`
      })
      p.stdin!.on("error", () => {})
      await new Promise<void>((ok) => { waiting.add(ok); setTimeout(ok, 2000) })
    } catch (e) {
      failed = (e as Error).message
    } finally {
      starting = null
    }
  })()
  await starting
}

const idle = setInterval(() => { if (child && Date.now() - asked > IDLE_MS) child.stdin?.end() }, 30_000)
plugin.onUnload(() => { clearInterval(idle); child?.kill(); child = null })

function send(line: string) {
  if (!child?.stdin?.writable) throw new HTTPError(503, failed || "Now playing isn't running")
  child.stdin.write(line + "\n")
}
/** The next state the adapter reports, or the one there is after `ms`. */
const next = (ms = 600) => new Promise<void>((ok) => { waiting.add(ok); setTimeout(ok, ms) })

// Spotify and Music are scripted (macOS asks once to let Vaultite control them): shuffle and seek, which MediaRemote
// misses for Spotify, and commands while another app is macOS's current player (the only one MediaRemote reaches).
const SCRIPTED: Record<string, { app: string; key: string }> = {
  "com.spotify.client": { app: "Spotify", key: "shuffling" },
  "com.apple.Music": { app: "Music", key: "shuffle enabled" },
}
const SCRIPT: Partial<Record<Command, string>> = { play: "play", pause: "pause", toggle: "playpause", next: "next track", previous: "previous track" }

const script = (app: string, lines: string[]) =>
  run("/usr/bin/osascript", ["-e", `tell application "${app}"`, ...lines.flatMap((l) => ["-e", l]), "-e", "end tell"])
    .catch((e) => { throw new HTTPError(502, `${app} didn't take it: ${(e as Error).message}`) })

async function readShuffle(bundle: string) {
  const s = SCRIPTED[bundle]
  if (!s) return
  try { shuffleOf.set(bundle, (await run("/usr/bin/osascript", ["-e", `tell application "${s.app}" to get ${s.key}`])).trim() === "true") } catch {}
}

/** Playing ones first, then macOS's current one, else as macOS lists them. */
function ordered(players: Raw[]) {
  return players.map((p, i) => ({ p, i })).sort((a, b) => +b.p.playing - +a.p.playing || +b.p.current - +a.p.current || a.i - b.i).map((x) => x.p)
}

function snapshot(): NowPlaying {
  if (!last) return { available: false, reason: failed || "Starting", players: [], volume: null, muted: false }
  const players = ordered(last.players).map((p): Player => {
    const t = p.track
    const mode = t.shuffle
    const shuffle = typeof mode === "number" && mode > 0 ? mode > 1 : shuffleOf.get(p.app.bundle) ?? null
    return {
      app: p.app, playing: p.playing, control: p.current || !!SCRIPTED[p.app.bundle], shuffle,
      track: { title: t.title, artist: t.artist, album: t.album, duration: t.duration, elapsed: t.elapsed, rate: t.rate, at: t.at, artwork: t.artwork },
    }
  })
  return { available: true, players, volume: last.volume, muted: last.muted }
}

const COMMANDS = ["play", "pause", "toggle", "next", "previous", "shuffle", "seek", "volume"] as const
type Command = (typeof COMMANDS)[number]

/** A command for one app's player (by bundle id; the main one without), or the output volume. */
async function command(cmd: Command, value?: number, player?: string) {
  await ensure()
  if ((cmd === "seek" || cmd === "volume") && (typeof value !== "number" || !Number.isFinite(value))) throw new HTTPError(400, `${cmd} needs a number`)
  if (cmd === "volume") {
    send(`volume ${Math.min(1, Math.max(0, value!))}`)
    await next()
    return snapshot()
  }
  const players = last ? ordered(last.players) : []
  const p = player ? players.find((x) => x.app.bundle === player) : players[0]
  if (player && !p) throw new HTTPError(404, `${player} isn't playing anything`)
  const bundle = p?.app.bundle ?? ""
  const s = SCRIPTED[bundle]
  if (cmd === "shuffle" && s) {
    shuffleOf.set(bundle, (await script(s.app, [`set ${s.key} to not ${s.key}`, `get ${s.key}`])).trim() === "true")
    return snapshot()
  }
  if (p && (!p.current || (cmd === "seek" && s))) {
    if (!s || cmd === "shuffle") {
      throw new HTTPError(409, `macOS lets Vaultite control only the app it shows as now playing${players.find((x) => x.current) ? ` (${players.find((x) => x.current)!.app.name})` : ""}, not ${p.app.name}`)
    }
    await script(s.app, [cmd === "seek" ? `set player position to ${Math.max(0, value!)}` : SCRIPT[cmd]!])
  } else send(cmd === "seek" ? `seek ${Math.max(0, value!)}` : cmd)
  await next()
  return snapshot()
}

async function allowed(req: { http?: unknown }) {
  const why = req.http ? await plugin.refusal(req.http as never, "this Mac's music") : ""
  if (why) throw new HTTPError(403, why)
}

plugin.route("GET", "now-playing", async (req) => {
  await allowed(req)
  await ensure()
  return snapshot()
}, { lock: false })

plugin.route("GET", "now-playing/artwork", async (req) => {
  await allowed(req)
  const art = artworks.get(String(req.query?.id ?? ""))
  if (!art) throw new HTTPError(404, "no artwork")
  return new Text(art.data, art.mime, { "Cache-Control": "private, max-age=86400" })
}, { lock: false })

plugin.route("POST", "now-playing/command", async (req) => {
  await allowed(req)
  const b = (req.body ?? {}) as { command?: string; value?: number; player?: string }
  if (!COMMANDS.includes(b.command as Command)) throw new HTTPError(400, `command: one of ${COMMANDS.join(", ")}`)
  return command(b.command as Command, b.value, b.player || undefined)
}, { lock: false })

function line(p: Player, also: boolean) {
  const t = p.track
  const by = t.artist ? ` by ${t.artist}` : ""
  const album = t.album && t.album !== t.title ? ` (${t.album})` : ""
  const at = t.duration ? `, ${clock(position(p))} of ${clock(t.duration)}` : ""
  const state = p.playing ? "Playing" : "Paused"
  return `${also ? `Also ${state.toLowerCase()}` : state}: ${t.title}${by}${album}${at}, in ${p.app.name} (${p.app.bundle})${p.control ? "" : ", can't be controlled from here"}.`
}

function describe(n: NowPlaying) {
  if (!n.available) return `Now playing isn't available: ${n.reason}.`
  const vol = n.volume == null ? "" : `Volume ${n.muted ? "muted" : `${Math.round(n.volume * 100)}%`}.`
  if (!n.players.length) return ["Nothing is playing on this Mac.", vol].filter(Boolean).join(" ")
  return [...n.players.map((p, i) => line(p, i > 0)), vol].filter(Boolean).join("\n")
}

plugin.block("now-playing", async () => {
  await ensure()
  return describe(snapshot())
})

plugin.op({
  id: "now-playing.get",
  summary: "What this Mac is playing, every app at once (Spotify, Music, a browser), the main one first: how far in, and the volume.",
  help: "vau now-playing.get",
  kind: "read",
  params: {},
  run: async () => { await ensure(); return snapshot() },
  text: (n: NowPlaying) => describe(n),
})

plugin.op({
  id: "now-playing.control",
  summary: "Control what this Mac plays: play, pause, toggle, next, previous, shuffle, seek (seconds) or volume (0-1); --player picks the app (bundle id), else the main one.",
  help: `vau now-playing.control pause
  vau now-playing.control next --player com.spotify.client
  vau now-playing.control volume --value 0.3`,
  kind: "write",
  params: {
    command: { type: "string", enum: [...COMMANDS], description: "what to do" },
    value: { type: "number", description: "seek: the position in seconds; volume: 0 to 1" },
    player: { type: "string", description: "the app, by its bundle id as now-playing.get lists it (com.spotify.client); the main one when left out" },
  },
  args: ["command"],
  run: async ({ command: c, value, player }) => {
    if (!COMMANDS.includes(c as Command)) throw new HTTPError(400, `command: one of ${COMMANDS.join(", ")}`)
    return command(c as Command, value as number | undefined, (player as string | undefined) || undefined)
  },
  text: (n: NowPlaying) => describe(n),
})
