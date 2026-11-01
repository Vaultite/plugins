// Obsidian's API doing what it says, in the lab's page (the probe plugin hands over the module): files, events,
// metadata, links, the file manager, the adapter, ES5 subclasses, the editor's positions, post-processors over a note
// being read. WRITES "Api test/": lab only.
//   node behaviour.mjs <base url>
import { apiAt, palette, qa, until, wait } from "../../../qa.mjs"

const { args: [B0], browser, check, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
const errs = []
page.on("pageerror", (e) => errs.push(String(e.stack ?? e).slice(0, 300)))
await page.goto(B)
await until(() => page.evaluate(() => !!window.__probe && window.app?.workspace?.layoutReady), 90000, 500)
const run = (fn, arg) => page.evaluate(`(async () => { const { obsidian: o, app } = window.__probe; const arg = ${JSON.stringify(arg ?? null)}; try { return await (${fn})(o, app, arg) } catch (e) { return { thrown: String(e && e.stack || e) } } })()`)

await run(async (o, app) => { for (const f of [...app.vault.getFiles()].filter((f) => f.path.startsWith("Api test/"))) await app.vault.delete(f) })

const r1 = await run(async (o, app) => {
  const ev = []
  const refs = [app.vault.on("create", (f) => ev.push(`create ${f.path}`)), app.metadataCache.on("changed", (f, data) => ev.push(`changed ${f.path} ${data.length}`)),
    app.metadataCache.on("resolved", () => ev.push("resolved"))]
  if (!app.vault.getFolderByPath("Api test")) await app.vault.createFolder("Api test")
  const b = await app.vault.create("Api test/B.md", "# B\n\nSome text ^blk\n\n## Sub\n\nmore\n")
  const a = await app.vault.create("Api test/A.md", "---\ntags: [x, y]\naliases: [Alpha]\n---\n# A\n\nSee [[B]] and [[B#Sub]] and [[Nowhere]] #inline\n\n- [ ] task one\n  - [x] child ^c1\n")
  await new Promise((r) => setTimeout(r, 300))
  refs.forEach((x) => x.e.offref(x))
  const c = app.metadataCache.getFileCache(a)
  return { ev, same: app.vault.getFileByPath("Api test/A.md") === a, links: c?.links?.map((l) => l.link), tags: o.getAllTags(c), fm: c?.frontmatter,
    resolved: app.metadataCache.resolvedLinks["Api test/A.md"], unresolved: app.metadataCache.unresolvedLinks["Api test/A.md"],
    tasks: c?.listItems?.map((l) => [l.task, l.parent]), blocks: Object.keys(c?.blocks ?? {}), sub: o.resolveSubpath(app.metadataCache.getFileCache(b), "#Sub")?.current?.heading,
    blk: o.resolveSubpath(app.metadataCache.getFileCache(b), "#^blk")?.type, dest: app.metadataCache.getFirstLinkpathDest("B", "Api test/A.md")?.path,
    linktext: app.metadataCache.fileToLinktext(b, "Api test/A.md"), mdlink: app.fileManager.generateMarkdownLink(b, "Api test/A.md", "#Sub", "bee"),
    backlinks: app.metadataCache.getBacklinksForFile(b).keys() }
})
check("create: same object, events", r1.same && r1.ev.some((e) => e.startsWith("create Api test/A.md")) && r1.ev.some((e) => e.startsWith("changed Api test/A.md")), r1)
check("metadata: links, tags, frontmatter", JSON.stringify(r1.links) === JSON.stringify(["B", "B#Sub", "Nowhere"]) && r1.tags?.join() === "#x,#y,#inline" && r1.fm?.aliases?.[0] === "Alpha", r1)
check("links resolved and unresolved", r1.resolved?.["Api test/B.md"] === 2 && r1.unresolved?.Nowhere === 1, r1)
// (a child's parent is its item's line; a top item's is minus its list's first line, minus one: the file's lines,
// the frontmatter the server adds included)
check("list items and blocks", r1.tasks?.[0]?.[0] === " " && r1.tasks[1]?.[0] === "x" && r1.tasks[1][1] > 0 && r1.tasks[0][1] === -(r1.tasks[1][1] + 1) && r1.blocks.includes("c1"), r1)
check("subpaths", r1.sub === "Sub" && r1.blk === "block", r1)
check("link resolution and text", r1.dest === "Api test/B.md" && r1.linktext === "B" && r1.mdlink === "[[B#Sub|bee]]" && r1.backlinks.includes("Api test/A.md"), r1)

// Obsidian's order: vault create/modify first, then the note's metadata and one "changed", then "resolved"; a plugin
// handling both create and changed builds once (Map View's markers did twice).
const r1b = await run(async (o, app) => {
  const ev = [], P = "Api test/Once.md", mine = (f) => f.path === P, fm = (f) => app.metadataCache.getFileCache(f)?.frontmatter?.n ?? null
  const refs = [app.vault.on("create", (f) => mine(f) && ev.push(["create", app.metadataCache.getFileCache(f)])), app.vault.on("modify", (f) => mine(f) && ev.push(["modify", fm(f)])),
    app.metadataCache.on("changed", (f, data, c) => mine(f) && ev.push(["changed", c?.frontmatter?.n ?? null, fm(f)])), app.metadataCache.on("resolved", () => ev.push(["resolved"]))]
  const f = await app.vault.create(P, "---\nn: 1\n---\nfirst\n")
  await new Promise((r) => setTimeout(r, 1500))
  const made = ev.splice(0)
  await app.vault.modify(f, "---\nn: 2\n---\nsecond\n")
  await new Promise((r) => setTimeout(r, 1500))
  refs.forEach((x) => x.e.offref(x))
  return { made: JSON.stringify(made.slice(0, 3)), more: made.slice(3).filter(([e]) => e !== "resolved").length, changed: JSON.stringify(ev.filter(([e]) => e !== "resolved")) }
})
check("a new note: one create (metadata not in yet), one changed with it, then resolved",
  r1b.made === JSON.stringify([["create", null], ["changed", 1, 1], ["resolved"]]) && r1b.more === 0, r1b)
check("a changed note: modify sees the old metadata, one changed the new", r1b.changed === JSON.stringify([["modify", 1], ["changed", 2, 2]]), r1b)

const r2 = await run(async (o, app) => {
  const a = app.vault.getFileByPath("Api test/A.md")
  let renamed = null
  const ref = app.vault.on("rename", (f, old) => { renamed = [f === a, old, f.path] })
  await app.fileManager.renameFile(a, "Api test/A2.md")
  app.vault.offref(ref)
  await app.fileManager.processFrontMatter(a, (fm) => { fm.status = "done"; delete fm.aliases })
  const text = await app.vault.read(a)
  await app.vault.process(a, (t) => t + "\nappended\n")
  return { renamed, path: a.path, basename: a.basename, inMap: app.vault.getAbstractFileByPath("Api test/A2.md") === a, old: app.vault.getAbstractFileByPath("Api test/A.md"), text, after: (await app.vault.read(a)).endsWith("appended\n") }
})
check("rename keeps the object, says the old path", JSON.stringify(r2.renamed) === JSON.stringify([true, "Api test/A.md", "Api test/A2.md"]) && r2.inMap && r2.old === null && r2.basename === "A2", r2)
check("processFrontMatter keeps the body", /status: done/.test(r2.text) && !/aliases/.test(r2.text) && r2.text.includes("See [[B]]") && r2.after, r2)

const r3 = await run(async (o, app) => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  const f = await app.vault.createBinary("Api test/bin.dat", bytes.buffer)
  const back = new Uint8Array(await app.vault.readBinary(f))
  await app.vault.adapter.write(".api-test/state.json", JSON.stringify({ a: 1 }))
  const read = await app.vault.adapter.read(".api-test/state.json")
  const ex = await app.vault.adapter.exists(".api-test/state.json")
  const list = await app.vault.adapter.list(".api-test")
  await app.vault.adapter.rmdir(".api-test", true)
  const gone = !(await app.vault.adapter.exists(".api-test"))
  const att = await app.fileManager.getAvailablePathForAttachment("pic.png", "Api test/A2.md")
  return { bin: [...back].join(), read, ex, list, gone, att, cfg: app.vault.getConfig("attachmentFolderPath"), b64: o.arrayBufferToBase64(bytes.buffer) }
})
check("binary round trip", r3.bin === "0,1,2,250,255" && r3.b64 === "AAEC+v8=", r3)
check("adapter on hidden files", r3.read === '{"a":1}' && r3.ex && r3.list?.files?.includes(".api-test/state.json") && r3.gone, r3)
check("attachment path follows app.json", r3.cfg === "Attachments" && r3.att === "Attachments/pic.png", r3)

// cachedRead: reads asked together (and the notes read ahead with them) each get their own file's text, and a note
// changed elsewhere, while a read of it is on its way, reads as it is now once its modify event is out.
const rc = await run(async (o, app) => {
  const fs = [] // (the server gives a new note frontmatter)
  for (let i = 0; i < 30; i++) fs.push(await app.vault.create(`Api test/C${i}.md`, `cached ${i}\n`))
  app.vault.text.clear()
  const first = await app.vault.cachedRead(fs[5]), all = await Promise.all([...fs, ...fs].map((f) => app.vault.cachedRead(f)))
  app.vault.text.delete(fs[1].path)
  const modified = new Promise((r) => { const ref = app.vault.on("modify", (f) => { if (f === fs[1]) { app.vault.offref(ref); r(true) } }) })
  const old = app.vault.cachedRead(fs[1])
  await fetch(`${location.origin}/api/file`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: fs[1].path, text: "changed 1\n" }) })
  const heard = await Promise.race([modified, new Promise((r) => setTimeout(() => r(false), 10000))])
  await old
  const after = await app.vault.cachedRead(fs[1])
  await app.vault.modify(fs[2], "changed 2\n")
  return { first, own: all.every((t, i) => t.endsWith(`\ncached ${i % 30}\n`)), heard, after, mine: await app.vault.cachedRead(fs[2]) }
})
check("cachedRead: concurrent reads each return their own file's text", rc.first?.endsWith("\ncached 5\n") && rc.own, rc)
check("cachedRead: current text after a modify", rc.heard && /^changed 1\n?$/.test(rc.after) && rc.mine === "changed 2\n", rc)

const r4 = await run(async (o, app) => {
  function Old(a, m) { o.Plugin.call(this, a, m); this.mine = 1 }
  Old.prototype = Object.create(o.Plugin.prototype); Old.prototype.constructor = Old
  const p = new Old(app, { id: "x", name: "X" })
  const ES5 = function (a) { var _this = o.Modal.call(this, a) || this; _this.extra = 2; return _this }
  Object.setPrototypeOf(ES5, o.Modal); ES5.prototype = Object.create(o.Modal.prototype, { constructor: { value: ES5 } })
  const m = new ES5(app)
  const c = new o.Component(); const child = new o.Component(); let unloaded = 0
  child.onunload = () => { unloaded++ }; c.addChild(child); c.load(); c.registerInterval(window.setInterval(() => {}, 1000)); c.unload()
  const deb = []; const d = o.debounce((x) => deb.push(x), 20, true); d(1); d(2); await new Promise((r) => setTimeout(r, 60))
  return { plugin: p instanceof o.Plugin && p.app === app && p.manifest.id === "x" && p.mine === 1, modal: m instanceof o.Modal && !!m.modalEl && m.extra === 2, unloaded, deb,
    req: await o.requestUrl({ url: location.origin + "/api/plugins" }).json.then((j) => Array.isArray(j)).catch((e) => String(e)) }
})
check("ES5 subclasses of Plugin and Modal", r4.plugin && r4.modal, r4)
check("Component unloads children", r4.unloaded === 1 && r4.deb.join() === "2", r4)
check("requestUrl's promise has .json", r4.req === true, r4)
const r4b = await run(async (o) => {
  const stray = []
  const on = (e) => stray.push(String(e.reason).slice(0, 120))
  window.addEventListener("unhandledrejection", on)
  // (a page that isn't JSON: its text, no parse unless asked; a 404 that isn't JSON fails with its status)
  const text = await o.requestUrl({ url: location.origin + "/" }).text
  const failed = await o.requestUrl({ url: location.origin + "/no/such/file.png" }).then(() => null, (e) => ({ status: e.status, msg: e.message, text: typeof e.text }))
  const kept = await o.requestUrl({ url: location.origin + "/no/such/file.png", throw: false })
  const asked = (() => { try { return kept.json } catch (e) { return e.name } })()
  await new Promise((r) => setTimeout(r, 300))
  window.removeEventListener("unhandledrejection", on)
  return { html: /^<!doctype/i.test(text), failed, kept: kept.status, asked, stray }
})
check("requestUrl: non-JSON answers parse only when asked, errors keep their status", r4b.html && r4b.failed?.status === 404 && /status 404/.test(r4b.failed.msg)
  && r4b.failed.text === "string" && r4b.kept === 404 && r4b.asked === "SyntaxError" && !r4b.stray.length, r4b)
const r4c = await run(async () => {
  const r = await fetch(`${location.origin}/api/plugin-compat/config/read?optional=1&path=${encodeURIComponent(".obsidian/no-such.json")}`)
  return { status: r.status, body: await r.json() }
})
await run(async () => { window.__probe.plugin.registerEditorExtension([]) })
const probeReport = await until(async () => Object.values(await (await fetch(`${B}api/plugin-compat/report`)).json())
  .flatMap((c) => c?.results ?? []).find((x) => x.id === "probe" && x.editorExtensions), 20000, 1000).catch(() => null)
check("the load report says a plugin added editor extensions", !!probeReport, probeReport)
check("absent settings files read as none, not a 404", r4c.status === 200 && r4c.body.base64 === null, r4c)

// Obsidian's CLI: a plugin's command, run from vau in the open window with its flags as text (writing as it goes).
await run(async (o, app, _a) => {
  window.__probe.plugin.registerCliHandler("probe:echo", "Says its flags back", { name: { value: "<name>", description: "who", required: true }, loud: { description: "shout" } },
    async (p) => `hi ${p.name}${p.loud === "true" ? "!" : ""} (${(await app.vault.create(`Api test/Cli ${Date.now()}.md`, p.name)).path})`)
})
const api = apiAt(B), cli = (body) => api("POST", "ops/plugin-compat.cli", body).catch((e) => ({ error: String(e) }))
const listed = await cli({}), echoed = await cli({ command: "probe:echo", flags: { name: "Alice", loud: true } }), short = await cli({ command: "probe:echo" })
const res = (r) => r?.result ?? r
check("cli: a plugin's command is listed, runs with its flags, and says what it needs", res(listed)?.some?.((c) => c.command === "probe:echo" && c.flags.name.required)
  && /^hi Alice! \(Api test\/Cli \d+\.md\)$/.test(res(echoed)?.output ?? "") && /needs --name/.test(JSON.stringify(short)), { listed, echoed, short })

// The editor: a note with frontmatter, positions in the whole file's lines.
await page.evaluate(() => { location.hash = `#file/${encodeURIComponent("Api test/B.md")}` })
await wait(1500)
await page.evaluate(() => { location.hash = `#file/${encodeURIComponent("Api test/A2.md")}` })
await until(() => page.evaluate(() => window.app.workspace.activeEditor?.file?.path === "Api test/A2.md"), 15000, 300).catch(() => {})
const r5 = await run(async (o, app) => {
  const ed = app.workspace.activeEditor?.editor
  if (!ed) return { none: true }
  const v = ed.getValue(), n = v.split("\n").findIndex((l) => l.startsWith("# A"))
  const line = ed.getLine(n)
  ed.replaceRange("Title ", { line: n, ch: 2 })
  const after = ed.getLine(n), off = ed.posToOffset({ line: n, ch: 0 }), back = ed.offsetToPos(off)
  return { starts: v.startsWith("---\n"), line, after, back, n, cm: ed.cm.state.doc.toString().includes("# Title A") }
})
const r6 = await run(async (o, app) => {
  const ed = app.workspace.activeEditor?.editor
  if (!ed) return { none: true }
  const n = ed.getValue().split("\n").findIndex((l) => l.startsWith("See"))
  ed.setSelection({ line: n, ch: 0 }, { line: n, ch: 3 })
  const sel = ed.getSelection(), list = ed.listSelections()
  ed.transaction({ changes: [{ from: { line: n, ch: 0 }, to: { line: n, ch: 3 }, text: "Read" }], selection: { from: { line: n, ch: 4 } } })
  const word = ed.wordAt({ line: n, ch: 1 }), cur = ed.getCursor()
  ed.setCursor(n, 0); ed.exec("goEnd")
  const end = ed.getCursor().ch === ed.getLine(n).length
  const info = ed.cm.state.field(o.editorInfoField, false)
  const view = ed.cm.state.field(o.editorEditorField, false)
  const mv = app.workspace.getActiveViewOfType(o.MarkdownView), viewField = ed.cm.state.field(o.editorViewField, false)
  return { sel, list: list[0]?.head?.ch, line: ed.getLine(n).slice(0, 4), word: word && ed.getRange(word.from, word.to), cur, end, info: info?.file?.path, view: view?.state === ed.cm.state,
    isView: info instanceof o.MarkdownView && viewField instanceof o.MarkdownView, title: viewField?.getDisplayText?.(), leaf: info?.leaf === mv?.leaf && !!mv, type: info?.getViewType?.() }
})
check("editor selections, transactions, words, commands", r6.sel === "See" && r6.list === 3 && r6.line === "Read" && r6.word === "Read" && r6.cur?.ch === 4 && r6.end, r6)
check("editor fields: info and view", r6.info === "Api test/A2.md" && r6.view === true, r6)
check("a note's editor field is its MarkdownView (instanceof, title, leaf)", r6.isView && r6.title === "A2" && r6.leaf && r6.type === "markdown", r6)
const r7 = await run(async (o, app) => ({
  daily: app.internalPlugins.getPluginById("daily-notes")?.instance?.options, on: !!app.internalPlugins.getEnabledPluginById("daily-notes"),
  templates: app.internalPlugins.getEnabledPluginById("templates")?.options?.folder, newParent: app.fileManager.getNewFileParent("Api test/A2.md").path,
  cmd: app.commands.findCommand("editor:toggle-bold")?.name ?? null, manifests: Object.keys(app.plugins.manifests).length,
  installed: (await (await fetch(`${location.origin}/api/plugin-compat/plugins`)).json()).length, scope: app.scope.register(["Mod"], "F9", () => false) && true,
}))
check("core plugins' options from .obsidian/", r7.daily?.folder === "Daily" && r7.daily?.template === "Templates/Daily" && r7.on && r7.templates === "Templates", r7)
check("new notes go where app.json says", r7.newParent === "Notes", r7)
check("Obsidian's core commands by id, every installed manifest", !!r7.cmd && r7.manifests >= r7.installed, r7)
check("editor lines are the file's", r5.starts && r5.line === "# A" && r5.after === "# Title A" && r5.back?.line === r5.n && r5.cm, r5)

// Obsidian's private parts popular plugins use: leaves of one split, the title bar's sidebar toggles, vault.exists,
// onCleanCache, isVimEnabled, the protocol handlers' map (plugins wrap its get).
const rp = await run(async (o, app) => {
  const ws = app.workspace, mine = new o.WorkspaceSplit(ws, "vertical"), a = new o.WorkspaceLeaf(app), b = new o.WorkspaceLeaf(app)
  mine.insertChild(0, a); mine.insertChild(1, b)
  const walked = [], stopped = ws.iterateLeaves(mine, (l) => { walked.push(l === a ? "a" : "b"); return true })
  let roots = 0; ws.iterateLeaves(ws.rootSplit, () => { roots++ })
  const ids = [mine.id, ws.rootSplit.id, ws.leftSplit.id].every((x) => typeof x === "string" && x) && ws.rootSplit.resizeHandleEl instanceof HTMLElement
  const copy = ws.rightSidebarToggleButtonEl.cloneNode(true), was = ws.rightSplit.collapsed
  ws.rightSidebarToggleButtonEl.click(); const toggled = ws.rightSplit.collapsed !== was; ws.rightSplit.toggle()
  let clean = false; app.metadataCache.onCleanCache(() => { clean = true })
  const handler = () => {}; window.__probe.plugin.registerObsidianProtocolHandler("probe-uri", handler)
  const fn = ws.protocolHandlers.get("probe-uri") === handler
  return { walked, stopped, ids, roots: roots === ws.rootSplit.children.length, copy: copy.classList.contains("mod-right"), toggled, clean,
    exists: [await app.vault.exists("Api test/B.md"), await app.vault.exists("Api test/none.md"), await app.vault.exists(".obsidian/app.json")],
    vim: app.isVimEnabled() === !!app.vault.getConfig("vimMode"), fn }
})
check("workspace.iterateLeaves walks one split's leaves, stops on true; splits have ids, resize handles", rp.walked?.join() === "a" && rp.stopped === true && rp.roots && rp.ids, rp)
check("the sidebar toggle buttons clone and toggle their split", rp.copy && rp.toggled, rp)
check("vault.exists, metadataCache.onCleanCache, app.isVimEnabled", rp.exists?.join() === "true,false,true" && rp.clean && rp.vim, rp)
check("protocolHandlers maps each action to its handler, as Obsidian's", rp.fn === true, rp)

const r8 = await run(async (o, app) => {
  const seen = [], ref = app.workspace.on("file-open", (f) => seen.push(f?.path ?? null))
  // (a note left before it's drawn: plugins hear of the one shown after it, last)
  location.hash = `#file/${encodeURIComponent("Api test/B.md")}`
  await new Promise((r) => setTimeout(r, 30))
  location.hash = `#file/${encodeURIComponent("Api test/A2.md")}`
  await new Promise((r) => setTimeout(r, 3000))
  app.workspace.offref(ref)
  return { seen }
})
check("file-open: the note shown last is the last one announced", r8.seen.at(-1) === "Api test/A2.md", r8)

// Reading: each block of the note goes to post-processors as Obsidian's section (its lines, the frontmatter's
// pre.frontmatter), only one that changed shows as drawn, and its children unload when the note is edited.
await run(async (o, app) => {
  await app.vault.create("Api test/R.md", "---\ntags: [r]\n---\n# Reading\n\nFirst paragraph.\n\nmark me, please\n\n- one\n- two\n")
  const seen = window.__readingSeen = []
  class Child extends o.MarkdownRenderChild { onunload() { seen.push("unloaded") } }
  window.__readingFn = (el, ctx) => {
    if (ctx.sourcePath !== "Api test/R.md") return
    const info = ctx.getSectionInfo(el)
    seen.push([el.className.split(" ").find((c) => /^el-|^mod-frontmatter$/.test(c)), info?.lineStart, info?.lineEnd, ctx.frontmatter?.tags?.[0] ?? null, !!el.querySelector("pre.frontmatter")])
    if (el.textContent.includes("mark me")) { el.querySelector("p").createSpan({ cls: "probe-mark", text: "!" }); ctx.addChild(new Child(el)) }
  }
  o.MarkdownPreviewRenderer.registerPostProcessor(window.__readingFn)
})
await page.evaluate(() => { location.hash = `#file/${encodeURIComponent("Api test/R.md")}` })
await wait(2500)
await palette(page, "Switch to reading view")
const shown = () => page.evaluate(() => ({ seen: window.__readingSeen, marked: !!document.querySelector(".cm-content .cm-block-read .probe-mark"),
  drawn: document.querySelectorAll(".cm-content .cm-block-read").length, lines: [...document.querySelectorAll(".cm-content > .cm-line")].map((l) => l.textContent).filter(Boolean) }))
const r9 = await until(async () => { const r = await shown(); return r.marked && r }, 10000) || await shown()
// (the lines as the file has them: the server adds to its frontmatter)
const rl = (await run(async (o, app) => app.vault.read(app.vault.getFileByPath("Api test/R.md")))).split("\n"), at = (t) => rl.indexOf(t)
const sec = (cls) => JSON.stringify(r9.seen?.find((x) => Array.isArray(x) && x[0] === cls))
check("reading: post-processors get each section with its lines", sec("mod-frontmatter") === JSON.stringify(["mod-frontmatter", 0, at("# Reading") - 1, "r", true])
  && sec("el-h1") === JSON.stringify(["el-h1", at("# Reading"), at("# Reading"), "r", false]) && sec("el-ul") === JSON.stringify(["el-ul", at("- one"), at("- two"), "r", false]), { r9, rl })
check("reading: only the block a post-processor changed is drawn by it", r9.marked && r9.drawn === 1 && r9.lines.includes("First paragraph."), r9)
await palette(page, "Switch to live preview")
const r10 = await until(async () => { const r = await shown(); return r.seen.includes("unloaded") && !r.drawn && r }, 5000) || await shown()
check("editing: the note's source, the block's children unloaded", r10.seen?.includes("unloaded") && !r10.drawn && r10.lines.some((l) => l.includes("mark me")), r10)
await run(async (o) => { o.MarkdownPreviewRenderer.unregisterPostProcessor(window.__readingFn) })

// Reading: a callout and a table, which the editor draws itself, get their sections too.
await run(async (o, app) => {
  await app.vault.create("Api test/C.md", "# Drawn\n\n> [!note] Opal\n> Kept in the safe.\n\n| Gem | Carat |\n| --- | --- |\n| Ruby | 2 |\n")
  const seen = window.__drawnSeen = []
  window.__drawnFn = (el, ctx) => {
    const what = el.querySelector(".callout") ? "callout" : el.querySelector("table") ? "table" : null
    const info = what && ctx.getSectionInfo(el)
    if (info) seen.push([what, info.lineStart, info.lineEnd, info.text.includes("\n# Drawn\n")])
  }
  o.MarkdownPreviewRenderer.registerPostProcessor(window.__drawnFn)
})
await page.evaluate(() => { location.hash = `#file/${encodeURIComponent("Api test/C.md")}` })
const r11 = await until(() => page.evaluate(() => { const s = window.__drawnSeen; return s.some((x) => x[0] === "callout") && s.some((x) => x[0] === "table") && s }), 10000)
  || await page.evaluate(() => window.__drawnSeen)
const cl = (await run(async (o, app) => app.vault.read(app.vault.getFileByPath("Api test/C.md")))).split("\n"), cat = (t) => cl.findIndex((l) => l.startsWith(t))
const drawnSec = (what) => JSON.stringify(r11.find((x) => x[0] === what))
check("reading: a callout and a table the editor draws get their sections", drawnSec("callout") === JSON.stringify(["callout", cat("> [!note]"), cat("> Kept"), true])
  && drawnSec("table") === JSON.stringify(["table", cat("| Gem"), cat("| Ruby"), true]), { r11, cl })
await run(async (o) => { o.MarkdownPreviewRenderer.unregisterPostProcessor(window.__drawnFn) })

// Reading: the view's previewMode.renderer.sections, Obsidian's sections with their lines, those plugins drew (Execute
// Code finds its code block's lines from them).
await run(async (o) => { window.__secFn = (el) => el.addClass("sec-mark"); o.MarkdownPreviewRenderer.registerPostProcessor(window.__secFn) })
await palette(page, "Switch to reading view")
const r11b = await until(() => run(async (o, app) => {
  const v = app.workspace.getActiveViewOfType(o.MarkdownView), s = v?.previewMode?.renderer?.sections ?? []
  return s.length >= 2 && { file: v.file.path, lines: s.map((x) => [x.lineStart, x.lineEnd]), inPage: s.every((x) => x.el.isConnected) }
}), 10000) || await run(async (o, app) => ({ sections: app.workspace.getActiveViewOfType(o.MarkdownView)?.previewMode?.renderer?.sections?.length }))
await palette(page, "Switch to live preview")
await run(async (o) => { o.MarkdownPreviewRenderer.unregisterPostProcessor(window.__secFn) })
check("reading: previewMode.renderer.sections, in order with their lines", r11b.file === "Api test/C.md" && r11b.inPage
  && r11b.lines.every((l, i) => l[0] <= l[1] && (i === 0 || l[0] > r11b.lines[i - 1][1])) && r11b.lines.some((l) => l[0] === cat("# Drawn")), r11b)

// A post-processor's context has containerEl, what the Markdown is drawn into (Pixel Banner reads its classes).
const r12 = await run(async (o, app) => {
  const into = document.createElement("div"), seen = []
  const fn = (el, ctx) => { seen.push(ctx.containerEl === into) }
  o.MarkdownPreviewRenderer.registerPostProcessor(fn)
  await o.MarkdownRenderer.render(app, "Some **text**", into, "Api test/C.md", new o.Component())
  o.MarkdownPreviewRenderer.unregisterPostProcessor(fn)
  return seen
})
check("post-processors get containerEl: the element drawn into", r12.length > 0 && r12.every(Boolean), r12)

// Node's http client: a response's headers are there on its response event (the request library follows a redirect
// from them: Advanced Slides' download), its body after.
const r14 = await run(async () => {
  const http = window.require("http")
  const srv = http.createServer((req, res) => {
    if (req.url === "/a") { res.writeHead(302, { location: "/b" }); res.end() } else { res.writeHead(200, { "content-type": "text/plain" }); res.end("arrived") }
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  const get = (p) => new Promise((done) => http.get(`http://127.0.0.1:${port}${p}`, (res) => {
    const seen = { status: res.statusCode, location: res.headers.location ?? null }, chunks = []
    res.on("data", (c) => chunks.push(c))
    res.on("end", () => done({ ...seen, body: chunks.map(String).join("") }))
  }))
  const a = await get("/a"), b = a.location ? await get(a.location) : null
  srv.close()
  return { a, b }
})
check("http client: headers on the response event, a redirect followed to its body", r14.a?.status === 302 && r14.a.location === "/b" && r14.b?.body === "arrived", r14)

// The window's component (Obsidian's container.component): per-window parts plugins add to it load (Quick Explorer's
// and Hover Editor's services, from pjeby's ophidian).
const r16 = await run(async (o, app) => {
  const c = app.workspace.rootSplit.getContainer().component, child = new o.Component()
  let loaded = false
  child.onload = () => { loaded = true }
  c.addChild(child)
  c.removeChild(child)
  return { has: !!c, loaded }
})
check("the window's container has a loaded component plugins add to", r16.has && r16.loaded, r16)

// A plugin's modal holds the focus as the app's sheets do, without a ring around the whole sheet.
const r15 = await run(async (o, app) => {
  const m = new o.Modal(app)
  m.contentEl.setText("Lighthouse")
  m.open()
  await new Promise((r) => setTimeout(r, 300))
  const focused = m.modalEl.contains(document.activeElement), ring = getComputedStyle(document.activeElement).outlineStyle
  m.close()
  return { focused, ring }
})
check("a modal takes focus without a focus ring around it", r15.focused && r15.ring === "none", r15)

// A banner a plugin puts absolute in the note's anchors (Pixel Banner's) flows: the text starts under it.
const r13 = await run(async () => {
  const box = document.querySelector(".plugin-compat-anchors")
  if (!box) return { box: false }
  const b = box.createDiv({ cls: "pixel-banner-image", attr: { style: "position: absolute; top: 0; left: 0; right: 0; height: 120px; z-index: -1" } })
  document.querySelector(".file-view").style.setProperty("--pixel-banner-content-start", "125px")
  await new Promise((r) => setTimeout(r, 100))
  const text = document.querySelector(".cm-content").getBoundingClientRect().top, under = b.getBoundingClientRect().bottom, shown = getComputedStyle(box).display
  b.remove()
  return { box: true, shown, below: text >= under }
})
check("a plugin's banner in the note's anchors pushes the text below it", r13.box && r13.shown !== "none" && r13.below, r13)

// Sidebars hold their leaves in a tab group, as Obsidian's sidedocks do (Make.md walks them); a leaf there still has
// its sidebar as its root.
const r17 = await run(async (o, app) => {
  const ws = app.workspace, groups = ws.leftSplit.children, leaves = groups[0]?.children ?? []
  return { groups: groups.length, leaves: leaves.length, root: leaves.every((l) => l.getRoot() === ws.leftSplit && l.parent === groups[0]) }
})
check("a sidebar's leaves are in its tab group, their root the sidebar", r17.groups === 1 && r17.leaves > 0 && r17.root, r17)

// A leaf in a split a plugin made (Hover Editor's popover): the note in the app's editor there, edited and saved, walked
// with its split, gone when detached; no tab opens for it.
const tabs = () => page.evaluate(() => document.querySelectorAll("[role=tab]").length)
const tabsBefore = await tabs()
const r20 = await run(async (o, app) => {
  const f = await app.vault.create("Api test/F.md", "# Float\n\nSome text\n")
  const split = new o.WorkspaceSplit(app.workspace, "vertical")
  const box = document.body.createDiv({ attr: { style: "position: fixed; left: 0; top: 0; width: 400px; height: 300px; z-index: 90" } })
  box.append(split.containerEl)
  const leaf = app.workspace.createLeafInParent(split, 0)
  await leaf.openFile(f)
  const inSplit = split.containerEl.contains(leaf.containerEl) && !!leaf.containerEl.querySelector(".cm-editor")
  const isMd = leaf.view instanceof o.MarkdownView && leaf.view.file === f
  const ed = leaf.view.editor, last = ed.lastLine()
  ed.replaceRange("\nTyped in the float.", { line: last, ch: ed.getLine(last).length })
  await new Promise((r) => setTimeout(r, 2000))
  const saved = (await app.vault.adapter.read(f.path)).includes("Typed in the float.")
  const walked = []
  app.workspace.iterateLeaves(split, (l) => { walked.push(l === leaf) })
  leaf.detach()
  await new Promise((r) => setTimeout(r, 300))
  const gone = !split.containerEl.querySelector(".cm-editor") && !app.workspace.getLeafById(leaf.id)
  box.remove()
  return { inSplit, isMd, saved, walked, gone }
})
check("a leaf in a plugin's split: the note's editor there, saved, walked, detached", r20.inSplit && r20.isMd && r20.saved && r20.walked?.join() === "true" && r20.gone, r20)
check("a leaf in a plugin's split opens no tab", (await tabs()) === tabsBefore, { tabsBefore, after: await tabs() })

// Page preview's onLinkHover taken by a plugin (on its prototype, as Hover Editor does): links hovered go to it, with
// a parent it can keep its popover on, and the app's own preview steps aside until it's given back.
const r21 = await run(async (o, app) => {
  const pp = app.internalPlugins.plugins["page-preview"], proto = Object.getPrototypeOf(pp.instance), orig = proto.onLinkHover, seen = []
  const toggle = async () => { await pp.disable(); await pp.enable(); await new Promise((r) => setTimeout(r, 50)) }
  const was = document.body.dataset.noPreview !== undefined
  proto.onLinkHover = function (parent, targetEl, linktext) { seen.push([linktext, !!parent && "hoverPopover" in parent]) }
  await toggle()
  const off = document.body.dataset.noPreview !== undefined
  const a = document.querySelector(".file-view").createEl("a", { text: "B", attr: { "data-wiki": "B" } })
  a.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))
  proto.onLinkHover = orig
  await toggle()
  a.remove()
  return { off, seen, back: (document.body.dataset.noPreview !== undefined) === was }
})
check("a plugin that takes page preview's onLinkHover gets hovered links; the app's preview steps aside", r21.off && r21.seen[0]?.[0] === "B" && r21.seen[0][1] && r21.back, r21)

// The app's root as Obsidian's .app-container, the window's size (plugins measure it); a plugin's own popover styles
// win over the defaults here.
const r22 = await page.evaluate(() => {
  const st = document.head.appendChild(document.createElement("style"))
  st.textContent = "@layer plugins { .popover.lab-pop { padding: 0px; max-height: none; } }"
  const p = document.body.appendChild(Object.assign(document.createElement("div"), { className: "popover hover-popover lab-pop", textContent: "x" }))
  const cs = getComputedStyle(p), out = { app: document.querySelector(".app-container").getBoundingClientRect().height, win: innerHeight, padding: cs.padding, max: cs.maxHeight }
  p.remove(); st.remove()
  return out
})
check("the app container is the window's height; a plugin's popover styles win", r22.app === r22.win && r22.padding === "0px" && r22.max === "none", r22)

await run(async (o, app) => { for (const f of [...app.vault.getFiles()].filter((f) => f.path.startsWith("Api test/"))) await app.vault.delete(f) })
// (other plugins' own errors, on load, aren't this script's)
const mine = errs.filter((e) => !e.includes("obsidian-plugin:") && !e.includes("Request failed, status"))
check("no page errors from the runtime", mine.length === 0, mine)
await done()
