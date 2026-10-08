// Tasks in a browser: a ```tasks block drawn and ticked (the done date and a recurrence's next written to the note),
// the editor's checkbox and [/] [-] boxes, Create or edit task from the palette and from a query's pencil; desktop and
// 390px, light and dark, with screenshots. WRITES QA/Tasks/ and the look (put back): throwaway server only, with the
// plugin installed and on.
//   node tasks/.test/qa/tasks.mjs <base url> <vault path> [out dir]   (VAULTITE_APP: the app's checkout)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP = process.env.VAULTITE_APP ?? path.resolve(fileURLToPath(import.meta.url), "../../../../../vaultite")
const { qa, until, wait } = await import(path.join(APP, "web/qa/lib/qa.mjs"))
const { args: [B0, VAULT, OUT0], browser, check, watch, noErrors, done } = await qa(import.meta.url)
const B = B0.endsWith("/") ? B0 : `${B0}/`
const OUT = (OUT0 ?? "/tmp/tasks-shots").replace(/\/?$/, "/")
mkdirSync(OUT, { recursive: true })

const pad = (n) => String(n).padStart(2, "0")
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d) }
const TODAY = day(0)
const enc = encodeURIComponent
const api = async (method, p, body) => (await fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json()

const LIST = "QA/Tasks/Lighthouse.md", BOARD = "QA/Tasks/Board.md"
const file = (rel) => `${VAULT}/${rel}`
const read = (rel) => readFileSync(file(rel), "utf8")
const lineOf = (rel, words) => read(rel).split("\n").filter((l) => l.includes(words))
function fixtures() {
  mkdirSync(file("QA/Tasks"), { recursive: true })
  writeFileSync(file(LIST), `# Lighthouse

## This week
- [ ] Order a new lamp ⏫ 📅 ${day(-1)} #shopping
- [ ] Paint the railing 🛫 ${day(4)} 📅 ${day(14)}
- [/] Write the keeper's log 📅 ${TODAY}
- [ ] Water the plants 🔁 every week ⏳ ${day(-2)} 📅 ${TODAY}
- [x] Check the beam 📅 ${day(-5)} ✅ ${day(-4)}

## Later
- [ ] Repair the stairs 🔽 🆔 stairs
- [ ] Repaint after the stairs ⛔ stairs
- [-] Install a fog horn ❌ ${day(-16)}
- [ ] Call Alice Park about the visit  [priority:: medium]  [due:: ${day(1)}]

Buy paint for the door
`)
  writeFileSync(file(BOARD), `# Board

\`\`\`tasks
not done
path includes {{query.file.folder}}
due before in 15 days
group by due
\`\`\`

\`\`\`tasks
path includes QA/Tasks
heading includes later
\`\`\`
`)
}
fixtures()
const restoreLook = await api("GET", "config/appearance").catch(() => ({}))
await wait(1200)

async function open(w, h, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
  return { ctx, page: watch(await ctx.newPage(), { label: `${w}px`, console: true }) }
}
const shot = async (page, name) => { await wait(500); await page.screenshot({ path: `${OUT}${name}.png` }); console.log(`     ${OUT}${name}.png`) }
async function go(page, rel) {
  await page.goto("about:blank")
  await page.goto(`${B}#file/${enc(rel)}`)
  await until(() => page.locator("main").count(), 8000)
  await wait(1800)
}
const rows = (page) => page.locator("[data-task-row]")
const row = (page, words) => page.locator("[data-task-row]", { hasText: words }).first()
const settle = () => wait(1500)

try {
  // ---------- the API: the Dataview format setting, for what agents add
  await api("PATCH", "config/plugin/tasks", { format: "dataview" })
  const added = await api("POST", "ops/tasks.add", { path: LIST, description: "Book the ferry", due: day(3), priority: "high", heading: "Later" })
  check("tasks.add writes Dataview fields when the setting says so", lineOf(LIST, "Book the ferry")[0] === `- [ ] Book the ferry  [priority:: high]  [due:: ${day(3)}]`, [added, lineOf(LIST, "Book the ferry")])
  await api("PATCH", "config/plugin/tasks", { format: null })
  check("it goes at the end of its section", read(LIST).includes(`[due:: ${day(1)}]\n- [ ] Book the ferry`), read(LIST))

  // ---------- desktop, light: the board
  await api("PATCH", "config/appearance", { theme: "light" })
  {
    const { ctx, page } = await open(1440, 900)
    await go(page, BOARD)
    await until(() => page.locator("[data-tasks-result]").count(), 8000)
    await until(async () => (await rows(page).count()) >= 6, 5000)
    const heads = await page.locator("[data-tasks-group]").allInnerTexts()
    check("the board groups by due date", heads.length >= 3 && heads.some((h) => h.startsWith(TODAY)), heads)
    check("an overdue task is shown", await row(page, "Order a new lamp").count() === 1)
    check("the count says how many", /\d+ tasks?/.test(await page.locator("[data-tasks-count]").first().innerText()))
    check("Dataview fields read", await row(page, "Call Alice Park").count() === 1)
    check("the blocked one says so", /Blocked/.test(await row(page, "Repaint after").innerText()), await row(page, "Repaint after").innerText())
    await shot(page, "desktop-light-board")

    // Tick in the query: done date written, the row ticks.
    await row(page, "Order a new lamp").locator("[data-task-box]").click()
    await until(() => lineOf(LIST, "Order a new lamp")[0]?.startsWith("- [x]"), 5000)
    check("ticking in a query writes [x] and the done date", lineOf(LIST, "Order a new lamp")[0] === `- [x] Order a new lamp ⏫ 📅 ${day(-1)} #shopping ✅ ${TODAY}`, lineOf(LIST, "Order a new lamp"))
    await settle()
    check("a ticked task leaves a not done query", await row(page, "Order a new lamp").count() === 0)

    // A recurring one: its next occurrence above it, dates moved a week.
    await row(page, "Water the plants").locator("[data-task-box]").click()
    await until(() => lineOf(LIST, "Water the plants").length === 2, 5000)
    check("a recurring task adds its next one above", JSON.stringify(lineOf(LIST, "Water the plants")) === JSON.stringify([
      `- [ ] Water the plants 🔁 every week ⏳ ${day(5)} 📅 ${day(7)}`,
      `- [x] Water the plants 🔁 every week ⏳ ${day(-2)} 📅 ${TODAY} ✅ ${TODAY}`]), lineOf(LIST, "Water the plants"))
    await settle()

    // The pencil: the form, for a line in another note (written through tasks.update).
    await row(page, "Paint the railing").hover()
    await row(page, "Paint the railing").locator("[data-task-edit]").click()
    await until(() => page.locator("dialog[open] [data-task-form]").count(), 4000)
    check("the pencil opens the form", await page.locator("dialog[open] [data-task-form]").count() === 1)
    check("the form has the task's due date", await page.locator("dialog[open] input[data-task-field=due]").inputValue() === day(14))
    await shot(page, "desktop-light-form")
    await page.locator("dialog[open] input[data-task-field=due]").fill(day(3))
    await page.locator("dialog[open] [data-task-field=priority]").getByRole("radio", { name: "High", exact: true }).click()
    await page.locator("dialog[open] input[data-task-field=recurrence]").fill("every month on the 1st")
    await page.locator("dialog[open] [data-task-save]").click()
    await until(() => lineOf(LIST, "Paint the railing")[0]?.includes("⏫"), 5000)
    check("the form writes the line in place", lineOf(LIST, "Paint the railing")[0] === `- [ ] Paint the railing ⏫ 🔁 every month on the 1st 🛫 ${day(4)} 📅 ${day(3)}`, lineOf(LIST, "Paint the railing"))
    check("the sheet closes", await until(async () => (await page.locator("dialog[open] [data-task-form]").count()) === 0, 3000))
    await ctx.close()
  }

  // ---------- desktop, light: the note itself
  {
    const { ctx, page } = await open(1440, 900)
    await go(page, LIST)
    await until(() => page.locator(".cm-content").count(), 8000)
    const boxes = page.locator(".tasks-box")
    check("[/] and [-] get boxes", await boxes.count() === 2, await boxes.count())
    await shot(page, "desktop-light-note")
    // The editor's own checkbox: the done date comes with it.
    const callLine = page.locator(".cm-line", { hasText: "Repair the stairs" }).first()
    await callLine.locator("input.cm-task").click()
    await until(() => lineOf(LIST, "Repair the stairs")[0]?.includes("✅"), 5000)
    check("ticking in the note writes the done date", lineOf(LIST, "Repair the stairs")[0] === `- [x] Repair the stairs 🔽 🆔 stairs ✅ ${TODAY}`, lineOf(LIST, "Repair the stairs"))
    // In progress, clicked: done.
    await page.locator(".tasks-box[data-status='/']").click()
    await until(() => lineOf(LIST, "keeper's log")[0]?.startsWith("- [x]"), 5000)
    check("an in-progress box ticks done", lineOf(LIST, "keeper's log")[0] === `- [x] Write the keeper's log 📅 ${TODAY} ✅ ${TODAY}`, lineOf(LIST, "keeper's log"))
    // Undo takes the tick and the date back together.
    await page.keyboard.press("Meta+z")
    await until(() => lineOf(LIST, "keeper's log")[0]?.startsWith("- [/]"), 5000)
    check("one Undo takes back the tick and its date", lineOf(LIST, "keeper's log")[0] === `- [/] Write the keeper's log 📅 ${TODAY}`, lineOf(LIST, "keeper's log"))

    // Create or edit task, from the palette, on a plain new line.
    await page.locator(".cm-line", { hasText: "Buy paint for the door" }).first().click()
    await wait(300)
    await page.keyboard.press("Meta+p")
    await page.keyboard.type("Create or edit task")
    await wait(400)
    await page.keyboard.press("Enter")
    await until(() => page.locator("dialog[open] [data-task-form]").count(), 4000)
    check("the command opens the form for the line", await page.locator("dialog[open] input[data-task-field=description]").inputValue() === "Buy paint for the door",
      await page.locator("dialog[open] input[data-task-field=description]").inputValue().catch(() => null))
    await page.locator("dialog[open] input[data-task-field=due]").fill(day(2))
    await page.locator("dialog[open] [data-task-field=priority]").getByRole("radio", { name: "Low", exact: true }).click()
    await shot(page, "desktop-light-new-task")
    await page.locator("dialog[open] [data-task-save]").click()
    await until(() => lineOf(LIST, "Buy paint")[0]?.includes("📅"), 5000)
    check("the form makes the line a task", lineOf(LIST, "Buy paint")[0] === `- [ ] Buy paint for the door 🔽 📅 ${day(2)}`, lineOf(LIST, "Buy paint"))

    // Toggle task done, from the palette, on the cursor's line.
    await page.locator(".cm-line", { hasText: "Buy paint for the door" }).first().click()
    await wait(300)
    await page.keyboard.press("Meta+p")
    await page.keyboard.type("Toggle task done")
    await wait(400)
    await page.keyboard.press("Enter")
    await until(() => lineOf(LIST, "Buy paint")[0]?.startsWith("- [x]"), 5000)
    check("Toggle task done ticks the cursor's line", lineOf(LIST, "Buy paint")[0] === `- [x] Buy paint for the door 🔽 📅 ${day(2)} ✅ ${TODAY}`, lineOf(LIST, "Buy paint"))
    await ctx.close()
  }

  // ---------- desktop, dark
  await api("PATCH", "config/appearance", { theme: "dark" })
  {
    const { ctx, page } = await open(1440, 900)
    await go(page, BOARD)
    await until(async () => (await rows(page).count()) >= 4, 8000)
    await shot(page, "desktop-dark-board")
    await go(page, LIST)
    await until(() => page.locator(".tasks-box").count(), 8000)
    await shot(page, "desktop-dark-note")
    await ctx.close()
  }

  // ---------- phone, 390px, dark then light
  for (const theme of ["dark", "light"]) {
    await api("PATCH", "config/appearance", { theme })
    const { ctx, page } = await open(390, 844, true)
    await go(page, BOARD)
    await until(async () => (await rows(page).count()) >= 4, 8000)
    const wide = await page.evaluate(() => [...document.querySelectorAll("[data-tasks-result] *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.tagName + "." + e.className).slice(0, 5))
    check(`phone ${theme}: nothing runs off the screen`, !wide.length, wide)
    const box = await row(page, "Call Alice").locator("[data-task-box]").boundingBox()
    check(`phone ${theme}: a box is a 44px target`, box && box.width >= 44 && box.height >= 44, box)
    await shot(page, `phone-${theme}-board`)
    await row(page, "Call Alice").locator("[data-task-edit]").click()
    await until(() => page.locator("dialog[open] [data-task-form]").count(), 4000)
    check(`phone ${theme}: Save is in the sheet's bar`, await until(() => page.locator("[data-task-save-bar]").isVisible(), 3000))
    await shot(page, `phone-${theme}-form`)
    const formWide = await page.evaluate(() => { const d = document.querySelector("dialog[open]"); return [...d.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.tagName).slice(0, 5) })
    check(`phone ${theme}: the form fits`, !formWide.length, formWide)
    await ctx.close()
  }
  noErrors()
} finally {
  await api("PATCH", "config/appearance", { theme: restoreLook.theme ?? null }).catch(() => {})
  await api("PATCH", "config/plugin/tasks", { format: null }).catch(() => {})
  rmSync(file("QA/Tasks"), { recursive: true, force: true })
}
await done()
