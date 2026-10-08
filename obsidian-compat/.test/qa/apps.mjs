// The catalog's "apps" group doing their job: boards, drawings and their embeds, mind maps, ExcaliBrain, make.md, image
// conversion on paste, custom frames, Thino and Annotator's views. WRITES notes: lab only (lab.mjs up … with the group).
//   node apps.mjs <base url> [phone]
import fs from "node:fs"
import { qa } from "../../../qa.mjs"
const { args: [B0, mode = ""], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`, phone = mode === "phone", S = `/tmp/oc-lab/shots/apps-${phone ? "phone-" : ""}`
fs.mkdirSync("/tmp/oc-lab/shots", { recursive: true })
const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const wait = (ms) => page.waitForTimeout(ms)
const api = (m, r, b) => page.evaluate(async ([m, r, b]) => (await fetch(`/api/${r}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json(), [m, r, b])
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`)).text ?? ""
const note = (path, text) => api("POST", "file", { path, text })
const open = async (p) => { await page.evaluate((p) => { location.hash = `#file/${encodeURIComponent(p)}` }, p); await wait(3000); await closeModals() }
// (a phone opens a note to read: typing needs it editing)
const editing = async () => { if (phone && await page.evaluate(() => document.querySelector("[data-view-toggle]")?.getAttribute("data-view-toggle") === "read")) { await page.evaluate(() => document.querySelector("[data-view-toggle]")?.click()); await wait(800) } }
const closeModals = async () => { for (const m of await page.$$(".modal .modal-close-button")) await m.click().catch(() => {}) }
const on = (id, v) => api("POST", "obsidian-compat/enable", { id, on: v })
const reload = async () => { await page.reload(); await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 90000 }); await wait(3000); await closeModals() }
const results = []
const check = async (id, fn) => {
  let r
  try { r = await fn() } catch (e) { r = { ok: false, why: String(e).split("\n")[0].slice(0, 200) } }
  results.push({ id, ...r })
  console.log(`${r.ok ? "ok  " : "FAIL"} ${id}${r.why ? ` (${r.why})` : ""}`)
  await page.screenshot({ path: `${S}${id}.png` }).catch(() => {})
  await closeModals()
}
await page.goto(B)
await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 90000 })
await on("obsidian-enhancing-mindmap", false); await on("media-extended", false); await on("obsidian-markmind", true)
await reload()
const desktop = !phone

await check("obsidian-kanban", async () => {
  await open("Boards/Roadmap.md")
  const lanes = await page.locator(".kanban-plugin__lane").count()
  await page.locator(".kanban-plugin__lane").first().locator("button.kanban-plugin__new-item-button").click()
  await wait(500); await page.keyboard.type("Card from QA"); await page.keyboard.press("Enter"); await wait(3500)
  const saved = (await read("Boards/Roadmap.md")).includes("- [ ] Card from QA")
  return { ok: lanes >= 3 && saved, why: `${lanes} lanes, card ${saved ? "written" : "not written"}` }
})

let drawing = ""
await check("obsidian-excalidraw-plugin", async () => {
  await page.evaluate(() => app.commands.executeCommandById("obsidian-excalidraw-plugin:excalidraw-autocreate"))
  await wait(6000); await closeModals()
  drawing = await page.evaluate(() => app.vault.getFiles().filter((f) => /excalidraw\.md$/.test(f.path)).sort((a, b) => b.stat.ctime - a.stat.ctime)[0]?.path ?? "")
  const c = page.locator(".excalidraw canvas.interactive").first()
  const box = await c.boundingBox()
  await page.locator('.excalidraw [data-testid="toolbar-rectangle"]').first().click()
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }); await page.mouse.up()
  await page.evaluate(async () => { const v = app.workspace.getLeavesOfType("excalidraw")[0]?.view; await v?.save?.(false) })
  await wait(2000)
  const text = await read(drawing)
  return { ok: !!drawing && box.height > 200 && text.length > 1000, why: `${drawing}, canvas ${Math.round(box.height)}px, ${text.length} chars saved` }
})

await check("obsidian-excalidraw-plugin embed", async () => {
  await note("Notes/Embeds.md", `# Embeds\n\n![[${drawing.replace(/\.md$/, "")}]]\n`)
  await wait(800); await open("Notes/Embeds.md"); await wait(2000)
  const svg = await page.locator(".obsidian-compat-embed svg").count()
  return { ok: svg > 0, why: `${svg} svg` }
})

await check("obsidian-mind-map", async () => {
  await open("Notes/Outline.md")
  await page.evaluate(() => app.commands.executeCommandById("obsidian-mind-map:app:markmap-preview")); await wait(4000)
  const texts = await page.evaluate(() => [...document.querySelectorAll('[data-type="mindmap"] svg foreignObject div')].map((e) => e.textContent))
  return { ok: texts.includes("One a"), why: texts.slice(0, 4).join(", ") }
})

await check("obsidian-markmind", async () => {
  await note("Notes/Map.md", "---\nmindmap-plugin: basic\n---\n\n# Lighthouse\n\n## Goals\n- Ship\n- Log\n")
  await wait(800); await open("Notes/Map.md"); await wait(2000)
  const v = await page.evaluate(() => ({ type: app.workspace.viewTypeFor("Notes/Map.md"), drawn: !!document.querySelector('[data-type="mindmapview"] .mm-app-container') }))
  return { ok: v.type === "mindmapview" && v.drawn, why: `${v.type}${v.drawn ? ", drawn" : ""}` }
})

await check("obsidian-enhancing-mindmap", async () => {
  await on("obsidian-markmind", false); await on("obsidian-enhancing-mindmap", true); await reload()
  await open("Notes/Map.md"); await wait(2000)
  const nodes = await page.evaluate(() => [...document.querySelectorAll('[data-type="mindmapView"] .mm-node-content')].map((e) => e.textContent.trim()))
  return { ok: nodes.includes("Goals") && nodes.includes("Ship"), why: nodes.join(", ") }
})

await check("excalibrain", async () => {
  // (it waits for Dataview: the lab needs dataview on too)
  if (!(await page.evaluate(() => !!app.plugins.plugins.dataview))) return { ok: false, why: "needs Dataview on in the lab" }
  await open("Projects/Lighthouse.md")
  await page.evaluate(() => app.commands.executeCommandById("excalibrain:excalibrain-start")); await wait(7000); await closeModals()
  await page.locator('article.file-view[data-path="Projects/Lighthouse.md"] .cm-content').first().click({ position: { x: 40, y: 10 } }).catch(() => {})
  await wait(5000)
  const central = await page.evaluate(() => app.plugins.plugins.excalibrain?.scene?.centralPagePath)
  return { ok: central === "Projects/Lighthouse.md", why: `central ${central}` }
})

await check("make-md", async () => {
  const items = await page.evaluate(() => [...document.querySelectorAll(".mk-tree-text")].map((e) => e.textContent.trim()))
  return { ok: items.includes("Daily") && items.includes("Notes"), why: `${items.length} items in its navigator` }
})

await check("image-converter", async () => {
  const P = `Notes/Paste ${Date.now()}.md`
  await note(P, "# Paste\n\nHere:\n"); await wait(800); await open(P); await editing()
  await page.locator(`article.file-view[data-path="${P}"] .cm-content`).click(); await page.keyboard.press(phone ? "End" : "Meta+ArrowDown")
  await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 40; c.height = 30; c.getContext("2d").fillRect(0, 0, 40, 30)
    const blob = await new Promise((r) => c.toBlob(r, "image/png")), dt = new DataTransfer()
    dt.items.add(new File([blob], "image.png", { type: "image/png" }))
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await wait(5000)
  const text = await read(P)
  return { ok: /!\[\[[^\]]+\.webp\]\]/.test(text), why: text.split("\n").pop() }
})

await check("obsidian-custom-frames", async () => {
  await page.evaluate(async (b) => { const pl = app.plugins.plugins["obsidian-custom-frames"]; pl.settings.frames = [{ url: `${b}api/file?path=Start%20here.md`, displayName: "Docs page", icon: "", hideOnMobile: false, addRibbonIcon: false, openInCenter: true, zoomLevel: 1, forceIframe: false, customCss: "", customJs: "" }]; await pl.saveSettings() }, B)
  await reload()
  await page.evaluate(() => app.commands.executeCommandById("obsidian-custom-frames:open-custom-frames-docs-page")); await wait(3000)
  const body = await page.evaluate(() => { try { return document.querySelector('[data-type^="custom-frames"] iframe')?.contentDocument?.body?.innerText?.slice(0, 40) } catch { return null } })
  return { ok: !!body && body.includes("Start here"), why: body ?? "no frame" }
})

await check("obsidian-memos", async () => {
  await page.evaluate(() => app.commands.executeCommandById("obsidian-memos:open-thino-in-center")); await wait(3000)
  const t = await page.evaluate(() => document.querySelector('[data-type="thino_view"]')?.textContent ?? "")
  return { ok: /Thino/.test(t), why: t.slice(0, 60) }
})

await check("obsidian-annotator", async () => {
  await note("Notes/Annotated.md", "---\nannotation-target: Attachments/sample.pdf\n---\n\n# Annotated\n"); await wait(800); await open("Notes/Annotated.md"); await wait(4000)
  const v = await page.evaluate(() => ({ type: app.workspace.viewTypeFor("Notes/Annotated.md"), frame: !!document.querySelector('[data-type="pdf-annotator"] iframe') }))
  return { ok: v.type === "pdf-annotator" && v.frame, why: `${v.type}, its frame ${v.frame ? "there (its viewer stays blank)" : "missing"}` }
})

void desktop
fs.writeFileSync(`/tmp/oc-lab/apps-${phone ? "phone" : "web"}.json`, JSON.stringify(results, null, 2))
await ctx.close()
await done()
