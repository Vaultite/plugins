// Excalidraw at any size: a drawing holding pasted images (about 30 MB of JSON) opens with every image, a shape drawn
// and an image pasted are saved with the rest kept, it opens again after a reload, its picture draws in a note, File
// history keeps it and search finds it. Installs the plugin; WRITES a "Qa big drawings" folder, plugins.json and the
// workspaces' data.json (put back): throwaway server only.
//   node excalidraw/.test/qa/big.mjs <base url> <vault path> [out dir]
import { readFileSync, statSync } from "node:fs"
import { crc32, deflateSync } from "node:zlib"
import { install, SHOTS, qa, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
const req = (method, path, body) => fetch(`${B}api/${path}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) })
const DIR = "Qa big drawings", DRAWING = `${DIR}/Moodboard.excalidraw`, NOTE = `${DIR}/With the moodboard.md`
const read = () => JSON.parse(readFileSync(`${VAULT}/${DRAWING}`, "utf8"))
const live = (els) => els.filter((e) => !e.isDeleted)
const mb = () => (statSync(`${VAULT}/${DRAWING}`).size / 2 ** 20).toFixed(1)

/** A PNG of noise (it doesn't compress: its size is its pixels), `w` x `h`. */
function noisePng(w, h, seed) {
  let x = seed
  const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) >>> 24
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : rnd()
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])) >>> 0); return Buffer.concat([l, Buffer.from(t), d, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch("IHDR", ihdr), ch("IDAT", deflateSync(raw, { level: 0 })), ch("IEND", Buffer.alloc(0))])
}

// Twelve pasted images, as Excalidraw keeps them: each a data URL in `files`, placed by an image element.
const IMAGES = 12
const files = {}, elements = []
for (let i = 0; i < IMAGES; i++) {
  const id = `qa-file-${i}`
  files[id] = { id, mimeType: "image/png", dataURL: `data:image/png;base64,${noisePng(1000, 600, i + 1).toString("base64")}`, created: 1 }
  elements.push({ id: `qa-img-${i}`, type: "image", fileId: id, status: "saved", x: (i % 4) * 520, y: Math.floor(i / 4) * 330, width: 500, height: 300,
    angle: 0, strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0,
    opacity: 100, groupIds: [], frameId: null, roundness: null, seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false, boundElements: null,
    updated: 1, link: null, locked: false, scale: [1, 1], crop: null })
}
elements.push({ id: "qa-title", type: "text", x: 0, y: -80, width: 400, height: 45, text: "Lighthouse moodboard", originalText: "Lighthouse moodboard",
  fontSize: 36, fontFamily: 5, textAlign: "left", verticalAlign: "top", strokeColor: "#1e1e1e", seed: 99 })
const scene = { type: "excalidraw", version: 2, source: "qa", appState: { viewBackgroundColor: "#ffffff" }, files, elements }

const putBackWs = setAsideWorkspaces(VAULT)
await req("DELETE", `file?path=${encodeURIComponent(DIR)}`)
const made = await req("POST", "file", { path: DRAWING, text: JSON.stringify(scene, null, 2) })
check(`a drawing of ${mb()} MB is written through the API`, made.ok && Number(mb()) > 25, made.status)
await req("POST", "file", { path: NOTE, text: `The moodboard:\n\n![[${DRAWING}|300]]\n` })
install(B, "excalidraw")

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
const page = watch(await ctx.newPage())
page.on("response", (r) => { if (r.status() >= 400) console.log("  (", r.status(), r.url(), ")") })
// (a small one first: the plugin's code is built once it's installed, which takes a while whatever the drawing)
await req("POST", "file", { path: `${DIR}/Small.excalidraw`, text: JSON.stringify({ ...scene, files: {}, elements: [] }) })
await page.goto(`${B}#file/${encodeURIComponent(`${DIR}/Small.excalidraw`)}`)
await page.locator(".excalidraw canvas").first().waitFor({ timeout: 120000 })
const t0 = Date.now()
await page.goto(`${B}#file/${encodeURIComponent(DRAWING)}`)
await page.reload()
await page.locator(".excalidraw canvas").first().waitFor({ timeout: 60000 }).catch(async (e) => { await page.screenshot({ path: `${OUT}excalidraw-big-fail.png` }); throw e })
const opened = Date.now() - t0
await wait(2000)
check(`opens as a whiteboard, editing, in seconds (${opened} ms)`, opened < 15000 && !(await page.locator(".excalidraw--view-mode").count()))
check("not a card, not read-only", !(await page.getByText(/too big/i).count()) && !(await page.getByText(/read-only/i).count()))
await page.screenshot({ path: `${OUT}excalidraw-big-open.png` })

// A shape drawn: saved, the images all still there.
const canvas = page.locator(".excalidraw canvas.interactive")
const cb = await canvas.boundingBox()
await page.locator(".excalidraw [data-testid=toolbar-rectangle]").click({ force: true })
await page.mouse.move(cb.x + cb.width - 300, cb.y + cb.height - 250)
await page.mouse.down(); await page.mouse.move(cb.x + cb.width - 150, cb.y + cb.height - 150, { steps: 8 }); await page.mouse.up()
const drawn = await until(() => live(read().elements).length === IMAGES + 2, 15000)
let disk = read()
check(`a drawn rectangle is saved (${live(disk.elements).length} elements, ${mb()} MB)`, drawn)
check(`every image kept (${Object.keys(disk.files).length})`, Object.keys(disk.files).length === IMAGES &&
  Object.values(disk.files).every((f, i) => f.dataURL === files[`qa-file-${i}`].dataURL))

// An image pasted (a screenshot from the clipboard): saved into the drawing with the rest.
// (as a person does: the pointer over the canvas, Excalidraw focused, then ⌘V)
await page.keyboard.press("Escape")
await page.mouse.move(cb.x + cb.width - 100, cb.y + 120)
const pasted = noisePng(800, 500, 77).toString("base64")
const focus = await page.evaluate((b64) => {
  const box = document.querySelector(".excalidraw-container") ?? document.querySelector(".excalidraw")
  box?.focus()
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const dt = new DataTransfer()
  dt.items.add(new File([bytes], "image.png", { type: "image/png" }))
  ;(document.activeElement ?? document).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
  return document.activeElement?.className
}, pasted)
console.log(`  (pasted into ${focus})`)
const got = await until(() => Object.keys(read().files).length === IMAGES + 1, 20000)
disk = read()
check(`a pasted image is saved too (${Object.keys(disk.files).length} images, ${mb()} MB)`, got && live(disk.elements).filter((e) => e.type === "image").length === IMAGES + 1)
await page.screenshot({ path: `${OUT}excalidraw-big-pasted.png` })

// Again after a reload: all of it.
const t1 = Date.now()
await page.reload()
await page.locator(".excalidraw canvas").first().waitFor({ timeout: 60000 })
console.log(`  (open again: ${Date.now() - t1} ms)`)
await wait(2000)
check("opens again after a reload", !(await page.getByText(/couldn't|too big/i).count()))
check("every image still in it", JSON.stringify(read().files) === JSON.stringify(disk.files))

// Its picture in a note, every image in it.
await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`)
await page.locator("[data-excalidraw-preview] svg").first().waitFor({ timeout: 30000 }).catch(() => {})
const imgs = await page.locator("[data-excalidraw-preview] svg image").count()
check(`![[Moodboard.excalidraw]] draws a picture with its images (${imgs})`, imgs >= IMAGES + 1)
await page.screenshot({ path: `${OUT}excalidraw-big-embed.png` })

// File history keeps it; search finds its text.
const versions = await until(async () => (await (await req("GET", `history?path=${encodeURIComponent(DRAWING)}`)).json()).versions?.length, 10000)
check(`File history keeps its versions (${versions})`, versions >= 1)
const hits = await (await req("GET", `search?q=${encodeURIComponent("Lighthouse moodboard")}`)).json()
check("search finds it", hits.some((h) => h.path === DRAWING), hits.map((h) => h.path))

await req("DELETE", `file?path=${encodeURIComponent(DIR)}`)
putBackWs()
await done()
