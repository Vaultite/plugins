// What the plugins' QA scripts share: the app's QA library (web/qa/lib at $VAULTITE_APP, default ../vaultite) and
// installing a plugin of this repository into the throwaway server's vault.
import { execFileSync } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ENV } from "./testkit.ts" // (and its resolve hook: a plugin's own modules, imported after this, find the app's packages)

export const APP = path.resolve(process.env.VAULTITE_APP ?? path.join(import.meta.dirname, "..", "vaultite"))
const lib = await import(pathToFileURL(path.join(APP, "web/qa/lib/qa.mjs")).href)
export const { SHOTS, apiAt, command, fingers, freePort, palette, qa, terminalText, until, wait } = lib
export const { setAsideWorkspaces } = await import(pathToFileURL(path.join(APP, "web/qa/lib/wsfiles.mjs")).href)

/** The app's vau against the server at `base`. */
export const vauAt = (base) => (...a) => execFileSync(process.execPath, [path.join(APP, "bin", "vau"), "--url", base, ...a],
  { encoding: "utf8", env: { ...ENV, VAULTITE_URL: base } })

/** Plugin `id` from this repository, as it is now, in the server's vault and on (so allowed on this machine).
 *  `edits`: its folder's later changes run too (a file it writes there would make it wait to be allowed again). */
export function install(base, id, { edits = false } = {}) {
  const vau = vauAt(base)
  if (JSON.parse(vau("plugins", "--json")).some((p) => p.id === id)) vau("plugin", "uninstall", id)
  vau("plugin", "install", path.join(import.meta.dirname, id))
  vau("plugin", "on", id)
  if (edits) vau("plugin", "allow", id, "--edits")
}

/** The desktop app (Electron, from $VAULTITE_APP) on a throwaway vault, never seen (VAULTITE_QUIET), with plugins `ids`
 *  of this repository installed and on, then opened again: what it reads as a window opens (App windows) sees them. */
export async function desktop(ids) {
  const fs = await import("node:fs"), os = await import("node:os")
  const { _electron } = await import(pathToFileURL(path.join(APP, "node_modules/playwright-core/index.mjs")).href)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-plugins-desktop-")), vault = path.join(tmp, "vault"), userData = path.join(tmp, "userData")
  execFileSync(process.execPath, [path.join(APP, "bin", "vau"), "sandbox", vault], { stdio: "ignore", env: ENV })
  const env = { ...ENV, VAULTITE_QUIET: "1", VAULTITE_USER_DATA: userData, VAULTITE_LOCAL: path.join(tmp, "local") }
  const open = async () => {
    const app = await _electron.launch({ executablePath: path.join(APP, "node_modules/.bin/electron"), args: [APP, "--vault", vault], env })
    const win = await app.firstWindow()
    await win.waitForSelector("[role=tree]", { timeout: 90000 })
    return { app, win, base: `${new URL(win.url()).origin}/` }
  }
  let d = await open()
  for (const id of ids) install(d.base, id)
  await d.app.close()
  d = await open()
  const close = async () => { await d.app.close().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
  return { ...d, vault, userData, vau: vauAt(d.base), close }
}
