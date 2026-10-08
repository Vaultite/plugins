// Kanban: an Obsidian Kanban board opens as lanes of cards; ticking, dragging cards (between and within lanes) and
// lanes, adding a card and a lane, editing a card in place, archiving one (and Undo) each write the file as a small
// edit; links, tags and dates show on cards; an agent's change on disk shows; editing view is the Markdown; "New board"
// makes one; desktop and a 390px phone (one lane wide, a held finger drags), light and dark.
// Installs the plugin; WRITES a "Qa kanban" folder and the workspaces' data.json (put back): throwaway server only.
//   node kanban/.test/qa/kanban.mjs <base url> <vault path> [out dir]
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fingers, install, palette, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const k = await import("../../format.ts")
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const req = (method, p, body) => fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) })
const F = "Qa kanban", BOARD = `${F}/Launch.md`
const SAMPLE = readFileSync(path.join(import.meta.dirname, "..", "sample.md"), "utf8")
const read = () => readFileSync(path.join(VAULT, BOARD), "utf8")
const lanes = () => k.parseBoard(read()).lanes.map((l) => l.cards.map((c) => c.text.split("\n")[0]))
const reset = async () => { await req("PUT", "file", { path: BOARD, text: SAMPLE }); await wait(900) }

const putBackWs = setAsideWorkspaces(VAULT)
await req("DELETE", `file?path=${encodeURIComponent(F)}`)
await req("POST", "file", { path: BOARD, text: SAMPLE })
await req("POST", "file", { path: `${F}/Alice Park.md`, text: "A person the board links to.\n" })
install(B, "kanban")

/** A page on the board in a fresh context. */
async function open(ctxOpts, label) {
  const ctx = await browser.newContext(ctxOpts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank")
  await page.goto(`${B}#file/${encodeURIComponent(BOARD)}`)
  await page.locator("[data-kanban-lane]").first().waitFor({ timeout: 15000 })
  await wait(600)
  return { ctx, page }
}
const card = (page, lane, i) => page.locator(`[data-kanban-lane="${lane}"] [data-kanban-card="${i}"]`)
/** The mouse from the middle of one element to a point, in steps (the app's drag starts after 5px). */
async function mouseDrag(page, from, to) {
  const a = await from.boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + Math.min(14, a.height / 2))
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + 20, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 14 })
  await wait(150)
  const line = await page.locator("[data-kanban-drop]").count()
  await page.mouse.up()
  await wait(700)
  return line
}

// ---------- desktop, light
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 }, colorScheme: "light" }, "desktop")
  check("4 lanes, the collapsed one narrow, counts and the limit", await page.locator("[data-kanban-lane]").count() === 4 &&
    await page.locator("[data-kanban-lane][data-collapsed]").count() === 1 && (await page.locator('[data-kanban-lane="1"] [data-kanban-lane-count]').textContent()) === "2/2")
  check("a card's [[link]] is a link, its #tag a tag, its date under it", await page.locator('[data-kanban-card] [data-wiki]').count() >= 1 &&
    await page.locator("[data-kanban-card] [data-tag]").count() >= 2 && (await page.locator("[data-kanban-date]").first().textContent()).includes("Oct 12"))
  await page.screenshot({ path: `${OUT}kanban-desktop-light.png` })

  // Tick a card: one line changes.
  await card(page, 0, 0).locator("[role=checkbox]").click()
  check("ticking a card writes [x] on its line", await until(() => read().includes("- [x] Draft the Lighthouse launch post"), 3000))
  await card(page, 0, 0).locator("[role=checkbox]").click()
  await until(() => read() === SAMPLE, 3000)
  check("and unticking puts the file back as it was", read() === SAMPLE)

  // Drag a card to another lane, between two cards.
  const doing = await card(page, 1, 1).boundingBox()
  const line = await mouseDrag(page, card(page, 0, 2), { x: doing.x + doing.width / 2, y: doing.y + 4 })
  check("dragging shows where it lands", line >= 1)
  check("a card dragged to another lane lands between two cards", await until(() => JSON.stringify(lanes()[1]) === JSON.stringify(["Fix the onboarding copy #web", "Order sample prints", "Update the pricing page"]), 3000), lanes())
  check("its block id came with it, nothing else changed", read().includes("- [ ] Order sample prints ^k3v9\n- [x] Update") && read().split("\n").sort().join() === SAMPLE.split("\n").sort().join())
  await page.screenshot({ path: `${OUT}kanban-desktop-moved.png` })
  // Within a lane: the first card to the bottom.
  const last = await card(page, 0, 1).boundingBox()
  await mouseDrag(page, card(page, 0, 0), { x: last.x + last.width / 2, y: last.y + last.height - 3 })
  check("a card dragged down its own lane", await until(() => lanes()[0][1]?.startsWith("Draft the Lighthouse"), 3000), lanes())
  // Into the complete lane: ticked.
  const done1 = await card(page, 2, 0).boundingBox()
  await mouseDrag(page, card(page, 1, 0), { x: done1.x + done1.width / 2, y: done1.y + done1.height - 2 })
  check("a card dragged into the complete lane is ticked", await until(() => read().includes("- [x] Ship the beta to Bob Lee\n- [x] Fix the onboarding copy #web"), 3000), lanes())
  // A lane by its heading: Done before Doing.
  const head = page.locator('[data-kanban-lane="2"] [data-kanban-lane-head]')
  const doingLane = await page.locator('[data-kanban-lane="1"]').boundingBox()
  await mouseDrag(page, head, { x: doingLane.x + 20, y: doingLane.y + 30 })
  check("a lane dragged by its heading moves with its cards", await until(() => k.parseBoard(read()).lanes.map((l) => l.title).join() === "Backlog,Done,Doing,Empty lane", 3000),
    k.parseBoard(read()).lanes.map((l) => l.title))
  check("the collapsed flags follow the lanes", JSON.stringify(k.parseBoard(read()).settings["list-collapse"]) === "[false,false,false,true]")
  await reset()

  // Add a card: Enter adds and opens the next, Escape closes.
  await page.locator('[data-kanban-lane="0"] [data-kanban-add-card]').click()
  await page.locator("[data-kanban-new-card] .cm-content").waitFor()
  await page.keyboard.type("Plan the demo with [[Alice")
  await wait(400)
  await page.keyboard.press("Escape") // (the link suggestions)
  await page.keyboard.type("]] @{2026-10-20}")
  await page.keyboard.press("Enter")
  check("a card added from the lane, at its end", await until(() => read().includes("- [ ] Order sample prints ^k3v9\n- [ ] Plan the demo with [[Alice]] @{2026-10-20}\n"), 3000), lanes()[0])
  check("and the next new card is open", await page.locator("[data-kanban-new-card] .cm-content").count() === 1)
  await page.keyboard.press("Escape"); await wait(300)
  check("Escape closes it, nothing added", await page.locator("[data-kanban-new-card]").count() === 0 && lanes()[0].length === 4)

  // Edit a card in place: double-click, Shift+Enter for a second line, Enter keeps it.
  await card(page, 1, 0).dblclick()
  await page.locator("[data-kanban-card][data-editing] .cm-content").waitFor()
  await page.keyboard.press("Meta+a"); await page.keyboard.type("Fix the onboarding copy #web")
  await page.keyboard.press("Shift+Enter"); await page.keyboard.type("and the welcome email")
  await page.keyboard.press("Enter")
  check("a card edited in place: a second line indented under it", await until(() => read().includes("- [ ] Fix the onboarding copy #web\n\tand the welcome email\n- [x] Update"), 3000), read().split("\n").slice(16, 20))
  await page.screenshot({ path: `${OUT}kanban-desktop-edited.png` })

  // Add a lane.
  await page.locator("[data-kanban-add-lane]").click()
  await page.keyboard.type("Review"); await page.keyboard.press("Enter")
  check("a lane added after the others, before the archive", await until(() => k.parseBoard(read()).lanes.map((l) => l.title).join() === "Backlog,Doing,Done,Empty lane,Review", 3000) &&
    k.parseBoard(read()).archive?.cards.length === 1)

  // Archive a card from its menu, then Undo.
  await card(page, 0, 0).hover()
  await card(page, 0, 0).locator("[data-kanban-card-menu]").click()
  await page.getByRole("menuitem", { name: "Archive" }).click()
  check("archived from its menu: into ## Archive, dated (the board's setting)", await until(() => k.parseBoard(read()).archive?.cards.length === 2, 3000) &&
    /- \[ \] \d{4}-\d{2}-\d{2} \d{2}:\d{2} Draft the Lighthouse launch post/.test(read()))
  await page.getByRole("button", { name: "Undo" }).click()
  check("Undo puts it back", await until(() => lanes()[0][0]?.startsWith("Draft the Lighthouse") && k.parseBoard(read()).archive?.cards.length === 1, 3000), lanes()[0])

  // An agent's change on disk shows on the board.
  await req("POST", "ops/kanban.add", { path: BOARD, lane: "Empty lane", text: "Added by an agent" })
  await page.locator('[data-kanban-lane="3"]').click() // (collapsed: a click opens it)
  check("an agent's card shows", await until(async () => (await page.locator('[data-kanban-lane="3"]').textContent()).includes("Added by an agent"), 4000))

  // Editing view is the Markdown.
  await page.keyboard.press("Meta+e"); await wait(800)
  check("⌘E: the board's Markdown in the editor", (await page.locator(".cm-content").first().textContent()).includes("## Backlog") && !(await page.locator("[data-kanban-lane]").count()))
  await page.keyboard.press("Meta+e"); await wait(800)
  check("and back to the board", await page.locator("[data-kanban-lane]").count() === 5)
  await reset()

  // New board, from the palette: where new notes go, Obsidian's shape, opened as a board.
  const before = new Set(readdirSync(VAULT))
  await palette(page, "New board", 1500)
  const made = readdirSync(VAULT).filter((f) => !before.has(f) && f.endsWith(".md"))
  check(`"New board" makes one where new notes go (${made.join(", ")})`, made.length === 1 && k.isBoard(readFileSync(path.join(VAULT, made[0]), "utf8")), made)
  check("and opens it as a board: To do, Doing, Done", await until(async () => (await page.locator("[data-kanban-lane]").count()) === 3, 4000))
  await page.screenshot({ path: `${OUT}kanban-desktop-new.png` })
  for (const f of made) await req("DELETE", `file?path=${encodeURIComponent(f)}`)
  await ctx.close()
}

// ---------- desktop, dark
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" }, "dark")
  await page.screenshot({ path: `${OUT}kanban-desktop-dark.png` })
  await ctx.close()
}

// ---------- phone, light and dark: one lane wide, swiped sideways, a held finger drags a card to the next lane
for (const scheme of ["light", "dark"]) {
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme }, `phone ${scheme}`)
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: innerWidth }))
  const lane = await page.locator('[data-kanban-lane="0"]').boundingBox()
  check(`390px ${scheme}: the page doesn't scroll sideways, a lane is about the screen's width (${Math.round(lane.width)})`, w.doc <= 390 && lane.width > 320 && lane.width < 370, w)
  await page.screenshot({ path: `${OUT}kanban-phone-${scheme}.png` })
  if (scheme === "dark") { await ctx.close(); continue }
  const { touch, swipe } = await fingers(page)
  const scroller = page.locator("[data-kanban-lanes]")
  await swipe(300, lane.y + 40, 60, lane.y + 40)
  await wait(700)
  const left = await scroller.evaluate((e) => e.scrollLeft)
  check(`a swipe shows the next lane, snapped (${Math.round(left)})`, left > 300)
  await page.screenshot({ path: `${OUT}kanban-phone-swiped.png` })
  await scroller.evaluate((e) => { e.scrollLeft = 0 }); await wait(500)
  // Hold a card, then drag it right: the board scrolls to Doing at the edge; drop it there.
  const c = await card(page, 0, 0).boundingBox()
  const x = c.x + 60, y = c.y + c.height / 2
  await touch("touchStart", x, y)
  await wait(700)
  for (let i = 1; i <= 10; i++) { await touch("touchMove", x + i * 28, y); await wait(30) }
  // (held at the edge, the lanes scroll: until the next one is in view, then the finger goes back to the middle)
  const scrolled = await until(async () => { const l = await scroller.evaluate((e) => e.scrollLeft); return l > 250 && l }, 4000)
  for (let i = 1; i <= 6; i++) { await touch("touchMove", 360 - i * 25, y + 20); await wait(30) }
  await wait(300)
  const under = await page.evaluate(([x, y]) => Number(document.elementFromPoint(x, y)?.closest("[data-kanban-lane]")?.dataset.kanbanLane ?? -1), [210, y + 20])
  await page.screenshot({ path: `${OUT}kanban-phone-dragging.png` })
  await touch("touchEnd", 210, y + 20)
  check(`a held card dragged to the edge scrolls the lanes (${Math.round(scrolled || 0)})`, scrolled > 250)
  check(`and drops into the lane under the finger (${under})`, under > 0 && await until(() => lanes()[under]?.includes("Draft the Lighthouse launch post @{2026-10-12} #writing"), 3000), lanes())
  await page.keyboard.press("Escape")
  // A tap on a card edits it.
  await reset()
  await page.locator('[data-kanban-lane="0"] [data-kanban-card="2"] .note-prose').tap()
  check("a tap on a card edits it", await until(() => page.locator("[data-kanban-card][data-editing] .cm-content").count(), 2000))
  await page.screenshot({ path: `${OUT}kanban-phone-editing.png` })
  await ctx.close()
}

await req("DELETE", `file?path=${encodeURIComponent(F)}`)
putBackWs()
writeFileSync(path.join(OUT, "kanban-done.txt"), new Date().toISOString())
await done()
