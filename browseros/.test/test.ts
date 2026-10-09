// BrowserOS neo's sessions on a throwaway server, from a made-up neo server: the live ones with the tab each worked in
// last and a help request, its previews passed through, and a tab to show checked.   node browseros/.test/test.ts
import http from "node:http"
import type { AddressInfo } from "node:net"

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const neo = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x")
  if (url.pathname === "/api/v1/sessions" && url.searchParams.get("status") === "live") {
    res.setHeader("content-type", "application/json")
    return res.end(JSON.stringify({ items: [
      { sessionId: "s1", slug: "claude-code", label: "claude-code", name: "invoice processing", site: "example.com", startedAt: 1,
        live: { state: "active", browserTabs: [
          { browserTabId: 11, url: "https://example.com/a", title: "A", lastActivityAt: 5 },
          { browserTabId: 12, url: "https://example.com/b", title: "B", lastActivityAt: 9 }] } },
      { sessionId: "s2", slug: "codex", name: "", site: "lighthouse.example", startedAt: 2,
        live: { state: "idle", browserTabs: [{ browserTabId: 21, url: "https://lighthouse.example/", title: "Sign in" }],
          helpRequest: { requestedAt: 7, reason: "a one-time code" } } },
    ] }))
  }
  if (url.pathname === "/api/v1/sessions/s1/preview" && url.searchParams.get("browserTabId") === "12") {
    res.setHeader("content-type", "image/jpeg")
    return res.end(JPEG)
  }
  res.statusCode = 404
  res.end("{}")
})
await new Promise<void>((r) => neo.listen(0, "127.0.0.1", r))
process.env.BROWSEROS_NEO_API = `http://127.0.0.1:${(neo.address() as AddressInfo).port}/api/v1`
const { check, done, serve } = await import("../../testkit.ts")

const s = await serve(["browseros"])
try {
  const [code, r] = await s.api("GET", "browseros/sessions")
  const [a, b] = r.sessions ?? []
  check("sessions: neo answers, two live sessions", code === 200 && r.running === true && r.sessions.length === 2, [code, r])
  check("sessions: the tab worked in last, working", a?.tab?.id === 12 && a.active && a.agent === "claude-code" && a.name === "invoice processing" && !a.help, a)
  check("sessions: a help request, the agent by its slug", b?.help?.reason === "a one-time code" && b.agent === "codex" && !b.active && b.tab?.id === 21, b)
  const shot = await fetch(`${s.base}api/browseros/preview/s1?tab=12`)
  const bytes = Buffer.from(await shot.arrayBuffer())
  check("preview: the tab's JPEG passed through", shot.ok && shot.headers.get("content-type") === "image/jpeg" && bytes.equals(JPEG), [shot.status, shot.headers.get("content-type")])
  check("preview: none for a session without one", (await fetch(`${s.base}api/browseros/preview/s9`)).status === 404)
  const [bad] = await s.api("POST", "browseros/focus", { tab: "x" })
  check("focus: a tab id is asked for", bad === 400, bad)
  await new Promise<void>((r) => neo.close(() => r()))
  const [, off] = await s.api("GET", "browseros/sessions")
  check("sessions: neo not running", off.running === false && off.sessions.length === 0, off)
} finally {
  s.stop()
  neo.close()
}
done()
