// Excalidraw: a drawing (and Obsidian's .excalidraw.md) opens as a whiteboard with the app's own fonts (nothing from esm.sh), a shape drawn is saved to
// the file, a change made on disk meanwhile is kept, reading is view mode, source is its JSON, `![[x.excalidraw]]`
// draws a picture in a note, "New drawing" makes one, the plugin off opens it as text, and a phone at 390px.
// Installs the plugin; WRITES a "Qa drawings" folder, plugins.json and the workspaces' data.json (put back): throwaway
// server only.
//   node excalidraw/.test/qa/excalidraw.mjs <base url> <vault path> [out dir]
import { readFileSync, writeFileSync, utimesSync } from "node:fs"
import { install, SHOTS, palette, qa, setAsideWorkspaces, wait } from "../../../qa.mjs"
const { obsidian } = await import("../../codec.ts")
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, noErrors, done } = await qa(import.meta.url)
// As the app: the drawings are the user's (a note an agent makes through the API gets `origin: ai`: Provenance).
const req = (method, path, body) => fetch(`${B}api/${path}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) })
const DRAWING = "Qa drawings/Sample.excalidraw", NOTE = "Qa drawings/With a drawing.md"
const read = () => JSON.parse(readFileSync(`${VAULT}/${DRAWING}`, "utf8"))
const live = (els) => els.filter((e) => !e.isDeleted)

const scene = { type: "excalidraw", version: 2, source: "qa", appState: { viewBackgroundColor: "#ffffff" }, files: {}, elements: [
  { id: "qa-box", type: "rectangle", x: 0, y: 0, width: 200, height: 90, strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "solid", roughness: 1, strokeWidth: 2, seed: 1, boundElements: [{ id: "qa-text", type: "text" }] },
  { id: "qa-text", type: "text", x: 50, y: 32, width: 100, height: 25, text: "Hello", originalText: "Hello", fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: "qa-box", strokeColor: "#1e1e1e", seed: 2 },
] }
// Workspaces keep tabs that would take the page's address over: none during the run (put back at the end).
const putBackWs = setAsideWorkspaces(VAULT)
await req("DELETE", `file?path=${encodeURIComponent("Qa drawings")}`)
await req("POST", "file", { path: DRAWING, text: JSON.stringify(scene, null, 2) })
await req("POST", "file", { path: NOTE, text: `A picture:\n\n![[${DRAWING}|300]]\n` })

// Installed and on for this run (a vault plugin is off until then).
install(B, "excalidraw")
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
const page = watch(await ctx.newPage())
const fonts = [], outside = []
page.on("response", (r) => { if (r.url().includes("/api/excalidraw/fonts/")) fonts.push(r.status()) })
page.on("request", (r) => { if (/esm\.sh|unpkg\.com/.test(r.url())) outside.push(r.url()) })

await page.goto(`${B}#file/${encodeURIComponent(DRAWING)}`)
await page.locator(".excalidraw canvas").first().waitFor({ timeout: 15000 })
await wait(1500)
check("opens editing on desktop", !(await page.locator(".excalidraw--view-mode").count()))
check(`fonts come from the app (${fonts.length}, all 200)`, fonts.length > 0 && fonts.every((s) => s === 200))
check(`nothing from esm.sh/unpkg (${outside.length})`, !outside.length)
// The whole pane, edge to edge under the path bar (its format's layout: "pane"), with no title or box around it.
const box = await page.locator("[data-format-pane]").boundingBox()
const paneBox = await page.locator("[data-pane-body]").first().boundingBox()
check(`fills the pane, edge to edge (${Math.round(box?.width ?? 0)} x ${Math.round(box?.height ?? 0)} of ${Math.round(paneBox?.width ?? 0)} x ${Math.round(paneBox?.height ?? 0)})`,
  box && paneBox && Math.abs(box.width - paneBox.width) < 2 && Math.abs(box.y + box.height - (paneBox.y + paneBox.height)) < 2 && box.height > paneBox.height - 70)
check("no box and no title around it", !(await page.$("[data-format-box]")) && !(await page.$("article[data-layout=pane] textarea")))
await page.screenshot({ path: `${OUT}excalidraw-edit.png` })

// Draw a rectangle: it lands in the file.
const canvas = page.locator(".excalidraw canvas.interactive")
const cb = await canvas.boundingBox()
const rect = () => page.locator(".excalidraw [data-testid=toolbar-rectangle]").click({ force: true })
await rect()
await page.mouse.move(cb.x + cb.width - 300, cb.y + cb.height - 250)
await page.mouse.down(); await page.mouse.move(cb.x + cb.width - 150, cb.y + cb.height - 150, { steps: 8 }); await page.mouse.up()
await wait(2000)
check(`a drawn rectangle is saved (${live(read().elements).length} elements)`, live(read().elements).length === 3)

// Changed on disk meanwhile (an AI adds an ellipse): shown, and kept by the next save.
const disk = read()
disk.elements.push({ id: "qa-ai", type: "ellipse", x: 300, y: 0, width: 120, height: 80, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", roughness: 1, strokeWidth: 2, seed: 9, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, angle: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, strokeStyle: "solid" })
writeFileSync(`${VAULT}/${DRAWING}`, JSON.stringify(disk, null, 2))
const t = Date.now() / 1000 + 2; utimesSync(`${VAULT}/${DRAWING}`, t, t)
await wait(2500)
await rect()
await page.mouse.move(cb.x + cb.width - 250, cb.y + 110)
await page.mouse.down(); await page.mouse.move(cb.x + cb.width - 120, cb.y + 180, { steps: 8 }); await page.mouse.up()
await wait(2000)
const after = live(read().elements)
check(`the change on disk stays after drawing (${after.map((e) => e.id.slice(0, 6)).join(" ")})`, after.some((e) => e.id === "qa-ai") && after.length === 5)
await page.screenshot({ path: `${OUT}excalidraw-merged.png` })
check("no conflict banner", !(await page.locator("[role=alert]").count()))

// Reading is view mode; source is the JSON.
await page.keyboard.press("Escape")
await page.keyboard.press("Meta+e"); await wait(600)
check("⌘E with the canvas focused reaches the app: reading", await page.locator(".excalidraw--view-mode").count())
await page.keyboard.press("Meta+e"); await wait(600)
check("and back to editing", !(await page.locator(".excalidraw--view-mode").count()))
await palette(page, "Switch to reading view")
check("reading view is Excalidraw's view mode", await page.locator(".excalidraw--view-mode").count())
await palette(page, "Switch to source mode")
check("source mode is its JSON", (await page.locator(".cm-content").first().innerText()).includes("\"type\": \"excalidraw\""))
await palette(page, "Switch to live preview")
await page.locator(".excalidraw canvas").first().waitFor({ timeout: 10000 })
check("back to editing", !(await page.locator(".excalidraw--view-mode").count()))

// Embedded in a note: a picture.
await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`); await wait(500)
await page.locator("[data-excalidraw-preview] svg").first().waitFor({ timeout: 15000 }).catch(() => {})
check("![[x.excalidraw]] draws a picture in a note", await page.locator("[data-excalidraw-preview] svg").count())
await page.screenshot({ path: `${OUT}excalidraw-embed.png` })

// Obsidian's .excalidraw.md: drawn, a shape saved back in Obsidian's format, embedded by its name without .md.
const OBS = "Qa drawings/From obsidian.excalidraw.md"
const OBS_HEAD = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n==Switch to EXCALIDRAW VIEW==\n\n\n# Excalidraw Data\n\n## Text Elements\nHello ^qa-text\n\n%%\n## Drawing\n```compressed-json\nN4Ig\n```\n%%"
await req("POST", "file", { path: OBS, text: obsidian.write(OBS_HEAD, JSON.stringify(scene)) })
await req("POST", "file", { path: "Qa drawings/Empty obsidian.excalidraw.md", text: obsidian.write(OBS_HEAD, JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} })) })
await page.goto(`${B}#file/${encodeURIComponent(OBS)}`)
await page.locator(".excalidraw canvas").first().waitFor({ timeout: 15000 }).catch(() => {})
await wait(1200)
check("Obsidian drawing opens as a whiteboard", await page.locator(".excalidraw canvas").count())
await page.screenshot({ path: `${OUT}excalidraw-obsidian.png` })
{
  const c = await page.locator(".excalidraw canvas.interactive").boundingBox()
  await page.locator(".excalidraw [data-testid=toolbar-rectangle]").click({ force: true })
  await page.mouse.move(c.x + c.width - 250, c.y + 110)
  await page.mouse.down(); await page.mouse.move(c.x + c.width - 120, c.y + 180, { steps: 8 }); await page.mouse.up()
  await wait(2000)
  const text = readFileSync(`${VAULT}/${OBS}`, "utf8")
  const back = obsidian.read(text)
  check("saved in Obsidian's format (frontmatter, compressed, text elements)", text.startsWith("---\n\nexcalidraw-plugin: parsed") && /```compressed-json\n/.test(text) && text.includes("## Text Elements\nHello ^qa-text"))
  check(`the shape is in it (${live(back.elements).length} elements)`, live(back.elements).length === 3)
}
await page.goto(`${B}#file/${encodeURIComponent("Qa drawings/Empty obsidian.excalidraw.md")}`)
await page.locator(".excalidraw canvas").first().waitFor({ timeout: 15000 }).catch(() => {})
check("an empty Obsidian drawing opens", await page.locator(".excalidraw canvas").count() && !(await page.getByText("couldn't be drawn").count()))
await req("PUT", "file", { path: NOTE, text: `A picture:\n\n![[From obsidian.excalidraw|300]]\n` })
await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`)
await page.locator("[data-excalidraw-preview] svg").first().waitFor({ timeout: 15000 }).catch(() => {})
await page.screenshot({ path: `${OUT}excalidraw-obsidian-embed.png` })
check(`![[Name.excalidraw]] embeds Obsidian's Name.excalidraw.md (${page.url().slice(-40)}: ${(await page.locator("article").first().innerText().catch(() => "")).slice(0, 120).replace(/\n/g, " ")})`, await page.locator("[data-excalidraw-preview] svg").count())

// New drawing (palette): a file in Drawings/, open.
await palette(page, "New drawing")
await wait(1500)
const files = await (await req("GET", "files")).json()
const made = [...files.files, ...files.others].map((f) => f.path).filter((p) => /\.excalidraw$/.test(p) && p !== DRAWING && !p.startsWith(".trash/"))
check(`New drawing makes a file (${made.join(", ")})`, made.length >= 1)
check("and opens it", await page.locator(".excalidraw canvas").count())
for (const p of made.filter((p) => p.startsWith("Qa drawings/") || p.startsWith("Drawings/"))) await req("DELETE", `file?path=${encodeURIComponent(p)}`)

// The plugin off: its text, as code.
const enabled = (await (await req("GET", "config/plugins")).json().catch(() => ({}))).enabled ?? []
await req("PATCH", "config/plugins", { enabled: enabled.filter((x) => x !== "excalidraw") })
await page.goto(`${B}#file/${encodeURIComponent(DRAWING)}`); await page.reload(); await wait(2500)
check("plugin off: opened as text", !(await page.locator(".excalidraw").count()) && (await page.locator(".cm-content").first().innerText()).includes("excalidraw"))
await req("PATCH", "config/plugins", { enabled })

// Phone.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const pp = watch(await phone.newPage(), { label: "phone" })
await pp.goto(`${B}#file/${encodeURIComponent(DRAWING)}`)
await pp.locator(".excalidraw canvas").first().waitFor({ timeout: 15000 }).catch(() => {})
await wait(1500)
check("phone: opens reading (view mode)", await pp.locator(".excalidraw--view-mode").count())
const wide = await pp.evaluate(() => document.documentElement.scrollWidth)
check(`phone: no overflow (${wide}px)`, wide <= 390)
await pp.screenshot({ path: `${OUT}excalidraw-phone.png` })
noErrors()

await req("DELETE", `file?path=${encodeURIComponent("Qa drawings")}`)
await browser.close()
putBackWs()
await done()
