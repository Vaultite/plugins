// What the server answers (GET /api/now-playing), and where the track is: both sides use these.
export type App = { bundle: string; name: string }
export type Track = { title: string; artist: string | null; album: string | null; duration: number | null; elapsed: number | null
  rate: number | null; at: number | null; artwork: string | null }
export type NowPlaying = { available: boolean; reason?: string; playing: boolean; app: App | null; track: Track | null
  shuffle: boolean | null; volume: number | null; muted: boolean }

/** Where the track is now, in seconds: its last reported position moved on by the time since. */
export function position(n: NowPlaying, now = Date.now()) {
  const t = n.track
  if (!t || t.elapsed == null) return null
  const moved = n.playing && t.at ? ((now - t.at) / 1000) * (t.rate || 1) : 0
  return Math.max(0, t.duration ? Math.min(t.duration, t.elapsed + moved) : t.elapsed + moved)
}

export const clock = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`)
