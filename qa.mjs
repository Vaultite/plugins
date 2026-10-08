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
 *  `edits`: its folder's later changes run too (Vim's init.vim is in it, and would make it wait to be allowed again). */
export function install(base, id, { edits = false } = {}) {
  const vau = vauAt(base)
  if (JSON.parse(vau("plugins", "--json")).some((p) => p.id === id)) vau("plugin", "uninstall", id)
  vau("plugin", "install", path.join(import.meta.dirname, id))
  vau("plugin", "on", id)
  if (edits) vau("plugin", "allow", id, "--edits")
}
