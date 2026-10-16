// Podcasts on a throwaway server, following a made-up show from a feed served here: its latest episode downloaded into
// the vault with its transcript, a note in the inbox, then the shows listed and unfollowed.   node podcasts/.test/test.ts
import fs from "node:fs"
import http from "node:http"
import { check, done, serve } from "../../testkit.ts"

const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome to the harbour.\n"
const feed = (base: string) => `<?xml version="1.0"?><rss><channel><title>Harbour Hour</title><itunes:author>Alice Park</itunes:author>
<item><title>Tides</title><guid>ep-2</guid><pubDate>Tue, 14 Oct 2025 08:00:00 GMT</pubDate><itunes:duration>12:00</itunes:duration>
<enclosure url="${base}ep2.mp3" type="audio/mpeg"/><description>&lt;p&gt;All about tides.&lt;/p&gt;</description>
<podcast:transcript url="${base}ep2.vtt" type="text/vtt"/></item>
<item><title>Knots</title><guid>ep-1</guid><pubDate>Tue, 07 Oct 2025 08:00:00 GMT</pubDate><enclosure url="${base}ep1.mp3" type="audio/mpeg"/></item>
</channel></rss>`
const shows = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${(shows.address() as { port: number }).port}/`
  if (req.url === "/feed.xml") return void res.writeHead(200, { "Content-Type": "application/rss+xml" }).end(feed(base))
  if (req.url?.endsWith(".mp3")) return void res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.alloc(64, 1))
  if (req.url === "/ep2.vtt") return void res.writeHead(200, { "Content-Type": "text/vtt" }).end(VTT)
  res.writeHead(404).end()
})
await new Promise<void>((ok) => shows.listen(0, "127.0.0.1", ok))
const url = `http://127.0.0.1:${(shows.address() as { port: number }).port}/feed.xml`

const s = await serve(["podcasts"])
try {
  const run = (id: string, params: unknown) => s.api("POST", `ops/${id}`, params)
  const [c, r] = await run("podcast.follow", { show: url })
  check("podcast.follow: by its feed, its latest episode coming", c === 200 && r.title === "Harbour Hour" && r.episodes === 1, [c, r])
  let note = ""
  for (let i = 0; i < 80 && !note; i++) {
    const [, files] = await s.api("GET", "files")
    note = files.files.map((f: { path: string }) => f.path).find((p: string) => /Tides\.md$/.test(p)) ?? ""
    if (!note) await new Promise((ok) => setTimeout(ok, 250))
  }
  const text = note ? s.read(note) : ""
  check("the episode lands in the inbox: its audio embedded, its notes and transcript", text.includes("![[Harbour Hour - Tides.mp3]]") && text.includes("All about tides.") &&
    text.includes("Welcome to the harbour."), [note, text])
  const saved = (fs.readdirSync(s.vault, { recursive: true }) as string[]).filter((p) => !p.startsWith("."))
  check("its audio and captions are files in the vault", saved.some((p: string) => p.endsWith("Harbour Hour - Tides.mp3")) && saved.some((p: string) => p.endsWith("Harbour Hour - Tides.vtt")) &&
    !saved.some((p: string) => p.includes("Knots")), saved.filter((p: string) => p.includes("Harbour")))
  const [, again] = await run("podcast.follow", { show: url })
  check("following it again says so", again.already === true, again)
  const [, list] = await run("podcast.list", {})
  check("podcast.list: the shows followed", list.shows.length === 1 && list.shows[0].title === "Harbour Hour", list)
  const [, checked] = await run("podcast.check", {})
  check("podcast.check: nothing new, the older episode was seen when it was followed", checked.saved.length === 0, checked)
  const [uc, un] = await run("podcast.unfollow", { show: "Harbour Hour" })
  const [, left] = await run("podcast.list", {})
  check("podcast.unfollow: not followed any more", uc === 200 && un.title === "Harbour Hour" && left.shows.length === 0, [uc, un, left])
} finally {
  s.stop()
  shows.close()
}
done()
