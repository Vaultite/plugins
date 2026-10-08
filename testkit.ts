// What the plugins' tests share: check(), and a throwaway server of the app at $VAULTITE_APP (default ../vaultite) on
// a sandbox vault, on a free port in 8930-8939, with plugins of this repository installed and on.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import { isBuiltin, registerHooks } from "node:module"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const APP = path.resolve(process.env.VAULTITE_APP ?? path.join(import.meta.dirname, "..", "vaultite"))
/** This environment without the Vaultite it may run in (a Vaultite terminal names the user's vault and server). */
export const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VAULTITE") || k === "VAULTITE_APP"))

// A plugin's modules imported here (`await import("./codec.ts")`, after this) find what they would in the server:
// @vaultite/core/<name>.ts and the app's npm packages.
registerHooks({
  resolve(spec, context, next) {
    const core = /^@vaultite\/core\/(\w+)(?:\.ts)?$/.exec(spec)
    if (core) return next(pathToFileURL(path.join(APP, "core", `${core[1]}.ts`)).href, context)
    if (/^(@[\w.-]+\/)?\w/.test(spec) && !isBuiltin(spec) && !spec.includes(":")) return next(spec, { ...context, parentURL: pathToFileURL(path.join(APP, "package.json")).href })
    return next(spec, context)
  },
})

const fails: string[] = []

export function check(name: string, ok: unknown, got?: unknown) {
  console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : `  -> ${JSON.stringify(got)?.slice(0, 400)}`))
  if (!ok) fails.push(name)
}

export function done() {
  console.log(fails.length ? `\n${fails.length} failed` : "\nall passed")
  process.exit(fails.length ? 1 : 0)
}

const free = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.createServer().once("error", () => resolve(false))
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)))
})

/** A server of its own: a sandbox vault with `ids` installed from this repository and turned on (so allowed here). */
export async function serve(ids: string[]) {
  let port = 0
  for (let p = 8930; p <= 8939 && !port; p++) if (await free(p)) port = p
  if (!port) throw new Error("no free port in 8930-8939")
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-plugins-test-"))
  const vault = path.join(tmp, "vault"), local = path.join(tmp, "local")
  const bin = path.join(APP, "bin", "vau")
  execFileSync(process.execPath, [bin, "sandbox", vault], { stdio: "ignore", env: ENV })
  const proc = spawn(process.execPath, [path.join(APP, "server.ts")], {
    cwd: APP, stdio: "ignore", env: { ...ENV, PORT: String(port), HOST: "127.0.0.1", VAULTITE_VAULT: vault, VAULTITE_LOCAL: local },
  })
  const base = `http://127.0.0.1:${port}/`
  const api = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`${base}api/${route}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data: unknown = text
    try { data = JSON.parse(text) } catch { /* (text) */ }
    return [r.status, data] as [number, any] // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const vau = (...a: string[]) => execFileSync(process.execPath, [bin, "--url", base, ...a], { encoding: "utf8", env: { ...ENV, VAULTITE_URL: base } })
  const stop = () => {
    proc.kill()
    try { execFileSync("tmux", ["-L", `vaultite-${port}`, "kill-server"], { stdio: "ignore" }) } catch { /* (none) */ }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  for (let i = 0; ; i++) {
    // (ours: a server of the run before may still answer on the port while it stops)
    try { const r = await fetch(`${base}api/state`); if (r.ok && (await r.json()).vault?.path === vault) break } catch { /* (not yet) */ }
    if (i > 160) { stop(); throw new Error(`the server on ${port} didn't start`) }
    await new Promise((r) => setTimeout(r, 250))
  }
  try {
    for (const id of ids) { vau("plugin", "install", path.join(import.meta.dirname, id)); vau("plugin", "on", id) }
  } catch (e) { stop(); throw e }
  return { base, vault, api, vau, stop, read: (p: string) => fs.readFileSync(path.join(vault, p), "utf8"),
    write: (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(vault, p)), { recursive: true }); fs.writeFileSync(path.join(vault, p), text) } }
}
