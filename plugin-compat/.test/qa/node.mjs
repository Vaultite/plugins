// Node for Obsidian plugins on a computer, end to end: the bridge's modules from a page (files, the config overlay,
// processes, crypto, zlib, http both ways), then Git committing, Local REST API answering, Claudian's view.
// WRITES the lab's vault and makes it a git repository: throwaway server only (lab.mjs, with GIT_CONFIG_GLOBAL set).
//   node node.mjs <base url> <vault path>
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, VAULT], browser, check, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const git = (...a) => execFileSync("git", ["-C", VAULT, ...a], { encoding: "utf8" }).trim()
if (!fs.existsSync(path.join(VAULT, ".git"))) { git("init", "-q"); git("add", "-A"); git("commit", "-qm", "start") }

const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e)))
await page.goto(B)
await until(() => page.evaluate(() => ["obsidian-git", "realclaudian", "obsidian-local-rest-api"].every((id) => window.app?.plugins?.plugins?.[id]?._loaded)), 180000, 1000)
await wait(3000)

const r = await page.evaluate(async () => {
  const out = {}
  const req = window.require
  const fs = req("fs"), cp = req("child_process"), crypto = req("crypto"), zlib = req("zlib"), os = req("os"), http = req("http"), util = req("util"), path = req("path")
  const base = app.vault.adapter.getBasePath()
  out.adapter = app.vault.adapter instanceof req("obsidian").FileSystemAdapter && app.vault.adapter.getBasePath() === base
  out.read = fs.readFileSync(path.join(base, "Notes/Table.md"), "utf8").split("\n")[0]
  fs.mkdirSync(path.join(base, ".obsidian/plugins/qa-node"), { recursive: true })
  fs.writeFileSync(path.join(base, ".obsidian/plugins/qa-node/state.json"), "{\"a\":1}")
  out.overlayRead = fs.readFileSync(path.join(base, ".obsidian/plugins/qa-node/state.json"), "utf8")
  out.listed = fs.readdirSync(path.join(base, ".obsidian/plugins")).includes("qa-node") && fs.readdirSync(path.join(base, ".obsidian/plugins")).includes("obsidian-git")
  out.stat = fs.statSync(path.join(base, "Notes")).isDirectory()
  out.promises = (await fs.promises.readFile(path.join(base, "Notes/Table.md"), "utf8")).length > 10
  out.cb = await new Promise((ok) => fs.readFile(path.join(base, "nope.md"), (e) => ok(e?.code)))
  out.execSync = cp.execSync("echo hi").toString().trim()
  out.exec = (await util.promisify(cp.exec)("printf '%s' $PWD")).stdout
  out.spawn = await new Promise((ok) => { const p = cp.spawn("cat"); let s = ""; p.stdout.on("data", (c) => { s += c }); p.on("close", (code) => ok(`${s}:${code}`)); p.stdin.write("piped"); p.stdin.end() })
  out.hash = crypto.createHash("sha256").update("abc").digest("hex").slice(0, 12)
  out.zlib = zlib.gunzipSync(zlib.gzipSync(Buffer.from("round trip"))).toString()
  out.os = [os.platform(), typeof os.homedir()]
  const proc = req("process")
  out.process = [proc.platform, proc.cwd() === base, typeof proc.env.PATH]
  out.server = await new Promise((ok) => {
    const s = http.createServer((q, res) => { res.setHeader("Content-Type", "text/plain"); res.end(`hello ${q.method} ${q.url}`) })
    s.listen(0, "127.0.0.1", () => {
      http.get(`http://127.0.0.1:${s.address().port}/x`, (res) => { let b = ""; res.on("data", (c) => { b += c }); res.on("end", () => { s.close(); ok(`${res.statusCode} ${b}`) }) })
    })
  })
  return out
})
check("adapter is FileSystemAdapter", r.adapter === true, r.adapter)
check("fs reads a note", r.read === "# Table", r.read)
check("a write in .obsidian/ lands in ours, read back", r.overlayRead === "{\"a\":1}" && fs.existsSync(path.join(VAULT, ".vaultite/obsidian/plugins/qa-node/state.json")) && !fs.existsSync(path.join(VAULT, ".obsidian/plugins/qa-node")))
check("readdir merges ours and Obsidian's", r.listed)
check("stat, promises, callbacks", r.stat && r.promises && r.cb === "ENOENT", r)
check("execSync", r.execSync === "hi", r.execSync)
check("exec runs in the vault", r.exec === VAULT || fs.realpathSync(r.exec) === fs.realpathSync(VAULT), r.exec)
check("spawn streams both ways", r.spawn === "piped:0", r.spawn)
check("crypto", r.hash === "ba7816bf8f01", r.hash)
check("zlib", r.zlib === "round trip", r.zlib)
check("os and process are the server's", r.os[0] === process.platform && r.process[0] === process.platform && r.process[1], [r.os, r.process])
check("http server and client", r.server === "200 hello GET /x", r.server)

// Git: commit through its command
fs.writeFileSync(path.join(VAULT, "Notes/Git test.md"), "# Git test\n")
await until(async () => (await api("GET", "plugin-compat/report").catch(() => ({}))) && true, 2000)
await page.evaluate(() => app.commands.executeCommandById("obsidian-git:commit"))
const committed = await until(() => git("log", "-1", "--format=%an|%s").includes("|") && !git("status", "--porcelain").includes("Git test") ? git("log", "-1", "--format=%an|%s") : null, 30000, 1000).catch(() => null)
check("Git commits the vault's changes", !!committed && !committed.endsWith("|start"), committed ?? git("status", "--porcelain"))

// Local REST API: its https server, on the server's machine
const rest = await until(() => { try { return execFileSync("curl", ["-sk", "-m", "3", "https://127.0.0.1:27124/"], { encoding: "utf8" }) } catch { return null } }, 30000, 1000).catch(() => null)
check("Local REST API answers on 27124", !!rest && /status|authenticated|OK/i.test(rest), rest)

// Claudian: its view opens
const claudian = await page.evaluate(async () => { await app.workspace.getRightLeaf(false)?.setViewState({ type: "claudian-view", active: true }); await new Promise((r) => setTimeout(r, 1500)); return document.querySelectorAll("[data-type='claudian-view'], .claudian-container, .claudian").length })
check("Claudian's view draws", claudian > 0, claudian)
check("no page errors", !errs.length, errs.slice(0, 5))
console.log(JSON.stringify((await api("GET", "plugin-compat/report")).node, null, 1).slice(0, 1500))
await done()
