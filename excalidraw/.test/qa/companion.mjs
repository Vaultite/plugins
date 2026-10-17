// The companion on a drawing: its cursor is one of Excalidraw's collaborators (each agent's, in its colour), its words
// pop at a place of the canvas, its drawing is made live as one step ⌘Z takes back, and what the user does there (open,
// a change after a pause, a text with @claude) reaches it with the scene as text. Driven through the ops an agent calls.
// Installs the plugin; WRITES "Qa companion drawings/", plugins.json and the companion's settings: throwaway server only.
//   node excalidraw/.test/qa/companion.mjs <base url> <vault path> [out dir]
import { readFileSync } from "node:fs"
import { install, SHOTS, qa, setAsideWorkspaces, vauAt, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
const req = (method, path, body) => fetch(`${B}api/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json())
const op = (id, params = {}) => req("POST", `ops/${id}`, params)
const DIR = "Qa companion drawings", DRAWING = `${DIR}/Flow.excalidraw`
const live = () => JSON.parse(readFileSync(`${VAULT}/${DRAWING}`, "utf8")).elements.filter((e) => !e.isDeleted)

const putBackWs = setAsideWorkspaces(VAULT)
install(B, "excalidraw")
vauAt(B)("plugin", "on", "companion")
await req("PATCH", "config/plugin/companion", { mode: "pair", pause: 1 })
await req("DELETE", `file?path=${encodeURIComponent(DIR)}`)
await req("POST", "file", { path: DRAWING, text: JSON.stringify({ type: "excalidraw", version: 2, source: "qa", appState: { viewBackgroundColor: "#ffffff" }, files: {}, elements: [
  { id: "qa-box", type: "rectangle", x: 0, y: 0, width: 200, height: 90, strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "solid", roughness: 1, strokeWidth: 2, seed: 1, boundElements: [{ id: "qa-text", type: "text" }] },
  { id: "qa-text", type: "text", x: 50, y: 32, width: 100, height: 25, text: "Hello", originalText: "Hello", fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: "qa-box", strokeColor: "#1e1e1e", seed: 2 },
] }, null, 2) })

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
const page = watch(await ctx.newPage(), { console: true })
await page.goto(`${B}#file/${encodeURIComponent(DRAWING)}`)
await page.locator(".excalidraw canvas.interactive").waitFor({ timeout: 15000 })
await wait(1500)
await op("companion.next", { timeout: 0 })
const canvas = await page.locator(".excalidraw canvas.interactive").boundingBox()
const api = () => page.evaluate(() => { const c = globalThis.__vaultite.modules["@vaultite"].canvases()[0]; return c && { items: c.items(), path: c.path } })
const screenOf = (id) => page.evaluate((id) => {
  const c = globalThis.__vaultite.modules["@vaultite"].canvases()[0], i = c.items().find((x) => x.id === id)
  return i && c.toScreen({ x: i.x + i.w / 2, y: i.y + i.h })
}, id)
check("the drawing is a canvas others can reach, its label folded into its shape", JSON.stringify((await api())?.items) === JSON.stringify([{ id: "qa-box", type: "rectangle", x: 0, y: 0, w: 200, h: 90, text: "Hello" }]), await api())

// Opening it (doing something there): an open moment, with the scene as text.
await page.mouse.move(canvas.x + canvas.width - 200, canvas.y + 200)
await page.mouse.click(canvas.x + canvas.width - 200, canvas.y + 200)
let r = await op("companion.next", { timeout: 6 })
const open = r.moments?.find((m) => m.kind === "open" && m.path === DRAWING)
check("open: a moment for the drawing, at the user's pointer", !!open && open.x !== undefined && open.line === undefined, r.moments)
r = await req("POST", "ops/companion.next", { timeout: 0 })

// Its cursor: one of Excalidraw's collaborators, by the element it looks at.
await op("companion.look", { path: DRAWING, find: "Hello" })
await wait(1200)
check("look: the agent is one of the drawing's collaborators", (await page.locator(".excalidraw .Avatar").count()) >= 1)
await page.screenshot({ path: `${OUT}companion-drawing-look.png` })
await op("companion.say", { text: "A box for the greeting.", path: DRAWING, find: "qa-box" })
const bubble = page.getByText("A box for the greeting.")
await bubble.waitFor({ timeout: 3000 })
await wait(900)
const b = await bubble.boundingBox(), at = await screenOf("qa-box")
check("say: its words pop by the element on the canvas", !!b && !!at && Math.abs(b.x - at.x) < 60 && b.y + b.height < at.y + 10 && at.y - (b.y + b.height) < 40, { b, at })
check("say: no second cursor of the app's over the canvas", !(await page.locator('.companion-cursor[data-agent="Claude"] svg').count()))
await page.screenshot({ path: `${OUT}companion-drawing-say.png` })
// Another agent (--as) in its own colour, beside it.
await op("companion.look", { path: DRAWING, x: 400, y: 200, as: "Ada" })
await wait(1000)
await page.screenshot({ path: `${OUT}companion-drawing-two.png` })
check("look --as: another agent, another collaborator", (await page.locator(".excalidraw .Avatar").count()) + (await page.locator(".excalidraw .UserList__more").count()) >= 2)

// Following one (a click on it, top right): the view keeps its pointer in sight. (Ada gone first: Claude alone there.)
await op("companion.stop", { as: "Ada" })
await wait(800)
check("an agent gone is gone from the drawing", (await page.locator(".excalidraw .Avatar").count()) === 1 && !(await page.locator(".excalidraw .UserList__more").count()))
await page.locator(".excalidraw .Avatar").first().click()
await op("companion.look", { path: DRAWING, x: 4000, y: 3000 })
await wait(2500)
const view = await page.evaluate(() => globalThis.__vaultite.modules["@vaultite"].canvases()[0].view())
check(`follow: following ${await page.locator(".excalidraw .follow-mode__badge").innerText().then((t) => t.replace(/\s+/g, " ")).catch(() => "no one")}`, /Claude/.test(await page.locator(".excalidraw .follow-mode__badge").innerText().catch(() => "")))
check("follow: the view goes where the followed agent looks", view.x < 4000 && view.x + view.w > 4000 && view.y < 3000 && view.y + view.h > 3000, view)
await page.locator(".excalidraw .Avatar").first().click()
await op("companion.look", { path: DRAWING, find: "qa-box" })
await page.keyboard.press("Shift+1")
await wait(800)

// Drawing: made live, the file saved by the window, one ⌘Z takes it all back.
r = await op("companion.draw", { path: DRAWING, actions: [{ op: "add", type: "ellipse", id: "qa-new", x: 320, y: 0, label: "New idea", fill: "green" }, { op: "add", type: "arrow", id: "qa-go", from: "qa-box", to: "qa-new" }] })
check("draw: made in the window that shows it", r.how === "drawn" && r.touched?.includes("qa-new"), r)
const items = (await api()).items
check("draw: the shape, its label and the arrow joining them are there", items.some((i) => i.id === "qa-new" && i.text === "New idea") && items.some((i) => i.id === "qa-go" && i.from === "qa-box" && i.to === "qa-new"), items)
await wait(2000)
check("draw: and saved to the file", live().some((e) => e.id === "qa-go"))
await page.screenshot({ path: `${OUT}companion-drawing-drawn.png` })
r = await op("companion.draw", { path: DRAWING, actions: [{ op: "move", id: "nope", x: 0, y: 0 }] })
check("draw: an action that doesn't fit is refused with why", /no element "nope"/.test(r.error ?? ""), r)
await page.mouse.click(canvas.x + canvas.width - 120, canvas.y + canvas.height - 120)
await page.keyboard.press("Meta+z")
await wait(1800)
check("draw: one undo takes the whole drawing back", !(await api()).items.some((i) => i.id === "qa-new" || i.id === "qa-go") && !live().some((e) => e.id === "qa-new"), (await api()).items.map((i) => i.id))
await page.keyboard.press("Meta+Shift+z")
await wait(600)
check("draw: and redo brings it back", (await api()).items.some((i) => i.id === "qa-new"))

// A change of theirs after a pause: an edit moment with what changed.
await op("companion.next", { timeout: 0 })
await page.locator(".excalidraw [data-testid=toolbar-rectangle]").click({ force: true })
await page.mouse.move(canvas.x + 300, canvas.y + canvas.height - 260)
await page.mouse.down(); await page.mouse.move(canvas.x + 420, canvas.y + canvas.height - 180, { steps: 8 }); await page.mouse.up()
r = await op("companion.next", { timeout: 8 })
const edit = r.moments?.find((m) => m.kind === "edit")
check("edit: what they drew reaches it after a pause", !!edit && edit.changes?.some((c) => /^\+ [\w-]+ rectangle at /.test(c)), r.moments)
check("edit: with the scene, ids and arrows as a -> b", /qa-go arrow qa-box "Hello" -> qa-new "New idea"/.test(r.notes?.[0]?.scene ?? ""), r.notes)

// An ask: a text with @claude, once it's written.
await page.keyboard.press("Escape")
await page.locator(".excalidraw [data-testid=toolbar-text]").click({ force: true })
await page.mouse.click(canvas.x + 300, canvas.y + 120)
await page.keyboard.type("@claude what goes here?")
await page.keyboard.press("Escape")
r = await op("companion.next", { timeout: 6 })
const ask = r.moments?.find((m) => m.kind === "ask")
check("ask: a text with @claude asks it what follows", ask?.text === "what goes here?" && !!ask.find && ask.path === DRAWING, r.moments)
await page.screenshot({ path: `${OUT}companion-drawing-ask.png` })

// What a drawing doesn't have: a margin.
r = await op("companion.comment", { path: DRAWING, text: "Hi", find: "qa-box" })
check("comment: refused on a drawing, saying what to use", /say|draw/.test(r.error ?? ""), r)

// A phone: the bubble on its canvas too.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const pp = watch(await phone.newPage(), { label: "phone" })
await pp.goto(`${B}#file/${encodeURIComponent(DRAWING)}`)
await pp.locator(".excalidraw canvas").first().waitFor({ timeout: 15000 })
await wait(1500)
await op("companion.say", { text: "Here on the phone.", path: DRAWING, find: "qa-box" })
await pp.getByText("Here on the phone.").waitFor({ timeout: 3000 }).catch(() => {})
check("phone: its words on the drawing", await pp.getByText("Here on the phone.").isVisible())
await pp.screenshot({ path: `${OUT}companion-drawing-phone.png` })
await phone.close()

// No window showing it: written to the file.
await ctx.close()
await wait(500)
r = await op("companion.draw", { path: DRAWING, actions: [{ op: "change", id: "qa-box", label: "Hi" }] })
check("draw: with no window, written to the file", r.how === "written" && live().some((e) => e.containerId === "qa-box" && e.text === "Hi"), r)

await req("DELETE", `file?path=${encodeURIComponent(DIR)}`)
putBackWs()
await done()
