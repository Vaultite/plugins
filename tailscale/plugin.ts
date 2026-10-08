// Tailscale: the tailnet's devices and what this machine serves (`tailscale serve status`), live; labels by port (and
// `host`) in the settings. Provides "machines:url", this server's tailnet address, for Machines.
import { execFile } from "node:child_process"
import fs from "node:fs"
import { bullets, type Machine, Plugin, section } from "@vaultite/core/plugins.ts"
import { type Item, sortBy } from "@vaultite/core/vault.ts"

export const plugin = new Plugin(import.meta.url)
/** The CLI: where Homebrew, the Mac app's installer and Linux packages put it, or the Mac app's own binary. */
const TAILSCALE = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"].find((p) => fs.existsSync(p)) ?? "tailscale"
const PORT = Number(process.env.PORT || 8793)

/** [answers, page title] for a backend URL. */
async function probe(backend: string): Promise<[boolean, string]> {
  try {
    const r = await fetch(backend, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return [false, ""]
    let html = ""
    const reader = r.body!.getReader()
    const dec = new TextDecoder("utf-8")
    for (let n = 0; n < 65536;) {
      const { value, done } = await reader.read()
      if (done) break
      html += dec.decode(value, { stream: true })
      n += value.length
    }
    void reader.cancel().catch(() => {})
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 65536))
    return [true, m ? m[1].trim() : ""]
  } catch {
    return [false, ""]
  }
}

function cli(args: string[]): Promise<Item> {
  return new Promise((resolve, reject) => {
    execFile(TAILSCALE, args, { timeout: 10000, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err && !stdout) return reject(err)
      try {
        resolve(JSON.parse(stdout || "{}"))
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** Every Serve handler: its address, the device's name, the port and the backend. */
async function handlers() {
  const st = await cli(["serve", "status", "--json"])
  const rows: Item[] = []
  for (const [hostport, web] of Object.entries((st.Web ?? {}) as Item)) {
    const at = hostport.lastIndexOf(":")
    const host = hostport.slice(0, at), port = hostport.slice(at + 1)
    for (const [p, h] of Object.entries((web.Handlers ?? {}) as Item)) {
      const backend = h.Proxy || h.Path || h.Text || ""
      rows.push({ url: `https://${host}${port === "443" ? "" : ":" + port}${p}`, host: host.split(".")[0], port: Number(port), backend })
    }
  }
  return rows
}

async function serveStatus() {
  const rows = await handlers()
  const probes = await Promise.all(rows.map((r) => (r.backend.startsWith("http") ? probe(r.backend) : Promise.resolve([null, ""] as const))))
  rows.forEach((r, i) => Object.assign(r, { up: probes[i][0], title: probes[i][1] }))
  return rows
}

async function services() {
  const rows = (await plugin.memo(60, serveStatus)).map((r) => ({ ...r }))
  const list = ((plugin.settings({}).services ?? []) as Item[])
  const same = (s: Item, host: string) => String(s.host).toLowerCase() === String(host).toLowerCase()
  for (const r of rows) {
    // This machine's own entry for the port (`host`) wins over one for any machine.
    let i = list.findIndex((s) => s.port === r.port && s.host && same(s, r.host))
    if (i < 0) i = list.findIndex((s) => s.port === r.port && !s.host)
    const meta = i >= 0 ? list[i] : {}
    Object.assign(r, { label: meta.label || r.title, note: meta.note ?? "", order: i >= 0 ? i : list.length })
  }
  return sortBy(rows, (r) => [r.order, r.port])
}

plugin.route("GET", "tailscale/services", () => services())

// --- the tailnet's devices

export type Device = { name: string; dns: string; os: string; online: boolean; self: boolean; lastSeen: string | null
  ips: string[]; tags: string[]; exitNode: boolean; owner: string }

async function devices(): Promise<Device[]> {
  const st = await plugin.memo(10, function tailnet() { return cli(["status", "--json"]) })
  const users = (st.User ?? {}) as Item
  const one = (p: Item, self: boolean): Device => {
    const dns = String(p.DNSName ?? "").replace(/\.$/, "")
    const seen = String(p.LastSeen ?? "")
    return { name: dns.split(".")[0] || String(p.HostName ?? ""), dns, os: String(p.OS ?? ""), online: self || !!p.Online, self,
      lastSeen: seen && !seen.startsWith("0001") ? seen : null, ips: Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs : [],
      tags: Array.isArray(p.Tags) ? p.Tags : [], exitNode: !!p.ExitNode, owner: String(users[String(p.UserID)]?.LoginName ?? "") }
  }
  const out = [...(st.Self ? [one(st.Self, true)] : []), ...Object.values((st.Peer ?? {}) as Item).map((p) => one(p as Item, false))]
  return sortBy(out, (d) => [d.self ? 0 : 1, d.online ? 0 : 1, d.name])
}

plugin.route("GET", "tailscale/devices", () => devices())

/** This server's address on the tailnet: the Serve handler whose backend is this server's port, or null. */
plugin.provide("machines:url", async () => {
  const own = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}/?$`)
  const hit = (await plugin.memo(60, handlers)).find((h) => own.test(String(h.backend)))
  return hit ? String(hit.url).replace(/\/+$/, "") : null
})

// --- blocks as text

const since = (iso: string | null) => {
  if (!iso) return "not seen yet"
  const h = (Date.now() - Date.parse(iso)) / 3600000
  return h < 1 ? "seen within the hour" : h < 48 ? `seen ${Math.round(h)} h ago` : `seen ${Math.round(h / 24)} days ago`
}

/** The machines (Machines plugin, when it's on), or none. */
const machineList = () => plugin.ask<Machine[]>("machines", [])

/** What a machine serves: this one's here, another's asked of it. */
async function servedBy(m: Machine | null): Promise<Item[]> {
  if (!m || m.self) return services()
  if (!m.online || !m.plugins?.includes("tailscale")) throw new Error(`${m.label} isn't answering`)
  const r = await fetch(`${m.url}/api/tailscale/services`, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`${m.label} answered ${r.status}`)
  return await r.json() as Item[]
}

const servedLine = (r: Item) => `${r.label || r.url}: ${r.url}${r.note ? " (" + r.note + ")" : ""}${r.up ? "" : ", not answering"}`

/** What this machine serves on the tailnet, and whether each answers (`machine:` is drawn by that machine: core/render.ts). */
plugin.block("tailscale", async () => {
  let rows: Item[]
  try {
    rows = await services()
  } catch (e) {
    return section("On the tailnet", `_Couldn't ask Tailscale: ${(e as Error).name}_`)
  }
  return section("On the tailnet", bullets(rows.map(servedLine)))
})

/** Every device on the tailnet, and what the ones that are machines serve. */
plugin.block("tailnet", async () => {
  let rows: Device[]
  try {
    rows = await devices()
  } catch (e) {
    return section("Tailnet", `_Couldn't ask Tailscale: ${(e as Error).name}_`)
  }
  const machines = await machineList()
  const lines = await Promise.all(rows.map(async (d) => {
    const m = machineOf(machines, d)
    let served: Item[] = []
    if (m) try { served = await servedBy(m) } catch { /* not answering */ }
    return `${d.name}${d.self ? " (this one)" : ""}: ${d.os}, ${d.online ? "online" : `offline, ${since(d.lastSeen)}`}` +
      `${d.tags.length ? `, ${d.tags.join(" ")}` : ""}${served.map((r) => `\n  - ${servedLine(r)}`).join("")}`
  }))
  return section("Tailnet", bullets(lines))
})

/** The machine a device is: its address is on the device. */
export function machineOf<M extends { url: string; self: boolean }>(machines: M[], d: { dns: string; self: boolean }): M | null {
  const host = (u: string) => { try { return new URL(u).hostname.toLowerCase() } catch { return "" } }
  return machines.find((m) => host(m.url) === d.dns.toLowerCase()) ?? (d.self ? machines.find((m) => m.self) ?? null : null)
}
