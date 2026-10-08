// Dataview in a real browser: a note of ```dataview fences (a table, a grouped list, tasks, a calendar, a query with a
// mistake, a dataviewjs block) and inline queries, drawn as the app's cards; a task ticked from the list writes its
// box in its note; a new note shows up in the table on its own; a row opens its note. Desktop and a 390px phone, light
// and dark, with screenshots. WRITES a "Qa dataview" folder (removed after): a throwaway server only.
//   node dataview/.test/qa/dataview.mjs <base url> <vault path> [out dir]     (VAULTITE_APP: the app's checkout, ../vaultite)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const [B, VAULT, OUT = "/tmp/dataview-shots/"] = process.argv.slice(2)
if (!B || !VAULT) { console.error("usage: node dataview/.test/qa/dataview.mjs <base url> <vault path> [out dir]"); process.exit(2) }
const APP = process.env.VAULTITE_APP ?? path.resolve(import.meta.dirname, "../../../../vaultite")
const { chromium } = await import(path.join(APP, "node_modules/playwright-core/index.mjs"))
const base = B.endsWith("/") ? B : `${B}/`
mkdirSync(OUT, { recursive: true })

const fails = [], errs = []
const check = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || got === undefined ? "" : `  (got ${JSON.stringify(got)?.slice(0, 400)})`}`)
  if (!ok) fails.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms
  for (;;) { let v; try { v = await fn() } catch { /* not yet */ } if (v || Date.now() > end) return v; await wait(100) }
}

const DIR = "Qa dataview", NOTE = `${DIR}/Queries.md`
const abs = (p) => path.join(VAULT, p)
rmSync(abs(DIR), { recursive: true, force: true })
cpSync(path.join(import.meta.dirname, "..", "fixtures", "vault"), abs(DIR), { recursive: true })
writeFileSync(abs(NOTE), `# Queries

\`\`\`dataview
TABLE author AS "Author", rating AS "Rating", status AS "Status", finished - started AS "Took"
FROM "${DIR}/Books"
SORT rating DESC
\`\`\`

\`\`\`dataview
LIST rows.file.link
FROM "${DIR}/People"
GROUP BY relation
\`\`\`

\`\`\`dataview
TASK
FROM "${DIR}/Daily" OR "${DIR}/Projects"
WHERE !completed
\`\`\`

\`\`\`dataview
CALENDAR file.day
FROM "${DIR}/Daily"
\`\`\`

\`\`\`dataview
TABLE rating FORM #book
\`\`\`

\`\`\`dataviewjs
dv.list(dv.pages("#book").file.name)
\`\`\`

This note is \`= this.file.name\` and Dune got \`= [[Dune]].rating\`.
`)
const disk = (p) => readFileSync(abs(p), "utf8")

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
// (a computer's open pane; a phone has one page, #main-scroll)
let P = "[data-pane]:not([data-kept]) "
const open = async (ctx, file = NOTE) => {
  await ctx.addInitScript(() => { try { localStorage.setItem("vaultite.editMode", "live") } catch { /* not the app's frame */ } })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => errs.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()) })
  await page.goto(`${base}#file/${encodeURIComponent(file)}`)
  await page.waitForSelector(".cm-content", { timeout: 15000 })
  await until(() => page.locator(`${P}[data-dataview=table] tbody tr`).count(), 10000)
  await wait(600)
  return page
}
/** Each card's screenshot, scrolled into view. */
const shoot = async (page, name) => {
  await page.screenshot({ path: `${OUT}${name}.png` })
  const cards = page.locator(`${P}[data-dataview], ${P}[data-dv-js]`)
  for (let i = 0; i < await cards.count(); i++) {
    const card = cards.nth(i).locator("xpath=ancestor::section[1]")
    await card.scrollIntoViewIfNeeded()
    await card.screenshot({ path: `${OUT}${name}-card${i + 1}.png` })
  }
}

try {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme })
    const page = await open(ctx)
    if (scheme === "light") {
      const table = page.locator(`${P}[data-dataview=table]`).first()
      const heads = await table.locator("th").allTextContents()
      check("table: its columns, File first", heads.join("|") === "File|Author|Rating|Status|Took", heads)
      const rows = await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())))
      check("table: sorted by rating, a link, a date span, a dash for nothing", rows.length === 3 && rows[0][0] === "Dune" && rows[0][1] === "Frank Herbert"
        && rows[0][2] === "9" && rows[0][4] === "2 weeks, 5 days" && rows[2][0] === "The Hobbit" && rows[2][2] === "–", rows)
      check("table: the count in the card's head", (await page.locator(`${P}[data-dv-count]`).first().textContent()) === "3 results")
      check("table: titled by its folder", (await table.locator("xpath=ancestor::section[1]//h2").textContent()) === "Books")
      const groups = await page.locator(`${P}[data-dataview=list] [data-dv-group]`).allTextContents()
      check("list: grouped by relation, each with its people", groups.join("|") === "colleague1|family1|friend1", groups)
      const tasks = await page.locator(`${P}[data-dataview=task] [data-dv-tasks]`).count()
      check("tasks: under their notes", tasks === 5, tasks)
      check("tasks: a subtask under its parent", await page.locator(`${P}[data-dataview=task] li li`).count() === 2)
      check("calendar: a month with the daily notes", await until(() => page.locator(`${P}[data-dataview=calendar] [data-dv-item]`).count()) >= 3)
      check("a mistake is said calmly", (await page.locator(`${P}[data-dv-error]`).textContent()).includes("expected FROM, WHERE"))
      check("dataviewjs: a note, not its code run", (await page.locator(`${P}[data-dv-js]`).textContent()).includes("doesn't run"))
      await page.locator(`${P}h1, ${P}.cm-line`).first().click()
      await page.keyboard.press("Meta+Home")
      const inline = await until(async () => { const t = await page.locator(`${P}.cm-dv-inline`).allTextContents(); return t.length === 2 && !t.includes("…") && t })
      check("inline queries: their values off the cursor's line", inline && inline[0] === "Queries" && inline[1] === "9", inline)

      // Tick a task: its box in its note changes, nothing else.
      const before = disk(`${DIR}/Daily/2026-10-02.md`)
      const box = page.locator(`${P}[data-dv-task^="${DIR}/Daily/2026-10-02.md"] input`).first()
      await box.scrollIntoViewIfNeeded()
      await box.click()
      check("tick: the note's box is ticked", await until(() => disk(`${DIR}/Daily/2026-10-02.md`) === before.replace("- [ ] Return", "- [x] Return")), disk(`${DIR}/Daily/2026-10-02.md`))
      check("tick: and it leaves the list of open tasks", await until(async () => !(await page.locator(`${P}[data-dv-task^="${DIR}/Daily/2026-10-02.md"]`).count())))
      writeFileSync(abs(`${DIR}/Daily/2026-10-02.md`), before)
      check("untick from the note: back in the list", await until(() => page.locator(`${P}[data-dv-task^="${DIR}/Daily/2026-10-02.md"]`).count()))
      const sub = page.locator(`${P}[data-dv-task^="${DIR}/Projects/Lighthouse.md"] li input`).first()
      const lh = disk(`${DIR}/Projects/Lighthouse.md`)
      await sub.click()
      check("tick a done subtask: unticked, the others as they were", await until(() => disk(`${DIR}/Projects/Lighthouse.md`) === lh.replace("\t- [x] Ask", "\t- [ ] Ask")), disk(`${DIR}/Projects/Lighthouse.md`))
      writeFileSync(abs(`${DIR}/Projects/Lighthouse.md`), lh)

      // Live: a new book shows up, a change of rating moves it.
      writeFileSync(abs(`${DIR}/Books/Kindred.md`), "---\nauthor: Octavia E. Butler\nrating: 10\nstatus: read\ntags: [book]\n---\n")
      check("live: a new note joins the table", await until(async () => (await table.locator("tbody tr").first().textContent()).startsWith("Kindred"), 8000))
      writeFileSync(abs(`${DIR}/Books/Kindred.md`), "---\nauthor: Octavia E. Butler\nrating: 1\nstatus: read\ntags: [book]\n---\n")
      check("live: and moves when its rating changes", await until(async () => (await table.locator("tbody tr").nth(2).textContent()).startsWith("Kindred"), 8000))
      rmSync(abs(`${DIR}/Books/Kindred.md`))
      await until(async () => await table.locator("tbody tr").count() === 3, 8000)
    }
    await page.locator(`${P}.cm-content`).first().click({ position: { x: 5, y: 5 } }).catch(() => {})
    await shoot(page, `desktop-${scheme}`)
    // Reading view: the same, inline values too.
    await page.keyboard.press("Meta+e"); await wait(800)
    if (scheme === "light") {
      const read = await until(async () => { const t = await page.locator(`${P}.cm-dv-inline`).allTextContents(); return t.length === 2 && !t.includes("…") && t })
      check("reading view: inline values", read && read[0] === "Queries", read)
      // A row opens its note.
      await page.locator(`${P}[data-dataview=table] tbody tr`).first().click()
      check("a row opens its note", await until(() => page.evaluate(() => decodeURIComponent(location.hash)).then((h) => h.includes("Books/Dune"))))
    }
    await ctx.close()
  }

  P = "#main-scroll "
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme })
    const page = await open(ctx)
    // (cards are drawn as they near the screen: scroll through them all first)
    for (let y = 0; y < 8; y++) { await page.locator("#main-scroll").evaluate((e) => e.scrollBy(0, 700)); await wait(300) }
    const wide = await page.evaluate(() => [document.documentElement.scrollWidth, ...[...document.querySelectorAll("#main-scroll section")].map((s) => s.getBoundingClientRect().right)])
    check(`phone (${scheme}): nothing wider than the screen`, wide.every((w) => w <= 391), wide)
    if (scheme === "light") {
      const days = await page.locator(`${P}[data-dv-calendar] [data-dv-item]`).evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.getBoundingClientRect().height))
      check("phone: the calendar lists its days, rows a finger can tap", days.length === 3 && days.every((h) => h >= 44), days)
      const row = await page.locator(`${P}[data-dataview=task] li > div`).first().boundingBox()
      check("phone: a task's row is tall enough to tap", row && row.height >= 44, row)
    }
    await shoot(page, `phone-${scheme}`)
    await ctx.close()
  }
} finally {
  await browser.close()
  rmSync(abs(DIR), { recursive: true, force: true })
}
check("no page errors", !errs.length, errs.slice(0, 5))
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed")
console.log(`screenshots: ${OUT}`)
process.exit(fails.length ? 1 : 0)
