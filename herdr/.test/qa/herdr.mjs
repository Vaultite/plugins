// herdr as the terminal's backend in a browser, on a herdr session of its own that this script starts (`herdr --session
// vaultite-qa server`, stopped at the end; skipped when herdr isn't installed): its panel lists the session's panes,
// clicking one opens it in a tab that types into it, closing that tab leaves the pane running in herdr, and with "Start
// new terminals in herdr" a new terminal is a pane in herdr's Vaultite workspace. Installs the plugin, writes its
// settings and runs shells: throwaway server only.
//   node herdr/.test/qa/herdr.mjs <base url> <vault path> [out dir]
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { install, qa, until, vauAt, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = "/tmp/herdr-shots/"], browser, check, watch, noErrors, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const api = (p, o) => fetch(new URL(`/api/${p}`, B), o).then((r) => r.json())
const id = `qa${Date.now().toString(36)}`

const page = watch(await browser.newPage({ viewport: { width: 1440, height: 900 } }))

const HERDR = ["/opt/homebrew/bin/herdr", "/usr/local/bin/herdr", path.join(os.homedir(), ".local/bin/herdr")].find(existsSync)
const SESSION = "vaultite-qa"
const SOCK = path.join(os.homedir(), ".config/herdr/sessions", SESSION, "herdr.sock")
const herdrCall = (method, params = {}) => new Promise((ok, fail) => {
  const c = net.connect(SOCK, () => c.write(JSON.stringify({ id: "qa", method, params }) + "\n"))
  let buf = ""
  c.setEncoding("utf8")
  c.on("data", (d) => { buf += d; if (buf.includes("\n")) { c.end(); const m = JSON.parse(buf.split("\n")[0]); m.error ? fail(new Error(m.error.message)) : ok(m.result) } })
  c.on("error", fail)
})
const settings = path.join(VAULT, ".vaultite/plugins/herdr/data.json")
// The plugin on, its panel shown after Terminals (in the window's workspace and in sidebars.json), whatever the vault
// turned off or hid (the sandbox starts calm).
const vau = vauAt(B)
async function showPanel() {
  install(B, "herdr")
  for (const where of [[], ["--vault"]]) {
    const now = vau("panels", ...where)
    if (!/\d+\. terminal:sessions/.test(now)) vau("panels", "show", "terminals", ...where)
    if (!/\d+\. herdr:agents/.test(now)) vau("panels", "show", "herdr", ...where)
  }
}
const setHerdr = (s) => { mkdirSync(path.dirname(settings), { recursive: true }); writeFileSync(settings, JSON.stringify(s, null, 2) + "\n") }

let server = null
try {
  await page.goto(B); await wait(2000)

  if (!HERDR) { console.log("skip herdr: not installed") } else {
    // --- herdr: a session of its own, one pane in it running a shell
    server = spawn(HERDR, ["--session", SESSION, "server"], { stdio: "ignore", detached: true })
    await until(() => existsSync(SOCK), 8000); await wait(500)
    const made = await herdrCall("workspace.create", { cwd: VAULT, label: "QA", focus: false })
    const term = made.root_pane.terminal_id
    setHerdr({ session: SESSION })
    await showPanel()
    const row = await until(() => page.$(`[data-herdr-pane="${made.root_pane.pane_id}"]`), 10000)
    check("herdr: the panel lists the session's pane", !!row)
    await page.screenshot({ path: `${OUT}panel.png` })
    await row?.click(); await wait(2000)
    await page.keyboard.type("echo typed-in-herdr-$((40+2))\n")
    const seen = await until(async () => (await herdrCall("pane.read", { pane_id: made.root_pane.pane_id, source: "recent", lines: 20, format: "text", strip_ansi: true }))
      .read?.text?.includes("typed-in-herdr-42"), 8000)
    check("herdr: the pane opens in a tab that types into it", !!seen)
    await page.screenshot({ path: `${OUT}pane.png` })
    // Closing its tab leaves it running in herdr.
    for (const t of await page.$$("[data-tab-id]")) {
      if (!/Terminal|zsh/.test(await t.textContent())) continue
      await t.click({ button: "right" }); await page.getByRole("menuitem", { name: "Close", exact: true }).click(); break
    }
    await wait(1500)
    const still = (await herdrCall("pane.list", {})).panes.some((p) => p.terminal_id === term)
    check("herdr: closing its tab leaves the pane running in herdr", still)

    // New terminals in herdr: a pane in its Vaultite workspace, labelled with the terminal's id.
    setHerdr({ session: SESSION, newTerminals: true }); await wait(1200)
    const fresh = `${id}h`
    await api(`terminals/${fresh}`, { method: "POST" })
    const there = await until(async () => (await herdrCall("pane.list", {})).panes.find((p) => p.label === fresh), 8000)
    check("herdr: with newTerminals, a new terminal is a pane in herdr's Vaultite workspace", !!there, there)
    await api(`terminals/${fresh}`, { method: "DELETE" })
    const gone = await until(async () => !(await herdrCall("pane.list", {})).panes.some((p) => p.label === fresh), 8000)
    check("herdr: ending it closes the pane", !!gone)
  }
  noErrors()
} finally {
  if (HERDR) {
    try { execFileSync(HERDR, ["--session", SESSION, "server", "stop"], { stdio: "ignore", timeout: 5000 }) } catch { server?.kill() }
    rmSync(settings, { force: true })
  }
  await browser.close()
}
await done()
