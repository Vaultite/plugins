// Templater in a real browser: "New note from template" with a Templater template asks its prompt and its suggester in
// the app's chooser, renames and moves the note and puts the cursor at tp.file.cursor(); "Insert template" fills in
// the open note's frontmatter at the cursor; a folder template fills a new note made in its folder (its prompt asked
// too). Desktop and a 390px phone, with screenshots. Installs the plugin; WRITES a "Qa templater" folder and the
// Templates plugin's folder setting (put back): a throwaway server only.
//   node templater/.test/qa/templater.mjs <base url> <vault path> [out dir]
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { install, palette, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const req = (method, p, body) => fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) })
const F = "Qa templater", TPL = `${F}/Templates`
const read = (p) => (existsSync(`${VAULT}/${p}`) ? readFileSync(`${VAULT}/${p}`, "utf8") : "")
const today = new Date(), iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`

const putBackWs = setAsideWorkspaces(VAULT)
await req("DELETE", `file?path=${encodeURIComponent(F)}`)
const tplBefore = (await (await req("GET", "config/plugin/templates")).json()).folder ?? null
await req("PATCH", "config/plugin/templates", { folder: TPL })
await req("POST", "file", { path: `${TPL}/Meeting.md`, text: `---
type: note
tags: [meeting]
---
<%*
const topic = await tp.system.prompt("Topic of the meeting")
const kind = await tp.system.suggester(["One to one", "Team sync", "Planning"], ["1-1", "sync", "plan"], false, "Kind of meeting")
await tp.file.move("${F}/" + tp.date.now("YYYY-MM-DD") + " " + topic)
-%>
# <% topic %> (<% kind %>)
<% tp.date.now("dddd D MMMM") %>, week <% tp.date.now("w") %>

## Notes
- <% tp.file.cursor() %>

## Next steps
- [ ]
` })
await req("POST", "file", { path: `${TPL}/Status.md`, text: "Owner: <% tp.frontmatter.owner %>, status <% tp.frontmatter.status %>, checked <% tp.date.now(\"YYYY-MM-DD\") %>" })
await req("POST", "file", { path: `${TPL}/Book.md`, text: "---\ntype: note\ntags: [book]\n---\n# <% tp.file.title %>\nBy <% tp.system.prompt(\"Author\") %>, started <% tp.date.now(\"D MMM\") %>\n" })
await req("POST", "file", { path: `${F}/Lighthouse.md`, text: "---\nowner: Alice Park\nstatus: active\n---\n\nThe Lighthouse project.\n" })
install(B, "templater")
await req("PATCH", "config/plugin/templater", { folderTemplates: { [`${F}/Books`]: "Book" } })

const chooser = (page) => page.locator("[role=dialog][aria-modal=true] [role=listbox]")
/** Answer the chooser that's open: type, then Enter. */
async function answer(page, text) {
  await chooser(page).waitFor({ timeout: 8000 })
  await page.keyboard.type(text); await wait(250)
  await page.keyboard.press("Enter"); await wait(400)
}
async function open(ctxOpts, label, file) {
  const ctx = await browser.newContext(ctxOpts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank")
  await page.goto(`${B}#file/${encodeURIComponent(file)}`)
  await page.locator(".vau-editor .cm-content").first().waitFor({ timeout: 15000 })
  await wait(800)
  return { ctx, page }
}
const meetings = () => readdirSync(`${VAULT}/${F}`).filter((n) => n.startsWith(iso))

for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 860 } }],
  ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  const { ctx, page } = await open(opts, label, `${F}/Lighthouse.md`)
  const topic = label === "phone" ? "Roadmap" : "Budget"

  // New note from a template: its prompt, then its suggester, in the app's chooser.
  await palette(page, "New note from template", 600)
  await page.keyboard.type("Meeting"); await wait(200); await page.keyboard.press("Enter")
  await chooser(page).waitFor({ timeout: 8000 })
  check(`${label}: the prompt asks in the chooser`, (await page.locator("[role=dialog][aria-modal=true]").innerText()).includes("Topic of the meeting"))
  await page.keyboard.type(topic); await wait(250)
  await page.screenshot({ path: `${OUT}templater-${label}-prompt.png` })
  await page.keyboard.press("Enter"); await wait(500)
  await chooser(page).waitFor({ timeout: 8000 })
  check(`${label}: then the suggester lists its labels`, (await chooser(page).innerText()).includes("Team sync"))
  await page.keyboard.type("team"); await wait(250)
  await page.screenshot({ path: `${OUT}templater-${label}-suggester.png` })
  await page.keyboard.press("Enter")
  const path = `${F}/${iso} ${topic}.md`
  check(`${label}: the note is made where the template moved it`, await until(() => read(path), 8000), meetings())
  await until(() => decodeURIComponent(page.url()).includes(path), 5000)
  await wait(1500)
  const text = read(path)
  check(`${label}: prompt and suggester answers, dates`, text.includes(`# ${topic} (sync)`) && /, week \d+/.test(text), text)
  check(`${label}: the cursor went where tp.file.cursor() was, the mark gone`, !text.includes("tp.file.cursor") && await until(() => page.evaluate(() => {
    const sel = window.getSelection(); return sel?.anchorNode?.parentElement?.closest(".cm-line")?.textContent?.startsWith("-")
  }), 3000), text)
  await page.keyboard.type("Spoke about it")
  check(`${label}: typing goes there`, await until(() => read(path).includes("- Spoke about it\n"), 4000), read(path))
  await page.screenshot({ path: `${OUT}templater-${label}-new-note.png` })

  // Insert a template at the cursor of the open note: its frontmatter read by tp.frontmatter.
  await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent(`${F}/Lighthouse.md`)}`)
  await page.locator(".vau-editor .cm-line", { hasText: "The Lighthouse project." }).first().click()
  await page.keyboard.press("End"); await page.keyboard.press("Enter")
  await palette(page, "Insert template", 600)
  await page.keyboard.type("Status"); await wait(200); await page.keyboard.press("Enter")
  check(`${label}: Insert template puts it at the cursor`, await until(() => read(`${F}/Lighthouse.md`).includes(`The Lighthouse project.\nOwner: Alice Park, status active, checked ${iso}`), 6000), read(`${F}/Lighthouse.md`))
  await page.screenshot({ path: `${OUT}templater-${label}-inserted.png` })

  // A folder template: a new empty note in Books asks the template's prompt, then is filled.
  const book = `${F}/Books/${label === "phone" ? "Dune" : "Solaris"}.md`
  await req("POST", "file", { path: book, text: "" }) // (as the app's New note does)
  await answer(page, "Stanisław Lem")
  check(`${label}: a folder template fills a new note, its prompt asked`, await until(() => read(book).includes("By Stanisław Lem, started"), 6000), read(book))
  await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent(book)}`)
  await wait(1500)
  await page.screenshot({ path: `${OUT}templater-${label}-folder.png` })
  await ctx.close()
}

await req("PATCH", "config/plugin/templates", { folder: tplBefore })
putBackWs()
await done()
