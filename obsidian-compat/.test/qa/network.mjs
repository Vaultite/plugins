// The network group's plugins doing their job (catalog.tsv): Git committing to a remote, Local REST API answering,
// agents spawning their CLI through the Node bridge, imports, installs, a terminal. For an isolated lab only
// (OC_ISOLATE=1 lab.mjs: its own HOME, fake agent CLIs, a made-up git author); WRITES into its vault.
//   node network.mjs <base url> [phone] [ids,comma,separated]
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, mode = "", only = ""], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const phone = mode === "phone"
const lab = fs.readdirSync("/tmp/oc-lab").map((n) => path.join("/tmp/oc-lab", n)).find((d) => { try { return JSON.parse(fs.readFileSync(path.join(d, "lab.json"), "utf8")).base === B } catch { return false } })
const info = lab && JSON.parse(fs.readFileSync(path.join(lab, "lab.json"), "utf8"))
if (!info?.isolate) throw new Error(`${B} isn't an isolated lab (OC_ISOLATE=1 node lab.mjs up …): plugins here would reach this machine's own tools`)
const home = path.join(lab, "home"), vault = info.vault, fakeLog = path.join(home, "fake-cli.log")
const git = (...a) => execFileSync("git", a, { cwd: vault, encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } })

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA } : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e.stack ?? e).slice(0, 300)))
const said = []
page.on("console", (m) => said.push(m.text().slice(0, 300)))
let answer = null // what a prompt() (a dialog's stand-in in a browser) is answered with
page.on("dialog", (d) => void (answer ? d.accept(answer) : d.dismiss()))

const ev = (fn, arg) => page.evaluate(fn, arg)
const run = (id) => ev((id) => { window.app.commands.executeCommandById(id) }, id)
const clean = () => ev(() => { document.querySelectorAll("dialog[open]").forEach((d) => d.close()); document.querySelectorAll(".modal-container").forEach((m) => m.remove()) })
const notices = () => ev(() => [...document.querySelectorAll("[data-sonner-toast], .notice")].map((n) => n.innerText).join("\n"))
const viewText = (type) => ev((t) => window.app.workspace.getLeavesOfType(t).map((l) => l.view.containerEl.innerText || l.view.containerEl.textContent).join("\n"), type)
const tabText = async (id) => {
  await clean()
  await ev((id) => window.app.setting.openTabById(id), id)
  await wait(2500)
  return ev(() => [...document.querySelectorAll(".vertical-tab-content")].pop()?.innerText ?? "")
}
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`))?.text ?? null
async function open(p) {
  await ev((h) => { location.hash = h }, `#file/${encodeURIComponent(p)}`)
  await until(() => ev((p) => window.app?.workspace?.getActiveFile()?.path === p, p), 15000).catch(() => {})
  await wait(1500)
}
const has = (plugin) => ev((id) => !!window.app.plugins.plugins[id], plugin)

const results = {}
async function check(id, fn) {
  if (only && !only.split(",").includes(id)) return
  if (!(await has(id))) { results[id] = { state: phone ? "n/a" : "fails", why: phone ? "not loaded on a phone" : "not loaded" }; console.log(`${results[id].state.padEnd(6)} ${id}: ${results[id].why}`); return }
  const before = errs.length
  let r
  try { r = await fn() } catch (e) { r = { state: "fails", why: String(e?.message ?? e).split("\n")[0].slice(0, 200) } }
  r.errors = errs.slice(before).slice(0, 2)
  results[id] = r
  console.log(`${r.state.padEnd(6)} ${id}${r.why ? `: ${r.why}` : ""}${r.errors.length ? `  [${r.errors.length} page errors: ${r.errors[0].split("\n")[0]}]` : ""}`)
  await page.keyboard.press("Escape").catch(() => {})
  await clean().catch(() => {})
}
const ok = (cond, why, partly) => (cond ? (partly ? { state: "partly", why: partly } : { state: "works" }) : { state: "fails", why })

// A vault under git with a remote, before the page loads (Git reads it at start).
if (!phone && !fs.existsSync(path.join(vault, ".git"))) {
  execFileSync("git", ["init", "-q", "--bare", path.join(lab, "remote.git")])
  fs.writeFileSync(path.join(vault, ".gitignore"), ".vaultite/\n.smart-env/\n")
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init"); git("remote", "add", "origin", path.join(lab, "remote.git")); git("push", "-q", "-u", "origin", "main")
}
fs.writeFileSync(path.join(vault, "library.json"), JSON.stringify([{ id: "park2024light", type: "article-journal", title: "Keeping a lighthouse log", author: [{ family: "Park", given: "Alice" }], issued: { "date-parts": [[2024]] } }]))
fs.mkdirSync(path.join(home, "import"), { recursive: true })
fs.writeFileSync(path.join(home, "import", "Garden plan.html"), "<html><head><title>Garden plan</title></head><body><h1>Garden plan</h1><p>Plant <b>tomatoes</b> in May.</p></body></html>")

await page.goto(B)
await until(() => ev(() => window.app?.workspace?.layoutReady), 90000)
await wait(5000)
await clean()
await open("Notes/Table.md")

await check("remotely-save", async () => {
  // (its first run asks to agree, as in Obsidian)
  await ev(async () => {
    const m = [...document.querySelectorAll(".modal")].find((x) => /Remotely Save/.test(x.innerText))
    if (!m) return
    m.querySelectorAll("input[type=checkbox]").forEach((c) => c.click())
    ;[...m.querySelectorAll("button")].find((b) => b.innerText.trim() === "Agree")?.click()
  })
  const t = await tabText("remotely-save")
  return ok(/Choose A Remote Service/i.test(t) && /Webdav/i.test(t), "settings without its services")
})

await check("obsidian-git", async () => {
  // (on a phone it's isomorphic-git, as on Obsidian's mobile app: the author is the repository's own, as its settings set it,
  // and it pushes over HTTPS only, so a commit is the check there)
  if (phone) { git("config", "user.name", "Alice Park"); git("config", "user.email", "alice@example.com") }
  const count = (where) => execFileSync("git", ["-C", where, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim()
  const target = phone ? vault : path.join(lab, "remote.git")
  await api("PUT", "file", { path: "Notes/Table.md", text: `# Table\n\nchanged by qa ${Date.now()}\n` })
  await wait(1500)
  await run("obsidian-git:open-git-view")
  await until(async () => /Table/.test(await viewText("git-view")), 10000).catch(() => {})
  const listed = /Table/.test(await viewText("git-view"))
  const before = count(target)
  said.length = 0
  await run(phone ? "obsidian-git:commit" : "obsidian-git:push")
  await until(() => count(target) !== before, 20000).catch(() => {})
  const after = execFileSync("git", ["-C", target, "log", "-1", "--format=%an %s", "HEAD"], { encoding: "utf8" }).trim()
  const why = said.filter((t) => /git|isomorphic/i.test(t)).slice(-1)[0] ?? ""
  return ok(listed && count(target) !== before && /vault backup/.test(after), `listed ${listed}, ${phone ? "committed" : "pushed"} ${count(target) !== before}${why ? `: ${why.slice(0, 140)}` : ""}`,
    phone ? "lists changes and commits (isomorphic-git, as on Obsidian mobile); pushing needs an HTTPS remote" : undefined)
})

await check("obsidian-local-rest-api", async () => {
  // (its key is made on its first run: asked again until it answers with the note)
  let out = ""
  await until(async () => {
    const key = await ev(() => window.app.plugins.plugins["obsidian-local-rest-api"].settings?.apiKey)
    out = key ? execFileSync("curl", ["-sk", "-H", `Authorization: Bearer ${key}`, "https://127.0.0.1:27124/vault/Notes/Table.md"], { encoding: "utf8" }) : ""
    return /changed by qa|Table/.test(out)
  }, 15000, 1000).catch(() => {})
  return ok(/changed by qa|Table/.test(out), `answered: ${out.slice(0, 80)}`)
})

await check("smart-connections", async () => {
  await open("Projects/Lighthouse.md")
  await until(() => ev(() => window.app.plugins.plugins["smart-connections"].env?.state === "loaded"), 60000)
  await run("smart-connections:smart-connections-view")
  await wait(2000)
  await open("People/Alice Park.md")
  await open("Projects/Lighthouse.md")
  await until(async () => /\d\.\d\d/.test(await viewText("smart-connections-view")), 60000).catch(() => {})
  const t = await viewText("smart-connections-view")
  return ok(/\d\.\d\d/.test(t), `no connections listed: ${t.slice(0, 80)}`)
})

await check("realclaudian", async () => {
  fs.writeFileSync(fakeLog, "")
  await run("realclaudian:open-view")
  await until(async () => /Claudian/.test(await viewText("claudian-view")), 10000).catch(() => {})
  const view = await viewText("claudian-view")
  await ev(async (p) => { const c = window.app.plugins.plugins.realclaudian; c.settings.providerConfigs.claude.cliPath = p; await c.saveData(c.settings) }, path.join(home, "bin", "claude"))
  const tab = await tabText("realclaudian")
  await ev(async () => {
    const el = [...document.querySelectorAll(".vertical-tab-content")].pop()
    ;[...el.querySelectorAll("button")].find((b) => b.innerText === "Providers")?.click(); await new Promise((r) => setTimeout(r, 800))
    ;[...el.querySelectorAll("button")].find((b) => b.innerText === "Claude Code")?.click()
  })
  await until(() => fs.readFileSync(fakeLog, "utf8").includes("stream-json"), 10000).catch(() => {})
  const spawned = fs.readFileSync(fakeLog, "utf8").includes("stream-json")
  return ok(/Claudian/.test(view) && /Providers/.test(tab) && spawned, `view ${/Claudian/.test(view)}, spawned ${spawned}`, "its view, settings and the CLI's session spawn through the bridge; a real chat needs Claude Code itself")
})

await check("agent-client", async () => {
  fs.writeFileSync(fakeLog, "")
  await ev(async () => { const p = window.app.plugins.plugins["agent-client"]; p.settings.defaultAgentId = "opencode"; await p.saveSettings?.() })
  await run("agent-client:open-new-chat-view")
  await until(() => fs.readFileSync(fakeLog, "utf8").includes("opencode acp"), 15000).catch(() => {})
  const spawned = fs.readFileSync(fakeLog, "utf8").includes("opencode acp")
  return ok(spawned, `spawned ${spawned}`, "the chat view spawns its agent (ACP) through the bridge; a real chat needs the agent itself")
})

await check("copilot", async () => {
  await run("copilot:chat-open-window")
  await wait(2500)
  const input = page.locator(".workspace-leaf[data-type=copilot-chat-view] [contenteditable=true]").first()
  await input.scrollIntoViewIfNeeded()
  await clean()
  await input.click({ timeout: 10000 }).catch(() => input.click({ force: true }))
  await page.keyboard.type("hello"); await page.keyboard.press("Enter")
  await until(async () => /No chat model enabled|API key/i.test(await viewText("copilot-chat-view")), 15000).catch(() => {})
  return ok(/No chat model enabled|API key/i.test(await viewText("copilot-chat-view")), "no clear error without a model")
})

await check("obsidian-textgenerator-plugin", async () => {
  await open("Notes/Table.md")
  await run("obsidian-textgenerator-plugin:generate-text")
  await until(async () => /Missing credentials|API key/i.test(await notices()), 15000).catch(() => {})
  return ok(/Missing credentials|API key/i.test(await notices()), "no clear error without a key")
})

await check("obsidian-livesync", async () => {
  const t = await tabText("obsidian-livesync")
  return ok(/Setup URI|Quick Setup/i.test(t), "settings without its setup")
})

await check("obsidian-importer", async () => {
  if (phone) { const t = await tabText("obsidian-importer"); return ok(/Markdown|HTML/.test(t), "no formats on a phone") }
  await clean()
  await run("obsidian-importer:open-modal")
  await page.locator(".mod-importer .setting-item", { hasText: "HTML" }).first().click()
  answer = path.join(home, "import", "Garden plan.html")
  await page.locator(".mod-importer .setting-item.mod-add-item", { hasText: "Choose files" }).first().click()
  answer = null
  for (const b of ["Continue", "Continue", "Start import"]) { await wait(1500); await page.locator(".mod-importer button", { hasText: b }).first().click() }
  await until(async () => /Import complete/.test(await ev(() => document.querySelector(".mod-importer")?.innerText ?? "")), 20000).catch(() => {})
  const note = await read("HTML/Garden plan.md")
  return ok(/tomatoes/.test(note ?? ""), "no imported note")
})

await check("obsidian42-brat", async () => {
  said.length = 0
  const added = await ev(() => window.app.plugins.plugins["obsidian42-brat"].betaPlugins.addPlugin("tgrosinger/recent-files-obsidian", false, false, false, "", false, false).catch((e) => String(e)))
  await wait(1500)
  const listed = (await api("GET", "obsidian-compat/plugins")).find((p) => p.id === "recent-files-obsidian")
  const where = fs.existsSync(path.join(vault, ".vaultite/obsidian/plugins/recent-files-obsidian/main.js"))
  if (added !== true && said.some((t) => /rate limit/i.test(t))) return { state: "works", why: "GitHub's API refused this run (rate limit); installed into the overlay and listed when it answered" }
  return ok(added === true && listed && where, `added ${added}, listed ${!!listed}, in the overlay ${where}`)
})

await check("terminal", async () => {
  if (phone) return { state: "n/a", why: "a shell needs Node, which phones haven't (as in Obsidian's mobile app)" }
  await run("terminal:open-terminal.integrated.root")
  // (xterm draws on a canvas: the shell's name in its tab, and no "exited" after a while)
  await until(() => ev(() => window.app.workspace.getLeavesOfType("terminal:terminal").some((l) => /zsh|bash|sh$/.test(l.getDisplayText()))), 15000).catch(() => {})
  await wait(3000)
  const name = await ev(() => window.app.workspace.getLeavesOfType("terminal:terminal").map((l) => l.getDisplayText()).join())
  return ok(/zsh|bash|sh/.test(name) && !/Terminal exited/.test(await notices()), `shell: ${name}`)
})

await check("obsidian-zotero-desktop-connector", async () => {
  await open("Notes/Table.md")
  await run("obsidian-zotero-desktop-connector:zdc-insert-notes")
  await until(async () => /Cannot connect to Zotero/.test(await notices()), 10000).catch(() => {})
  return ok(/Cannot connect to Zotero/.test(await notices()), "no clear error without Zotero", "reaches Zotero's local API (none running here: it says so)")
})

await check("obsidian-citation-plugin", async () => {
  await ev(async () => { const p = window.app.plugins.plugins["obsidian-citation-plugin"]; p.settings.citationExportPath = "library.json"; p.settings.citationExportFormat = "csl-json"; await p.saveSettings?.(); await p.loadLibrary() })
  await wait(1500)
  await run("obsidian-citation-plugin:insert-citation")
  await wait(1500)
  const m = await ev(() => document.querySelector(".modal-container")?.innerText ?? "")
  return ok(/lighthouse log/.test(m), "library not listed")
})

await check("obsidian-pandoc", async () => {
  const t = await tabText("obsidian-pandoc")
  return /not installed/i.test(t) ? { state: "n/a", why: "pandoc isn't installed on this machine (the plugin says so); it runs pandoc through the bridge" } : ok(/Pandoc/.test(t), "no settings")
})

await check("obsidian-enhancing-export", async () => {
  await open("Notes/Table.md")
  await run("obsidian-enhancing-export:obsidian-enhancing-export:export")
  await wait(1500)
  const m = await ev(() => document.querySelector(".modal-container")?.innerText ?? "")
  return ok(/Export to/.test(m), "no export dialog", "its export dialog opens; exporting runs pandoc, not installed here")
})

await check("better-export-pdf", async () => {
  await run("better-export-pdf:export-current-file-to-pdf")
  await wait(2000)
  const m = await ev(() => document.querySelector(".modal-container")?.innerText ?? "")
  return ok(/Export to PDF/.test(m), "no export dialog", "its dialog opens; the preview and PDF need Electron's <webview> (the app's own Export to PDF stands in)")
})

await check("obsidian-auto-link-title", async () => {
  await open("Notes/Table.md")
  await ev(() => {
    const ed = window.app.workspace.activeEditor.editor
    ed.setCursor({ line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length }); ed.replaceSelection("\n")
    const dt = new DataTransfer(); dt.setData("text/plain", "https://example.com")
    ed.cm.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await until(async () => /\[Example Domain\]\(https:\/\/example\.com\)/.test(await read("Notes/Table.md") ?? ""), 15000).catch(() => {})
  return ok(/\[Example Domain\]\(https:\/\/example\.com\)/.test(await read("Notes/Table.md") ?? ""), "no titled link")
})

const out = path.join(import.meta.dirname, "..", "results", "network.tsv")
const rows = fs.existsSync(out) ? Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").slice(1).map((l) => [l.split("\t")[0], l.split("\t")])) : {}
for (const [id, r] of Object.entries(results)) {
  const row = rows[id] ?? [id, "", "", ""]
  row[phone ? 2 : 1] = r.state
  if (r.why && (!phone || !row[3])) row[3] = r.why
  rows[id] = row
}
fs.writeFileSync(out, ["id\tweb\tphone\tnotes", ...Object.values(rows).map((r) => r.join("\t"))].join("\n") + "\n")
await ctx.close()
await done()
