// Every plugin here, against the app at $VAULTITE_APP (default ../vaultite): the app's check as an installable vault
// plugin, then its own tests (<id>/.test/test.ts: hidden, so never installed).   node test.ts [id...]
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const HERE = import.meta.dirname
const APP = path.resolve(process.env.VAULTITE_APP ?? path.join(HERE, "..", "vaultite"))
const ids = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(HERE).filter((d) => fs.existsSync(path.join(HERE, d, "manifest.json"))).sort()
// (never the Vaultite this may run in: a Vaultite terminal names the user's vault and server)
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VAULTITE")))
const failed: string[] = []
const run = (what: string, args: string[]) => {
  const r = spawnSync(process.execPath, args, { cwd: HERE, stdio: "inherit", env: { ...ENV, VAULTITE_APP: APP } })
  if (r.status !== 0) failed.push(what)
}

for (const id of ids) {
  console.log(`\n== ${id}`)
  run(`${id} (check)`, [path.join(APP, "tools", "check_plugins.ts"), "--plugin", id, "--installable"])
  const test = path.join(id, ".test", "test.ts")
  if (fs.existsSync(path.join(HERE, test))) run(`${id} (test)`, [test])
}
console.log(failed.length ? `\nFailed: ${failed.join(", ")}` : `\nAll ${ids.length} plugins pass`)
process.exit(failed.length ? 1 : 0)
