// Dispatch in this process, on another machine (a made-up peer server, listed in Machines): passed on to its server
// once its copy of the note matches, the terminal named with its machine; and what it refuses.
//   node dispatch/.test/test.ts
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { check, done, inProcess } from "../../testkit.ts"

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
const s = await inProcess(["dispatch"])
const { api, write } = s
const seen: string[] = []
let peerVault: string | null = null // (this vault's, else its own)
const peer = http.createServer((req, res) => {
  seen.push(`${req.url} ${req.headers["x-vaultite-client"]}`)
  const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)) }
  if (req.url === "/api/machines/self") return json(200, { instance: "peer-1", host: "box", platform: "linux", version: "0.1.0", commit: "abc1234", plugins: ["terminal", "dispatch"],
    vault: peerVault ?? JSON.parse(fs.readFileSync(path.join(s.vault, ".vaultite/plugins/machines/vault.json"), "utf8")).id })
  if (req.url === "/api/file?path=Notes%2FQa%20there.md") return json(200, { path: "Notes/Qa there.md", text: "Over there.\n" })
  if (req.url === "/api/ops/dispatch.run" && req.method === "POST") {
    let b = ""
    req.on("data", (d) => { b += d })
    req.on("end", () => { seen.push(`dispatch ${b}`); json(200, { id: "claude-qa1", action: "claude", path: "Notes/Qa there.md", shown: false }) })
    return
  }
  json(404, { error: "no such thing" })
})
await new Promise<void>((r) => peer.listen(0, "127.0.0.1", () => r()))
try {
  write(".vaultite/plugins/machines/data.json", JSON.stringify({ machines: [{ id: "box", label: "Box", url: `http://127.0.0.1:${(peer.address() as { port: number }).port}/` },
    { id: "gone", url: "http://127.0.0.1:9" }] }))
  await api("POST", "ops/plugin.enable", { id: "machines" })
  await api("GET", "machines") // (this vault's id made)
  write("Notes/Qa there.md", "Over there.\n")
  let [c, body] = await api("POST", "ops/dispatch.run", { path: "Notes/Qa there.md", machine: "box", open: false })
  check("on another machine, its terminal there", c === 200 && body.id === "claude-qa1@box" && body.machine === "box" &&
    seen.includes(`dispatch ${JSON.stringify({ path: "Notes/Qa there.md", action: "claude", open: false })}`), [c, body, seen.slice(-3)])
  const passed = await s.app.runOp("dispatch.run", { path: "Notes/Qa there.md", machine: "box" }, { who: { client: "machine/other", agent: null, label: "other", source: "other" } })
    .then(() => null, (e: Any) => e)
  check("one passed on from another machine isn't passed on again", passed?.status === 409, passed?.message)
  ;[c, body] = await api("POST", "ops/dispatch.run", { path: "Notes/Qa there.md", machine: "nope" })
  check("an unknown machine says which there are", c === 404 && String(body.error).includes("box"), [c, body])
  peerVault = "another"
  s.app.plugins.find((p: Any) => p.id === "machines")!.forget() // (the list is kept 20 s)
  const t0 = Date.now()
  ;[c, body] = await api("POST", "ops/dispatch.run", { path: "Notes/Qa there.md", machine: "box" })
  check("a machine with another vault is refused at once", c === 409 && String(body.error).includes("vault of its own") && Date.now() - t0 < 5000, [c, body])
  peerVault = null
  ;[c, body] = await api("POST", "ops/dispatch.run", { path: "Notes/Qa there.md", machine: "gone" })
  check("an offline machine says so", c === 502 && String(body.error).includes("offline"), [c, body])
  ;[c, body] = await api("POST", "ops/dispatch.run", { path: "Notes/Nowhere.md" })
  check("a file that isn't there says so, nothing started", c === 404 && /there's no file/.test(String(body.error)), [c, body])
} finally {
  peer.close()
  s.stop()
}
done()
