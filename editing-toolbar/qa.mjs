// Editing toolbar in a real browser: the bar at the top of a note, its buttons changing the note as the app's commands
// do, headings from its menu, More when it doesn't fit, near the selection, its settings sheet, reading view, and on a
// phone above the keyboard. WRITES a "Qa toolbar" folder and the plugin's settings: a throwaway server only.
//   node editing-toolbar/qa.mjs <base url> <vault path> [out dir]     (VAULTITE_APP: the app's checkout, ../vaultite)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const [B, VAULT, OUT = "/tmp/editing-toolbar-shots/"] = process.argv.slice(2)
if (!B || !VAULT) { console.error("usage: node editing-toolbar/qa.mjs <base url> <vault path> [out dir]"); process.exit(2) }
const APP = process.env.VAULTITE_APP ?? path.resolve(import.meta.dirname, "../../vaultite")
const { chromium } = await import(path.join(APP, "node_modules/playwright-core/index.mjs"))
const base = B.endsWith("/") ? B : `${B}/`
mkdirSync(OUT, { recursive: true })

const fails = [], errs = []
const check = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : `  (got ${JSON.stringify(got)?.slice(0, 400)})`}`)
  if (!ok) fails.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms
  for (;;) { let v; try { v = await fn() } catch { /* not yet */ } if (v || Date.now() > end) return v; await wait(100) }
}
const settings = (body) => fetch(`${base}api/config/plugin/editing-toolbar`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

const DIR = "Qa toolbar", NOTE = path.join(VAULT, DIR, "Toolbar.md")
rmSync(path.join(VAULT, DIR), { recursive: true, force: true })
mkdirSync(path.join(VAULT, DIR), { recursive: true })
const START = "alpha beta gamma\nsecond line\nthird line\n"
writeFileSync(NOTE, START)
const disk = () => readFileSync(NOTE, "utf8")
const saved = (want) => until(() => (typeof want === "function" ? want(disk()) : disk().includes(want)))
await settings({ position: null, phone: null, buttons: null })

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
const open = async (ctx) => {
  await ctx.addInitScript(() => { try { localStorage.setItem("vaultite.editMode", "live") } catch { /* not the app's frame */ } })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => errs.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()) })
  await page.goto(`${base}#file/${encodeURIComponent(`${DIR}/Toolbar.md`)}`)
  await page.waitForSelector(".cm-content", { timeout: 15000 })
  await wait(800)
  return page
}
try {
  // ---- a computer: the bar along the top of the note ----
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: "light" })
  const page = await open(ctx)
  const line = (n) => page.locator("[data-pane] .cm-content .cm-line").nth(n - 1)
  const select = async (n, word) => {
    await line(n).click(); await page.keyboard.press("Home")
    await page.keyboard.press(word ? "Shift+Alt+ArrowRight" : "Shift+End"); await wait(100)
  }
  const press = async (id) => { await page.locator(`[data-pane] [data-toolbar-button="${id}"]`).first().click(); await wait(250) }
  const reset = async (text = START) => { writeFileSync(NOTE, text); await until(async () => (await line(1).textContent()) === text.split("\n")[0]); await wait(300) }

  const bar = page.locator("[data-pane] [data-editing-toolbar=top]")
  check("the bar is along the top of the note", await bar.count() === 1 && await bar.isVisible())
  const ids = await bar.locator("[data-toolbar-button]").evaluateAll((els) => els.map((e) => e.getAttribute("data-toolbar-button")))
  check("its default buttons, in order", ids.join(",") === "undo,redo,heading,bold,italic,strikethrough,highlight,code,internal-link,external-link,bullet-list,numbered-list,task-list,indent,outdent,quote,callout,code-block,table,clear-formatting", ids)
  await page.locator("[data-pane] [data-toolbar-button=bold]").hover(); await wait(700)
  check("a button's tooltip says its keys", /Bold ⌘B/.test(await page.locator("body").innerText()))
  await page.screenshot({ path: `${OUT}desktop-top.png` })

  await select(1, true); await press("bold")
  check("Bold makes the selection bold", !!await saved("**alpha** beta"), disk())
  check("the keyboard stays in the note, the word still selected", await page.evaluate(() => !!document.activeElement?.closest(".cm-content") && getSelection()?.toString() === "alpha"))
  await press("italic"); check("Italic on top of it", !!await saved("***alpha***"), disk())
  await press("undo"); check("Undo takes the last one back", !!await saved((t) => t.startsWith("**alpha** beta")), disk())
  await press("redo"); check("Redo does it again", !!await saved("***alpha***"), disk())
  await reset()
  for (const [id, want] of [["strikethrough", "~~alpha~~"], ["highlight", "==alpha=="], ["code", "`alpha`"]]) {
    await select(1, true); await press(id)
    check(`${id} wraps the selection`, !!await saved(want), disk()); await reset()
  }
  await select(2, true); await press("internal-link"); check("Add link makes a [[link]]", !!await saved("[[second]]"), disk()); await reset()

  // Headings from the bar's menu.
  await line(1).click(); await press("heading")
  const items = await page.locator("[role=menu] [role=menuitem]").allTextContents()
  check("Heading opens a menu of levels and Body", ["Heading 1", "Heading 6", "Body"].every((x) => items.some((i) => i.startsWith(x))), items)
  await page.screenshot({ path: `${OUT}desktop-heading-menu.png` })
  await page.getByRole("menuitem", { name: /^Heading 2/ }).click(); await wait(300)
  check("Heading 2 makes the line a heading", !!await saved("## alpha beta gamma"), disk()); await reset()

  // Lists and blocks.
  await line(2).click(); await press("bullet-list"); check("Bullet list", !!await saved("\n- second line"), disk())
  await press("indent"); check("Indent moves the item in", !!await saved((t) => /\n\s+- second line/.test(t)), disk())
  await press("outdent"); check("Outdent moves it back", !!await saved("\n- second line"), disk()); await reset()
  await line(2).click(); await press("task-list"); check("Task list", !!await saved("- [ ] second line"), disk()); await reset()
  await line(2).click(); await press("numbered-list"); check("Numbered list", !!await saved("1. second line"), disk()); await reset()
  await line(3).click(); await press("quote"); check("Quote", !!await saved("> third line"), disk()); await reset()
  await line(3).click(); await page.keyboard.press("End"); await press("table"); check("Table", !!await saved("| --- | --- |"), disk()); await reset()
  await line(3).click(); await page.keyboard.press("End"); await press("code-block"); check("Code block", !!await saved("```\n"), disk()); await reset()

  // Sticky: a long note scrolled keeps the bar on screen.
  await reset(`${START}${Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")}\n`)
  await page.locator("[data-pane] .cm-content .cm-line", { hasText: "line 70" }).scrollIntoViewIfNeeded(); await wait(300)
  const box = await bar.boundingBox()
  check("scrolled down, the bar stays at the top of the pane", !!box && box.y >= 30 && box.y < 120, box)
  await page.screenshot({ path: `${OUT}desktop-scrolled.png` })
  await reset()

  // Narrow: what doesn't fit goes under More.
  await page.setViewportSize({ width: 820, height: 800 }); await wait(500)
  const more = page.locator("[data-pane] [data-toolbar-button=more]")
  check("narrow, the rest is under More", await more.count() === 1, await bar.locator("[data-toolbar-button]").count())
  await more.click(); await wait(250)
  const rest = await page.locator("[role=menu] [role=menuitem]").allTextContents()
  check("More lists the buttons that didn't fit", rest.some((i) => i.startsWith("Clear formatting")), rest)
  await page.screenshot({ path: `${OUT}desktop-narrow-more.png` })
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 1200, height: 800 }); await wait(400)

  // Reading view: no bar.
  await page.keyboard.press("Meta+e"); await wait(500)
  check("in reading view there's no bar", await bar.count() === 0)
  await page.keyboard.press("Meta+e"); await wait(500)

  // Near the selection.
  await settings({ position: "floating" })
  await until(async () => await bar.count() === 0)
  check("set to near the selection, the top bar goes", await bar.count() === 0)
  const tip = page.locator("[data-editing-toolbar=floating]")
  await line(2).click(); await wait(200)
  check("no bar without a selection", await tip.count() === 0)
  const l2 = await line(2).boundingBox()
  await page.mouse.move(l2.x + 2, l2.y + l2.height / 2); await page.mouse.down()
  await page.mouse.move(l2.x + 60, l2.y + l2.height / 2, { steps: 4 }); await wait(150)
  check("not while the mouse still drags", await tip.count() === 0)
  await page.mouse.up(); await wait(300)
  const tb = await tip.boundingBox()
  check("the bar shows above the selection", !!tb && tb.y + tb.height <= l2.y + 2 && tb.y > l2.y - 80, [tb, l2])
  await page.screenshot({ path: `${OUT}desktop-floating.png` })
  await tip.locator("[data-toolbar-button=bold]").click(); await wait(250)
  check("its Bold works on the selection", !!await saved((t) => /\*\*[^*]+\*\*/.test(t.split("\n")[1])), disk())
  await page.keyboard.press("End"); await wait(200)
  check("the selection gone, so is the bar", await tip.count() === 0)
  await reset(); await settings({ position: null })

  // Its settings: turn a button off, back on, and Reset.
  await page.keyboard.press("Meta+p"); await wait(300); await page.keyboard.type("Open Editing toolbar settings"); await wait(300); await page.keyboard.press("Enter")
  await page.waitForSelector("[data-toolbar-settings]", { timeout: 5000 })
  await wait(400)
  await page.screenshot({ path: `${OUT}desktop-settings.png` })
  const formRows = await page.locator("[data-setting]").evaluateAll((els) => els.map((e) => e.getAttribute("data-setting")))
  check("the sheet has Position and On phones from the manifest", formRows.includes("position") && formRows.includes("phone"), formRows)
  await page.locator('[data-toolbar-setting=bold] [role=switch]').click(); await wait(400)
  const saidFile = () => JSON.parse(readFileSync(path.join(VAULT, ".vaultite/plugins/editing-toolbar/data.json"), "utf8"))
  check("switching Bold off saves the list without it", !saidFile().buttons.includes("bold"), saidFile())
  check("the bar loses Bold", await bar.locator("[data-toolbar-button=bold]").count() === 0)
  await page.locator('[data-toolbar-setting=bold] [role=switch]').click(); await wait(400)
  check("switched on again it goes at the end", saidFile().buttons.at(-1) === "bold", saidFile())
  await page.locator("[data-toolbar-reset]").click(); await wait(400)
  check("Reset leaves the default (no key in the file)", saidFile().buttons === undefined, saidFile())
  await page.keyboard.press("Escape"); await wait(300)

  // Text kept outside a note's view (a canvas card) gets no bar.
  writeFileSync(path.join(VAULT, DIR, "Board.canvas"), JSON.stringify({ nodes: [{ id: "t1", type: "text", x: 0, y: 0, width: 320, height: 160, text: "Card text" }], edges: [] }))
  await page.goto("about:blank"); await page.goto(`${base}#file/${encodeURIComponent(`${DIR}/Board.canvas`)}`)
  await page.locator("[data-canvas-node=t1]").dblclick({ position: { x: 200, y: 120 }, timeout: 10000 }); await wait(600)
  check("a canvas card being edited has no bar", await page.locator(".canvas-edit .cm-content").count() === 1 && await page.locator("[data-editing-toolbar]").count() === 0)
  await ctx.close()

  // ---- a phone: above the keyboard (or the phone's bar while there's none) ----
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: "dark" })
  const phone = await open(pctx)
  const pline = (n) => phone.locator(".cm-content .cm-line").nth(n - 1)
  const kb = phone.locator("[data-editing-toolbar=keyboard]")
  check("on a phone, reading a note, no bar", await kb.count() === 0 && await phone.locator("[data-editing-toolbar=top]").count() === 0)
  await phone.locator("[data-view-toggle=read]").tap(); await wait(500)
  check("editing it, still none until it's typed in", await kb.count() === 0)
  await pline(1).tap(); await wait(400)
  check("typing in the note, the bar shows at the bottom", await kb.count() === 1 && await kb.isVisible())
  const kbox = await kb.boundingBox()
  check("its buttons are 44px", (await kb.locator("[data-toolbar-button=bold]").boundingBox())?.height === 44)
  check("it sits above the phone's bar", !!kbox && kbox.y + kbox.height <= 844 - 48, kbox)
  await phone.keyboard.press("Home"); await phone.keyboard.press("Shift+End"); await wait(100)
  await kb.locator("[data-toolbar-button=bold]").tap(); await wait(300)
  check("a tap on Bold makes the line bold", !!await saved("**alpha beta gamma**"), disk())
  check("and the keyboard stays in the note", await phone.evaluate(() => !!document.activeElement?.closest(".cm-content")))
  await phone.screenshot({ path: `${OUT}phone-keyboard.png` })
  await kb.locator("[data-toolbar-button=heading]").tap(); await wait(300)
  await phone.screenshot({ path: `${OUT}phone-heading-menu.png` })
  check("Heading's menu opens above the bar, which stays", await phone.locator("[role=menu]").count() > 0 && await kb.count() === 1
    && (await phone.locator("[role=menu]").first().boundingBox()).y + 10 < (await kb.boundingBox()).y)
  await phone.getByRole("menuitem", { name: /^Heading 1/ }).tap(); await wait(300)
  check("Heading 1 from the phone", !!await saved("# **alpha"), disk())
  const scrolls = await kb.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === "auto")
  check("the phone's bar scrolls sideways", scrolls)
  await reset()
  await settings({ phone: "same" }); await wait(800)
  await pline(2).tap(); await wait(300)
  const topBar = phone.locator("[data-editing-toolbar=top]")
  check("phones set to as on a computer: the top bar", await topBar.count() === 1 && await kb.count() === 0)
  check("with a phone's 44px buttons", (await topBar.locator("[data-toolbar-button=bold]").boundingBox())?.height === 44)
  await phone.screenshot({ path: `${OUT}phone-top.png` })
  await settings({ phone: "off" }); await wait(800)
  check("phones set to hidden: no bar", await phone.locator("[data-editing-toolbar]").count() === 0)
  await settings({ phone: null }); await wait(300)
  await pctx.close()
} finally {
  await browser.close()
  rmSync(path.join(VAULT, DIR), { recursive: true, force: true })
}
check("no page errors", !errs.length, errs.slice(0, 5))
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed")
process.exit(fails.length ? 1 : 0)
