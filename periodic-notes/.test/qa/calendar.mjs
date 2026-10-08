// The calendar in a real browser: the sidebar's month (today marked, dots for daily notes and their open tasks, week
// numbers, the open note's day lit), a click on a day with no note asks, then makes it from the daily template and
// opens it; a week number makes the weekly note; months go back and forth; the next/previous note commands. Desktop
// and a 390px phone (the drawer's panel and the tab), light and dark, with screenshots. Installs the plugin; WRITES
// notes in Daily/ and Weekly/, a template and the plugin's settings: a throwaway server only.
//   node periodic-notes/.test/qa/calendar.mjs <base url> <vault path> [out dir]
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { install, palette, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const req = (method, p, body) => fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json", "X-Vaultite-Client": "app/qa" }, body: body && JSON.stringify(body) }).then((r) => r.json())
const read = (p) => (existsSync(`${VAULT}/${p}`) ? readFileSync(`${VAULT}/${p}`, "utf8") : "")
const pad = (n) => String(n).padStart(2, "0"), now = new Date()
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, today = iso(now)

const putBackWs = setAsideWorkspaces(VAULT)
install(B, "periodic-notes")
await req("PATCH", "config/plugin/periodic-notes", { weekly: true, weekNumbers: true, dailyTemplate: "Qa daily", confirmCreate: true })
await req("POST", "file", { path: "Templates/Qa daily.md", text: "---\ntags: [journal]\n---\n## {{date:dddd D MMMM}}\n\n- [ ] Plan the day\n" })
// Today's note long, with a task left open (dots: its length; a ring: the task).
const todayPath = `Daily/${today}.md`, made = [], todayWas = read(todayPath)
await req("PUT", "file", { path: todayPath, text: `---\ntype: day\n---\n\n${"Wrote about the Lighthouse launch. ".repeat(160)}\n- [ ] Call Alice Park\n` })
const month = await req("GET", `periodic-notes/month?month=${today.slice(0, 7)}`)
const days = month.weeks.flatMap((w) => w.days).filter((d) => d.date.startsWith(month.month))
// A day of this month with no note yet, and a week with no weekly note, to make by clicking.
const blank = days.find((d) => !d.note.exists && d.date !== today)
const week = month.weeks.find((w) => !w.note.exists)
made.push(blank.note.path, week.note.path)

async function open(opts, label, hash) {
  const ctx = await browser.newContext(opts)
  const page = watch(await ctx.newPage(), { label, console: true })
  await page.goto("about:blank")
  await page.goto(`${B}#${hash}`)
  await wait(1800)
  return { ctx, page }
}
const cal = (page) => page.locator("[data-calendar]").first()
const shot = (page, name) => page.screenshot({ path: `${OUT}periodic-notes-${name}.png` })

for (const dark of [false, true]) {
  const scheme = dark ? "dark" : "light"
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 }, colorScheme: scheme }, `desktop ${scheme}`, `file/${encodeURIComponent(todayPath)}`)
  check(`desktop ${scheme}: the month in the sidebar`, await until(() => cal(page).isVisible(), 8000))
  const t = cal(page).locator(`[data-date="${today}"]`)
  check(`desktop ${scheme}: today marked, lit as the open note`, (await t.getAttribute("aria-current")) === "date"
    && await t.evaluate((e) => getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)"))
  check(`desktop ${scheme}: today's dots: its length and its open task`, (await t.locator("i").count()) === 4, await t.locator("i").count())
  check(`desktop ${scheme}: week numbers`, (await cal(page).locator("[data-week]").count()) === month.weeks.length)
  await shot(page, `desktop-${scheme}`)
  await cal(page).screenshot({ path: `${OUT}periodic-notes-panel-${scheme}.png` })
  if (dark) { await ctx.close(); continue }

  // A day with no note: asked, then made from the template and opened.
  await cal(page).locator(`[data-date="${blank.date}"]`).click()
  check("desktop: a click on an empty day asks first", await until(() => page.locator("[data-confirm]").isVisible(), 3000))
  await shot(page, "desktop-confirm")
  await page.locator("[data-confirm-ok]").click()
  check("desktop: the note is made from the daily template", await until(() => read(blank.note.path).includes("- [ ] Plan the day"), 6000), read(blank.note.path))
  check("desktop: with the app's type and the template's tags, dated for that day", /^---\ntype: day\ntags: \[journal\]/.test(read(blank.note.path))
    && read(blank.note.path).includes(`## ${new Date(blank.date + "T12:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).replace(",", "")}`), read(blank.note.path))
  check("desktop: and opened", await until(() => decodeURIComponent(page.url()).includes(blank.note.path), 5000), page.url())
  check("desktop: its day now has a dot", await until(async () => (await cal(page).locator(`[data-date="${blank.date}"] i`).count()) >= 1, 4000))
  await shot(page, "desktop-made")

  // The next and previous notes from there (the nearest there are).
  const after = days.filter((d) => d.date > blank.date && (d.note.exists || d.date === today))[0]
  if (after) {
    await palette(page, "Open next periodic note")
    check("desktop: Open next periodic note goes to the nearest later one", await until(() => decodeURIComponent(page.url()).includes(after.note.path), 4000), [after.note.path, page.url()])
    await palette(page, "Open previous periodic note")
    check("desktop: and back", await until(() => decodeURIComponent(page.url()).includes(blank.note.path), 4000), page.url())
  }

  // A week number: its weekly note.
  await cal(page).locator(`[data-week="${week.n}"]`).click()
  await until(() => page.locator("[data-confirm]").isVisible(), 3000)
  await page.locator("[data-confirm-ok]").click()
  check("desktop: a week number makes and opens its weekly note", await until(() => existsSync(`${VAULT}/${week.note.path}`) && decodeURIComponent(page.url()).includes(week.note.path), 6000), week.note.path)

  // Months back and forth.
  await cal(page).locator("button[aria-label='Next month']").click()
  const next = iso(new Date(now.getFullYear(), now.getMonth() + 1, 1)).slice(0, 7)
  check("desktop: the next month", await until(async () => (await cal(page).getAttribute("data-calendar")) === next, 4000))
  await cal(page).locator("button[aria-label='This month']").click()
  check("desktop: back to this month", await until(async () => (await cal(page).getAttribute("data-calendar")) === month.month, 4000))
  await ctx.close()
}

// A 390px phone: the drawer's panel, a day opened from it, the calendar's tab.
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
for (const dark of [false, true]) {
  const scheme = dark ? "dark" : "light"
  const { ctx, page } = await open({ ...phone, colorScheme: scheme }, `phone ${scheme}`, `file/${encodeURIComponent(blank.note.path)}`)
  await page.locator("[data-phone-header] button[aria-label='Open sidebar']").tap(); await wait(600)
  const c = page.locator("[data-phone-drawer] [data-calendar]")
  check(`phone ${scheme}: the calendar in the drawer`, await until(() => c.isVisible(), 4000))
  await c.scrollIntoViewIfNeeded(); await wait(300)
  const cell = await c.locator(`[data-date="${today}"]`).boundingBox(), row = await page.locator("[data-phone-drawer] [data-tree-path]").first().boundingBox()
  check(`phone ${scheme}: a day is at least as tall as the drawer's rows`, cell && row && cell.height >= row.height && cell.width >= row.height, [cell, row])
  const box = await c.boundingBox()
  check(`phone ${scheme}: fits the drawer`, box && box.x >= 0 && box.x + box.width <= 390, box)
  await shot(page, `phone-drawer-${scheme}`)
  if (!dark) {
    await c.locator(`[data-date="${today}"]`).tap()
    check("phone: a day's note opens from the drawer", await until(() => decodeURIComponent(page.url()).includes(todayPath), 4000), page.url())
    await wait(600)
  }
  await page.goto("about:blank"); await page.goto(`${B}#view/periodic-notes`); await wait(1800)
  const tab = page.locator("[data-calendar]").first()
  check(`phone ${scheme}: the calendar's tab`, await until(() => tab.isVisible(), 5000))
  const tb = await tab.boundingBox(), tcell = await tab.locator(`[data-date="${today}"]`).boundingBox()
  check(`phone ${scheme}: the tab fits 390px, its days a finger's size`, tb && tb.x >= 0 && tb.x + tb.width <= 390 && tcell?.height >= 44, [tb, tcell])
  await shot(page, `phone-tab-${scheme}`)
  await ctx.close()
}

if (todayWas) await req("PUT", "file", { path: todayPath, text: todayWas })
else made.push(todayPath)
for (const p of made) rmSync(`${VAULT}/${p}`, { force: true })
rmSync(`${VAULT}/Templates/Qa daily.md`, { force: true })
await req("PATCH", "config/plugin/periodic-notes", { weekly: null, weekNumbers: null, dailyTemplate: null, confirmCreate: null })
putBackWs()
await done()
