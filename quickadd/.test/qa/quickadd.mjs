// Quick add in a real browser: a choice's own palette command asks for its value in the palette and adds it to its
// note (a toast to open it); "Quick add" lists the choices, a group asks which, a template asks its Topic and opens the
// note made; a choice as a new tab's button; the settings sheet (a choice unfolded, edited, one added). Desktop and a
// 390px phone, light and dark, with screenshots. Installs the plugin; WRITES its settings, a template, Inbox/Ideas.md,
// Meetings/ and newtab.json: a throwaway server only.
//   node quickadd/.test/qa/quickadd.mjs <base url> <vault path> [out dir]
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { install, palette, qa, SHOTS, setAsideWorkspaces, until, vauAt, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const req = (method, p, body) => fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) }).then((r) => r.json())
const read = (p) => (existsSync(`${VAULT}/${p}`) ? readFileSync(`${VAULT}/${p}`, "utf8") : "")
const today = new Date().toLocaleDateString("sv"), NOTE = "Notes/Lisbon trip.md"

const putBackWs = setAsideWorkspaces(VAULT)
install(B, "quickadd")
await req("POST", "file", { path: "Templates/Qa meeting.md", text: "---\ntype: note\n---\n# {{title}}\n\nTopic: {{VALUE:Topic}}, from {{LINKCURRENT}}\n" })
await req("PATCH", "config/plugin/quickadd", { choices: [
  { id: "idea", name: "Log idea", type: "capture", command: true, file: "Inbox/Ideas", format: "- {{VALUE}} (from {{LINKCURRENT}})", heading: "Ideas" },
  { id: "meet", name: "Meeting", type: "template", command: true, template: "Qa meeting", nameFormat: "{{DATE}} {{VALUE:Topic}}", folder: "Meetings" },
  { id: "add", name: "Add", type: "multi", choices: ["Log idea", "Meeting"] },
] })
const asked = (page, text) => until(() => page.locator("[role=dialog]", { hasText: text }).isVisible(), 5000)
const shot = (page, name) => page.screenshot({ path: `${OUT}quickadd-${name}.png` })
async function open(opts, label, hash) {
  const ctx = await browser.newContext(opts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank"); await page.goto(`${B}#${hash}`); await wait(2000)
  return { ctx, page }
}

// ---------- desktop
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 } }, "desktop", `file/${encodeURIComponent(NOTE)}`)
  await palette(page, "Quick add: Log idea", 1200)
  check("desktop: its command asks for the value in the palette", await asked(page, "Log idea"))
  await page.keyboard.type("Book the ferry"); await shot(page, "desktop-ask")
  await page.keyboard.press("Enter")
  check("desktop: added under its heading, with the open note's link", await until(() => read("Inbox/Ideas.md").includes("## Ideas\n- Book the ferry (from [[Lisbon trip]])"), 5000), read("Inbox/Ideas.md"))
  check("desktop: a toast says where, with Open", await until(() => page.getByText("Added to Ideas").isVisible(), 3000))

  await palette(page, "Quick add", 800)
  const list = page.locator("[role=dialog] [role=option]")
  check("desktop: Quick add lists the choices, those in a group inside it", await until(async () => (await list.count()) === 1, 3000)
    && await list.filter({ hasText: "Add" }).count() === 1, await list.allInnerTexts())
  await shot(page, "desktop-choices")
  await list.filter({ hasText: "Add" }).click()
  check("desktop: a group asks which", await asked(page, "Meeting"))
  await page.locator("[role=dialog] [role=option]", { hasText: "Meeting" }).click()
  check("desktop: a template's named value asked", await asked(page, "Topic"))
  await page.keyboard.type("Budget"); await page.keyboard.press("Enter")
  const made = `Meetings/${today} Budget.md`
  check("desktop: the note made from the template", await until(() => read(made).includes("Topic: Budget, from [[Lisbon trip]]"), 5000), read(made))
  check("desktop: and opened", await until(() => decodeURIComponent(page.url()).includes(made), 5000), page.url())

  // A choice as a new tab's button (the app's own buttons, its command's icon and label).
  vauAt(B)("newtab", "button", "add", "quickadd:idea")
  await page.locator("button[aria-label='New tab']").first().click(); await wait(1000)
  await shot(page, "desktop-newtab")
  const btn = page.getByText("Log idea", { exact: true }).locator("visible=true").first()
  check("desktop: a new tab's button runs it", await until(() => btn.isVisible(), 4000))
  await shot(page, "desktop-newtab")
  await btn.click()
  check("desktop: its button asks too", await asked(page, "Log idea"))
  await page.keyboard.press("Escape"); await wait(400)

  // The settings sheet.
  await page.goto("about:blank"); await page.goto(`${B}#settings/plugin-settings/quickadd`); await wait(1800)
  const sheet = page.locator("[data-quickadd-settings]")
  check("desktop: the settings sheet lists them", await until(() => sheet.isVisible(), 4000) && await sheet.locator("[data-choice]").count() === 3)
  await sheet.locator("[data-choice='Log idea'] button").first().click(); await wait(400)
  check("desktop: a choice unfolds into its fields", await sheet.locator("[data-setting=heading]").isVisible() && await sheet.locator("[data-setting=format]").isVisible())
  await shot(page, "desktop-settings")
  const heading = sheet.locator("[data-setting=heading] input")
  await heading.fill("Later"); await heading.press("Enter")
  check("desktop: an edit is saved", await until(async () => (await req("GET", "config/plugin/quickadd")).choices?.[0]?.heading === "Later", 4000))
  await sheet.locator("[data-quickadd-add=capture]").click()
  check("desktop: a choice added, unfolded", await until(async () => (await req("GET", "config/plugin/quickadd")).choices?.length === 4, 4000)
    && await until(() => sheet.locator("[data-choice='New capture'] [data-setting=file]").isVisible(), 3000))
  await ctx.close()
}
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" }, "desktop dark", "settings/plugin-settings/quickadd")
  check("desktop dark: the settings sheet", await until(() => page.locator("[data-quickadd-settings]").isVisible(), 4000))
  await shot(page, "desktop-settings-dark")
  await ctx.close()
}

// ---------- a 390px phone
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
for (const dark of [false, true]) {
  const scheme = dark ? "dark" : "light"
  const { ctx, page } = await open({ ...phone, colorScheme: scheme }, `phone ${scheme}`, "settings/plugin-settings/quickadd")
  const sheet = page.locator("[data-quickadd-settings]")
  check(`phone ${scheme}: the settings sheet`, await until(() => sheet.isVisible(), 4000))
  await sheet.locator("[data-choice='Meeting'] button").first().tap(); await wait(400)
  const box = await sheet.boundingBox()
  check(`phone ${scheme}: fits 390px`, box && box.x >= 0 && box.x + box.width <= 390, box)
  await shot(page, `phone-settings-${scheme}`)
  if (!dark) {
    await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`); await wait(1800)
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true })))
    await wait(500)
    await page.keyboard.type("Quick add: Log idea"); await wait(300); await page.keyboard.press("Enter")
    check("phone: its command asks", await asked(page, "Log idea"))
    await page.keyboard.type("From the phone"); await shot(page, "phone-ask"); await page.keyboard.press("Enter")
    check("phone: added", await until(() => read("Inbox/Ideas.md").includes("- From the phone"), 5000), read("Inbox/Ideas.md"))
  }
  await ctx.close()
}

for (const p of ["Templates/Qa meeting.md", "Inbox/Ideas.md", `Meetings/${today} Budget.md`]) rmSync(`${VAULT}/${p}`, { force: true })
vauAt(B)("newtab", "button", "remove", "quickadd:idea")
await req("PATCH", "config/plugin/quickadd", { choices: null })
putBackWs()
await done()
