// How Obsidian plugins' UI looks here: screenshots of rendered Markdown, settings tabs, modals, menus and views, in
// light and dark, at a desktop's and a phone's size. Opens notes and dialogs only. Throwaway server (lab.mjs).
//   node look.mjs <base url> <out folder> [light|dark] [phone] [only,names]
import fs from "node:fs"
import { qa, until, wait } from "../../../qa.mjs"

const { args: [B0, OUT, scheme = "light", size = "", only = ""], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const phone = size === "phone"
fs.mkdirSync(OUT, { recursive: true })
const ctx = await browser.newContext({ colorScheme: scheme, ...(phone
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }
  : { viewport: { width: 1400, height: 900 } }) })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)))
await page.goto(B)
await until(() => page.evaluate(() => window.app?.workspace?.layoutReady), 60000)
await wait(3000)
const tag = `${scheme}${phone ? "-phone" : ""}`
const shot = (n) => page.screenshot({ path: `${OUT}/${tag}-${n}.png`, timeout: 8000 }).catch(() => {})
const clear = async () => { await page.keyboard.press("Escape").catch(() => {}); await page.evaluate(() => document.querySelectorAll(".modal-container, .menu, .suggestion-container, .popover").forEach((e) => e.remove())); await wait(300) }
const open = async (path) => { await page.evaluate((h) => { location.hash = h }, `#file/${encodeURIComponent(path)}`); await wait(2500) }
const run = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id)
/** A view's element, wherever the app shows it, in a box of a sidebar's size for the screenshot. */
const float = (type) => page.evaluate((type) => {
  const leaf = window.app.workspace.getLeavesOfType(type)[0]
  if (!leaf) return
  const box = document.createElement("div")
  box.id = "oc-rendered"
  box.className = "obsidian-compat-side"
  Object.assign(box.style, { position: "fixed", left: "250px", top: "60px", width: "300px", maxHeight: "700px", overflow: "auto", zIndex: 50, background: "var(--background)", border: "0.5px solid var(--border)", borderRadius: "10px", padding: "6px" })
  document.body.append(box)
  box.append(leaf.view.containerEl)
  if (!leaf.view.containerEl.textContent?.trim()) void leaf.view.onOpen?.()
}, type).then(() => wait(800))
const steps = {
  queries: async () => { await open("Dashboards/Queries.md"); await page.mouse.wheel(0, 300); await wait(1500) },
  callouts: async () => { await open("Notes/Callouts.md") },
  rendered: async () => {
    await page.evaluate(async () => {
      const box = document.createElement("div")
      box.id = "oc-rendered"
      Object.assign(box.style, { position: "fixed", right: "20px", top: "60px", width: "520px", maxHeight: "760px", overflow: "auto", zIndex: 50, padding: "12px", background: "var(--background-primary)", border: "1px solid var(--background-modifier-border)", borderRadius: "8px" })
      document.body.append(box)
      const md = "# Heading\n\nA [[Lighthouse]] link, a [[Nowhere]] one, #tag, ==mark==, `code` and [web](https://example.com).\n\n- [ ] open task\n- [x] done task\n- [/] half task\n\n> [!tip] Callout\n> Inside, a [[Alice Park]] link.\n\n| a | b |\n|--|--|\n| 1 | 2 |\n\n```dataview\nLIST FROM #project\n```\n\n```js\nconst x = 1\n```\n\n![[Alice Park]]\n"
      await window.__obsidianCompat?.renderMarkdown(md, box, "Notes/Rendered.md")
    })
    await wait(2000)
  },
  "settings-linter": async () => { await page.evaluate(() => window.app.setting.openTabById("obsidian-linter")); await wait(1500) },
  "settings-templater": async () => { await page.evaluate(() => window.app.setting.openTabById("templater-obsidian")); await wait(1500) },
  "settings-style": async () => { await page.evaluate(() => window.app.setting.openTabById("obsidian-style-settings")); await wait(1500) },
  quickadd: async () => { await run("quickadd:runQuickAdd"); await wait(1200) },
  omnisearch: async () => { await run("omnisearch:show-modal"); await wait(800); await page.keyboard.type("light"); await wait(1500) },
  notice: async () => { await page.evaluate(() => { const N = window.__obsidianCompat?.Notice; if (N) new N("A notice from a plugin", 8000) }); await wait(600) },
  menu: async () => {
    await page.evaluate(() => {
      const M = window.__obsidianCompat?.Menu
      if (!M) return
      const m = new M()
      m.addItem((i) => i.setTitle("Open").setIcon("file"))
      m.addItem((i) => i.setTitle("Rename").setIcon("pencil"))
      m.addSeparator()
      m.addItem((i) => i.setTitle("Delete").setIcon("trash").setWarning(true))
      m.showAtPosition({ x: 500, y: 300 })
    })
    await wait(800)
  },
  modal: async () => {
    await page.evaluate(() => {
      const { Modal, Setting } = window.__obsidianCompat ?? {}
      if (!Modal) return
      const m = new Modal(window.app)
      m.setTitle("A plugin's modal")
      m.contentEl.createEl("p", { text: "Some text in a modal, with controls below." })
      new Setting(m.contentEl).setName("Name").setDesc("What it's called").addText((t) => t.setPlaceholder("Lighthouse"))
      new Setting(m.contentEl).setName("On").addToggle((t) => t.setValue(true))
      new Setting(m.contentEl).setName("Kind").addDropdown((d) => d.addOptions({ a: "First", b: "Second" }))
      new Setting(m.contentEl).setName("Level").addSlider((s) => s.setLimits(0, 10, 1).setValue(4))
      new Setting(m.contentEl).addButton((b) => b.setButtonText("Cancel")).addButton((b) => b.setButtonText("Save").setCta())
      m.open()
    })
    await wait(800)
  },
  admonition: async () => { await open("Notes/Callouts.md"); await page.mouse.wheel(0, 200); await wait(1000) },
  calendar: async () => { await run("calendar:show-calendar-view"); await wait(1500); await float("calendar") },
  recent: async () => { await run("recent-files-obsidian:recent-files-open"); await open("Notes/Table.md"); await open("Notes/Outline.md"); await float("recent-files") },
  tasks: async () => { await open("Dashboards/Queries.md"); await page.mouse.wheel(0, 500); await wait(1500) },
}
for (const [name, fn] of Object.entries(steps)) {
  if (only && !only.split(",").includes(name)) continue
  try { await fn(); await shot(name) } catch (e) { console.log(`${name}: ${String(e).slice(0, 200)}`) }
  await clear()
  await page.evaluate(() => document.getElementById("oc-rendered")?.remove())
}
console.log(`errors: ${errs.length}`, errs.slice(0, 10))
await ctx.close()
await done()
