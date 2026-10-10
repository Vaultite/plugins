// What the server answers (GET /api/now-playing), and where a track is: both sides use these.
export type App = { bundle: string; name: string }
export type Track = { title: string; artist: string | null; album: string | null; duration: number | null; elapsed: number | null
  rate: number | null; at: number | null; artwork: string | null }
/** One app playing (or paused): `control` says whether Vaultite can play, pause and skip it (see plugin.ts). */
export type Player = { app: App; playing: boolean; control: boolean; shuffle: boolean | null; track: Track }
/** `players`: every app that told macOS what it plays, the main one first (what's playing, then macOS's current). */
export type NowPlaying = { available: boolean; reason?: string; players: Player[]; volume: number | null; muted: boolean }

/** Where the track is now, in seconds: its last reported position moved on by the time since. */
export function position(p: Player, now = Date.now()) {
  const t = p.track
  if (t.elapsed == null) return null
  const moved = p.playing && t.at ? ((now - t.at) / 1000) * (t.rate || 1) : 0
  return Math.max(0, t.duration ? Math.min(t.duration, t.elapsed + moved) : t.elapsed + moved)
}

export const clock = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`)
