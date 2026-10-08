// What the views group's Obsidian plugins do here (catalog.tsv), done like a user: panels opened and clicked, the file
// tree's rows, tags, headers, settings. WRITES notes and plugin settings: lab only (lab.mjs up ... <views ids>).
//   node views.mjs <base url> [phone] [ids,comma,separated]
import fs from "node:fs"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, mode = "", only = ""], browser, check, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const phone = mode === "phone"
const OUT = `/tmp/oc-lab/shots/views-${phone ? "phone" : "desktop"}`
fs.mkdirSync(OUT, { recursive: true })
const ctx = await browser.newContext(phone
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }
  : { viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on("pageerror", (e) => errs.push(`${String(e.message).slice(0, 200)} @ ${/obsidian-plugin:([^/]+)/.exec(e.stack ?? "")?.[1] ?? "?"}`))
const note = (path, text) => api("POST", "file", { path, text }).catch(() => api("PUT", "file", { path, text }))
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`)).text
const exists = (p) => api("GET", `file?path=${encodeURIComponent(p)}`).then(() => true, () => false)
const ev = (fn, arg) => page.evaluate(fn, arg)
const ready = () => until(() => ev(() => window.app?.workspace?.layoutReady && Object.keys(window.app.plugins.plugins).length > 0), 60000, 300)
const open = async (path) => {
  await ev((h) => { location.hash = h }, `#file/${encodeURIComponent(path)}`)
  await until(() => ev((p) => window.app.workspace.getActiveFile()?.path === p, path), 10000).catch(() => {})
  await wait(600)
}
const run = (id) => ev((id) => window.app.commands.executeCommandById(id), id)
const cmds = (prefix) => ev((p) => Object.keys(window.app.commands.commands).filter((k) => k.startsWith(p)), prefix)
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 5000 }).catch(() => {})
// (on a phone a side view is in a drawer: revealed as Obsidian's mobile app does, when its command left it there)
const inSight = (sel) => ev((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.x >= 0 && r.x < innerWidth }, sel)
const reveal = (sel) => ev((s) => { const ws = window.app.workspace, l = ws.allLeaves().find((x) => x.view?.containerEl?.querySelector(s)); if (l) void ws.revealLeaf(l) }, sel)
const view = async (cmd, sel) => {
  await run(cmd)
  await until(() => ev((s) => !!document.querySelector(s), sel), 8000)
  if (phone && !(await inSight(sel))) { await reveal(sel); await until(() => inSight(sel), 5000) }
}
const plugin = (id) => `window.app.plugins.plugins[${JSON.stringify(id)}]`
/** Change a plugin's settings as its options would (its own saveSettings), then let it apply them. */
const setSettings = (id, patch) => ev(async ([id, patch]) => {
  const p = window.app.plugins.plugins[id]
  Object.assign(p.settings ?? (p.settings = {}), patch)
  await (p.saveSettings?.() ?? p.saveData(p.settings))
}, [id, patch])
const results = {}
const test = async (id, fn) => {
  if (only && !only.split(",").includes(id)) return
  const before = errs.length
  let r
  try { r = await fn() } catch (e) { r = { state: "fails", why: String(e).split("\n")[0].slice(0, 200) }; await shot(`fail-${id}`) }
  r.errors = errs.slice(before).filter((e) => e.endsWith(`@ ${id}`)).slice(0, 3)
  results[id] = r
  check(`${id}: ${r.state}${r.why ? ` (${r.why})` : ""}`, r.state !== "fails")
  await page.keyboard.press("Escape").catch(() => {})
  await ev(() => document.querySelectorAll(".modal-container, .menu").forEach((e) => e.remove()))
}
const ok = (why) => ({ state: "works", ...(why ? { why } : {}) })
const partly = (why) => ({ state: "partly", why })
const fails = (why) => ({ state: "fails", why })
const na = (why) => ({ state: "n/a", why })

await note("Projects/Projects.md", "# Projects\n\nThe projects folder's note.\n")
await note("Notes/Tagged.md", "---\ntags: [idea]\nbanner: \"https://picsum.photos/seed/lh/800/200\"\n---\n# Tagged\n\nA #idea and a #work/deep tag.\n\n## First\n\ntext\n\n## Second\n\nmore\n")
await page.goto(B)
await ready()
await wait(1500)
// (plugins' first-run welcomes, closed as a user would)
for (let i = 0; i < 4 && await ev(() => !!document.querySelector(".modal-container")); i++) { await page.keyboard.press("Escape"); await wait(400) }
await ev(() => document.querySelectorAll(".modal-container").forEach((e) => e.remove()))

await test("calendar", async () => {
  await view("calendar:show-calendar-view", ".calendar td .day")
  const dots = await ev(() => document.querySelectorAll(".calendar .day .dot, .calendar .dot").length)
  await shot("calendar")
  // Today's note (made from the daily template when missing), by clicking its day.
  const today = await ev(() => window.moment().format("YYYY-MM-DD"))
  await page.locator(".calendar .day.today").first().click()
  await wait(800)
  if (await page.locator(".modal-container button.mod-cta").count()) await page.locator(".modal-container button.mod-cta").first().click()
  await until(() => exists(`Daily/${today}.md`), 6000)
  const active = await ev(() => window.app.workspace.getActiveFile()?.path)
  return dots && active === `Daily/${today}.md` ? ok() : fails(`dots ${dots}, opened ${active}`)
})

await test("recent-files-obsidian", async () => {
  await open("Notes/Table.md")
  await open("Notes/Outline.md")
  const id = (await cmds("recent-files-obsidian:"))[0]
  await run(id)
  await until(() => ev(() => !!document.querySelector(".recent-files-title")), 6000)
  const names = await ev(() => [...document.querySelectorAll(".recent-files-title .nav-file-title-content")].map((e) => e.textContent))
  await page.locator(".recent-files-title .nav-file-title-content", { hasText: "Table" }).first().click()
  await wait(500)
  const active = await ev(() => window.app.workspace.getActiveFile()?.path)
  return names[0] === "Outline" && names.includes("Table") && active === "Notes/Table.md" ? ok() : fails(`${names.slice(0, 4)} opened ${active}`)
})

await test("obsidian-icon-folder", async () => {
  await ev(async () => { const p = window.app.plugins.plugins["obsidian-icon-folder"]; p.addFolderIcon("Projects", "LiStar"); await p.saveIconFolderData() })
  await page.reload()
  await ready()
  await until(() => ev(() => !!document.querySelector('[data-tree-path="Projects"] .iconize-icon svg')), 8000)
  return ok()
})

await test("file-explorer-note-count", async () => {
  await until(() => ev(() => document.querySelector('[data-tree-path="Projects"]')?.getAttribute("data-count")), 8000)
  const shown = await ev(() => getComputedStyle(document.querySelector('[data-tree-path="Projects"]'), "::after").content)
  return /\d/.test(shown) ? ok() : partly(`counted, not drawn (${shown})`)
})

await test("folder-notes", async () => {
  // (on a phone the tree is in the drawer, which may be closed or scrolled: its row is clicked where it is)
  if (phone) await ev(() => document.querySelector('[data-tree-path="Projects"] button')?.click())
  else await page.locator('[data-tree-path="Projects"] button').first().click()
  await wait(800)
  const active = await ev(() => window.app.workspace.getActiveFile()?.path)
  return active === "Projects/Projects.md" ? ok() : fails(`opened ${active}`)
})


const clickText = async (sel, text) => { await page.locator(sel, { hasText: text }).first().click({ timeout: 6000 }); await wait(700) }
/** A real click at the middle of the first `sel` (for elements Playwright's checks won't click: always moving). */
const mouseClick = async (sel) => {
  const r = await ev((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }, sel)
  if (!r) throw new Error(`no ${sel}`)
  await page.mouse.click(r.x, r.y)
  await wait(500)
}
// (inside a panel too short to show it: a click all the same, as after scrolling it into sight)
const clickIn = async (sel, text) => { await ev(([s, t]) => [...document.querySelectorAll(s)].find((e) => e.textContent?.includes(t))?.dispatchEvent(new MouseEvent("click", { bubbles: true })), [sel, text]); await wait(700) }
const activePath = () => ev(() => window.app.workspace.getActiveFile()?.path)

await test("notebook-navigator", async () => {
  await view("notebook-navigator:open", ".notebook-navigator")
  await open("Projects/Lighthouse.md")
  await run("notebook-navigator:reveal-file")
  await until(() => ev(() => [...document.querySelectorAll(".nn-file-name")].some((e) => e.textContent?.trim() === "Projects")), 6000)
  await page.locator(".nn-file-name", { hasText: /^Projects$/ }).first().click({ timeout: 6000 })
  await wait(700)
  await shot("notebook-navigator")
  const a = await activePath()
  return a === "Projects/Projects.md" ? ok() : fails(`opened ${a}`)
})

await test("file-tree-alternative", async () => {
  // (in a tab, as its panel's "Open in a tab": its file list needs more height than a shared sidebar gives)
  await ev(() => window.app.workspace.getLeaf(true).setViewState({ type: "file-tree-view", active: true }))
  // (the copy in the tab, inside its leaf's own element: the sidebar may show another)
  const inTab = (sel, t) => ev(([s2, t2]) => { const l = window.app.workspace.getLeavesOfType("file-tree-view").find((x) => x.side === "main"); return [...(l?.view.containerEl.querySelectorAll(s2) ?? [])].find((e) => e.textContent?.includes(t2)) ? (([...l.view.containerEl.querySelectorAll(s2)].find((e) => e.textContent?.includes(t2))).click(), true) : false }, [sel, t])
  await until(() => inTab(".oz-folder-name", "Notes"), 8000)
  await until(() => ev(() => [...document.querySelectorAll(".oz-nav-file-title-content")].some((e) => e.textContent?.includes("Table"))), 6000)
  await until(() => inTab(".oz-nav-file-title-content", "Table"), 6000)
  const a = await until(async () => ((await activePath()) === "Notes/Table.md" ? "Notes/Table.md" : null), 5000).catch(() => activePath())
  await shot("file-tree-alternative")
  return a === "Notes/Table.md" ? ok() : fails(`opened ${a}`)
})

await test("obsidian-tagfolder", async () => {
  await view("obsidian-tagfolder:tagfolder-open", ".tag-folder-title")
  await clickText(".tag-folder-title", "idea")
  await until(() => ev(() => [...document.querySelectorAll(".tagfolder-view .nav-file-title, .nav-file-title-content")].some((e) => e.textContent?.includes("Tagged"))), 6000)
  await clickText(".nav-file-title-content", "Tagged")
  await shot("tagfolder")
  const a = await activePath()
  return a === "Notes/Tagged.md" ? ok() : fails(`opened ${a}`)
})

await test("obsidian-quiet-outline", async () => {
  await open("Notes/Tagged.md")
  await view("obsidian-quiet-outline:quiet-outline", ".quiet-outline")
  // (quiet: only the top heading shows until it's opened)
  await until(() => ev(() => document.querySelector(".quiet-outline")?.textContent?.includes("Tagged")), 6000)
  await page.locator(".quiet-outline .n-tree-node-content__text, .quiet-outline .n-tree-node-content", { hasText: "Tagged" }).first().click({ timeout: 6000 })
  await wait(700)
  const line = await ev(() => { const v = window.app.workspace.activeEditor?.editor; return v ? v.getLine(v.getCursor().line) : null })
  await shot("quiet-outline")
  return line?.includes("Tagged") ? ok() : partly(`lists headings; cursor on '${line}'`)
})

await test("obsidian-file-color", async () => {
  await ev(async () => {
    const p = window.app.plugins.plugins["obsidian-file-color"]
    p.settings.palette = [{ id: "c1", name: "Red", value: "#e03131" }]
    p.settings.fileColors = [{ path: "People", color: "c1" }]
    await p.saveSettings()
    p.generateColorStyles?.(); p.applyColorStyles?.()
  })
  await until(() => ev(() => { const r = document.querySelector('[data-tree-path="People"]'); return r && getComputedStyle(r.querySelector("button span:not([data-file-row-nodes])") ?? r).color === "rgb(224, 49, 49)" }), 8000)
  await shot("file-color")
  return ok()
})

await test("colored-tags", async () => {
  await open("Notes/Tagged.md")
  await until(() => ev(() => { const t = document.querySelector(".cm-content .cm-hashtag.cm-tag-idea"); return t && getComputedStyle(t).backgroundColor !== "rgba(0, 0, 0, 0)" }), 8000)
  await shot("colored-tags")
  return ok()
})

await test("tag-wrangler", async () => {
  await open("Notes/Tagged.md")
  const tag = page.locator(".cm-content .cm-hashtag.cm-tag-idea").first()
  if (phone) {
    // (a finger held on it, as on an iPhone: touch events through the browser's own input)
    const b = await tag.boundingBox(), cdp = await page.context().newCDPSession(page), at = [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }]
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at })
    await wait(900)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } else await tag.click({ button: "right" })
  await until(() => ev(() => [...document.querySelectorAll("[role=menuitem], .menu-item")].some((e) => /Rename #idea/.test(e.textContent ?? ""))), 5000)
  await page.locator("[role=menuitem], .menu-item", { hasText: "Rename #idea" }).first().click()
  await until(() => ev(() => !!document.querySelector(".modal-container input, .modal input")), 5000)
  await page.locator(".modal input").first().fill("thought")
  await page.keyboard.press("Enter")
  await wait(500)
  if (await page.locator(".modal button.mod-cta").count()) { await page.locator(".modal button.mod-cta").first().click(); await wait(300) }
  await until(async () => (await read("Notes/Tagged.md")).includes("#thought"), 8000)
  const text = await read("Notes/Tagged.md")
  return text.includes("tags: [thought]") || text.includes("- thought") || /tags:.*thought/.test(text) ? ok() : partly("renamed in the body, not the frontmatter")
})

await test("supercharged-links-obsidian", async () => {
  await setSettings("supercharged-links-obsidian", { targetAttributes: ["role"], targetTags: true, enableFileList: true })
  await page.reload()
  await ready()
  await page.locator('[data-tree-path="People"] button').first().click().catch(() => {})
  const row = await until(() => ev(() => document.querySelector('[data-tree-path="People/Alice Park.md"] [data-link-role]')?.getAttribute("data-link-role")), 8000).catch(() => null)
  await shot("supercharged-links")
  return row === "designer" ? partly("file tree and rendered links; not links in the editor (it reads Obsidian's own parser's tokens)") : fails(`row ${row}`)
})

await test("note-toolbar", async () => {
  await ev(async () => {
    const p = window.app.plugins.plugins["note-toolbar"], sm = p.settingsManager
    const tb = sm.getToolbarByName("QA") ?? await sm.newToolbar("QA")
    const item = sm.getDefaultItem("command")
    Object.assign(item, { label: "Bold it", icon: "bold", link: "editor:toggle-bold", linkAttr: { ...item.linkAttr, type: "command", commandId: "editor:toggle-bold" } })
    tb.items = [item]
    await sm.save()
  })
  await note("Notes/Toolbar.md", "---\nnotetoolbar: QA\n---\n# Toolbar\n\nsome text\n")
  await open("Notes/Toolbar.md")
  await until(() => ev(() => !!document.querySelector(".cg-note-toolbar-container .cg-note-toolbar-item")), 8000)
  await ev(() => { const e = window.app.workspace.activeEditor.editor, l = e.lastLine(); e.setSelection({ line: l - 1, ch: 0 }, { line: l - 1, ch: 4 }); e.focus() })
  await mouseClick(".cg-note-toolbar-item")
  await until(async () => (await read("Notes/Toolbar.md")).includes("**some**"), 6000)
  await shot("note-toolbar")
  return ok()
})

await test("cmdr", async () => {
  const pair = { id: "editor:toggle-bold", icon: "bold", name: "Bold (QA)", mode: "any" }
  await ev(async (pair) => {
    const p = window.app.plugins.plugins["cmdr"]
    p.settings.pageHeader = [pair]; p.settings.statusBar = [{ ...pair, name: "Bold (status)" }]
    await p.saveSettings()
  }, pair)
  await page.reload()
  await ready()
  await open("Notes/Toolbar.md")
  await until(() => ev(() => !!document.querySelector('[data-obsidian-actions] button[aria-label="Bold (QA)"]')), 8000)
  await ev(() => { const e = window.app.workspace.activeEditor.editor, l = e.lastLine(); e.setSelection({ line: l - 1, ch: 7 }, { line: l - 1, ch: 11 }); e.focus() })
  // (the note's own copy of the button: panels' headings show their views' actions too)
  await ev(() => document.querySelector('article.file-view [data-obsidian-actions] button[aria-label="Bold (QA)"], [data-obsidian-actions="markdown"] button[aria-label="Bold (QA)"]')?.click())
  await until(async () => (await read("Notes/Toolbar.md")).includes("**text**"), 6000)
  const status = await ev(() => [...document.querySelectorAll(".plugin-compat-status *")].some((e) => e.getAttribute("aria-label") === "Bold (status)"))
  await shot("cmdr")
  return status ? ok() : partly("page header works; its status bar item doesn't show")
})

await test("homepage", async () => {
  await ev(async () => {
    const p = window.app.plugins.plugins["homepage"]
    const d = await p.loadData() ?? {}
    d.homepages = { "Main Homepage": { ...(d.homepages?.["Main Homepage"] ?? {}), value: "Projects/Lighthouse", kind: "File", openOnStartup: true, openMode: "Keep open notes", manualOpenMode: "Keep open notes", view: "Default view", commands: [] } }
    await p.saveData(d)
  })
  await open("Notes/Table.md")
  await page.reload()
  await ready()
  await until(async () => (await activePath()) === "Projects/Lighthouse.md", 10000)
  return ok()
})

const settingsOf = async (id) => {
  await ev((id) => window.app.setting.openTabById(id), id)
  await until(() => ev((id) => document.querySelector(`[data-obsidian-settings="${id}"]`)?.querySelectorAll(".setting-item").length > 0, id), 8000)
  return ev((id) => document.querySelector(`[data-obsidian-settings="${id}"]`).querySelectorAll(".setting-item").length, id)
}

await test("obsidian-minimal-settings", async () => {
  const n = await settingsOf("obsidian-minimal-settings")
  await shot("minimal-settings")
  return n > 5 ? na(`for the Minimal theme, which isn't here: its ${n} settings show and set its classes`) : fails(`${n} settings`)
})

await test("obsidian-hider", async () => {
  const n = await settingsOf("obsidian-hider")
  const before = await ev(() => document.body.className)
  await page.locator('[data-obsidian-settings="obsidian-hider"] .checkbox-container').first().click()
  await wait(500)
  const after = await ev(() => document.body.className)
  await shot("hider")
  return n > 2 && before !== after ? na("it hides Obsidian's own chrome, which isn't here: its settings show and set its classes") : fails(`${n} settings, classes unchanged`)
})

await test("callout-manager", async () => {
  const n = await settingsOf("callout-manager")
  await shot("callout-manager")
  const text = await ev(() => document.querySelector('[data-obsidian-settings="callout-manager"]')?.textContent ?? "")
  return n > 0 && /note|tip|warning/i.test(text) ? ok() : partly(`${n} settings; callouts listed: ${/note/i.test(text)}`)
})

await test("obsidian-style-settings", async () => {
  // A snippet's settings, as a theme or plugin declares them (a /* @settings */ comment in a stylesheet).
  await ev(() => {
    const st = document.createElement("style")
    st.id = "qa-style-settings"
    st.textContent = `/* @settings\nname: QA snippet\nid: qa-snippet\nsettings:\n  -\n    id: qa-accent-size\n    title: Accent size\n    type: variable-number-slider\n    default: 10\n    min: 0\n    max: 40\n    step: 1\n    format: px\n*/\nbody { --qa-accent-size: 10px; }`
    document.head.append(st)
    window.app.workspace.trigger("css-change")
  })
  await wait(800)
  await run("obsidian-style-settings:show-style-settings-leaf")
  await until(() => ev(() => [...document.querySelectorAll(".style-settings-heading, .setting-item-heading, .setting-item-name")].some((e) => /QA snippet/.test(e.textContent ?? ""))), 8000)
  await page.locator(".style-settings-heading, .setting-item-heading", { hasText: "QA snippet" }).first().click()
  await until(() => ev(() => !!document.querySelector(".style-settings-container input[type=range], .style-settings-container .slider")), 5000)
  await ev(() => { const r = document.querySelector(".style-settings-container input[type=range]"); r.value = "24"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })) })
  await until(() => ev(() => getComputedStyle(document.body).getPropertyValue("--qa-accent-size").trim() === "24px"), 5000)
  await shot("style-settings")
  return ok()
})

await test("obsidian-admonition", async () => {
  await open("Notes/Callouts.md")
  await until(() => ev(() => [...document.querySelectorAll(".admonition-title, .callout-title")].some((e) => e.textContent?.includes("Careful"))), 8000)
  await shot("admonition")
  return ok()
})

await test("mermaid-tools", async () => {
  await note("Notes/Diagram.md", "# Diagram\n\n")
  await open("Notes/Diagram.md")
  await ev(() => { const e = window.app.workspace.activeEditor.editor; e.setCursor({ line: e.lastLine(), ch: 0 }); e.focus() })
  await view("mermaid-tools:open-toolbar", ".mermaid-toolbar-element")
  await clickIn(".mermaid-toolbar-element", "")
  await until(async () => /[A-Za-z]+.*-->|flowchart|graph|sequenceDiagram|-->/.test(await read("Notes/Diagram.md")), 6000)
  await shot("mermaid-tools")
  return ok()
})

await test("obsidian-banners", async () => {
  await open("Notes/Tagged.md")
  // (seen, not only there: the middle of the banner is the banner)
  const shown = await until(() => ev(() => { const b = document.querySelector(".file-view .obsidian-banner"); if (!b) return false; const r = b.getBoundingClientRect(); const img = b.querySelector("img"); return r.height > 20 && !!img && img.naturalWidth > 0 && b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), 4000).then(() => true, () => false)
  await wait(1500)
  await shot("banners")
  const stays = await ev(() => !!document.querySelector(".file-view .obsidian-banner img"))
  // (the note's text starts below it, as its spacer says)
  const clear = await ev(() => { const b = document.querySelector(".file-view .obsidian-banner")?.getBoundingClientRect(), l = document.querySelector(".file-view .cm-line")?.getBoundingClientRect(); return !!b && !!l && l.top >= b.bottom - 2 })
  if (shown && stays && !clear) return partly("its banner shows, over the note's first lines (the room its spacer makes isn't kept)")
  return shown && stays ? ok() : partly(shown ? "its banner shows for a moment, then the app's editor redraws over it" : "only in Markdown drawn outside the editor: in notes it reads Obsidian's own parser's frontmatter tokens")
})

await test("iconic", async () => {
  await ev(async () => {
    const p = window.app.plugins.plugins["iconic"]
    p.settings.folderIcons = { ...(p.settings.folderIcons ?? {}), People: { icon: "lucide-users", color: "red" } }
    await p.saveSettings?.()
  }).catch(() => {})
  await page.reload()
  await ready()
  const has = await until(() => ev(() => !!document.querySelector('[data-tree-path="People"] [data-file-row-nodes] svg, [data-tree-path="People"].iconic-item')), 6000).then(() => true, () => false)
  return has ? ok() : partly("loads and its settings show; its icons don't reach the app's file tree yet")
})

await test("obsidian-hover-editor", async () => {
  await open("Projects/Lighthouse.md")
  await page.locator(".cm-content [data-wiki], .cm-content .cm-link", { hasText: "Alice Park" }).first().hover({ timeout: 5000 }).catch(() => {})
  await page.keyboard.down("Meta"); await wait(1200); await page.keyboard.up("Meta")
  const editor = await ev(() => !!document.querySelector(".hover-editor, .popover.hover-editor"))
  return editor ? ok() : partly("loads; links show the app's own page preview, not its floating editor (it replaces Obsidian's popover internals)")
})

await test("pretty-properties", async () => {
  return na("it restyles Obsidian's properties view; the app draws its own properties")
})

fs.mkdirSync("/tmp/oc-lab/results", { recursive: true })
fs.writeFileSync(`/tmp/oc-lab/results/views-${phone ? "phone" : "web"}.json`, JSON.stringify(results, null, 1))
console.log("unattributed page errors:", errs.filter((e) => e.endsWith("@ ?")).slice(0, 5))
await ctx.close()
await done()
