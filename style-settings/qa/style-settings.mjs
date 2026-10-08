// Style settings in a browser: the sheet draws the app's knobs and each snippet's @settings, a change applies live and
// lands in data.json, data.json written from outside applies too, light and dark, desktop and 390px, turned off it
// leaves nothing behind. WRITES the vault's snippets, themes, appearance.json and the plugin's data.json (put back):
// throwaway server only, with the plugin installed and on.
//   node style-settings/qa/style-settings.mjs <base url> <vault path> [out dir]   (VAULTITE_APP: the app's checkout)
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP = process.env.VAULTITE_APP ?? path.resolve(fileURLToPath(import.meta.url), "../../../../vaultite")
const { qa, until, wait } = await import(path.join(APP, "web/qa/lib/qa.mjs"))
const [B0, VAULT, OUT = "/tmp/style-settings-shots/"] = process.argv.slice(2)
if (!B0 || !VAULT) { console.error("usage: node style-settings/qa/style-settings.mjs <base url> <vault path> [out dir]"); process.exit(2) }
const B = B0.endsWith("/") ? B0 : `${B0}/`
const { browser, check, watch, noErrors, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url))
const file = (rel) => `${VAULT}/${rel}`
const DATA = ".vaultite/plugins/style-settings/data.json"
const data = () => { try { return JSON.parse(readFileSync(file(DATA), "utf8")) } catch { return {} } }
const keep = (rel) => { const was = existsSync(file(rel)) ? readFileSync(file(rel), "utf8") : null; return () => { if (was === null) rmSync(file(rel), { force: true }); else writeFileSync(file(rel), was) } }
const restore = [keep(".vaultite/appearance.json"), keep(DATA)]
const api = async (method, p, body) => (await fetch(`${B}api/${p}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json()
const look = (v) => api("PATCH", "config/appearance", v)
const NOTE = "QA/Style settings.md"
const enc = encodeURIComponent

// The fixtures: two snippets (one on), an Obsidian theme with settings of its own, and a note to look at.
mkdirSync(file(".vaultite/snippets"), { recursive: true })
for (const n of ["Heading accents", "Wide tables"]) copyFileSync(`${FIX}${n}.css`, file(`.vaultite/snippets/${n}.css`))
cpSync(`${FIX}Harbor`, file(".vaultite/themes/Harbor"), { recursive: true })
mkdirSync(file("QA"), { recursive: true })
writeFileSync(file(NOTE), "# A first heading\n\nSome text under it, long enough to show how wide a line runs in the pane when the width changes. ".repeat(1) +
  "It goes on a little more, so the line wraps at the note's width.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n")
rmSync(file(DATA), { force: true })
await look({ snippets: ["Heading accents"], theme: "light", scheme: null })
await wait(1200)

async function open(w, h, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) })
  return { ctx, page: watch(await ctx.newPage(), { label: `${w}px`, console: true }) }
}
const shot = async (page, name) => { await wait(500); await page.screenshot({ path: `${OUT}${name}.png` }) }
async function go(page, h) {
  await page.goto("about:blank")
  await page.goto(`${B}#${h}`)
  await until(() => page.locator("main").count(), 5000)
  await wait(1800)
}
const sheet = (page) => page.locator("dialog[open] [data-style-settings]")
const h1 = (page) => page.evaluate(() => {
  const el = document.querySelector("[data-pane] .cm-h1, [data-pane] .note-prose .h1")
  if (!el) return null
  const cs = getComputedStyle(el)
  return { color: cs.color, family: cs.fontFamily, weight: cs.fontWeight, decoration: cs.textDecorationLine }
})
/** A computed rgb() within 2 of each channel (hsl-split rounds to whole degrees and percents). */
const near = (rgb, want) => { const got = (rgb ?? "").match(/\d+/g)?.map(Number) ?? []; return want.every((w, i) => Math.abs((got[i] ?? -9) - w) <= 2) }
const rootVar = (page, v) => page.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), v)
const bodyHas = (page, c) => page.evaluate((c) => document.body.classList.contains(c), c)
/** A native control changed as a person would: its value set, then input and change. */
const setInput = (page, sel, value) => page.locator(sel).first().evaluate((el, value) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
  set.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
}, value)
const row = (page, key) => page.locator(`dialog[open] [data-setting="${key}"]`)
const noSideScroll = (page) => page.evaluate(() => {
  const d = document.querySelector("dialog[open]")
  const wide = [d, ...d.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX))
  return wide.map((e) => `${e.tagName}.${e.className}`.slice(0, 120))
})

try {
  // ---------- desktop, light
  {
    const { ctx, page } = await open(1440, 900)
    await go(page, `file/${enc(NOTE)}`)
    check("the note's first heading is drawn", !!(await until(() => h1(page), 5000)))
    check("on: <body> has css-settings-manager and the defaults' classes", await bodyHas(page, "css-settings-manager") && await bodyHas(page, "ha-underline"))
    check("a themed colour's light default applies (hsl-split)", near((await h1(page))?.color, [184, 51, 106]), await h1(page))
    check("defaults aren't written to data.json", Object.keys(data()).length === 0, data())

    await go(page, `file/${enc(NOTE)}/plugin-settings/style-settings`)
    check("the sheet opens with the form", !!(await until(() => sheet(page).count(), 5000)))
    const sections = await page.locator("dialog[open] [data-style-section]").evaluateAll((els) => els.map((e) => e.dataset.styleSection))
    check("sections: the app's, then the snippet that's on", JSON.stringify(sections) === JSON.stringify(["vaultite", "heading-accents"]), sections)
    const text = await sheet(page).innerText()
    check("the snippet that's off is listed to turn on", text.includes("Snippets that are off") && text.includes("Wide tables"), text.slice(-300))
    check("info-text is drawn as Markdown", await page.locator("dialog[open] [data-style-section=heading-accents] strong", { hasText: "first headings" }).count() === 1)
    check("a collapsed heading starts folded", !(await row(page, "heading-accents@@ha-gap").count()))
    await shot(page, "1-desktop-light-sheet")

    // The accent: a colour well, applied to the app's own token at once and saved.
    await setInput(page, '[data-setting="vaultite@@primary"] input[type=color]', "#d33682")
    check("accent: --primary follows at once", await until(async () => (await rootVar(page, "--primary")) === "#d33682", 2000), await rootVar(page, "--primary"))
    check("accent: --ring too (alt-format)", (await rootVar(page, "--ring")) === "#d33682")
    check("accent: saved in data.json", await until(() => data()["vaultite@@primary"] === "#d33682", 3000), data())

    // Line width: the slider sets --line-width, which the note's column follows.
    await setInput(page, '[data-setting="vaultite@@line-width"] input[type=range]', "900")
    const width = () => page.evaluate(() => getComputedStyle(document.querySelector("[data-pane] article.file-view")).maxWidth)
    check("line width: the note's column is 900px", await until(async () => (await width()) === "900px", 2000), await width())
    check("line width: saved after the drag", await until(() => data()["vaultite@@line-width"] === 900, 3000), data())

    // The folded heading opens.
    await page.locator("dialog[open] [data-setting='heading-accents@@ha-shape'] button[aria-expanded]").first().click()
    check("a folded heading unfolds its rows", await until(() => row(page, "heading-accents@@ha-gap").count(), 2000))
    // A class toggle (the app's own switch) and a class select (segmented).
    await row(page, "heading-accents@@ha-underline").getByRole("switch").click()
    check("class toggle off: the class leaves <body>", await until(async () => !(await bodyHas(page, "ha-underline")), 2000))
    check("class toggle: false kept (its default is true)", await until(() => data()["heading-accents@@ha-underline"] === false, 3000), data())
    await row(page, "heading-accents@@ha-weight").getByRole("radio", { name: "Heavy" }).click()
    check("class select: its class on <body>", await until(() => bodyHas(page, "ha-weight-heavy"), 2000))
    check("class select: the heading is heavy", (await h1(page))?.weight === "850", await h1(page))

    // A number field with its unit.
    const gap = row(page, "heading-accents@@ha-gap").locator("input")
    await gap.fill("20"); await gap.press("Enter")
    check("number: --ha-gap is 20px", await until(async () => (await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ha-gap").trim())) === "20px", 2000))
    await shot(page, "2-desktop-light-changed")

    // Written from outside (an agent): the page follows.
    writeFileSync(file(DATA), JSON.stringify({ ...data(), "heading-accents@@ha-font": "Georgia, serif" }, null, 2))
    check("data.json changed on disk: the heading's font follows", await until(async () => (await h1(page))?.family.includes("Georgia"), 5000), await h1(page))
    const op = await api("POST", "ops/style-settings.set", { key: "heading-accents@@ha-h1-color@@light", value: "#2f6f3e" })
    check("the op sets a themed colour", op.value === "#2f6f3e", op)
    check("...and the page follows", await until(async () => near((await h1(page))?.color, [47, 111, 62]), 5000), await h1(page))
    const bad = await api("POST", "ops/style-settings.set", { key: "heading-accents@@ha-weight", value: "bold" })
    check("the op refuses a value the setting doesn't take", typeof bad.error === "string" && bad.error.includes("ha-weight-heavy"), bad)

    // Turning a snippet on from the sheet brings its section.
    await page.locator("dialog[open] section[aria-label='Snippets that are off']").getByRole("switch").click()
    check("an off snippet turned on: its section appears", await until(() => page.locator("dialog[open] [data-style-section=wide-tables]").count(), 5000))

    // Dark: the themed colour's dark value.
    await look({ theme: "dark" })
    check("dark: the themed colour's dark default", await until(async () => near((await h1(page))?.color, [245, 163, 199]), 5000), await h1(page))
    await shot(page, "3-desktop-dark-sheet")

    // An Obsidian theme in use: its own settings are named, not drawn.
    await look({ scheme: "theme:Harbor" })
    check("an Obsidian theme's settings: said not to apply", await until(() => page.locator("dialog[open] [data-style-theme]").count(), 5000))
    await page.locator("dialog[open] [data-style-theme]").scrollIntoViewIfNeeded()
    await shot(page, "4-desktop-dark-theme-note")
    await look({ scheme: null, theme: "light" })

    // Restore defaults for a section.
    await page.locator("dialog[open] [data-style-section=heading-accents]").getByRole("button", { name: "Restore defaults" }).click()
    check("restore defaults: the section's keys leave data.json", await until(() => !Object.keys(data()).some((k) => k.startsWith("heading-accents@@")), 3000), data())
    check("...and the defaults apply again", await until(() => bodyHas(page, "ha-underline"), 2000))

    // Off: nothing of it stays on the page; on again, it's back.
    await api("POST", "ops/plugin.disable", { id: "style-settings" })
    check("off: its stylesheet and classes are gone", await until(async () => !(await page.evaluate(() => !!document.getElementById("style-settings") || document.body.classList.contains("css-settings-manager"))), 5000))
    check("off: the accent is the scheme's again", (await rootVar(page, "--primary")) !== "#d33682")
    await api("POST", "ops/plugin.enable", { id: "style-settings" })
    check("on again: the accent comes back", await until(async () => (await rootVar(page, "--primary")) === "#d33682", 8000), await rootVar(page, "--primary"))
    await ctx.close()
  }

  // ---------- phone, light and dark
  for (const theme of ["light", "dark"]) {
    await look({ theme })
    const { ctx, page } = await open(390, 844, true)
    await go(page, `file/${enc(NOTE)}/plugin-settings/style-settings`)
    check(`phone ${theme}: the sheet opens`, !!(await until(() => sheet(page).count(), 5000)))
    const wide = await noSideScroll(page)
    check(`phone ${theme}: nothing scrolls sideways`, !wide.length, wide)
    const small = await page.locator("dialog[open] [data-style-settings] input[type=color]").evaluateAll((els) => els.filter((e) => e.closest("label").getBoundingClientRect().width < 32).length)
    check(`phone ${theme}: colour wells are 32px or more`, small === 0, small)
    await shot(page, `5-phone-${theme}-sheet`)
    await page.locator("dialog[open] [data-style-section=heading-accents]").scrollIntoViewIfNeeded()
    await page.locator("dialog[open] [data-setting='heading-accents@@ha-shape'] button[aria-expanded]").first().click()
    await page.locator("dialog[open] [data-setting='heading-accents@@ha-font']").scrollIntoViewIfNeeded()
    await shot(page, `6-phone-${theme}-sheet-lower`)
    await ctx.close()
  }
  noErrors()
} finally {
  await look({ theme: "light" }).catch(() => {})
  for (const r of restore) r()
  rmSync(file(NOTE), { force: true })
}
await done()
