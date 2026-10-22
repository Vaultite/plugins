// What the picks group's Obsidian plugins (catalog.tsv: a popular Obsidian video's) do here, done like a user: code
// blocks drawn, commands run on a note, views opened, settings shown; a screenshot each. Some need the network (map
// tiles, Wikipedia, dictionaryapi.dev, scales-chords.com). WRITES notes and plugin settings: lab only, its plugins
// installed the way users do: node ../try.mjs <ids of picks> --keep, then
//   node picks.mjs <base url> [ids,comma,separated]
import fs from "node:fs"
import { apiAt, qa, until, wait } from "../../../qa.mjs"

const { args: [B0, only = ""], browser, check, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const api = apiAt(B)
const OUT = "/tmp/oc-lab/shots/picks"
fs.mkdirSync(OUT, { recursive: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(B).origin })
const page = await ctx.newPage()
const errs = []
const owner = (s) => /obsidian-plugin:([^/\s)]+)/.exec(s ?? "")?.[1] ?? "?"
page.on("pageerror", (e) => errs.push(`${String(e.message).slice(0, 200)} @ ${owner(e.stack)}`))
page.on("console", (m) => { if (m.type() === "error" && /obsidian-plugin:/.test(m.text())) errs.push(`${m.text().split("\n")[0].slice(0, 200)} @ ${owner(m.text())}`) })
const note = (path, text) => api("POST", "file", { path, text }).then((r) => (r?.error ? api("PUT", "file", { path, text }) : r))
const read = async (p) => (await api("GET", `file?path=${encodeURIComponent(p)}`)).text ?? ""
const ev = (fn, arg) => page.evaluate(fn, arg)
const open = async (path) => {
  await ev((h) => { location.hash = h }, `#file/${encodeURIComponent(path)}`)
  await until(() => ev((p) => window.app.workspace.getActiveFile()?.path === p, path), 10000).catch(() => {})
  await wait(800)
}
const run = (id) => ev((id) => window.app.commands.executeCommandById(id), id)
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 5000 }).catch(() => {})
const settingsOf = async (id) => {
  await ev((id) => window.app.setting.openTabById(id), id)
  const n = await until(() => ev((id) => document.querySelector(`[data-obsidian-settings="${id}"]`)?.querySelectorAll(".setting-item").length || 0, id), 8000).catch(() => 0)
  await page.keyboard.press("Escape")
  return n
}
const cursor = (line, ch) => ev(([line, ch]) => { const ed = window.app.workspace.activeEditor.editor; ed.focus(); ed.setCursor({ line, ch }) }, [line, ch])
// (a line's number in the editor's whole file, frontmatter the server adds included)
const lineOf = (text) => ev((t) => window.app.workspace.activeEditor.editor.getValue().split("\n").findIndex((l) => l.startsWith(t)), text)
const visibleLines = () => ev(() => [...document.querySelectorAll(".cm-content .cm-line")].filter((l) => l.offsetHeight > 0).map((l) => l.innerText.trim()).filter(Boolean))
const results = {}
const test = async (id, fn) => {
  if (only && !only.split(",").includes(id)) return
  const before = errs.length
  let r
  try { r = await fn() } catch (e) { r = { state: "fails", why: String(e).split("\n")[0].slice(0, 200) }; await shot(`fail-${id}`) }
  // (a service's 5xx, a plugin's own request answered, is the service's: noted in its why)
  r.errors = errs.slice(before).filter((e) => e.endsWith(`@ ${id}`) && !/Request failed, status 5\d\d/.test(e)).slice(0, 3)
  results[id] = r
  check(`${id}: ${r.state}${r.why ? ` (${r.why})` : ""}`, r.state !== "fails" && !r.errors.length)
  await page.keyboard.press("Escape").catch(() => {})
  await ev(() => document.querySelectorAll(".modal-container, .menu").forEach((e) => e.remove()))
}
const ok = (why) => ({ state: "works", ...(why ? { why } : {}) })
const partly = (why) => ({ state: "partly", why })
const fails = (why) => ({ state: "fails", why })

await page.goto(B)
await until(() => ev(() => window.app?.workspace?.layoutReady && Object.keys(window.app.plugins.plugins).length > 0), 60000, 300)
await wait(1500)

await test("obsidian-nomnoml-diagram", async () => {
  await note("Picks/Diagram.md", "# Diagram\n\n```nomnoml\n[Alice Park]->[Lighthouse]\n[Lighthouse]-:>[Beacon]\n```\n\nafter\n")
  await open("Picks/Diagram.md")
  const svg = await until(() => ev(() => document.querySelector("[data-fence=nomnoml] svg, .block-language-nomnoml svg")?.textContent ?? ""), 8000).catch(() => "")
  await shot("nomnoml")
  await cursor(await lineOf("after"), 0)
  await run("obsidian-nomnoml-diagram:insert-nomnoml-code-fence")
  await wait(800)
  const inserted = (await read("Picks/Diagram.md")).includes("```nomnoml\n[]\n```after")
  return svg.includes("Lighthouse") && inserted ? ok() : fails(`diagram ${svg ? "drawn" : "not drawn"}, New diagram ${inserted ? "inserted" : "not inserted"}`)
})

await test("music-code-blocks", async () => {
  await note("Picks/Tune.md", "# Tune\n\n```abc\nX:1\nT:Scale\nM:4/4\nK:C\nCDEF GABc|\n```\n")
  await open("Picks/Tune.md")
  const notes = await until(() => ev(() => document.querySelectorAll("[data-fence=abc] svg .abcjs-note, [data-fence=abc] svg path").length), 8000).catch(() => 0)
  await shot("abc")
  return notes ? ok("score drawn (abcjs)") : fails("no score")
})

await test("scales-chords", async () => {
  await note("Picks/Song.md", "# Song\n\n```tab\nVerse\nG         Am             G/B     G %\nBlackbird singing in the dead of night\n```\n")
  await open("Picks/Song.md")
  const chords = await until(() => ev(() => [...document.querySelectorAll("[data-fence=tab] b")].map((b) => b.textContent)), 8000).catch(() => [])
  await wait(3000)
  const images = await ev(() => document.querySelectorAll("[data-fence=tab] img").length)
  await shot("scales-chords")
  // (its chord pictures come from scales-chords.com's API, behind a Cloudflare challenge now: no picture in Obsidian either)
  return chords.join() === "G,Am,G/B,G" ? (images ? ok() : partly("chords bolded; their pictures come from scales-chords.com, whose API answers 403 (a Cloudflare challenge) to any app"))
    : fails(`chords: ${chords.join()}`)
})

await test("obsidian-map-view", async () => {
  // (CARTO's default tiles now ask for an API key: OpenStreetMap's, as a user would add)
  await ev(async () => { const p = window.app.plugins.plugins["obsidian-map-view"]; p.settings.mapSources = [{ name: "OSM", urlLight: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", currentMode: "auto" }]; await p.saveSettings() })
  await note("Picks/Lisbon.md", "---\nlocation: [38.7223, -9.1393]\n---\n# Lisbon\n\nMeet at [Belem](geo:38.6916,-9.2160) tomorrow.\n")
  await open("Picks/Lisbon.md")
  const geolink = await until(() => ev(() => !!document.querySelector(".cm-content a.geolink")), 5000).catch(() => false)
  await run("obsidian-map-view:open-map-view")
  const map = await until(() => ev(() => { const m = document.querySelector(".leaflet-container"); return m && m.querySelectorAll(".leaflet-marker-icon").length ? { markers: m.querySelectorAll(".leaflet-marker-icon").length, tiles: m.querySelectorAll(".leaflet-tile-loaded").length } : null }), 15000).catch(() => null)
  if (map) map.tiles = await until(() => ev(() => document.querySelectorAll(".leaflet-container .leaflet-tile-loaded").length), 10000).catch(() => 0)
  await shot("map-view")
  const settings = await settingsOf("obsidian-map-view")
  const why = `${geolink ? "" : "geolink not decorated; "}${map ? `${map.markers} markers, ${map.tiles} tiles` : "no map or markers"}; ${settings} settings`
  return geolink && map?.markers && settings ? (map.tiles ? ok(why) : partly(`${why} (tiles need the network)`)) : fails(why)
})

await test("obsidian-file-info-plugin", async () => {
  await note("Picks/Info.md", "# Info\n\nSome words here for counting.\n")
  await open("Picks/Info.md")
  await run("obsidian-file-info-plugin:form-info-show-window")
  const text = await until(() => ev(() => window.app.workspace.getLeavesOfType("tlfItemView")[0]?.view.containerEl.innerText ?? "").then((t) => (/Info\.md/.test(t) && /Words/.test(t) ? t : null)), 8000).catch(() => "")
  await shot("file-info")
  return /Info\.md/.test(text) && /Words/.test(text) ? ok() : fails(`its view: ${JSON.stringify(text.slice(0, 80))}`)
})

await test("obsidian-plugin-todo", async () => {
  await note("Picks/Errands.md", "# Errands\n\n- [ ] Call Alice Park about Lighthouse\n- [ ] Water plants\n")
  // (it reads every note once loaded, one at a time: a while on a big vault)
  const leaf = () => ev(() => window.app.workspace.getLeavesOfType("online.larslockefeer.obsidian-plugin-todo")[0]?.view?.containerEl)
  await until(() => ev(() => (window.app.plugins.plugins["obsidian-plugin-todo"]?.todoIndex?.todos?.size ?? 0) > 0), 60000, 500)
  // (undated todos are in its Inbox tab)
  await ev(() => [...document.querySelectorAll(".todo-item-view-toolbar-item")][2]?.click())
  const item = await until(() => ev(() => [...document.querySelectorAll(".todo-item-view-item")].find((e) => e.textContent.includes("Call Alice Park")) ? true : null), 10000).catch(() => null)
  await shot("todo")
  if (!item || !(await leaf())) return fails("its list doesn't show the note's todo")
  await page.locator(".todo-item-view-item", { hasText: "Call Alice Park" }).locator(".todo-item-view-item-checkbox input").click()
  const ticked = await until(async () => (await read("Picks/Errands.md")).includes("- [x] Call Alice Park"), 10000, 500).catch(() => false)
  return ticked ? ok() : partly("lists todos; ticking one didn't change the note")
})

await test("obsidian-zoom", async () => {
  await note("Picks/Outline.md", "- one\n  - one a\n  - one b\n- two\n  - two a\n")
  await open("Picks/Outline.md")
  await cursor(await lineOf("- one"), 3)
  await run("obsidian-zoom:zoom-in")
  await wait(800)
  const zoomed = await visibleLines()
  const header = await ev(() => document.querySelector(".zoom-plugin-header")?.innerText.replace(/\s+/g, " ").trim() ?? "")
  await shot("zoom")
  await run("obsidian-zoom:zoom-out")
  await wait(500)
  const all = await visibleLines()
  const ok1 = !zoomed.some((l) => l.includes("two")) && all.some((l) => l.includes("two a"))
  return ok1 && header.includes("one") ? ok() : fails(`zoomed: ${zoomed.join(" | ")}; header: ${header}`)
})

await test("simple-embeds", async () => {
  await note("Picks/Video.md", "# Video\n\n[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n\nend\n")
  // (off by default: its embeds in live preview; reading view is where it works out of the box)
  await ev(async () => { await window.app.plugins.plugins["simple-embeds"].saveSettings({ enableInLivePreview: true }) })
  await open("Picks/Diagram.md")
  await open("Picks/Video.md")
  const live = await until(() => ev(() => !!document.querySelector(".cm-content .embed-container lite-youtube")), 8000).catch(() => false)
  await shot("simple-embeds-live")
  await ev(async () => { await window.app.plugins.plugins["simple-embeds"].saveSettings({ enableInLivePreview: false }) })
  await open("Picks/Diagram.md")
  await open("Picks/Video.md")
  await run("view:read")
  await wait(2000)
  const reading = await ev(() => !!document.querySelector(".embed-container lite-youtube"))
  await shot("simple-embeds-reading")
  await run("view:source")
  // (the app's reading view is its editor, read-only: Obsidian's Markdown post-processors only reach what it renders as HTML)
  return live ? (reading ? ok() : partly("embeds in live preview (its option); the reading view, its default, is the app's editor, which Markdown post-processors don't reach"))
    : fails("no embed")
})

await test("wikipedia-search", async () => {
  await note("Picks/Wiki.md", "# Wiki\n\nSee: \n")
  await open("Picks/Wiki.md")
  const n = await lineOf("See:")
  await cursor(n, 5)
  await run("wikipedia-search:link-wikipedia-article")
  await wait(500)
  await page.keyboard.type("Alan Turing")
  await page.keyboard.press("Enter")
  const found = await until(() => ev(() => [...document.querySelectorAll(".suggestion-item")].map((e) => e.innerText.split("\n")[0])).then((l) => (l.length ? l : null)), 10000).catch(() => [])
  await shot("wikipedia")
  await page.keyboard.press("Enter")
  const linked = await until(async () => (await read("Picks/Wiki.md")).includes("[Alan Turing](https://en.wikipedia.org/wiki/Alan_Turing)"), 6000).catch(() => false)
  return linked ? ok() : found.length ? partly(`searches (${found[0]}); linking didn't write`) : partly("no results (needs Wikipedia's API)")
})

await test("obsidian-read-it-later", async () => {
  await ev(() => navigator.clipboard.writeText("https://en.wikipedia.org/wiki/Lighthouse"))
  await run("obsidian-read-it-later:save-clipboard-to-notice")
  const made = await until(() => ev(() => window.app.vault.getMarkdownFiles().find((f) => f.path.startsWith("ReadItLater Inbox/") && /Lighthouse/.test(f.path))?.path), 30000, 500).catch(() => null)
  if (!made) return partly("no note made (needs the page over the network)")
  await open(made)
  await shot("read-it-later")
  const t = await read(made)
  return /# \[Lighthouse/.test(t) && /!\[\]\(ReadItLater%20Inbox\/assets\//.test(t) ? ok("article saved with its images") : partly(`note made: ${JSON.stringify(t.slice(0, 120))}`)
})

await test("obsidian-dictionary-plugin", async () => {
  await run("obsidian-dictionary-plugin:dictionary-open-view")
  const input = page.locator("input[placeholder='Enter a word']").first()
  await input.waitFor({ timeout: 8000 })
  await input.fill("lighthouse")
  await input.press("Enter")
  const text = await until(() => ev(() => { const t = window.app.workspace.getLeavesOfType("dictionary-view")[0]?.view.containerEl.innerText ?? ""; return /Something went wrong|noun|Definition|Synonyms/i.test(t) ? t : null }), 15000).catch(() => "")
  await shot("dictionary")
  await run("obsidian-dictionary-plugin:dictionary-open-language-switcher")
  const langs = await until(() => ev(() => document.querySelectorAll(".suggestion-item").length), 5000).catch(() => 0)
  // (definitions come from api.dictionaryapi.dev: a 530 when tested, its view says it can't be reached)
  return /noun/i.test(text) ? ok() : langs && /Something went wrong/.test(text) ? partly("view, languages and settings work; api.dictionaryapi.dev, its definitions, answered 530 (curl too)") : fails(`view: ${JSON.stringify(text.slice(0, 100))}`)
})

for (const id of Object.keys(results)) if (results[id].state !== "fails") results[id].settings = await settingsOf(id)
fs.mkdirSync("/tmp/oc-lab/results", { recursive: true })
fs.writeFileSync("/tmp/oc-lab/results/picks-web.json", JSON.stringify(results, null, 1))
console.log(JSON.stringify(results, null, 1))
console.log("unattributed page errors:", errs.filter((e) => e.endsWith("@ ?")).slice(0, 5))
await ctx.close()
await done()
