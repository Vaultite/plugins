// Health's sleep and activity cards in a real browser: the score's ring, the night's stages over time, the rings and
// the trends, on desktop and a 390px phone, light and dark, with screenshots. Installs the plugin; WRITES logs (made-up
// nights and days, source qa): a throwaway server only.   node health/.test/qa/health.mjs <base url> <vault path> [out dir]
import { mkdirSync } from "node:fs"
import { apiAt, install, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const api = apiAt(B)
const putBackWs = setAsideWorkspaces(VAULT)
install(B, "health")

const day = (k) => new Date(Date.now() - k * 86400000).toLocaleDateString("sv")
const nights = Array.from({ length: 10 }, (_, k) => ({
  area: "sleep", date: day(k), title: "Sleep", source: "qa", ext_id: `qa sleep ${k}`, duration_min: 420 + (k % 3) * 25,
  data: { bed: k % 2 ? "23:05" : "22:50", wake: "06:40", in_bed_min: 470, deep_min: 80, core_min: 230, rem_min: 120, awake_min: 18,
    timeline: "-6 C35 D48 C40 A4 R22 C55 D32 C38 R30 A6 C30 R40 C32 A8 R28" },
}))
const days = Array.from({ length: 30 }, (_, k) => ({
  area: "health", date: day(k), title: "Activity", source: "qa", ext_id: `qa day ${k}`,
  data: { steps: 5000 + ((k * 1379) % 6000), active_kcal: 380 + ((k * 37) % 200), exercise_min: 18 + (k % 20), stand_h: 8 + (k % 5),
    move_goal: 500, exercise_goal: 30, stand_goal: 12, resting_hr: 56 + (k % 6), hrv_ms: 42 + ((k * 7) % 15), vo2max: 44 + (k % 3) / 10 },
}))
await api("POST", "logs", [...nights, ...days])

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 1000 } }], ["phone", phone]]) {
  for (const dark of [false, true]) {
    const scheme = dark ? "dark" : "light", name = `${label} ${scheme}`
    const ctx = await browser.newContext({ ...opts, colorScheme: scheme })
    const page = watch(await ctx.newPage(), { label: name, console: true })
    await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent("Dashboards/Health.md")}`); await wait(2000)
    const stages = page.locator("[aria-label='Sleep stages']")
    check(`${name}: the night's stages over time`, await until(async () => (await stages.count()) === 1, 8000))
    await stages.scrollIntoViewIfNeeded()
    check(`${name}: the score, out of 100`, await page.getByText(/Score: duration \d+ of 50/).count() === 1)
    const shot = await stages.evaluate((e) => e.closest("section")?.getBoundingClientRect().toJSON())
    if (shot) await page.screenshot({ path: `${OUT}health-sleep-${label}-${scheme}.png`, clip: shot })
    const rings = page.getByText("Exercise", { exact: true }).first()
    await rings.scrollIntoViewIfNeeded()
    const box = await rings.evaluate((e) => e.closest("section")?.getBoundingClientRect().toJSON())
    check(`${name}: the rings and trends`, !!box && await page.getByText("Resting HR").count() === 1, box)
    if (box) await page.screenshot({ path: `${OUT}health-activity-${label}-${scheme}.png`, clip: box })
    await ctx.close()
  }
}
putBackWs()
await done()
