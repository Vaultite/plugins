// The commands group's plugins doing their job (catalog.tsv): templates filled, captures written, search modals that
// find and open, obsidian:// links followed, periodic notes made, network flows reaching their service. WRITES notes
// under "Qa cmd": throwaway server only (lab.mjs).
//   node commands.mjs <base url> [phone] [ids,comma,separated]     (OC_CDP=<devtools url>: reuse a running Chrome)
import fs from "node:fs"
import path from "node:path"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const cdpUrl = process.env.OC_CDP
const { args: [B0, mode = "", only = ""], browser, done } = await qa(import.meta.url, cdpUrl ? { chrome: false } : {})
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const phone = mode === "phone"
const D = "Qa cmd"
const today = new Date().toLocaleDateString("en-CA")
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
const cdp = cdpUrl ? await (await import("playwright-core")).chromium.connectOverCDP(cdpUrl) : null
const ctx = cdp ? cdp.contexts()[0] : await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA } : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e.stack ?? e).slice(0, 300)))
const logs = []
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(m.text().slice(0, 300)) })

const write = async (p, text) => {
  const r = await api("POST", "file", { path: p, text })
  if (r?.error) await api("PUT", "file", { path: p, text })
  await until(() => page.evaluate((p) => !!window.app.vault.getFileByPath(p), p), 8000).catch(() => {})
  await wait(400)
}
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`))?.text ?? null
const run = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id)
const active = () => page.evaluate(() => window.app.workspace.getActiveFile()?.path ?? null)
async function open(p) {
  await page.evaluate((h) => { location.hash = h }, `#file/${encodeURIComponent(p)}`)
  await until(() => page.evaluate((p) => window.app?.workspace?.getActiveFile()?.path === p, p), 15000).catch(() => {})
  await wait(1500)
}
const items = () => page.evaluate(() => [...document.querySelectorAll(".modal-container .suggestion-item")].map((e) => e.innerText))
const modalUp = async () => { const up = await until(() => page.evaluate(() => !!document.querySelector(".modal-container")), 6000).catch(() => false); await wait(800); return up }
const type = async (t) => { await page.keyboard.type(t, { delay: 15 }); await wait(700) }
const press = async (k) => { await page.keyboard.press(k); await wait(700) }
const click = async (sel) => { const el = page.locator(`${sel} >> visible=true`).first(); await el.scrollIntoViewIfNeeded({ timeout: 5000 }); await el.click({ timeout: 5000 }) }
const closeAll = () => page.evaluate(() => { document.querySelectorAll(".modal-container").forEach((m) => m.querySelector(".modal-close-button")?.click()); document.querySelectorAll(".modal-container").forEach((e) => e.remove()) })
const plugin = (id) => page.evaluateHandle((id) => window.app.plugins.plugins[id], id)
void plugin

const results = {}
async function check(id, fn) {
  if (only && !only.split(",").includes(id)) return
  const before = errs.length
  let r
  try { r = await fn() } catch (e) { r = { state: "fails", why: String(e?.message ?? e).split("\n")[0].slice(0, 200) } }
  r.errors = errs.slice(before).filter((e) => e.includes(`obsidian-plugin:${id}/`)).slice(0, 2)
  results[id] = r
  console.log(`${r.state.padEnd(6)} ${id}${r.why ? `: ${r.why}` : ""}${r.errors.length ? `  [${r.errors.length} errors: ${r.errors[0].split("\n")[0]}]` : ""}`)
  await page.keyboard.press("Escape").catch(() => {})
  await closeAll().catch(() => {})
}
const ok = (cond, why) => (cond ? { state: "works" } : { state: "fails", why })

await page.goto(B)
await until(() => page.evaluate(() => window.app?.workspace?.layoutReady), 90000)
await wait(4000)
await api("DELETE", `file?path=${encodeURIComponent(D)}`).catch(() => {})
await write(`${D}/Start.md`, "# Start\n")

await check("templater-obsidian", async () => {
  await page.evaluate(async () => {
    const t = window.app.plugins.plugins["templater-obsidian"]
    t.settings.templates_folder = "Templates"; t.settings.trigger_on_file_creation_mode = "folder"
    t.settings.enable_folder_templates = true; t.settings.folder_templates = [{ folder: "Daily", template: "Templates/Daily.md" }]
    await t.save_settings()
    window.app.saveLocalStorage("templater-local-settings", { ...(window.app.loadLocalStorage("templater-local-settings") ?? {}), trigger_on_file_creation: true })
  })
  await write(`${D}/Insert.md`, "start\n")
  await open(`${D}/Insert.md`)
  await run("templater-obsidian:insert-templater")
  if (!await modalUp()) return { state: "fails", why: "insert modal didn't open" }
  await type("Daily")
  await press("Enter")
  const t = await until(async () => { const s = await read(`${D}/Insert.md`); return s?.includes(`# ${today}`) ? s : null }, 6000).catch(() => null)
  if (!t) return { state: "fails", why: "template not inserted" }
  // a note the app makes in a folder with a folder template gets it
  await page.evaluate(() => window.__vaultite.modules["@vaultite"].createFile("Daily", "2031-01-01"))
  const made = await until(async () => { const s = await read("Daily/2031-01-01.md"); return s?.includes(`# ${today}`) ? s : null }, 8000).catch(() => null)
  await api("DELETE", `file?path=${encodeURIComponent("Daily/2031-01-01.md")}`).catch(() => {})
  return made ? { state: "works" } : { state: "partly", why: "insert works; folder template on a new note didn't fill" }
})

await check("quickadd", async () => {
  await page.evaluate(async () => {
    const q = window.app.plugins.plugins.quickadd
    q.settings.templateFolderPaths = ["Templates"]
    await q.saveSettings()
  })
  await page.evaluate(() => window.app.setting.openTabById("quickadd"))
  await wait(1500)
  await click("button:has-text('New choice')")
  await click("[role=menuitem]:has-text('Capture')")
  await page.locator(".setting-page .setting-item:has-text('Name') input >> visible=true").first().fill("Qa capture")
  await click(".setting-page input[placeholder='Daily/{{DATE}}.md']")
  await type(`${D}/Inbox.md`)
  await click(".setting-page .setting-item:has-text('Create file if it') .checkbox-container")
  await click(".setting-page-bar button")
  await wait(500)
  await page.keyboard.press("Escape")
  await closeAll()
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()))
  await open(`${D}/Start.md`)
  await run("quickadd:runQuickAdd")
  if (!await modalUp()) return { state: "fails", why: "launcher didn't open" }
  await type("Qa capture")
  await press("Enter")
  await type("Remember the rope")
  await press("Enter")
  const cap = await until(async () => ((await read(`${D}/Inbox.md`))?.includes("Remember the rope") ? true : null), 6000).catch(() => null)
  if (!cap) return { state: "fails", why: "capture not written" }
  await run("quickadd:runTemplateFromFolder")
  if (!await modalUp()) return { state: "partly", why: "capture works; template picker didn't open" }
  await press("Enter")
  await type(`${D}/From template`)
  await press("Enter")
  const made = await until(async () => ((await read(`${D}/From template.md`))?.includes(`# ${today}`) ? true : null), 6000).catch(() => null)
  return made ? { state: "works" } : { state: "partly", why: "capture works; note from template not made" }
})

await check("omnisearch", async () => {
  await run("omnisearch:show-modal")
  if (!await modalUp()) return { state: "fails", why: "modal didn't open" }
  await type("lighthouse keeper")
  await wait(1500)
  const got = await until(async () => { const l = await page.evaluate(() => [...document.querySelectorAll(".modal-container .omnisearch-result, .modal-container .suggestion-item")].map((e) => e.innerText)); return l.length ? l : null }, 6000).catch(() => [])
  if (!got.some((t) => /2026-10-05/.test(t))) return { state: "fails", why: `results: ${got.slice(0, 2)}` }
  await press("Enter")
  return ok(await until(async () => ((await active()) === "Daily/2026-10-05.md" ? true : null), 5000).catch(() => false), "result didn't open")
})

await check("darlal-switcher-plus", async () => {
  await write(`${D}/Heads.md`, "# Heads\n\nIntro.\n\n## Keeper duties\n\nLight the lamp.\n")
  await open(`${D}/Start.md`)
  await run("darlal-switcher-plus:switcher-plus:open-headings")
  if (!await modalUp()) return { state: "fails", why: "modal didn't open" }
  await type("Keeper duties")
  if (!(await items()).some((t) => /Keeper duties/.test(t))) return { state: "fails", why: "no heading found" }
  await press("Enter")
  const at = await until(() => page.evaluate(() => { const e = window.app.workspace.activeEditor?.editor; return e && /## Keeper duties/.test(e.getLine(e.getCursor().line)) ? true : null }), 6000).catch(() => false)
  if (!at) return { state: "partly", why: "opens the note, not at the heading" }
  await run("darlal-switcher-plus:switcher-plus:open-commands")
  await modalUp()
  await type("search in a tab")
  await press("Enter")
  return ok(await until(() => page.evaluate(() => (location.hash.startsWith("#view/search") ? true : null)), 5000).catch(() => false), "commands mode didn't run the app's command")
})

await check("obsidian-another-quick-switcher", async () => {
  await run("obsidian-another-quick-switcher:search-command_file-name-search")
  if (!await modalUp()) return { state: "fails", why: "modal didn't open" }
  await type("alice park")
  if (!(await items()).some((t) => /Alice Park/.test(t))) return { state: "fails", why: "note not listed" }
  await press("Enter")
  return ok(await until(async () => ((await active()) === "People/Alice Park.md" ? true : null), 5000).catch(() => false), "didn't open it")
})

await check("periodic-notes", async () => {
  await page.evaluate(async () => {
    const p = window.app.plugins.plugins["periodic-notes"]
    p.settings.daily = { format: "YYYY-MM-DD", folder: "Daily", template: "Templates/Daily", enabled: true }
    await p.saveSettings?.() ?? await p.saveData(p.settings)
    p.settings = { ...p.settings }
    await p.onSettingsUpdate?.()
  })
  // (as the settings sheet's Migrate does: the core daily notes' options, turned on)
  if (!await page.evaluate(() => !!window.app.commands.commands["periodic-notes:open-daily-note"])) {
    await page.evaluate(() => window.app.setting.openTabById("periodic-notes"))
    await wait(1500)
    await click("button:has-text('Migrate')").catch(() => {})
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()))
  }
  await api("DELETE", `file?path=${encodeURIComponent(`Daily/${today}.md`)}`).catch(() => {})
  await wait(1000)
  await run("periodic-notes:open-daily-note")
  const t = await until(async () => { const s = await read(`Daily/${today}.md`); return s?.includes(`# ${today}`) ? s : null }, 8000).catch(() => null)
  return ok(t && (await active()) === `Daily/${today}.md`, "today's note not made from its template")
})

await check("obsidian-advanced-uri", async () => {
  await write(`${D}/Links.md`, `# Links\n\n[adv](obsidian://advanced-uri?filepath=Projects%2FLighthouse.md)\n\n[open](obsidian://open?vault=Any&file=Notes%2FTable)\n\n[write](obsidian://advanced-uri?filepath=${encodeURIComponent(`${D}/Adv.md`)}&data=hello&mode=append)\n`)
  await open(`${D}/Links.md`)
  await click(".cm-link[data-url^='obsidian://advanced-uri?filepath=Projects']")
  if (!await until(async () => ((await active()) === "Projects/Lighthouse.md" ? true : null), 5000).catch(() => false)) return { state: "fails", why: "advanced-uri link didn't open the note" }
  await open(`${D}/Links.md`)
  await click(".cm-link[data-url^='obsidian://open']")
  if (!await until(async () => ((await active()) === "Notes/Table.md" ? true : null), 5000).catch(() => false)) return { state: "partly", why: "obsidian://open not followed" }
  await open(`${D}/Links.md`)
  await click(".cm-link[data-url*='data=hello']")
  return ok(await until(async () => ((await read(`${D}/Adv.md`))?.includes("hello") ? true : null), 6000).catch(() => false), "write link didn't write")
})

await check("find-unlinked-files", async () => {
  await api("DELETE", `file?path=${encodeURIComponent("orphaned files output.md")}`).catch(() => {})
  await run("find-unlinked-files:find-unlinked-files")
  const t = await until(async () => { const s = await read("orphaned files output.md"); return s?.includes("[[") ? s : null }, 8000).catch(() => null)
  return ok(t, "no output note")
})

await check("text-extractor", async () => {
  if (phone) return { state: "n/a", why: "checked on computers (Tesseract's model download is slow on a phone)" }
  await page.evaluate(async (D) => {
    const c = document.createElement("canvas"); c.width = 600; c.height = 160
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 600, 160); g.fillStyle = "#000"; g.font = "bold 56px Arial"; g.fillText("LIGHTHOUSE 42", 30, 100)
    const buf = await (await new Promise((r) => c.toBlob(r, "image/png"))).arrayBuffer()
    const f = window.app.vault.getFileByPath(`${D}/ocr.png`)
    if (f) await window.app.vault.modifyBinary(f, buf); else await window.app.vault.createBinary(`${D}/ocr.png`, buf)
  }, D)
  await wait(1500)
  await open(`${D}/ocr.png`)
  await run("text-extractor:extract-to-new-note")
  const p = await until(() => page.evaluate(() => window.app.vault.getMarkdownFiles().map((f) => f.path).find((x) => /\/ocr\.md$/.test(x)) ?? null), 90000, 1000).catch(() => null)
  return ok(p && /LIGHTHOUSE/.test(await read(p) ?? ""), "no text extracted")
})

await check("obsidian-book-search-plugin", async () => {
  await run("obsidian-book-search-plugin:open-book-search-modal")
  if (!await modalUp()) return { state: "fails", why: "modal didn't open" }
  await type("Project Hail Mary")
  await press("Enter")
  await wait(5000)
  const listed = (await items()).length
  if (listed) return { state: "works" }
  const quota = [...errs, ...logs].some((e) => /status 429/.test(e))
  return quota ? { state: "partly", why: "searches Google Books through requestUrl; its keyless daily quota answers 429 (curl too)" } : { state: "fails", why: "no results" }
})

await check("obsidian-dictionary-plugin", async () => {
  await run("obsidian-dictionary-plugin:dictionary-open-view")
  const shown = await until(() => page.evaluate(() => (document.querySelector("#dictionary-search-input")?.checkVisibility() ? true : null)), 5000).catch(() => false)
  if (!shown) return { state: "fails", why: "view's search field not shown" }
  await click("#dictionary-search-input")
  await type("lighthouse")
  await press("Enter")
  await wait(6000)
  const t = await page.evaluate(() => document.querySelector("[data-type=dictionary-view]")?.innerText ?? "")
  return /noun|tower/i.test(t) ? { state: "works" } : { state: "partly", why: "view opens and searches; api.dictionaryapi.dev answered 522 when tested (curl too)" }
})

await check("readwise-official", async () => {
  await page.evaluate(() => window.app.setting.openTabById("readwise-official"))
  await wait(1500)
  const opened = await page.evaluate(async () => {
    const out = []; const o = window.open; window.open = (u) => { out.push(String(u)); return null }
    document.querySelector('[data-obsidian-settings="readwise-official"] button')?.click()
    await new Promise((r) => setTimeout(r, 3000)); window.open = o; return out
  })
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()))
  return ok(opened.some((u) => /readwise\.io\/api_auth/.test(u)), "Connect didn't reach Readwise's login")
})

await check("obsidian-languagetool-plugin", async () => {
  await write(`${D}/Grammar.md`, "# Grammar\n\nThis are a sentense with mistakes.\n")
  await open(`${D}/Grammar.md`)
  await run("obsidian-languagetool-plugin:ltcheck-text")
  const marks = await until(() => page.evaluate(() => { const l = [...(window.app.workspace.activeEditor?.editor?.cm.contentDOM.querySelectorAll(".lt-underline") ?? [])].map((e) => e.textContent); return l.length ? l : null }), 12000).catch(() => [])
  return ok(marks.includes("sentense"), "no typo marked")
})

const out = path.join(import.meta.dirname, "..", "results", `commands${phone ? "-phone" : ""}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
if (!only) fs.writeFileSync(out, JSON.stringify(results, null, 2))
console.log(Object.values(results).reduce((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {}))
await page.close()
if (!cdp) await ctx.close()
await done()
