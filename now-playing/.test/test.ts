// Now playing on a throwaway server: what this machine plays (on a Mac with something playing: every player, its track
// and cover), the volume set back to itself, and bad commands refused. NOW_PLAYING_CONTROL=1 also pauses and plays
// each player that can be controlled, and seeks it; NOW_PLAYING_SOURCES=<n> expects at least n players.
//   node now-playing/.test/test.ts
const { check, done, serve } = await import("../../testkit.ts")
const { position } = await import("../shared.ts")

/** `fn`'s first truthy answer within `ms`. */
async function until(fn: () => Promise<unknown>, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((ok) => setTimeout(ok, 300))) if (await fn()) return true
  return false
}

type Player = { app: { bundle: string; name: string }; playing: boolean; control: boolean; track: { title: string; elapsed: number | null; artwork: string | null; duration: number | null } }

const s = await serve(["now-playing"])
try {
  const [code, n] = await s.api("GET", "now-playing")
  check("state: answers", code === 200 && typeof n.available === "boolean" && Array.isArray(n.players), [code, n])
  if (process.platform !== "darwin") check("state: not a Mac, not available", n.available === false && /Mac/.test(n.reason), n)
  else {
    check("state: available on a Mac", n.available === true && (n.volume === null || (n.volume >= 0 && n.volume <= 1)), n)
    const players = n.players as Player[]
    if (process.env.NOW_PLAYING_SOURCES) check(`players: at least ${process.env.NOW_PLAYING_SOURCES}`, players.length >= Number(process.env.NOW_PLAYING_SOURCES), players.map((p) => p.app))
    if (!players.length) console.log("(nothing playing: player checks skipped)")
    for (const p of players) {
      check(`${p.app.name}: an app, a title and a position`, p.app.bundle && p.app.name && p.track.title && typeof p.playing === "boolean" && typeof p.control === "boolean", p)
      if (p.track.artwork) {
        const r = await fetch(`${s.base}api/now-playing/artwork?id=${p.track.artwork}`)
        check(`${p.app.name}: its cover`, r.ok && /^image\//.test(r.headers.get("content-type") ?? "") && (await r.arrayBuffer()).byteLength > 100, r.status)
      }
    }
    if (players.length > 1) check("players: the playing ones first", players.findIndex((p) => !p.playing) === -1 || !players.slice(players.findIndex((p) => !p.playing)).some((p) => p.playing), players.map((p) => p.playing))
    // (muted, it's left alone: a volume above 0 unmutes)
    if (n.volume !== null && !n.muted) {
      const [vc, v] = await s.api("POST", "now-playing/command", { command: "volume", value: n.volume })
      check("volume: set to itself", vc === 200 && Math.abs(v.volume - n.volume) < 0.02, [vc, v])
    }
    const stuck = players.find((p) => !p.control)
    if (stuck) {
      const [sc, sv] = await s.api("POST", "now-playing/command", { command: "pause", player: stuck.app.bundle })
      check(`${stuck.app.name}: can't be controlled, says so`, sc === 409 && /control/.test(sv.error ?? sv), [sc, sv])
    }
    if (process.env.NOW_PLAYING_CONTROL) {
      for (const p of players.filter((x) => x.control && x.playing)) {
        const [, paused] = await s.api("POST", "now-playing/command", { command: "pause", player: p.app.bundle })
        await new Promise((ok) => setTimeout(ok, 1500))
        const [, after] = await s.api("GET", "now-playing")
        const was = (after.players as Player[]).find((x) => x.app.bundle === p.app.bundle)
        check(`${p.app.name}: pause stops it`, was && was.playing === false, [paused, was])
        check(`${p.app.name}: pause leaves the others`, (after.players as Player[]).filter((x) => x.app.bundle !== p.app.bundle && x.playing).length
          === players.filter((x) => x.app.bundle !== p.app.bundle && x.playing).length, after.players)
        await s.api("POST", "now-playing/command", { command: "play", player: p.app.bundle })
        await new Promise((ok) => setTimeout(ok, 1500))
        const [, again] = await s.api("GET", "now-playing")
        check(`${p.app.name}: plays again`, (again.players as Player[]).find((x) => x.app.bundle === p.app.bundle)?.playing === true, again.players)
        if (p.track.duration && p.track.duration > 60) {
          await s.api("POST", "now-playing/command", { command: "seek", value: 30, player: p.app.bundle })
          const near = await until(async () => {
            const [, n] = await s.api("GET", "now-playing")
            const x = (n.players as Player[]).find((y) => y.app.bundle === p.app.bundle)
            return x && Math.abs(position(x as never)! - 30) < 4
          })
          check(`${p.app.name}: seek moves it`, near)
        }
      }
    }
    const text = s.vau("now-playing.get")
    check("op: says what's on", /Playing|Paused|Nothing is playing/.test(text), text)
    if (players.length > 1) check("op: lists every player", players.every((p) => text.includes(p.app.bundle)), text)
  }
  const [bad] = await s.api("POST", "now-playing/command", { command: "explode" })
  check("command: an unknown one refused", bad === 400, bad)
  const [noValue] = await s.api("POST", "now-playing/command", { command: "seek" })
  check("seek: needs a number", noValue === 400 || noValue === 503, noValue)
  if (process.platform === "darwin") {
    const [none] = await s.api("POST", "now-playing/command", { command: "pause", player: "com.example.nothing" })
    check("player: one not playing is a 404", none === 404, none)
  }
} finally {
  s.stop()
}
done()
