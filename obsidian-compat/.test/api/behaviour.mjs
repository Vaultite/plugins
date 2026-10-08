// Obsidian's API doing what it says, in the lab's page (the probe plugin hands over the module): files, events,
// metadata, links, the file manager, the adapter, ES5 subclasses, the editor's positions. WRITES "Api test/": lab only.
//   node behaviour.mjs <base url>
import { qa, until, wait } from "../../../qa.mjs"

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
check("list items and blocks", JSON.stringify(r1.tasks) === JSON.stringify([[" ", -9], ["x", 8]]) && r1.blocks.includes("c1"), r1)
check("subpaths", r1.sub === "Sub" && r1.blk === "block", r1)
check("link resolution and text", r1.dest === "Api test/B.md" && r1.linktext === "B" && r1.mdlink === "[[B#Sub|bee]]" && r1.backlinks.includes("Api test/A.md"), r1)

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
  return { sel, list: list[0]?.head?.ch, line: ed.getLine(n).slice(0, 4), word: word && ed.getRange(word.from, word.to), cur, end, info: info?.file?.path, view: view?.state === ed.cm.state }
})
check("editor selections, transactions, words, commands", r6.sel === "See" && r6.list === 3 && r6.line === "Read" && r6.word === "Read" && r6.cur?.ch === 4 && r6.end, r6)
check("editor fields: info and view", r6.info === "Api test/A2.md" && r6.view === true, r6)
const r7 = await run(async (o, app) => ({
  daily: app.internalPlugins.getPluginById("daily-notes")?.instance?.options, on: !!app.internalPlugins.getEnabledPluginById("daily-notes"),
  templates: app.internalPlugins.getEnabledPluginById("templates")?.options?.folder, newParent: app.fileManager.getNewFileParent("Api test/A2.md").path,
  cmd: app.commands.findCommand("editor:toggle-bold")?.name ?? null, manifests: Object.keys(app.plugins.manifests).length, scope: app.scope.register(["Mod"], "F9", () => false) && true,
}))
check("core plugins' options from .obsidian/", r7.daily?.folder === "Daily" && r7.daily?.template === "Templates/Daily" && r7.on && r7.templates === "Templates", r7)
check("new notes go where app.json says", r7.newParent === "Notes", r7)
check("Obsidian's core commands by id, every installed manifest", !!r7.cmd && r7.manifests > 50, r7)
check("editor lines are the file's", r5.starts && r5.line === "# A" && r5.after === "# Title A" && r5.back?.line === r5.n && r5.cm, r5)

await run(async (o, app) => { for (const f of [...app.vault.getFiles()].filter((f) => f.path.startsWith("Api test/"))) await app.vault.delete(f) })
// (other plugins' own errors, on load, aren't this script's)
const mine = errs.filter((e) => !e.includes("obsidian-plugin:") && !e.includes("Request failed, status"))
check("no page errors from the runtime", mine.length === 0, mine)
await done()
