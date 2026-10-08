// Admonitions in a real browser: ```ad-<type> fences drawn as the app's callouts beside a real one (the same look),
// a title, an icon: of its own, foldable ones; in reading and editing, desktop and a 390px phone, light and dark, with
// screenshots. Installs the plugin; WRITES a note (Notes/Admonitions qa.md): a throwaway server only.
//   node admonition/.test/qa/admonition.mjs <base url> <vault path> [out dir]
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { install, qa, SHOTS, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })
const NOTE = "Notes/Admonitions qa.md"
writeFileSync(`${VAULT}/${NOTE}`, `# Admonitions qa

\`\`\`ad-tip
title: Pack light
icon: luggage

Bring **one** bag and a [[Lisbon trip|plan]].
\`\`\`

> [!tip] A real callout
> The same look.

\`\`\`ad-warning
collapse: closed
title: Folded
Hidden until opened.
\`\`\`

\`\`\`ad-faq
Why? Because.
\`\`\`
`)
const putBackWs = setAsideWorkspaces(VAULT)
install(B, "admonition")

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 860 } }], ["phone", phone]]) {
  for (const dark of [false, true]) {
    const scheme = dark ? "dark" : "light", name = `${label} ${scheme}`
    const ctx = await browser.newContext({ ...opts, colorScheme: scheme })
    const page = watch(await ctx.newPage(), { label: name, console: true })
    await page.goto("about:blank"); await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`); await wait(2000)
    const pane = page.locator("body")
    const tip = pane.locator(".callout[data-callout=tip]")
    check(`${name}: the fence drawn as a callout beside the real one`, await until(async () => (await tip.count()) === 2, 6000), await tip.count())
    const [a, b] = [tip.nth(0), tip.nth(1)]
    const look = (l) => l.evaluate((e) => { const s = getComputedStyle(e); return [s.backgroundColor, s.borderLeftColor, s.borderRadius, s.paddingLeft].join() })
    check(`${name}: the same look`, (await look(a)) === (await look(b)), [await look(a), await look(b)])
    check(`${name}: its title and its own icon`, (await a.locator(".callout-title-text").innerText()) === "Pack light"
      && await a.locator(".callout-icon svg.lucide-luggage").count() === 1)
    check(`${name}: its link drawn`, await a.locator("[data-wiki]").count() === 1)
    const folded = pane.locator("details.callout[data-callout=warning]")
    check(`${name}: collapse: closed is folded`, await folded.count() === 1 && !(await folded.evaluate((e) => e.open)))
    check(`${name}: an alias's type (faq: question)`, await pane.locator(".callout[data-callout=question]").count() === 1)
    await page.screenshot({ path: `${OUT}admonition-${label}-${scheme}.png` })
    if (!dark && label === "desktop") {
      await folded.locator("summary").click(); await wait(300)
      check("desktop: a folded one opens", await folded.evaluate((e) => e.open))
      // Reading view too.
      await page.keyboard.press("Meta+e"); await wait(800)
      check("desktop: in reading view too", await until(async () => (await pane.locator(".callout[data-callout=tip]").count()) === 2, 4000))
      await page.screenshot({ path: `${OUT}admonition-desktop-reading.png` })
    }
    await ctx.close()
  }
}
rmSync(`${VAULT}/${NOTE}`, { force: true })
putBackWs()
await done()
