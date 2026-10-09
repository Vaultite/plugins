// Now playing on a throwaway server: what this machine plays (on a Mac with something playing: its track and cover),
// the volume set back to itself, and bad commands refused. NOW_PLAYING_CONTROL=1 also pauses and plays again.
//   node now-playing/.test/test.ts
const { check, done, serve } = await import("../../testkit.ts")

const s = await serve(["now-playing"])
try {
  const [code, n] = await s.api("GET", "now-playing")
  check("state: answers", code === 200 && typeof n.available === "boolean", [code, n])
  if (process.platform !== "darwin") check("state: not a Mac, not available", n.available === false && /Mac/.test(n.reason), n)
  else {
    check("state: available on a Mac", n.available === true && (n.volume === null || (n.volume >= 0 && n.volume <= 1)), n)
    if (n.track) {
      check("track: a title and a position", typeof n.track.title === "string" && n.track.title && typeof n.track.elapsed === "number", n.track)
      if (n.track.artwork) {
        const r = await fetch(`${s.base}api/now-playing/artwork?id=${n.track.artwork}`)
        check("artwork: an image", r.ok && /^image\//.test(r.headers.get("content-type") ?? "") && (await r.arrayBuffer()).byteLength > 100, r.status)
      }
    } else console.log("(nothing playing: track checks skipped)")
    if (n.volume !== null) {
      const [vc, v] = await s.api("POST", "now-playing/command", { command: "volume", value: n.volume })
      check("volume: set to itself", vc === 200 && Math.abs(v.volume - n.volume) < 0.02, [vc, v])
    }
    if (process.env.NOW_PLAYING_CONTROL && n.track && n.playing) {
      const [, paused] = await s.api("POST", "now-playing/command", { command: "pause" })
      check("pause: stops", paused.playing === false, paused)
      const [, again] = await s.api("POST", "now-playing/command", { command: "play" })
      check("play: plays again", again.playing === true, again)
    }
    check("op: says what's on", /Playing|Paused|Nothing is playing/.test(s.vau("now-playing.get")))
  }
  const [bad] = await s.api("POST", "now-playing/command", { command: "explode" })
  check("command: an unknown one refused", bad === 400, bad)
  const [noValue] = await s.api("POST", "now-playing/command", { command: "seek" })
  check("seek: needs a number", noValue === 400 || noValue === 503, noValue)
} finally {
  s.stop()
}
done()
