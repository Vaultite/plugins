// A throwaway Obsidian-style vault and server to try Obsidian plugins on: the corpus here, the plugins from a folder of
// downloaded releases (OC_PLUGINS, default /tmp/oc100/dl) in .obsidian/plugins/, this plugin installed and on.
//   [OC_COMPAT=off|none] [OC_ISOLATE=1] node lab.mjs up <name> <port> [ids|top:N|all]   node lab.mjs down <name>   node lab.mjs sync <name>   node lab.mjs plugins <name> <ids>
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HERE = import.meta.dirname
const PLUGIN = path.resolve(HERE, "..")
// (a lab that's up keeps the app it was made with, unless VAULTITE_APP says otherwise)
const recorded = (() => { try { return JSON.parse(fs.readFileSync(path.join("/tmp/oc-lab", process.argv[3] ?? "", "lab.json"), "utf8")).app } catch { return null } })()
const APP = path.resolve(process.env.VAULTITE_APP ?? (process.argv[2] !== "up" ? recorded : null) ?? path.join(PLUGIN, "..", "..", "vaultite"))
const DL = process.env.OC_PLUGINS ?? "/tmp/oc100/dl"
const ROOT = "/tmp/oc-lab"
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VAULTITE") || k === "VAULTITE_APP"))
const [cmd, name, ...rest] = process.argv.slice(2)
if (!cmd || !name) { console.error("node lab.mjs up|down|sync|plugins <name> ..."); process.exit(2) }
const dir = path.join(ROOT, name), vault = path.join(dir, "vault"), local = path.join(dir, "local")
const info = () => JSON.parse(fs.readFileSync(path.join(dir, "lab.json"), "utf8"))
const vau = (base, ...a) => execFileSync(process.execPath, [path.join(APP, "bin", "vau"), "--url", base, ...a], { encoding: "utf8", env: { ...ENV, VAULTITE_URL: base } })

const ranked = () => fs.readdirSync(DL).filter((id) => fs.existsSync(path.join(DL, id, "main.js")))
  .map((id) => [id, Number(fs.readFileSync(path.join(DL, id, ".rank"), "utf8").split(" ")[0])]).sort((a, b) => a[1] - b[1]).map(([id]) => id)
function pick(spec) {
  if (!spec || spec === "none") return []
  if (spec === "all") return ranked()
  if (spec.startsWith("top:")) return ranked().slice(0, Number(spec.slice(4)))
  return spec.split(",").filter(Boolean)
}

/** Copy plugins' releases into .obsidian/plugins/ and list them in community-plugins.json (as Obsidian has them on). */
function putPlugins(ids) {
  const to = path.join(vault, ".obsidian", "plugins")
  fs.mkdirSync(to, { recursive: true })
  for (const id of ids) {
    const from = path.join(DL, id)
    if (!fs.existsSync(path.join(from, "main.js"))) { console.error(`no download of ${id} in ${DL}`); continue }
    fs.mkdirSync(path.join(to, id), { recursive: true })
    for (const f of ["main.js", "manifest.json", "styles.css"]) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(to, id, f))
  }
  const list = path.join(vault, ".obsidian", "community-plugins.json")
  const had = fs.existsSync(list) ? JSON.parse(fs.readFileSync(list, "utf8")) : []
  fs.writeFileSync(list, JSON.stringify([...new Set([...had, ...ids])], null, 2))
}

async function ready(base) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}api/plugins`)).ok) return } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server at ${base} didn't come up: ${dir}/server.log`)
}

function stop(port) {
  try { execFileSync("sh", ["-c", `kill $(lsof -tiTCP:${port} -sTCP:LISTEN) 2>/dev/null`]) } catch { /* not running */ }
  const run = process.platform === "darwin" ? os.tmpdir() : path.join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "vaultite")
  const pid = path.join(run, `vaultite-ptyd1-vaultite-${port}.sock.pid`)
  try { process.kill(Number(fs.readFileSync(pid, "utf8"))) } catch { /* none */ }
  try { execFileSync("tmux", ["-L", `vaultite-${port}`, "kill-server"], { stdio: "ignore" }) } catch { /* none */ }
}

// OC_ISOLATE: the server (and what plugins run through it) gets a home of its own, a PATH without the user's tools but
// fake agent CLIs (fake-cli.sh), and a made-up git author, so no plugin reaches the user's accounts or programs.
function isolated(on) {
  if (!on) return {}
  const home = path.join(dir, "home"), bin = path.join(home, "bin")
  fs.mkdirSync(bin, { recursive: true })
  for (const n of ["claude", "codex", "opencode", "gemini"]) {
    fs.copyFileSync(path.join(HERE, "fake-cli.sh"), path.join(bin, n))
    fs.chmodSync(path.join(bin, n), 0o755)
  }
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Alice Park\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n")
  // (nothing else of this shell's: no ZDOTDIR, XDG_* or tokens pointing back at the user's own setup)
  const keep = Object.fromEntries(["USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
  return { ...keep, HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") }
}

async function start(port, isolate) {
  const out = fs.openSync(path.join(dir, "server.log"), "a")
  const iso = isolated(isolate)
  const p = spawn(process.execPath, [path.join(APP, "server.ts")], { cwd: APP, detached: true, stdio: ["ignore", out, out],
    env: { ...(isolate ? iso : ENV), PORT: String(port), HOST: "127.0.0.1", VAULTITE_VAULT: vault, VAULTITE_LOCAL: local } })
  p.unref()
  const base = `http://127.0.0.1:${port}/`
  await ready(base)
  return base
}

if (cmd === "up") {
  const port = Number(rest[0])
  if (!port) throw new Error("a port")
  if (fs.existsSync(path.join(dir, "lab.json"))) stop(info().port)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  execFileSync(process.execPath, [path.join(APP, "bin", "vau"), "sandbox", vault], { stdio: "ignore", env: ENV })
  fs.cpSync(path.join(HERE, "corpus"), vault, { recursive: true })
  putPlugins(pick(rest[1] ?? "none"))
  const isolate = !!process.env.OC_ISOLATE
  const base = await start(port, isolate)
  fs.writeFileSync(path.join(dir, "lab.json"), JSON.stringify({ port, base, vault, app: APP, isolate }, null, 2))
  // (OC_COMPAT=off: installed but off, as someone who just moved from Obsidian has it; none: not even installed)
  if (process.env.OC_COMPAT !== "none") vau(base, "plugin", "install", PLUGIN)
  if (!process.env.OC_COMPAT) {
    vau(base, "plugin", "on", "plugin-compat")
    for (const p of JSON.parse(vau(base, "plugin-compat", "list", "--json"))) if (p.enabled && !p.allowed) vau(base, "plugin-compat", "allow", p.id)
  }
  console.log(base)
} else if (cmd === "down") {
  if (fs.existsSync(path.join(dir, "lab.json"))) stop(info().port)
  console.log(`stopped ${name}`)
} else if (cmd === "restart") {
  const { port } = info()
  stop(port)
  await new Promise((r) => setTimeout(r, 800))
  console.log(await start(port, info().isolate))
} else if (cmd === "sync") {
  console.log(vau(info().base, "plugin", "update", "plugin-compat", "--apply").trim().split("\n").slice(-1)[0])
  try { vau(info().base, "plugin", "allow", "plugin-compat") } catch { /* allowed already */ }
} else if (cmd === "plugins") {
  const ids = pick(rest[0])
  putPlugins(ids)
  // (enabled through the op: the overlay's community-plugins.json, once written, wins over Obsidian's)
  for (const id of ids) vau(info().base, "plugin-compat", "enable", id)
  console.log(`${ids.length} on`)
} else throw new Error(`no command ${cmd}`)
