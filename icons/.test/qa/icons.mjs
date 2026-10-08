// Icons in a real browser: a folder's icon picked from its right-click (search, Enter) and its colour from the
// chooser, drawn in the tree; a note's colour in its tint: and on its tab; another file's icon on its tab; Remove icon.
// Then a 390px phone: the row's … menu, the picker, the drawer's icons. Light and dark, with screenshots. Installs the
// plugin; WRITES its settings and a note's frontmatter: a throwaway server only.
//   node icons/.test/qa/icons.mjs <base url> <vault path> [out dir]
import { mkdirSync, readFileSync } from "node:fs"
import { install, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const req = (method, p, body) => fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) }).then((r) => r.json())
const settings = () => req("GET", "config/plugin/icons")
const NOTE = "Notes/Lisbon trip.md", BASE = "Notes/Books/Reading list.base"
const noteWas = readFileSync(`${VAULT}/${NOTE}`, "utf8")

const putBackWs = setAsideWorkspaces(VAULT)
install(B, "icons")
await req("PATCH", "config/plugin/icons", { icons: null })

const row = (page, p) => page.locator(`[data-tree-path="${p}"]`).first()
const rowIcon = (page, p) => row(page, p).locator("button[data-keyrow] svg:not(.lucide-chevron-right)").first()
const shot = (page, name) => page.screenshot({ path: `${OUT}icons-${name}.png` })
async function open(opts, label, hash = "") {
  const ctx = await browser.newContext(opts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank"); await page.goto(`${B}#${hash}`); await wait(1800)
  return { ctx, page }
}
async function menuPick(page, label) {
  const it = page.locator("[role=menu] [role=menuitem]", { hasText: label }).first()
  if (!await until(() => it.isVisible(), 3000)) return false
  await it.click(); await wait(400); return true
}

// ---------- desktop
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 } }, "desktop", `file/${encodeURIComponent(NOTE)}`)
  check("desktop: the tree", await until(() => row(page, "Projects").isVisible(), 6000))
  await row(page, "Projects").click({ button: "right" })
  check("desktop: a folder's menu has Change icon and Change colour", await page.locator("[role=menuitem]", { hasText: "Change icon" }).isVisible()
    && await page.locator("[role=menuitem]", { hasText: "Change colour" }).isVisible())
  await shot(page, "desktop-folder-menu")
  await menuPick(page, "Change icon")
  check("desktop: the icon picker", await until(() => page.locator("[role=dialog][aria-label='Change icon']").isVisible(), 3000))
  await page.keyboard.type("rocket"); await wait(500)
  await shot(page, "desktop-picker")
  await page.keyboard.press("Enter")
  check("desktop: kept in the settings", await until(async () => (await settings()).icons?.Projects?.icon === "rocket", 4000), await settings())
  check("desktop: drawn in the tree", await until(async () => (await rowIcon(page, "Projects").getAttribute("class"))?.includes("lucide-rocket"), 4000),
    await rowIcon(page, "Projects").getAttribute("class"))

  await row(page, "Projects").click({ button: "right" }); await menuPick(page, "Change colour")
  check("desktop: the colour chooser", await until(() => page.locator("[role=option]", { hasText: "Indigo" }).isVisible(), 3000))
  await shot(page, "desktop-colours")
  await page.keyboard.type("blue"); await wait(200); await page.keyboard.press("Enter")
  check("desktop: the folder's icon in its colour", await until(async () => (await rowIcon(page, "Projects").getAttribute("style"))?.includes("var(--blue)"), 4000))

  // A note: the app's own Change icon (Rename ▸), this plugin's colour in its tint:, drawn on its tab too.
  if (!await row(page, NOTE).isVisible()) { await row(page, "Notes").click(); await wait(400) }
  await row(page, NOTE).click({ button: "right" })
  check("desktop: a note's menu has Change colour, not a second Change icon",
    await page.locator("[role=menuitem]", { hasText: "Change colour" }).isVisible() && await page.locator("[role=menuitem]", { hasText: "Change icon" }).count() === 0)
  await menuPick(page, "Change colour")
  await page.keyboard.type("green"); await wait(200); await page.keyboard.press("Enter")
  check("desktop: a note's colour is its tint:", await until(() => /^tint: green$/m.test(readFileSync(`${VAULT}/${NOTE}`, "utf8")), 4000))
  const tabIcon = page.locator("[data-tab-id] svg").first()
  check("desktop: its tab's icon in that colour", await until(async () => (await tabIcon.getAttribute("style"))?.includes("var(--green)"), 4000), await tabIcon.getAttribute("style"))
  check("desktop: so is its row", await until(async () => (await rowIcon(page, NOTE).getAttribute("style"))?.includes("var(--green)"), 4000))

  // Another kind of file: its icon in the settings, on its tab.
  await req("POST", "ops/icons.set", { path: BASE, icon: "library", tint: "purple" })
  await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent(BASE)}`); await wait(2000)
  const baseTab = page.locator("[data-tab-id]", { hasText: "Reading list" }).locator("svg").first()
  check("desktop: another file's icon and colour on its tab", await until(async () => (await baseTab.getAttribute("class"))?.includes("lucide-library")
    && (await baseTab.getAttribute("style"))?.includes("var(--purple)"), 5000), [await baseTab.getAttribute("class"), await baseTab.getAttribute("style")])
  await shot(page, "desktop-light")
  await page.locator(`[data-tab-id]`, { hasText: "Reading list" }).first().click({ button: "right" })
  await shot(page, "desktop-tab-menu"); await menuPick(page, "Remove icon")
  check("desktop: Remove icon takes it away", await until(async () => !(await settings()).icons?.[BASE], 4000), await settings())
  await ctx.close()
}
{
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" }, "desktop dark", `file/${encodeURIComponent(NOTE)}`)
  await until(() => row(page, "Projects").isVisible(), 6000)
  check("desktop dark: the folder's icon", (await rowIcon(page, "Projects").getAttribute("class"))?.includes("lucide-rocket"))
  await shot(page, "desktop-dark")
  await ctx.close()
}

// ---------- a 390px phone: the drawer's tree, a row's … menu
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
for (const dark of [false, true]) {
  const scheme = dark ? "dark" : "light"
  const { ctx, page } = await open({ ...phone, colorScheme: scheme }, `phone ${scheme}`, `file/${encodeURIComponent(NOTE)}`)
  await page.locator("[data-phone-header] button[aria-label='Open sidebar']").tap(); await wait(700)
  const daily = page.locator("[data-phone-drawer] [data-tree-path='Daily']").first()
  check(`phone ${scheme}: the drawer's tree`, await until(() => daily.isVisible(), 4000))
  check(`phone ${scheme}: the folder's icon there`, (await page.locator("[data-phone-drawer] [data-tree-path='Projects'] button[data-keyrow] svg:not(.lucide-chevron-right)").first().getAttribute("class"))?.includes("lucide-rocket"))
  if (!dark) {
    await daily.locator("button[aria-label='More for Daily']").tap(); await wait(500)
    await shot(page, "phone-menu")
    await menuPick(page, "Change icon")
    check("phone: the icon picker", await until(() => page.locator("[role=dialog][aria-label='Change icon']").isVisible(), 3000))
    await page.keyboard.type("🌅"); await wait(400)
    await shot(page, "phone-picker")
    await page.keyboard.press("Enter")
    check("phone: an emoji kept", await until(async () => (await settings()).icons?.Daily?.icon === "🌅", 4000), await settings())
    await wait(600)
    await page.locator("[data-phone-header] button[aria-label='Open sidebar']").tap().catch(() => {}); await wait(600)
  }
  await shot(page, `phone-${scheme}`)
  await ctx.close()
}

await req("POST", "ops/file.write", { path: NOTE, text: noteWas })
await req("PATCH", "config/plugin/icons", { icons: null })
putBackWs()
await done()
