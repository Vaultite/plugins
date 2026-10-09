// Now playing: what this Mac plays (any app that tells macOS: Spotify, Music, a browser tab), and its output volume.
// macOS 15.4+ answers MediaRemote only for Apple's own binaries, so native/adapter.m is built here with clang and loaded
// into Apple's perl (native/adapter.pl): JSON lines out, commands in. It runs while someone looks, and stops after.
import { execFile, spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { HTTPError, Plugin, Text } from "@vaultite/core/plugins.ts"
import { clock, position, type NowPlaying } from "./shared.ts"

export const plugin = new Plugin(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IDLE_MS = 2 * 60_000

type Track = { title: string; artist: string | null; album: string | null; duration: number | null; elapsed: number | null
  rate: number | null; at: number | null; artwork: string | null; shuffle: number | null; repeat: number | null }
type Line = { type: "state"; playing?: boolean; app: { bundle: string; name: string } | null; track: Track | null; volume: number | null; muted: boolean }
  | { type: "artwork"; id: string; mime: string; data: string } | { type: "error"; error: string }

let child: ChildProcess | null = null
let starting: Promise<void> | null = null
let last: Extract<Line, { type: "state" }> | null = null
let artwork: { id: string; mime: string; data: Buffer } | null = null
let failed = ""
let asked = 0
const waiting = new Set<() => void>()
/** Shuffle as the app's own scripting says, by app: MediaRemote doesn't hear Spotify's. */
const shuffleOf = new Map<string, boolean>()

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
  if (m.type === "artwork") artwork = { id: m.id, mime: m.mime, data: Buffer.from(m.data, "base64") }
  else if (m.type === "error") failed = m.error
  else if (m.type === "state") {
    const was = last?.track?.title
    last = m
    if (m.track && m.track.title !== was && m.app) void readShuffle(m.app.bundle)
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

// Spotify and Music say their shuffle through AppleScript (macOS asks once to let Vaultite control them).
const SCRIPTED: Record<string, { app: string; key: string }> = {
  "com.spotify.client": { app: "Spotify", key: "shuffling" },
  "com.apple.Music": { app: "Music", key: "shuffle enabled" },
}
async function readShuffle(bundle: string) {
  const s = SCRIPTED[bundle]
  if (!s) return
  try { shuffleOf.set(bundle, (await run("/usr/bin/osascript", ["-e", `tell application "${s.app}" to get ${s.key}`])).trim() === "true") } catch {}
}

function snapshot(): NowPlaying {
  const off = { playing: false, app: null, track: null, shuffle: null, volume: null, muted: false }
  if (!last) return { available: false, reason: failed || "Starting", ...off }
  const t = last.track
  const mode = t?.shuffle
  const shuffle = typeof mode === "number" && mode > 0 ? mode > 1 : last.app ? shuffleOf.get(last.app.bundle) ?? null : null
  return {
    available: true, playing: !!last.playing && !!t, app: t ? last.app : null, shuffle, volume: last.volume, muted: last.muted,
    track: t ? { title: t.title, artist: t.artist, album: t.album, duration: t.duration, elapsed: t.elapsed, rate: t.rate, at: t.at, artwork: t.artwork } : null,
  }
}

const COMMANDS = ["play", "pause", "toggle", "next", "previous", "shuffle", "seek", "volume"] as const
type Command = (typeof COMMANDS)[number]

async function command(cmd: Command, value?: number) {
  await ensure()
  const bundle = last?.app?.bundle ?? ""
  if (cmd === "shuffle" && SCRIPTED[bundle]) {
    const s = SCRIPTED[bundle]
    const now = (await run("/usr/bin/osascript", ["-e", `tell application "${s.app}"`, "-e", `set ${s.key} to not ${s.key}`, "-e", `get ${s.key}`, "-e", "end tell"])
      .catch((e) => { throw new HTTPError(502, `${s.app} didn't take it: ${(e as Error).message}`) })).trim() === "true"
    shuffleOf.set(bundle, now)
    return snapshot()
  }
  if (cmd === "seek" || cmd === "volume") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new HTTPError(400, `${cmd} needs a number`)
    send(`${cmd} ${cmd === "volume" ? Math.min(1, Math.max(0, value)) : Math.max(0, value)}`)
  } else send(cmd)
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
  if (!artwork) throw new HTTPError(404, "no artwork")
  return new Text(artwork.data, artwork.mime, { "Cache-Control": "private, max-age=86400" })
}, { lock: false })

plugin.route("POST", "now-playing/command", async (req) => {
  await allowed(req)
  const b = (req.body ?? {}) as { command?: string; value?: number }
  if (!COMMANDS.includes(b.command as Command)) throw new HTTPError(400, `command: one of ${COMMANDS.join(", ")}`)
  return command(b.command as Command, b.value)
}, { lock: false })

function describe(n: NowPlaying) {
  if (!n.available) return `Now playing isn't available: ${n.reason}.`
  const vol = n.volume == null ? "" : ` Volume ${n.muted ? "muted" : `${Math.round(n.volume * 100)}%`}.`
  const t = n.track
  if (!t) return `Nothing is playing on this Mac.${vol}`
  const by = t.artist ? ` by ${t.artist}` : ""
  const album = t.album && t.album !== t.title ? ` (${t.album})` : ""
  const at = t.duration ? `, ${clock(position(n))} of ${clock(t.duration)}` : ""
  return `${n.playing ? "Playing" : "Paused"}: ${t.title}${by}${album}${at}${n.app ? `, in ${n.app.name}` : ""}.${vol}`
}

plugin.block("now-playing", async () => {
  await ensure()
  return describe(snapshot())
})

plugin.op({
  id: "now-playing.get",
  summary: "What this Mac is playing (any app: Spotify, Music, a browser), how far in, and its volume.",
  help: "vau now-playing.get",
  kind: "read",
  params: {},
  run: async () => { await ensure(); return snapshot() },
  text: (n: NowPlaying) => describe(n),
})

plugin.op({
  id: "now-playing.control",
  summary: "Control what this Mac plays: play, pause, toggle, next, previous, shuffle, seek (seconds) or volume (0-1).",
  help: `vau now-playing.control pause
  vau now-playing.control volume --value 0.3`,
  kind: "write",
  params: {
    command: { type: "string", enum: [...COMMANDS], description: "what to do" },
    value: { type: "number", description: "seek: the position in seconds; volume: 0 to 1" },
  },
  args: ["command"],
  run: async ({ command: c, value }) => {
    if (!COMMANDS.includes(c as Command)) throw new HTTPError(400, `command: one of ${COMMANDS.join(", ")}`)
    return command(c as Command, value as number | undefined)
  },
  text: (n: NowPlaying) => describe(n),
})
