// Outliner in a real browser, typing in the note's editor: ⌘⇧↑/↓ move an item with its children, Tab and Shift-Tab
// indent and outdent it with them, Enter on an empty item steps out, ⌘A takes the item then the list, ⌘↑/↓ fold through
// the Folding plugin, and keys are left alone in code and paragraphs. Desktop, then a 390px phone (the commands).
// Installs the plugin; WRITES a "Qa outliner" folder: a throwaway server only.
//   node outliner/.test/qa/outliner.mjs <base url> [out dir]
import { mkdirSync } from "node:fs"
import { install, palette, qa, SHOTS, wait } from "../../../qa.mjs"
const { args: [B, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const NOTE = "Qa outliner/Outline.md"
const write = (path, text) => fetch(`${B}api/file`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, text, base: null }) })
install(B, "outliner")

const TEXT = `Plans for the Lighthouse.

- Alice
  - one
  - two
    - deep
- Bob
  - three
- Carol

\`\`\`
- in code
- also code
\`\`\`
`
const cm = (page) => page.evaluate(() => {
  const v = document.querySelector(".file-view .cm-content").cmTile.root.view
  const r = v.state.selection.main
  return { doc: v.state.doc.toString(), sel: v.state.sliceDoc(r.from, r.to), line: v.state.doc.lineAt(r.head).text, ch: r.head - v.state.doc.lineAt(r.head).from }
})
const at = (page, text, d = 0) => page.evaluate(([t, d]) => {
  const v = document.querySelector(".file-view .cm-content").cmTile.root.view
  v.focus(); v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf(t) + d } })
}, [text, d])
const list = (doc) => doc.slice(doc.indexOf("- "), doc.indexOf("\n\n```"))

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
  const k = (key) => page.keyboard.press(key).then(() => wait(150))
  await at(page, "Bob", 1)
  await page.screenshot({ path: `${OUT}outliner-desktop-guides.png` })
  await k("Meta+Shift+ArrowUp"); let s = await cm(page)
  check("⌘⇧↑: Bob above Alice, with its child", list(s.doc) === "- Bob\n  - three\n- Alice\n  - one\n  - two\n    - deep\n- Carol", list(s.doc))
  check("the cursor goes with it", s.line === "- Bob" && s.ch === 3, s)
  await k("Meta+Shift+ArrowDown"); await k("Meta+Shift+ArrowDown"); s = await cm(page)
  check("⌘⇧↓ twice: Bob below Carol", list(s.doc) === "- Alice\n  - one\n  - two\n    - deep\n- Carol\n- Bob\n  - three", list(s.doc))
  await page.keyboard.press("Meta+z"); await wait(150)
  s = await cm(page)
  check("each move is one undo (one back: below Alice again)", list(s.doc) === "- Alice\n  - one\n  - two\n    - deep\n- Bob\n  - three\n- Carol", list(s.doc))

  await at(page, "two", 3); await k("Tab"); s = await cm(page)
  check("Tab: two under one, with its child", list(s.doc).startsWith("- Alice\n  - one\n    - two\n      - deep\n- Bob"), list(s.doc))
  check("the cursor stays in the text", s.line === "    - two" && s.ch === 9, s)
  await k("Tab"); s = await cm(page)
  check("Tab with no sibling above: nothing (no stray indent)", list(s.doc).startsWith("- Alice\n  - one\n    - two\n      - deep"), list(s.doc))
  await k("Shift+Tab"); await k("Shift+Tab"); s = await cm(page)
  check("Shift-Tab twice: two at the top, after Alice's other children", list(s.doc) === "- Alice\n  - one\n- two\n  - deep\n- Bob\n  - three\n- Carol", list(s.doc))

  await at(page, "three", 5); await k("Enter"); s = await cm(page)
  check("Enter after an item: a new one (the editor's)", s.line === "  - ", s.line)
  await k("Enter"); s = await cm(page)
  check("Enter on an empty item: out a level", s.line === "- " && list(s.doc).includes("  - three\n- \n- Carol"), list(s.doc))
  await k("Enter"); s = await cm(page)
  check("Enter on an empty top item: out of the list", s.line === "" && s.doc.includes("  - three\n\n- Carol"), list(s.doc))
  await page.keyboard.press("Backspace"); await wait(150)

  await at(page, "one", 1); await k("Meta+a"); s = await cm(page)
  check("⌘A: the item's text", s.sel === "one", s.sel)
  await k("Meta+a"); s = await cm(page)
  check("⌘A again: the whole list", s.sel.startsWith("- Alice") && s.sel.endsWith("- Carol"), s.sel)
  await k("Meta+a"); s = await cm(page)
  check("⌘A again: everything", s.sel === s.doc, s.sel.length)

  await at(page, "Alice", 1); await k("Meta+ArrowUp")
  check("⌘↑: folded by the Folding plugin", await page.locator(".file-view .cm-foldPlaceholder").count() === 1)
  await page.screenshot({ path: `${OUT}outliner-desktop-folded.png` })
  await k("Meta+ArrowDown")
  check("⌘↓: unfolded", await page.locator(".file-view .cm-foldPlaceholder").count() === 0)
  await at(page, "Carol", 1); await k("Meta+ArrowUp"); s = await cm(page)
  check("⌘↑ on an item with nothing under it: the editor's (to the top)", s.line === "Plans for the Lighthouse." || s.doc.indexOf(s.line) === 0, s.line)

  await at(page, "in code", 1); const before = (await cm(page)).doc
  await k("Meta+Shift+ArrowDown"); s = await cm(page)
  check("in code: ⌘⇧↓ is the editor's (selects to the end), nothing moved", s.doc === before && s.sel.length > 10, s.sel)
  await at(page, "in code", 1); await k("Tab"); s = await cm(page)
  check("in code: Tab is the editor's (indents the line alone)", s.doc.includes("  - in code\n- also code"), s.doc.slice(-40))
  await at(page, "Plans", 1); await k("Tab"); s = await cm(page)
  check("in a paragraph: the editor's Tab", /^\s+Plans/.test(s.doc), s.doc.slice(0, 12))
  await page.locator(".file-view .vau-editor .cm-content").first().blur(); await wait(600)
  await page.screenshot({ path: `${OUT}outliner-desktop-done.png` })
  await ctx.close()
}

// ---------- phone: the commands
{
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, "phone")
  await page.locator("button:has(svg.lucide-pencil)").first().tap(); await wait(600)
  await at(page, "Bob", 1)
  await palette(page, "Move list item up"); let s = await cm(page)
  check("phone: Move list item up", list(s.doc).startsWith("- Bob\n  - three\n- Alice"), list(s.doc))
  await at(page, "Carol", 1); await palette(page, "Indent list item"); s = await cm(page)
  check("phone: Indent list item", list(s.doc).endsWith("    - deep\n  - Carol"), list(s.doc))
  await palette(page, "Outdent list item"); s = await cm(page)
  check("phone: Outdent list item", list(s.doc).endsWith("    - deep\n- Carol"), list(s.doc))
  await page.screenshot({ path: `${OUT}outliner-phone.png` })
  await ctx.close()
}
await done()
