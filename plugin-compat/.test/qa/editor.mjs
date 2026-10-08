// The editor group's plugins doing their job, typed and clicked as a user would (catalog.tsv), on notes with and without
// frontmatter; writes .test/results/editor.tsv's column for this run. WRITES "Qa editor/": lab only.
//   node editor.mjs <base url> [phone] [ids,comma,separated]
import fs from "node:fs"
import path from "node:path"
import { qa, until, wait } from "../../../qa.mjs"

const { args: [B0, mode = "", only = ""], browser, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const phone = mode === "phone"
const D = "Qa editor"
const SHOTS = `/tmp/oc-lab/shots/editor-${phone ? "phone" : "web"}`
fs.mkdirSync(SHOTS, { recursive: true })
const ctx = await browser.newContext(phone
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }
  : { viewport: { width: 1400, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e.stack ?? e).slice(0, 300)))
const api = (m, r, b) => page.evaluate(async ([m, r, b]) => { const x = await fetch(`/api/${r}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); const t = await x.text(); try { return JSON.parse(t) } catch { return t } }, [m, r, b])
const FM = "---\ntags: [qa]\nstatus: draft\n---\n"
// (its frontmatter kept: the server may add its own keys to a file the API makes)
const keptFm = (t) => /^---\n[\s\S]*?tags: \[qa\][\s\S]*?status: draft[\s\S]*?\n---\n/.test(t)
const write = async (name, text) => { const p = `${D}/${name}.md`; await api("PUT", "file", { path: p, text }).then((r) => (r?.error ? api("POST", "file", { path: p, text }) : r)); return p }
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`)).text ?? ""
const body = (t) => t.replace(/^---\n[\s\S]*?\n---\n/, "")

await page.goto(B)
await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 90000 })
await wait(2000)

/** Open a note for editing; the editor in front holds it. */
async function open(p) {
  await page.evaluate((h) => { location.hash = h }, `#file/${encodeURIComponent(p)}`)
  await wait(1200)
  if (phone && await page.evaluate(() => document.querySelector("[data-view-toggle]")?.getAttribute("data-view-toggle") === "read")) {
    // (a toast may lie over it on a phone's first screen)
    await page.evaluate(() => document.querySelector("[data-view-toggle]")?.click()); await wait(600)
  }
  await until(() => page.evaluate((p) => window.app.workspace.activeEditor?.file?.path === p && !!window.app.workspace.activeEditor?.editor, p), 10000)
}
/** Cursor after the first `text` in the file (or `sel` characters selected from there), the editor focused. */
const cursor = (text, { at = text.length, sel = 0 } = {}) => page.evaluate(([t, at, sel]) => {
  const ed = window.app.workspace.activeEditor.editor, v = ed.getValue(), i = v.indexOf(t)
  if (i < 0) return false
  ed.focus(); ed.setSelection(ed.offsetToPos(i + at), ed.offsetToPos(i + at + sel))
  return true
}, [text, at, sel])
const select = (text) => cursor(text, { at: 0, sel: text.length })
const value = () => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue())
const run = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id)
const type = async (s) => { for (const ch of s) await page.keyboard.type(ch, { delay: 25 }) }
const saved = async (p, test, ms = 4000) => until(async () => test(await read(p)), ms, 250)

const results = {}
async function test(id, fn) {
  if (only && !only.split(",").includes(id)) return
  const before = errs.length
  let r
  try { r = await fn() } catch (e) { r = { state: "fails", why: String(e.message ?? e).split("\n")[0].slice(0, 160) } }
  if (typeof r === "boolean") r = { state: r ? "works" : "fails" }
  const own = errs.slice(before).filter((e) => e.includes(`obsidian-plugin:${id}/`))
  if (own.length && r.state === "works") r = { state: "partly", why: `errors: ${own[0].split("\n")[0]}` }
  results[id] = r
  console.log(`${r.state.padEnd(7)} ${id}${r.why ? `  (${r.why})` : ""}`)
  await page.screenshot({ path: `${SHOTS}/${id}.png` }).catch(() => {})
  await page.keyboard.press("Escape").catch(() => {})
  await page.evaluate(() => document.querySelectorAll(".modal-container, .suggestion-container").forEach((e) => e.remove()))
}
const fails = (why) => ({ state: "fails", why })

await test("table-editor-obsidian", async () => {
  const p = await write("Table", `${FM}# Table\n\n| a | bb |\n|--|--|\n| ccc | d |\n`)
  await open(p)
  await cursor("| ccc", { at: 3 })
  await page.keyboard.press("Tab")
  const t = await saved(p, (t) => t.includes("| a   | bb  |"))
  return t && keptFm(await read(p)) ? true : fails(`not formatted: ${JSON.stringify(body(await read(p)))}`)
})

await test("obsidian-outliner", async () => {
  const p = await write("Outline", `${FM}# Outline\n\n- One\n  - One a\n- Two\n- Three\n`)
  await open(p)
  await cursor("- Two", { at: 3 })
  // (a phone has no keys for it: its command, as from the palette)
  if (phone) await run("obsidian-outliner:move-list-item-down"); else await page.keyboard.press("Meta+Shift+ArrowDown")
  const moved = await saved(p, (t) => body(t).includes("- Three\n- Two"))
  // (its save coming back may redraw the note: the cursor is placed once that settled)
  await wait(1200)
  await cursor("- Three", { at: 7 })
  await page.keyboard.press("Tab")
  const indented = await saved(p, (t) => /- One\n\s+- One a\n\s+- Three\n- Two/.test(body(t)))
  return moved && indented && keptFm(await read(p)) ? true : fails(`moved=${!!moved} indented=${!!indented}: ${JSON.stringify(body(await read(p)))}`)
})

await test("obsidian-latex-suite", async () => {
  // (Obsidian pairs a typed $ itself; the app doesn't, so the math is there to type in)
  const p = await write("Math", `${FM}# Math\n\nInline: $$\n`)
  await open(p)
  await cursor("Inline: $")
  await type("x//")
  await wait(400)
  const v = await value()
  return /\\frac\{/.test(v) ? true : fails(`no snippet: ${JSON.stringify(body(v).slice(0, 80))}`)
})

await test("various-complements", async () => {
  const p = await write("Complete", `${FM}# Complete\n\nLighthouse is a word here.\n\n`)
  await open(p)
  await page.evaluate(() => window.app.commands.executeCommandById("various-complements:reload-current-vault"))
  await wait(1500)
  await cursor("here.\n\n", { at: 7 })
  await type("Lightho")
  const shown = await until(() => page.evaluate(() => [...document.querySelectorAll(".suggestion-item")].some((e) => e.textContent.includes("Lighthouse"))), 4000)
  if (!shown) return fails("no suggestion popup")
  await page.keyboard.press("Enter")
  const v = await value()
  return /\n\n(\[\[)?Lighthouse(\]\])?\s*$/.test(v) ? true : fails(`not completed: ${JSON.stringify(v.slice(-40))}`)
})

await test("easy-typing-obsidian", async () => {
  const p = await write("Easy", `${FM}# Easy\n\n`)
  await open(p)
  await cursor("# Easy\n\n", { at: 8 })
  await type("中文abc")
  await page.keyboard.press("Enter")
  await wait(400)
  const v = await value()
  return /中文 abc/.test(v) ? true : fails(`no spacing: ${JSON.stringify(v.slice(-30))}`)
})

await test("highlightr-plugin", async () => {
  const p = await write("Highlight", `${FM}# Highlight\n\nMark these words please.\n`)
  await open(p)
  await select("these words")
  await run("highlightr-plugin:Yellow")
  const t = await saved(p, (t) => /<mark[^>]*>these words<\/mark>/.test(t))
  return t ? true : fails(`not marked: ${JSON.stringify(body(await read(p)))}`)
})

await test("colored-text", async () => {
  const p = await write("Colored", `${FM}# Colored\n\nPaint this text.\n`)
  await open(p)
  await select("this text")
  await run("colored-text:color-text")
  const t = await saved(p, (t) => /<span style="color:[^"]+">this text<\/span>/.test(t))
  if (!t) return fails(`not coloured: ${JSON.stringify(body(await read(p)))}`)
  if (phone) return true
  // (its item in the editor's right-click menu, as plugins add them on editor-menu)
  await write("Colored", `${FM}# Colored\n\nPaint that word.\n`)
  await wait(1200)
  await select("that word")
  const at = await page.evaluate(() => { const ed = window.app.workspace.activeEditor.editor, i = ed.getValue().indexOf("that word"); return ed.cm.coordsAtPos(i + 2) })
  await page.mouse.click(at.left, at.top + 4, { button: "right" })
  const item = page.getByRole("menuitem", { name: "Color Text" })
  if (!await until(() => item.count(), 3000)) return fails("no item in the editor's menu")
  await item.click()
  const m = await saved(p, (t) => /<span style="color:[^"]+">that word<\/span>/.test(t))
  return m ? true : fails(`menu item didn't colour: ${JSON.stringify(body(await read(p)))}`)
})

await test("editing-toolbar", async () => {
  const p = await write("Toolbar", `${FM}# Toolbar\n\nMake bold here.\n`)
  // (off on phones until its "load on mobile" setting is on, as in Obsidian)
  if (phone && await page.evaluate(async () => { const pl = window.app.plugins.plugins["editing-toolbar"]; if (pl.settings.isLoadOnMobile) return false; pl.settings.isLoadOnMobile = true; await pl.saveSettings(); return true })) {
    await page.reload(); await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 90000 }); await wait(2000)
  }
  await open(p)
  await select("bold")
  await wait(800)
  const bar = await page.evaluate(() => { const b = document.querySelector("#editingToolbarModalBar, .editingToolbarModalBar, .editing-toolbar"); return !!b && b.getBoundingClientRect().width > 0 })
  if (!bar) return fails("no toolbar shown")
  await select("bold")
  const bold = page.locator('.editingToolbarModalBar button[aria-label="Bold"]').first()
  if (!await bold.count()) return fails("no bold button")
  await bold.click()
  const t = await saved(p, (t) => body(t).includes("**bold**"))
  return t ? true : fails(`bold not applied: ${JSON.stringify(body(await read(p)))}`)
})

await test("cmenu-plugin", async () => {
  if (phone) return { state: "n/a", why: "desktop only (isDesktopOnly), as in Obsidian" }
  const r = await page.evaluate(() => window.app.plugins.plugins["cmenu-plugin"] ? "loaded" : "no")
  if (r !== "loaded") return fails("doesn't load (needs Node's process: the bridge)")
  const p = await write("Cmenu", `${FM}# Cmenu\n\nMake bold here.\n`)
  await open(p)
  await select("bold")
  await wait(600)
  const bar = page.locator("#cMenuModalBar")
  if (!await until(() => bar.count(), 3000)) return fails("no toolbar")
  await select("bold")
  const b = page.locator('#cMenuModalBar button[aria-label*="old" i]').first()
  if (!await b.count()) return fails("no bold button")
  await b.click()
  const t = await saved(p, (t) => body(t).includes("**bold**"))
  return t ? true : fails(`bold not applied: ${JSON.stringify(body(await read(p)))}`)
})

await test("obsidian-text-format", async () => {
  const p = await write("Format", `${FM}# Format\n\nhello big world\n`)
  await open(p)
  await select("hello big world")
  await run("obsidian-text-format:uppercase")
  const t = await saved(p, (t) => body(t).includes("HELLO BIG WORLD"))
  return t ? true : fails(`not uppercased: ${JSON.stringify(body(await read(p)))}`)
})

/** Paste `text` into the editor in front, as the clipboard would. */
const paste = (text) => page.evaluate((text) => {
  const dt = new DataTransfer(); dt.setData("text/plain", text)
  window.app.workspace.activeEditor.editor.cm.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
}, text)

await test("url-into-selection", async () => {
  const p = await write("Url", `${FM}# Url\n\nRead Lighthouse docs.\n`)
  await open(p)
  await select("Lighthouse")
  await paste("https://example.com/lh")
  const t = await saved(p, (t) => body(t).includes("[Lighthouse](https://example.com/lh)"))
  return t ? true : fails(`not linked: ${JSON.stringify(body(await read(p)))}`)
})

await test("obsidian-emoji-toolbar", async () => {
  const p = await write("Emoji", `${FM}# Emoji\n\nSmile: \n`)
  await open(p)
  await cursor("Smile: ")
  await run("obsidian-emoji-toolbar:emoji-picker:open-picker")
  const shown = await until(() => page.evaluate(() => (document.querySelector("em-emoji-picker")?.shadowRoot?.querySelectorAll("button").length ?? 0) > 20), 5000)
  if (!shown) return fails("no picker")
  const emoji = page.locator("em-emoji-picker button[aria-label]").filter({ hasText: /\p{Extended_Pictographic}/u }).first()
  if (!await emoji.count()) return fails("picker has no emoji to click")
  await emoji.click()
  const t = await saved(p, (t) => /Smile: \S/u.test(body(t)))
  return t ? true : fails(`nothing inserted: ${JSON.stringify(body(await read(p)))}`)
})

await test("nldates-obsidian", async () => {
  const p = await write("Dates", `${FM}# Dates\n\nDue \n`)
  await open(p)
  await cursor("Due ")
  await type("@tod")
  const shown = await until(() => page.evaluate(() => [...document.querySelectorAll(".suggestion-item")].some((e) => /today/i.test(e.textContent))), 4000)
  if (!shown) return fails("no @ suggestion")
  await page.keyboard.press("Enter")
  const t = await saved(p, (t) => /Due \[\[\d{4}-\d\d-\d\d\]\]/.test(body(t)))
  return t ? true : fails(`no date link: ${JSON.stringify(body(await read(p)))}`)
})

await test("obsidian-linter", async () => {
  const data = await api("GET", "plugin-compat/config/read?path=.obsidian%2Fplugins%2Fobsidian-linter%2Fdata.json").catch(() => null)
  void data
  const p = await write("Lint", `${FM}# Lint\n\nTrailing spaces here.   \nSecond line.\t\n`)
  await page.evaluate(async () => {
    const pl = window.app.plugins.plugins["obsidian-linter"]
    for (const k of ["trailing-spaces", "yaml-title"]) pl.settings.ruleConfigs[k] = { ...(pl.settings.ruleConfigs[k] ?? {}), enabled: true }
    await pl.saveSettings?.()
  })
  await open(p)
  await run("obsidian-linter:lint-file")
  const t = await saved(p, (t) => !/ {3}\n/.test(t) && /^---\n[\s\S]*title: Lint[\s\S]*\n---\n/.test(t), 5000)
  const now = await read(p)
  return t && /tags: \[qa\]|tags:\n/.test(now) && body(now).includes("# Lint") ? true : fails(`lint wrong: ${JSON.stringify(now)}`)
})

await test("better-word-count", async () => {
  // (it counts the editor's whole text, frontmatter too, as in Obsidian: the check is that typing counts)
  const p = await write("Count", `${FM}# Count\n\none two three four five\n`)
  await open(p)
  const status = () => page.evaluate(() => [...document.querySelectorAll(".status-bar-item")].map((e) => e.textContent).join(" | "))
  const words = async () => Number(/(\d+)\s+words?/i.exec(await status())?.[1] ?? NaN)
  await cursor("five")
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight")
  await wait(800)
  const before = await words()
  await type(" six")
  await wait(800)
  const after = await words()
  if (phone && Number.isNaN(before)) return { state: "n/a", why: "no status bar on phones (as Obsidian mobile)" }
  return after === before + 1 ? true : fails(`count ${before} -> ${after}: ${JSON.stringify((await status()).slice(0, 80))}`)
})

await test("code-styler", async () => {
  const p = await write("Code", `${FM}# Code\n\n\`\`\`js title:demo\nconst a = 1\nconst b = 2\n\`\`\`\n\nAfter.\n`)
  await open(p)
  await cursor("After.")
  await wait(800)
  const styled = await page.evaluate(() => !!document.querySelector(".code-styler-header-container, [class*=code-styler-line], .code-styler-line-number, .code-styler"))
  return styled ? true : fails("no code-styler decoration")
})

await test("oz-image-plugin", async () => {
  return { state: "n/a", why: "the app already draws images, transclusions and PDFs in the editor; it loads and its toggles run" }
})

await test("obsidian-auto-link-title", async () => {
  const p = await write("Autolink", `${FM}# Autolink\n\nSee: \n`)
  await open(p)
  await cursor("See: ")
  await paste("https://example.com/")
  const t = await saved(p, (t) => /See: \[Example Domain\]\(https:\/\/example\.com\/\)/.test(body(t)), 15000)
  if (t) return true
  const now = body(await read(p))
  return /\]\(https:\/\/example\.com\/\)/.test(now)
    ? { state: "partly", why: phone ? "a link, no title: require('electron') should be absent on phones (its fetch path then)" : "a link, no title: needs electron's remote.BrowserWindow (the Node bridge's electron)" }
    : fails(`no link: ${JSON.stringify(now)}`)
})

await test("note-refactor-obsidian", async () => {
  const p = await write("Refactor", `${FM}# Refactor\n\nSplit idea\nIt has a body.\n\nKeep this.\n`)
  await open(p)
  await select("Split idea\nIt has a body.")
  await run("note-refactor-obsidian:app:extract-selection-first-line")
  const t = await saved(p, (t) => /\[\[[^\]]*Split idea\]\]/.test(t), 5000)
  const made = (await api("GET", "plugin-compat/vault")).files.some((f) => /Split idea\.md$/.test(f.path))
  return t && made ? true : fails(`link=${!!t} file=${made}: ${JSON.stringify(body(await read(p)))}`)
})

await test("obsidian-plugin-toc", async () => {
  const p = await write("Toc", `${FM}# Toc\n\n\n\n## First\n\ntext\n\n## Second\n\nmore\n`)
  await open(p)
  await cursor("# Toc\n\n", { at: 7 })
  await run("obsidian-plugin-toc:create-toc")
  const t = await saved(p, (t) => /- \[\[#First\|First\]\]|- \[First\]\(#first\)|\[\[#First/.test(t))
  return t ? true : fails(`no toc: ${JSON.stringify(body(await read(p)))}`)
})

// Not a plugin's own job: how they sit with the app (desktop). "_" ones aren't written to the results.
if (!phone) {
  await test("_hotkeys", async () => {
    // Outliner's fold (Mod+↑) before the editor's own Mod+↑ (to the top), as in Obsidian
    const p = await write("Fold", `${FM}# Fold\n\n- One\n  - One a\n  - One b\n- Two\n`)
    await open(p)
    await cursor("- One\n", { at: 5 })
    await page.keyboard.press("Meta+ArrowUp")
    await wait(400)
    const r = await page.evaluate(() => { const ed = window.app.workspace.activeEditor.editor; return { line: ed.getCursor().line, text: ed.getLine(ed.getCursor().line), folded: !!document.querySelector(".cm-foldPlaceholder, .cm-fold-placeholder") } })
    return r.text === "- One" && r.folded ? true : fails(`fold: ${JSON.stringify(r)}`)
  })
  await test("_plugin-off", async () => {
    // A plugin turned off on the Plugins page takes its editor keys with it, and comes back on
    const sw = async (on) => {
      await page.evaluate(() => { location.hash = "#plugins" }); await wait(1500)
      const s = page.locator('[data-plugin-row="obsidian.table-editor-obsidian"]').locator("xpath=..").getByRole("switch")
      if ((await s.getAttribute("aria-checked")) !== String(on)) await s.click()
      await wait(2500)
    }
    await sw(false)
    const p = await write("Table off", `${FM}# Table\n\n| a | bb |\n|--|--|\n| ccc | d |\n`)
    await open(p)
    await cursor("| ccc", { at: 3 })
    await page.keyboard.press("Tab")
    await wait(1500)
    const off = !(await read(p)).includes("| a   | bb  |")
    await sw(true)
    await open(p)
    await cursor("| ccc", { at: 3 })
    await page.keyboard.press("Tab")
    const on = await saved(p, (t) => t.includes("| a   | bb  |"))
    return off && on ? true : fails(`off=${off} on=${!!on}`)
  })
}

// The column for this run in .test/results/editor.tsv (id, web, phone, notes).
const file = path.join(import.meta.dirname, "..", "results", "editor.tsv")
const rows = new Map()
if (fs.existsSync(file)) for (const l of fs.readFileSync(file, "utf8").trim().split("\n").slice(1)) { const [id, web, ph, notes] = l.split("\t"); rows.set(id, { web, phone: ph, notes }) }
for (const [id, r] of Object.entries(results)) {
  if (id.startsWith("_")) continue
  const row = rows.get(id) ?? { web: "", phone: "", notes: "" }
  row[phone ? "phone" : "web"] = r.state
  const note = r.why ? `${phone ? "phone" : "web"}: ${r.why}` : ""
  row.notes = [...(row.notes ?? "").split(" ; ").filter((n) => n && !n.startsWith(phone ? "phone:" : "web:")), note].filter(Boolean).join(" ; ")
  rows.set(id, row)
}
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, ["id\tweb\tphone\tnotes", ...[...rows].map(([id, r]) => [id, r.web, r.phone, r.notes].join("\t"))].join("\n") + "\n")
const n = Object.values(results).reduce((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {})
console.log(JSON.stringify(n))
await ctx.close()
await done()
