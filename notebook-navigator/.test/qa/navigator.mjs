// Notebook navigator: made-up notes (a folder of 500 for speed, recipes with images and tags, nested project folders),
// then the sidebar panel (stacked, and side by side when wide), the tab, and a 390px phone (places, a place's notes,
// a note, Back), light and dark: counts, date groups, previews and thumbnails, sorting per folder, pinned notes on
// top, the search field, keyboard, the app's file menu, dragging a note onto a folder (moves) and a tag (tags it).
// Installs the plugin; WRITES a "Qa navigator" folder and the workspaces' data.json (put back): throwaway server only.
//   node notebook-navigator/.test/qa/navigator.mjs <base url> <vault path> [out dir]
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { install, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
fs.mkdirSync(OUT, { recursive: true })
const req = (method, p, body) => fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) })
const F = "Qa navigator", abs = (p) => path.join(VAULT, p)

// ---------- made-up notes, written on disk with their dates (the server's watcher reads them)
/** A small PNG of one colour, a thumbnail to find. */
function png(r, g, b, n = 48) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]) }
  const head = Buffer.alloc(13); head.writeUInt32BE(n, 0); head.writeUInt32BE(n, 4); head[8] = 8; head[9] = 2
  const rows = Buffer.concat(Array.from({ length: n }, (_, y) => Buffer.from([0, ...Array.from({ length: n }, (_, x) => [r, (g + x * 2) % 256, (b + y * 2) % 256]).flat()])))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
}
const DAY = 864e5, now = Date.now()
function note(p, text, ago) {
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true })
  fs.writeFileSync(abs(p), text)
  const t = new Date(now - ago); fs.utimesSync(abs(p), t, t)
}
const WORDS = "lighthouse harbour morning tide notebook coffee garden river letter window paper autumn station meadow lantern".split(" ")
const putBackWs = setAsideWorkspaces(VAULT)
for (const p of (await (await req("GET", "state")).json()).pinned ?? []) if (p.startsWith(`${F}/`)) await req("POST", "pins", { path: p, pinned: false })
fs.rmSync(abs(F), { recursive: true, force: true })
for (let i = 0; i < 500; i++) {
  const w = (k) => WORDS[(i * 7 + k * 3) % WORDS.length]
  note(`${F}/Journal/Entry ${String(i + 1).padStart(3, "0")}.md`, `# Entry ${i + 1}\n\nA ${w(1)} by the ${w(2)}, then ${w(3)} and ${w(4)}.${i % 9 === 0 ? " #journal/travel" : ""}\n\nMore about the ${w(5)}.\n`, (i * 0.8 + 0.01) * DAY)
}
const colours = [[200, 80, 40], [40, 140, 90], [60, 90, 200], [190, 160, 30]]
colours.forEach(([r, g, b], i) => { fs.mkdirSync(abs(`${F}/Attachments`), { recursive: true }); fs.writeFileSync(abs(`${F}/Attachments/dish ${i + 1}.png`), png(r, g, b)) })
const dishes = ["Tomato soup", "Lemon pasta", "Green curry", "Corn bread", "Apple pie", "Bean stew"]
dishes.forEach((d, i) => note(`${F}/Recipes/${d}.md`, `---\ntags: [recipe${i % 2 ? ", recipe/dinner" : ""}]\n---\n${i < 4 ? `![[dish ${i + 1}.png]]\n\n` : ""}Serves four. Start with the ${WORDS[i]} and go slowly.\n`, i * 3 * DAY + 3600e3))
for (const [k, sub] of ["Lighthouse", "Harbour"].entries()) {
  for (let i = 0; i < 6; i++) note(`${F}/Projects/${sub}/${sub} note ${i + 1}.md`, `Plans for ${sub.toLowerCase()} part ${i + 1}.\n\n\`\`\`block-x\nnot shown\n\`\`\`\n`, (k * 40 + i * 6) * DAY)
}
note(`${F}/Projects/Overview.md`, "Both projects at a glance.\n", 2 * DAY)
install(B, "notebook-navigator")
await until(async () => (await (await req("GET", "files")).json()).files.filter((f) => f.path.startsWith(`${F}/`)).length >= 519, 20000)
await req("PATCH", "config/plugin/notebook-navigator", { shortcuts: [`folder:${F}/Recipes`] })


const SIDEBARS = abs(".vaultite/sidebars.json"), sidebarsWas = fs.existsSync(SIDEBARS) ? fs.readFileSync(SIDEBARS, "utf8") : null
fs.writeFileSync(SIDEBARS, JSON.stringify({ left: ["pages:pages", "notebook-navigator:navigator"], right: [], collapsed: [], heights: {} }))
// Put back however the run ends.
process.on("exit", () => { if (sidebarsWas === null) fs.rmSync(SIDEBARS, { force: true }); else fs.writeFileSync(SIDEBARS, sidebarsWas); putBackWs() })
const settings = () => { try { return JSON.parse(fs.readFileSync(abs(".vaultite/plugins/notebook-navigator/data.json"), "utf8")) } catch { return {} } }
/** Where the navigator looked for is: the sidebar's (""), or a tab's ("[data-pane] "). */
let scope = ""
const place = (page, p) => page.locator(`${scope}[data-nn-place="${p}"]`).first()
const rows = (page) => page.locator(`${scope}[data-nn-note]`)
const titles = (page) => rows(page).evaluateAll((els) => els.map((e) => e.dataset.nnNote.split("/").pop().replace(/\.md$/, "")))
const heads = (page) => page.locator("[data-nn-list] h3").allTextContents()
/** Opens a folder's chevron, by its place. */
const unfold = async (page, p) => { const b = page.locator(`${scope}[data-nn-drop="${p}"] > button[aria-expanded=false]`).first(); if (await b.count()) await b.click(); await wait(150) }
/** The mouse from one element to another, in steps (the app's drag starts after 5px): the drop hint shown on the way. */
async function drag(page, from, to) {
  // (In the middle of the pane: near its edge, a drag scrolls it.)
  for (const l of [to, from]) await l.evaluate((e) => e.scrollIntoView({ block: "center" }))
  const a = await from.boundingBox(), b = await to.boundingBox()
  await page.mouse.move(a.x + 30, a.y + a.height / 2); await page.mouse.down()
  await page.mouse.move(a.x + 40, a.y + a.height / 2 + 10, { steps: 3 })
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 12 }); await wait(200)
  const hinted = await page.locator("[data-nn-drop].ring-1").count()
  await page.mouse.up(); await wait(900)
  return hinted
}
async function open(ctxOpts, label, to = "") {
  const ctx = await browser.newContext(ctxOpts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank")
  await page.goto(`${B}${to}`)
  await page.waitForSelector("[data-sidebar-body], [data-phone-header]", { timeout: 15000 })
  await wait(1200)
  return { ctx, page }
}
const DESK = { viewport: { width: 1280, height: 860 } }

// ---------- desktop, the sidebar panel (stacked), then wide (side by side)
{
  const { ctx, page } = await open({ ...DESK, colorScheme: "light" }, "desktop", `#file/${encodeURIComponent("Start here.md")}`)
  check("the panel is in the sidebar, All notes counting every note", await until(() => page.locator("[data-nn-places]").count(), 8000) > 0
    && Number(await place(page, "folder:").locator("span.tabular-nums").textContent()) >= 700)
  check("a folder counts the notes under it", (await page.locator(`[data-nn-place="folder:${F}"] .tabular-nums`).textContent()) === "519")
  await unfold(page, `folder:${F}`)
  // Opening the folder of 500: the main thread's work (CDP's TaskDuration), and the time from the click to its rows drawn.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const busy = async () => (await cdp.send("Performance.getMetrics")).metrics.find((x) => x.name === "TaskDuration").value * 1000
  const busy0 = await busy()
  const ms = await page.evaluate(async (p) => {
    const t = performance.now()
    document.querySelector(`[data-nn-place="${CSS.escape(p)}"]`).click()
    await new Promise((r) => { const go = () => (document.querySelectorAll("[data-nn-note]").length >= 500 ? r() : requestAnimationFrame(go)); go() })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return performance.now() - t
  }, `folder:${F}/Journal`)
  const work = await busy() - busy0
  check(`a folder of 500 notes opens at once (${Math.round(ms)} ms to drawn, ${Math.round(work)} ms of work)`, ms < 250 && work < 250, [ms, work])
  check("its notes are grouped by date: Today, Yesterday, the last 7 and 30 days, then months", await until(async () => {
    const h = await heads(page); return h[0] === "Today" && h[1] === "Yesterday" && h.includes("Previous 7 days") && h.includes("Previous 30 days") && h.length > 8
  }, 3000), await heads(page))
  const preview = () => rows(page).first().locator(".line-clamp-2").textContent()
  check("rows show the time and a preview of the first lines (as text, without the heading)", await until(async () => /^\d+:\d\d.*A \w+ by the \w+, then/.test(await preview()) && !/Entry 1\b|#/.test((await preview()).replace("#journal/travel", "")), 4000),
    await preview())
  await page.screenshot({ path: `${OUT}nn-panel-light.png` })
  // Dragging over a list of 500: each move costs little (the rows aren't drawn again).
  const r0 = await rows(page).nth(2).boundingBox()
  await page.mouse.move(r0.x + 30, r0.y + 10); await page.mouse.down(); await page.mouse.move(r0.x + 40, r0.y + 30, { steps: 3 })
  const b0 = await busy()
  for (let i = 0; i < 20; i++) await page.mouse.move(r0.x + 40, r0.y + 30 + i * 4)
  const perMove = (await busy() - b0) / 20
  await page.keyboard.press("Escape"); await page.mouse.up(); await wait(300)
  check(`dragging a note over the 500 costs little per move (${perMove.toFixed(1)} ms)`, perMove < 8, perMove)
  // Sorting this folder by title: saved for it alone, groups gone.
  await page.locator('[data-nn-list] button[aria-label^="Sort"]').click(); await wait(200)
  await page.getByRole("menuitemradio", { name: "Title" }).click()
  check("sorted by title: A to Z, no date headings, kept for that folder", await until(async () => (await titles(page))[0] === "Entry 001" && !(await heads(page)).length, 3000)
    && settings().sorts?.[`folder:${F}/Journal`] === "title", settings())
  await page.locator('[data-nn-list] button[aria-label^="Sort"]').click(); await wait(200)
  await page.getByRole("menuitemradio", { name: "Date modified" }).click(); await wait(400)
  check("back to the default: the folder's own sort is gone", !settings().sorts?.[`folder:${F}/Journal`], settings())

  // The search field: names, then words in the text (the app's search).
  await page.locator("[data-nn-list] input[type=search]").fill("entry 250"); await wait(500)
  check("search: by name", JSON.stringify(await titles(page)) === JSON.stringify(["Entry 250"]), await titles(page))
  await page.locator("[data-nn-list] input[type=search]").fill("notebook"); await wait(900)
  const n = await rows(page).count()
  check(`search: by words in the text, within the folder (${n})`, n > 10 && n < 500, n)
  await page.locator("[data-nn-list] input[type=search]").fill(""); await wait(300)

  // Recipes: thumbnails from the first image, tags with counts.
  await place(page, `folder:${F}/Recipes`).click(); await wait(800)
  check("a note's first image is its thumbnail", await until(async () => (await page.locator("[data-nn-note] img").count()) === 4, 4000), await page.locator("[data-nn-note] img").count())
  check("the thumbnails load", await page.locator("[data-nn-note] img").first().evaluate((i) => i.complete && i.naturalWidth > 0))
  check("tags are listed with their counts, nested under their parents", (await page.locator('[data-nn-place="tag:recipe"] .tabular-nums').textContent()) === "6")

  // The keyboard: arrows move through the rows, Enter opens.
  await rows(page).first().focus()
  await page.keyboard.press("ArrowDown"); await wait(100)
  const second = await page.evaluate(() => document.activeElement?.dataset.nnNote)
  await page.keyboard.press("Enter"); await wait(800)
  check("arrows move down the list, Enter opens the note", !!second && decodeURIComponent(await page.evaluate(() => location.hash)).includes(second), [second, await page.evaluate(() => location.hash)])
  check("the open note is lit in the list", await page.locator(`[data-nn-note="${second}"].bg-foreground\\/\\[0\\.08\\]`).count() === 1)

  // A note's menu is the app's file menu.
  await rows(page).first().click({ button: "right" }); await wait(300)
  const items = await page.getByRole("menuitem").allTextContents()
  check("right-click: the app's file menu (open, rename, move, duplicate, pin, copy path, delete)", ["Open in new tab", "Rename", "Move file to…", "Duplicate", "Pin", "Copy path", "Delete"].every((x) => items.some((i) => i.startsWith(x))), items)
  // Pin it there: on top of its list, and in Shortcuts.
  const first = await rows(page).first().getAttribute("data-nn-note")
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click(); await wait(800)
  check("a pinned note is on top, under Pinned, and in Shortcuts", (await heads(page))[0] === "Pinned" && await page.locator("[data-nn-places]", { hasText: first.split("/").pop().replace(".md", "") }).count() > 0, await heads(page))

  // Wide: the panes side by side.
  const grip = page.locator('[aria-label="Resize the sidebar"]').first(), g = await grip.boundingBox()
  await page.mouse.move(g.x + g.width / 2, 300); await page.mouse.down(); await page.mouse.move(640, 300, { steps: 8 }); await page.mouse.up(); await wait(600)
  const [pl, li] = [await page.locator("[data-nn-places]").boundingBox(), await page.locator("[data-nn-list]").boundingBox()]
  check("a wide sidebar has the two panes side by side", li.x > pl.x + pl.width - 2 && Math.abs(li.y - pl.y) < 40, [pl, li])
  await page.screenshot({ path: `${OUT}nn-panel-wide.png` })
  // Folded to the icon rail: its icon opens the panel beside it, side by side.
  await page.keyboard.press("Meta+\\"); await wait(500)
  await page.locator('[data-flyout-icon="notebook-navigator:navigator"]').click(); await wait(600)
  const [fp, fl] = [await page.locator("[data-flyout] [data-nn-places]").boundingBox(), await page.locator("[data-flyout] [data-nn-list]").boundingBox()]
  check("in the icon rail, a flyout with the two panes side by side", !!fp && !!fl && fl.x > fp.x + fp.width - 2, [fp, fl])
  await page.screenshot({ path: `${OUT}nn-flyout.png` })
  await ctx.close()
}

// ---------- desktop, a tab, light and dark
scope = "[data-pane] "
for (const scheme of ["light", "dark"]) {
  const { ctx, page } = await open({ ...DESK, colorScheme: scheme }, `tab ${scheme}`, "#view/notebook-navigator")
  const [pl, li] = [await page.locator("[data-pane] [data-nn-places]").boundingBox(), await page.locator("[data-pane] [data-nn-list]").boundingBox()]
  check(`${scheme}: the tab has the two panes side by side`, !!pl && !!li && li.x > pl.x + pl.width - 2, [pl, li])
  check(`${scheme}: each pane scrolls on its own`, await page.locator("[data-pane] [data-nn-list]").evaluate((e) => getComputedStyle(e.parentElement.parentElement).overflowY) === "auto")
  await page.screenshot({ path: `${OUT}nn-tab-${scheme}.png` })
  if (scheme === "dark") { await ctx.close(); continue }
  // Drag a note onto a tag (tagged), then onto a folder (moved).
  await place(page, `folder:${F}/Recipes`).click(); await wait(600)
  const tabs = () => page.locator("[data-tab-id]").count(), tabsBefore = await tabs()
  check("a note dragged onto a tag it has already: nothing to do", await drag(page, rows(page).filter({ hasText: "Bean stew" }), place(page, "tag:recipe")) === 0)
  await unfold(page, "tag:recipe")
  const curry = () => fs.readFileSync(abs(`${F}/Recipes/Green curry.md`), "utf8")
  check("dragging a note onto a tag shows where it goes", await drag(page, rows(page).filter({ hasText: "Green curry" }), place(page, "tag:recipe/dinner")) === 1)
  check("dropped on a tag, the note gets it in its frontmatter (and opens nowhere)", await until(() => curry().includes("recipe/dinner"), 3000) && /^---\ntags:/.test(curry()) && await tabs() === tabsBefore, curry())
  await unfold(page, `folder:${F}`)
  const hinted = await drag(page, rows(page).filter({ hasText: "Corn bread" }), place(page, `folder:${F}/Projects`))
  check("dropped on a folder, the note moves there", hinted === 1 && await until(() => fs.existsSync(abs(`${F}/Projects/Corn bread.md`)), 3000) && !fs.existsSync(abs(`${F}/Recipes/Corn bread.md`)))

  // Held near the places' bottom edge, a drag scrolls them.
  await page.locator(`${scope}[data-nn-places]`).evaluate((e) => { while (getComputedStyle(e).overflowY !== "auto") e = e.parentElement; e.dataset.qaScroller = "" })
  const box = page.locator("[data-qa-scroller]"), bb = await box.boundingBox()
  await box.evaluate((e) => { e.scrollTop = 0 })
  const r1 = await rows(page).first().boundingBox()
  await page.mouse.move(r1.x + 30, r1.y + 10); await page.mouse.down(); await page.mouse.move(r1.x + 40, r1.y + 30, { steps: 3 })
  await page.mouse.move(bb.x + 60, bb.y + bb.height - 6, { steps: 10 }); await wait(500)
  const scrolled = await box.evaluate((e) => e.scrollTop)
  await page.keyboard.press("Escape"); await page.mouse.up(); await wait(300)
  check(`a drag held near the places' edge scrolls them (${scrolled}px)`, scrolled > 20, scrolled)
  await page.screenshot({ path: `${OUT}nn-tab-dropped.png` })
  await ctx.close()
}

scope = ""
// ---------- phone: places, a place's notes, a note, Back
for (const scheme of ["light", "dark"]) {
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme }, `phone ${scheme}`, "#view/notebook-navigator")
  check(`390px ${scheme}: the places fill the screen`, await until(() => page.locator("[data-nn-places]").count(), 5000) > 0 && !(await page.locator("[data-nn-list]").count()))
  const w = await page.evaluate(() => document.documentElement.scrollWidth)
  check(`390px ${scheme}: nothing scrolls sideways`, w <= 390, w)
  await page.screenshot({ path: `${OUT}nn-phone-places-${scheme}.png` })
  await place(page, `folder:${F}/Recipes`).tap(); await wait(900)
  check(`390px ${scheme}: a place opens its notes, as a screen of their own`, await page.locator("[data-nn-list]").count() === 1 && !(await page.locator("[data-nn-places]").count()))
  await page.screenshot({ path: `${OUT}nn-phone-list-${scheme}.png` })
  if (scheme === "light") {
    await rows(page).first().tap(); await wait(1000)
    check("390px: a note opens", decodeURIComponent(await page.evaluate(() => location.hash)).startsWith(`#file/${F}/`), await page.evaluate(() => location.hash))
    await page.screenshot({ path: `${OUT}nn-phone-note.png` })
    await page.goBack(); await wait(1000)
    check("390px: Back from the note is the place's notes", await page.locator("[data-nn-list]").count() === 1, await page.evaluate(() => location.hash))
    await page.goBack(); await wait(1000)
    check("390px: Back again is the places", await page.locator("[data-nn-places]").count() === 1, await page.evaluate(() => location.hash))
  }
  await ctx.close()
}

await done()
