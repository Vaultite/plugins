// What of obsidian.d.ts (api.json, from dts.mjs) the runtime hasn't: run against a lab with the probe plugin on
// (node ../lab.mjs plugins <lab> … puts it there with `probe`). Prints the missing names, by class.
//   node check.mjs <base url> [--all: deprecated and optional members too]
import fs from "node:fs"
import path from "node:path"
import { qa, until } from "../../../qa.mjs"

const { args: [B0, flag = ""], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "api.json"), "utf8"))
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
await page.goto(B)
await until(() => page.evaluate(() => !!window.__probe && window.app?.workspace?.layoutReady), 90000, 500)
const missing = await page.evaluate(([api, all]) => {
  const { obsidian: o, app, plugin } = window.__probe
  const div = () => document.createElement("div")
  const file = app.vault.getFiles().find((f) => f.extension === "md")
  const known = { App: app, Vault: app.vault, Workspace: app.workspace, MetadataCache: app.metadataCache, FileManager: app.fileManager, TFile: file,
    TFolder: app.vault.getRoot(), TAbstractFile: file, Keymap: app.keymap, Plugin: plugin, FileSystemAdapter: app.vault.adapter, CapacitorAdapter: app.vault.adapter,
    SecretStorage: app.secretStorage, WorkspaceLeaf: app.workspace.activeLeaf ?? app.workspace.getLeavesOfType?.("markdown")?.[0] }
  const make = (name, C) => {
    if (known[name]) return known[name]
    for (const args of name.endsWith("Component") || name === "Setting" || name === "SettingGroup" ? [[div()], [app, div()], []] : name.includes("Modal") || name.endsWith("Suggest") || name.endsWith("Tab") || name.endsWith("Page") ? [[app, plugin], [app, div()], [app]] : [[app], [div()], []]) {
      try { return new C(...args) } catch { /* next */ }
    }
    return null
  }
  const out = {}
  for (const v of api.values) if (!(v in o)) (out["(module)"] ??= []).push(v)
  for (const [name, c] of Object.entries(api.classes)) {
    const C = o[name]
    if (typeof C !== "function") { (out["(module)"] ??= []).push(`class ${name}`); continue }
    const inst = make(name, C)
    const gone = c.members.filter((m) => all || (!m.deprecated && !m.optional)).filter((m) => {
      if (m.name.startsWith("static ")) return !(m.name.slice(7) in C)
      if (m.name in C.prototype) return false
      return !(inst && m.name in inst)
    }).map((m) => m.name + (inst ? "" : "?"))
    if (gone.length) out[name] = gone
    document.querySelectorAll(".modal-container, .notice-container, .menu").forEach((e) => e.remove())
  }
  return out
}, [api, flag === "--all"])
let n = 0
for (const [k, v] of Object.entries(missing)) { n += v.length; console.log(`${k}: ${v.join(", ")}`) }
console.log(`\n${n} missing (? = checked on the prototype only: no instance)`)
await done()
