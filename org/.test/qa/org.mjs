// Org files in a browser: reading, live preview and source, desktop and phone, light and dark, with screenshots.
// Installs the plugin and WRITES under Notes/Org qa/: a throwaway server only.
//   node org/.test/qa/org.mjs <base url> <vault path> [out dir]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { install, palette, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const DIR = "Notes/Org qa", FILE = `${DIR}/launch.org`
mkdirSync(`${VAULT}/${DIR}/pics`, { recursive: true })
copyFileSync(new URL("./rich.org", import.meta.url), `${VAULT}/${FILE}`)
writeFileSync(`${VAULT}/${DIR}/notes.org`, "#+TITLE: Notes\n\n* Somewhere\nText.\n")
writeFileSync(`${VAULT}/${DIR}/pics/harbor.png`, png(480, 160))
const putBackWs = setAsideWorkspaces(B)
install(B, "org", { edits: true })

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const tall = process.env.ORG_TALL === "1"
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: tall ? 2600 : 860 } }], ["phone", { ...phone, viewport: { width: 390, height: tall ? 3400 : 844 } }]]) {
  for (const dark of [false, true]) {
    const scheme = dark ? "dark" : "light", name = `${label} ${scheme}`
    const ctx = await browser.newContext({ ...opts, colorScheme: scheme })
    const page = watch(await ctx.newPage(), { label: name, console: true })
    await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent(FILE)}`)
    // Desktop opens editing (live preview), a phone reading.
    const first = label === "desktop" ? "[data-org-live] .cm-content" : "[data-org-doc]"
    check(`${name}: the file drawn`, await until(async () => (await page.locator(first).count()) === 1, 15000), await page.locator(first).count())
    await wait(1200)
    await page.screenshot({ path: `${OUT}org-${label}-${scheme}-${label === "desktop" ? "live" : "reading"}.png` })
    if (label === "desktop") await page.keyboard.press("Meta+e")
    else await page.locator("button[aria-label=Edit]").first().click()
    const other = label === "desktop" ? "[data-org-doc]" : "[data-org-live] .cm-content"
    check(`${name}: and the other way`, await until(async () => (await page.locator(other).count()) === 1, 8000))
    await wait(1200)
    await page.screenshot({ path: `${OUT}org-${label}-${scheme}-${label === "desktop" ? "reading" : "live"}.png` })
    if (label === "phone" && !dark) {
      await page.locator(".cm-line", { hasText: "Turn on billing" }).click(); await page.keyboard.press("End")
      await page.keyboard.type(" soon"); await wait(300)
      check("phone: typing in live preview", await until(() => readFileSync(`${VAULT}/${FILE}`, "utf8").includes("Turn on billing soon"), 6000))
      copyFileSync(new URL("./rich.org", import.meta.url), `${VAULT}/${FILE}`)
    }
    await ctx.close()
  }
}

// Live preview: typing (a list continues), boxes and keywords as widgets, undo, the file changed elsewhere while open,
// a fold kept for reading, a link followed.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" })
  const page = watch(await ctx.newPage(), { label: "editing", console: true })
  await page.goto(`${B}#file/${encodeURIComponent(FILE)}`)
  const ed = page.locator("[data-org-live] .cm-content")
  await until(async () => (await ed.count()) === 1, 15000)
  await wait(800)
  const text = () => readFileSync(`${VAULT}/${FILE}`, "utf8")
  const line = (t) => ed.locator(".cm-line", { hasText: t })
  check("off the cursor's line: stars, markers and link targets hidden; chips drawn", !(await line("Ship the beta").innerText()).includes("*") &&
    await line("Ship the beta").locator(".org-kw").count() === 1 && await line("Ship the beta").locator(".org-tags a.tag").count() === 2 &&
    !(await line("The launch of").innerText()).includes("[[") && await ed.locator(".org-chip").count() >= 2 && await ed.locator(".cm-task").count() >= 5)
  await line("Turn on billing").click(); await page.keyboard.press("End")
  check("on it: the line's own text", (await line("Turn on billing").innerText()).startsWith("- [ ] Turn on billing"), await line("Turn on billing").innerText())
  await page.keyboard.press("Enter"); await page.keyboard.type("Ship it")
  check("typing: Enter continues the list, with a box", await until(() => text().includes("- [ ] Turn on billing\n- [ ] Ship it\n"), 6000), text().slice(700, 900))
  await line("North Pier").locator(".cm-task").click()
  check("a box ticks: its parent and the cookies follow", await until(() => text().includes("- [X] North Pier") && /- \[X\] Invite the teams/.test(text()) && text().includes("[3/5] [60%]"), 6000), text().slice(600, 900))
  await line("Legal review").locator(".org-kw").click()
  check("a keyword moves on, CLOSED written", await until(() => /\* DONE Legal review\nCLOSED: \[\d{4}-\d\d-\d\d \w{3} \d\d:\d\d\] SCHEDULED/.test(text()), 6000), text().slice(900, 1300))
  await line("Landing page copy").locator(".org-kw").click({ button: "right" })
  await page.locator("[data-menu-list] > button", { hasText: "CANCELLED" }).click()
  check("its menu sets any keyword", await until(() => text().includes("** CANCELLED [#C] Landing page copy"), 6000))
  await page.screenshot({ path: `${OUT}org-desktop-light-edited.png` })
  // The other plugins' extensions come too: ⌘F finds in the editor.
  await line("Ship it").click(); await page.keyboard.press("Meta+f"); await wait(500)
  await page.keyboard.type("Harbor"); await wait(500)
  const bar = page.locator("[data-find-bar]:not([data-page-find])")
  check("⌘F: the editor's find bar, finding in the file", await bar.count() === 1 && /\d+ of 2/.test(await bar.locator("[data-find-count]").innerText().catch(() => "")), await page.locator("[data-find-bar]").evaluateAll((e) => e.map((x) => x.outerHTML.slice(0, 200))))
  await page.screenshot({ path: `${OUT}org-desktop-light-find.png` })
  const field = bar.locator("input").first()
  await field.fill("example.com/brief"); await wait(500)
  const hidden = await bar.locator("[data-find-count]").innerText().catch(() => "")
  await field.fill("brief"); await wait(500)
  const seen = await bar.locator("[data-find-count]").innerText().catch(() => "")
  check("⌘F: a link's hidden target isn't found, its text is", !/[1-9]/.test(hidden) && /1/.test(seen), [hidden, seen])
  await page.keyboard.press("Escape"); await wait(300)
  // Changed elsewhere while open: it comes in, the cursor stays where it was, and undo still takes back the user's own.
  await line("Ship it").click(); await page.keyboard.press("End")
  writeFileSync(`${VAULT}/${FILE}`, text().replace("The launch of", "Changed elsewhere. The launch of"))
  check("the file changed elsewhere comes in while open", await until(async () => (await line("Changed elsewhere").count()) === 1, 10000))
  await page.keyboard.type("!")
  check("...the cursor kept its place", await until(() => text().includes("- [ ] Ship it!"), 6000), text().slice(700, 950))
  await page.keyboard.press("Meta+z"); await wait(300)
  check("undo takes back the user's own edit only", await until(() => text().includes("- [ ] Ship it\n") && text().includes("Changed elsewhere."), 6000))
  await page.keyboard.press("Meta+z"); await wait(300)
  check("...and the one before (the keyword)", await until(() => text().includes("** TODO [#C] Landing page copy"), 6000))
  // A fold made here holds in reading.
  await line("Ship the beta").click(); await page.keyboard.press("End"); await page.keyboard.press("Tab"); await wait(500)
  check("Tab folds a headline", await line("Freeze the API").count() === 0)
  await page.keyboard.press("Meta+e"); await wait(1000)
  const doc = page.locator("[data-org-doc]")
  check("the fold holds in reading", await doc.locator(".org-fold.is-folded").count() >= 1 && await doc.locator("li", { hasText: "Freeze the API" }).count() === 0)
  await doc.locator("a", { hasText: "the beta" }).click(); await wait(800)
  check("[[#custom-id]] unfolds and goes there", await doc.locator("li", { hasText: "Freeze the API" }).count() === 1)
  await doc.locator("a", { hasText: "the budget" }).click(); await wait(800)
  const top = await doc.locator("h1.org-h", { hasText: "Budget" }).evaluate((e) => e.getBoundingClientRect().top)
  check("[[*Budget]] scrolls to it", top > 0 && top < 300, top)
  await page.keyboard.press("Meta+e"); await wait(1000)
  await page.evaluate(() => document.querySelector("[data-org-live]")?.scrollIntoView()); await wait(300)
  await ed.locator(".cm-org-link", { hasText: "the budget" }).click(); await wait(600)
  check("live: a link off the cursor's line is followed", (await page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent ?? "")).includes("Budget"))
  await ctx.close()
  copyFileSync(new URL("./rich.org", import.meta.url), `${VAULT}/${FILE}`)
}

// The source: highlighted as a note's (headings by level), Tab folds a headline, Alt+→ demotes it.
for (const dark of [false, true]) {
  const scheme = dark ? "dark" : "light"
  const ctx = await browser.newContext({ viewport: { width: 1280, height: tall ? 2400 : 860 }, colorScheme: scheme })
  const page = watch(await ctx.newPage(), { label: `source ${scheme}`, console: true })
  await page.goto(`${B}#file/${encodeURIComponent(FILE)}`)
  await until(async () => (await page.locator("[data-org-doc]").count()) === 1, 15000)
  await palette(page, "Switch to source mode")
  const ed = page.locator(".cm-content")
  check(`source ${scheme}: headlines drawn as the note's headings`, await until(async () => (await ed.locator(".cm-line.cm-h1").count()) >= 1 && (await ed.locator(".cm-line.cm-h2").count()) >= 1, 6000))
  check(`source ${scheme}: keywords and dates`, await ed.locator(".cm-org-kw").count() >= 2 && await ed.locator(".cm-org-time").count() >= 3)
  await page.screenshot({ path: `${OUT}org-source-${scheme}.png` })
  if (!dark) {
    await ed.locator(".cm-line", { hasText: "Ship the beta" }).click(); await page.keyboard.press("End")
    await page.keyboard.press("Tab"); await wait(300)
    check("source: Tab folds the headline", await ed.locator(".cm-line", { hasText: "Freeze the API" }).count() === 0 && await page.locator(".cm-foldPlaceholder").count() === 1)
    await page.keyboard.press("Tab"); await wait(200)
    await page.keyboard.press("Alt+ArrowRight"); await wait(200)
    check("source: Alt+→ demotes it", (await ed.locator(".cm-line", { hasText: "Ship the beta" }).innerText()).startsWith("** NEXT"))
    await page.keyboard.press("Meta+z")
  }
  await ctx.close()
}
copyFileSync(new URL("./rich.org", import.meta.url), `${VAULT}/${FILE}`)

// Embedded in a note, whole and one headline; and a Markdown note beside, to compare the look.
writeFileSync(`${VAULT}/${DIR}/Embeds.md`, "# Embeds\n\nThe budget:\n\n![[launch.org#Budget]]\n\nA note:\n\n![[Compare#Budget]]\n")
writeFileSync(`${VAULT}/${DIR}/Compare.md`, readFileSync(new URL("./compare.md", import.meta.url), "utf8"))
for (const [name, file] of [["embed", `${DIR}/Embeds.md`], ["markdown", `${DIR}/Compare.md`]]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: tall ? 1600 : 860 }, colorScheme: "light" })
  const page = watch(await ctx.newPage(), { label: name, console: true })
  await page.goto(`${B}#file/${encodeURIComponent(file)}`); await wait(2500)
  if (name === "markdown") { await page.keyboard.press("Meta+e"); await wait(1000) }
  if (name === "embed") check("an embed draws the headline", await until(async () => (await page.locator("[data-org-doc] h1.org-h", { hasText: "Budget" }).count()) === 1, 8000))
  await page.screenshot({ path: `${OUT}org-${name}.png` })
  await ctx.close()
}
// The Plugins page's preview: the made-up sample drawn.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" })
  const page = watch(await ctx.newPage(), { label: "preview", console: true })
  await page.goto(`${B}#plugins`)
  const row = page.locator('[data-plugin-row="org"]')
  await until(async () => (await row.count()) > 0, 10000)
  await row.first().click()
  const prev = page.locator("[data-org-doc]")
  check("the Plugins page's preview draws the sample", await until(async () => (await prev.count()) === 1, 8000), await prev.count())
  await wait(600)
  await page.screenshot({ path: `${OUT}org-preview.png` })
  await ctx.close()
}
putBackWs()
await done()

/** A plain PNG of w×h: a soft gradient. */
function png(w, h) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + x / w * 60; raw[o + 1] = 110 + y / h * 80; raw[o + 2] = 180 + x / w * 60 }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
