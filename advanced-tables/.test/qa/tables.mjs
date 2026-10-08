// Advanced tables in a real browser, typing in the note's editor: Tab, Shift-Tab and Enter between cells (new rows at the
// end, out of the table from an empty last row), the table aligned as it goes, a `| a | b |` line made a table, keys left
// alone in code and paragraphs, and the commands from the palette. Desktop, then a 390px phone (the commands). Installs
// the plugin; WRITES a "Qa tables" folder: a throwaway server only.
//   node advanced-tables/.test/qa/tables.mjs <base url> [out dir]
import { mkdirSync } from "node:fs"
import { install, palette, qa, SHOTS, wait } from "../../../qa.mjs"
const { args: [B, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const NOTE = "Qa tables/Tables.md"
const write = (path, text) => fetch(`${B}api/file`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, text, base: null }) })
install(B, "advanced-tables")

const TEXT = `Intro paragraph.

|Name|Team|
|:-|-:|
|Alice Park|Lighthouse|
|Kai|東京 🙂|

\`\`\`
|in|code|
|-|-|
\`\`\`

> [!note] A callout
> |x|y|
> |-|-|
> |1|2|

End.
`
/** The note's editor: its text and selection (CodeMirror's view, reached from its DOM). */
const cm = (page) => page.evaluate(() => {
  const v = document.querySelector(".file-view .cm-content").cmTile.root.view
  const r = v.state.selection.main
  return { doc: v.state.doc.toString(), from: r.from, to: r.to, sel: v.state.sliceDoc(r.from, r.to), line: v.state.doc.lineAt(r.head).text }
})
/** The cursor put after the first `text` (+ `d`), the editor focused. */
const at = (page, text, d = 0) => page.evaluate(([t, d]) => {
  const v = document.querySelector(".file-view .cm-content").cmTile.root.view
  v.focus(); v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf(t) + d } })
}, [text, d])
const table = (doc, first) => { const i = doc.indexOf(first); return doc.slice(i, doc.indexOf("\n\n", i)) }

async function open(opts, label) {
  await write(NOTE, TEXT)
  const ctx = await browser.newContext(opts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank")
  await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`)
  await page.locator(".file-view .vau-editor .cm-content").first().waitFor({ timeout: 15000 })
  await wait(1200)
  return { ctx, page }
}

// ---------- desktop: the keys
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 } }, "desktop")
  check("desktop: the table is drawn while the cursor is elsewhere", await page.locator(".file-view .cm-block-table").count() >= 1)
  check("desktop: the drawn table aligns as its separator says", await page.locator(".file-view .cm-block-table th").nth(1).evaluate((e) => getComputedStyle(e).textAlign) === "right")
  check("desktop: a table in a callout is drawn as a table", await page.locator(".file-view .cm-block-callout th").first().evaluate((e) => getComputedStyle(e).paddingRight) === "14px")
  await page.screenshot({ path: `${OUT}tables-desktop-drawn.png` })
  const k = (key) => page.keyboard.press(key).then(() => wait(120))

  await at(page, "|Name", 2); await k("Tab")
  let s = await cm(page)
  check("Tab: aligned, alignments kept", table(s.doc, "| Name") === "| Name       |       Team |\n| :--------- | ---------: |\n| Alice Park | Lighthouse |\n| Kai        |    東京 🙂 |", table(s.doc, "| Name"))
  check("Tab: the next cell's text selected", s.sel === "Team", s)
  await page.keyboard.type("Group"); await k("Tab")
  s = await cm(page)
  check("typing replaces it; Tab goes on to the next row", s.doc.includes("| Name       |      Group |") && s.sel === "Alice Park", s.sel)
  await k("Shift+Tab"); s = await cm(page)
  check("Shift-Tab: back to the row above's last cell", s.sel === "Group", s.sel)
  await at(page, "東京"); await k("Tab"); s = await cm(page)
  check("Tab past the last cell: a new row", /\| Kai {8}\| +東京 🙂 \|\n\| {12}\| +\|/.test(s.doc) && s.line.startsWith("|            |"), table(s.doc, "| Name"))
  await page.keyboard.type("Lea"); await k("Enter"); s = await cm(page)
  check("Enter on the last row: another row, same column", table(s.doc, "| Name").split("\n").length === 6 && s.from === s.to, table(s.doc, "| Name"))
  await k("Enter"); s = await cm(page)
  check("Enter on an empty last row: it goes, the cursor below the table", table(s.doc, "| Name").split("\n").length === 5 && s.line === "", { line: s.line, t: table(s.doc, "| Name") })
  await page.screenshot({ path: `${OUT}tables-desktop-after-keys.png` })

  await at(page, "|in|", 1); await k("Tab"); s = await cm(page)
  check("in code: not a table (the editor's Tab)", s.doc.includes("|in|code|\n|-|-|"), s.line)
  await at(page, "Intro"); await k("Tab"); s = await cm(page)
  check("in a paragraph: the editor's Tab", s.doc.startsWith("  Intro") || s.doc.startsWith("\tIntro"), s.doc.slice(0, 20))
  await page.keyboard.press("Meta+z"); await wait(150)
  await at(page, "|x|", 1); await k("Tab"); s = await cm(page)
  check("in a callout: aligned with its > kept", s.doc.includes("> | x   | y   |\n> | --- | --- |\n> | 1   | 2   |"), table(s.doc, "> | x"))

  // A new one: `| a | b |` then Tab.
  await at(page, "End."); await page.keyboard.press("End"); await k("Enter"); await k("Enter")
  await page.keyboard.type("|Day|Steps|"); await page.keyboard.press("Home"); await k("Tab"); s = await cm(page)
  check("| a | b | then Tab: a table with its separator", s.doc.includes("| Day | Steps |\n| --- | ----- |") && s.sel === "Steps", s.doc.slice(-60))
  await k("Tab"); await page.keyboard.type("Mon"); await k("Tab"); await page.keyboard.type("9000"); await k("Tab"); await page.keyboard.type("Tue"); await k("Tab"); await page.keyboard.type("12000")
  await k("Enter"); await k("Enter"); s = await cm(page)
  check("rows typed with Tab", s.doc.includes("| Day | Steps |\n| --- | ----- |\n| Mon | 9000  |\n| Tue | 12000 |\n"), s.doc.slice(-90))

  // Commands, from the palette.
  await at(page, "| 9000", 3)
  await palette(page, "Sort rows by this column, descending")
  s = await cm(page)
  check("sort descending, numbers as numbers", s.doc.includes("| Tue | 12000 |\n| Mon | 9000  |"), table(s.doc, "| Day"))
  await palette(page, "Insert column right"); await page.keyboard.type("Note")
  s = await cm(page)
  check("insert column right, the cursor in it", s.doc.includes("| Day | Steps |     |\n| --- | ----- | --- |\n| Tue | 12000 | Note"), table(s.doc, "| Day"))
  await palette(page, "Align column right"); s = await cm(page)
  check("align right: the separator and the cells", /\| --- \| ----- \| ---: \|/.test(s.doc), table(s.doc, "| Day"))
  await palette(page, "Delete column"); s = await cm(page)
  check("delete column", s.doc.includes("| Day | Steps |\n| --- | ----- |"), table(s.doc, "| Day"))
  await at(page, "| Tue", 2); await palette(page, "Move row down"); s = await cm(page)
  check("move row down", s.doc.includes("| Mon | 9000  |\n| Tue | 12000 |"), table(s.doc, "| Day"))
  await palette(page, "Move column right"); s = await cm(page)
  check("move column right", s.doc.includes("| Steps | Day |"), table(s.doc, "| Steps"))
  await palette(page, "Insert row above"); await palette(page, "Delete row"); s = await cm(page)
  check("insert row above, then delete it", table(s.doc, "| Steps").split("\n").length === 4, table(s.doc, "| Steps"))
  await page.screenshot({ path: `${OUT}tables-desktop-commands.png` })

  await page.evaluate(() => { const v = document.querySelector(".file-view .cm-content").cmTile.root.view; v.dispatch({ changes: { from: 0, insert: "|p|q|\n|-|-|\n|long text|1|\n\n" } }) })
  await at(page, "Intro"); await palette(page, "Format all tables in the note"); s = await cm(page)
  check("format all tables", s.doc.startsWith("| p         | q   |\n| --------- | --- |\n| long text | 1   |") && s.doc.includes("|in|code|"), s.doc.slice(0, 70))
  check("away from a table, its commands aren't offered", !(await (async () => { await page.keyboard.press("Meta+p"); await wait(300); await page.keyboard.type("Insert row below"); await wait(300); const n = await page.locator("[role=option]", { hasText: "Insert row below" }).count(); await page.keyboard.press("Escape"); return n })()))
  await page.locator(".file-view .vau-editor .cm-content").first().blur(); await wait(600)
  await page.screenshot({ path: `${OUT}tables-desktop-done.png` })
  await ctx.close()
}

// ---------- phone: the commands
{
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, "phone")
  await page.screenshot({ path: `${OUT}tables-phone-drawn.png` })
  // (a phone opens notes to read: the pencil edits)
  await page.locator("button:has(svg.lucide-pencil)").first().tap(); await wait(600)
  await page.locator(".file-view .cm-block-table").first().tap(); await wait(600)
  let s = await cm(page)
  check("phone: a tap puts the cursor in the table's Markdown", s.line.startsWith("|") || s.doc.slice(s.from - 5, s.from + 5).includes("|"), s.line)
  await at(page, "|Kai", 2)
  await palette(page, "Insert row below"); await page.keyboard.type("Alice")
  s = await cm(page)
  check("phone: insert row below, the cursor in it", s.doc.includes("| Kai        |    東京 🙂 |\n| Alice "), table(s.doc, "| Name"))
  await palette(page, "Sort rows by this column"); s = await cm(page)
  check("phone: sort", /\| Alice +\|[^\n]*\n\| Alice Park/.test(s.doc), table(s.doc, "| Name"))
  await page.screenshot({ path: `${OUT}tables-phone-editing.png` })
  await ctx.close()
}
await done()
