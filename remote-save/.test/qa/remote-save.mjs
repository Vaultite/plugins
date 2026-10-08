// Remote save in a real browser, against a fake S3 bucket in this process: add a remote in its sheet (Test connection
// right and wrong, the keys never in the vault), sync from the sheet and from the block, the settings sheet's list, the
// status bar; then a 390px phone (the block, the sheet: no sideways scroll, 16px fields) and dark. Installs the plugin;
// WRITES a remote, "Qa remote save.md" and the workspaces' data.json (put back): throwaway server only.
//   node remote-save/.test/qa/remote-save.mjs <base url> <vault path> [out dir]
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { apiAt, command, install, SHOTS, qa, setAsideWorkspaces, until, wait } from "../../../qa.mjs"
const { fakeS3 } = await import("../fakes.ts")
const { args: [B, VAULT, OUT = SHOTS], browser, check, watch, done } = await qa(import.meta.url)

const api = apiAt(B, { "X-Vaultite-Client": "app/qa" })
const KEY = "AKIDQAEXAMPLE", SECRET = "qa-secret-not-real-0123456789"
const s3 = await fakeS3("qa-vault", { [KEY]: SECRET })
const NOTE = "Qa remote save.md"
const putBackWs = setAsideWorkspaces(VAULT)
install(B, "remote-save")
for (const r of (await api("GET", "remote-save")).remotes) await api("DELETE", `remote-save/remotes/${r.id}`)
await api("DELETE", `file?path=${encodeURIComponent(NOTE)}`)
await api("POST", "file", { path: NOTE, text: "# Qa remote save\n\n```block-remote-save\n```\n" })

const sheet = (id) => `[data-remote-sheet="${id}"]`
const fill = async (page, key, value) => { const f = page.locator(`[data-setting="${key}"] input`); await f.fill(value) }

try {
  // ---------- desktop
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
  const page = watch(await ctx.newPage(), { console: true })
  await page.goto(`${B}#file/${encodeURIComponent(NOTE)}`)
  await page.waitForSelector("[data-remote-save-block], [data-pane] section", { timeout: 15000 })
  await wait(800)
  check("the block with no remote offers to add one", (await page.locator("section", { hasText: "No remotes yet" }).count()) > 0)
  check("Add a remote is a command", await command(page, "Add a remote", 600))
  await page.waitForSelector(sheet("new"))
  await fill(page, "name", "Qa bucket")
  await fill(page, "endpoint", s3.url)
  await fill(page, "region", "auto")
  await fill(page, "bucket", "qa-vault")
  await fill(page, "prefix", "Vault/")
  await fill(page, "accessKeyId", KEY)
  await fill(page, "secret", "wrong-secret")
  check("the secret is a password field", (await page.locator('[data-setting="secret"] input').getAttribute("type")) === "password")
  await page.click("[data-remote-test-button]")
  await page.waitForSelector("[data-remote-test]")
  const bad = await page.locator("[data-remote-test]").innerText()
  check("Test connection with a wrong key says so", (await page.locator("[data-remote-test=failed]").count()) === 1 && /refused the keys/.test(bad), bad)
  await page.screenshot({ path: `${OUT}remote-save-test-failed.png` })
  await fill(page, "secret", SECRET)
  await page.click("[data-remote-test-button]")
  await page.waitForSelector("[data-remote-test=ok]")
  check("Test connection with the right key works", /Writing works/.test(await page.locator("[data-remote-test]").innerText()))
  await page.screenshot({ path: `${OUT}remote-save-add.png` })
  await page.click("[data-remote-save-button]")
  await page.waitForSelector(sheet("qa-bucket"), { timeout: 8000 }).catch(async (e) => { await page.screenshot({ path: `${OUT}remote-save-debug.png` }); throw e })
  const data = readFileSync(path.join(VAULT, ".vaultite/plugins/remote-save/data.json"), "utf8")
  check("added: the vault has the remote, not its keys or address", data.includes("Qa bucket") && !data.includes(SECRET) && !data.includes(KEY) && !data.includes(s3.url), data)
  check("added: the secret field says it's saved, without showing it", (await page.locator('[data-setting="secret"] input').getAttribute("placeholder")) === "Saved on this machine" &&
    (await page.locator('[data-setting="secret"] input').inputValue()) === "")
  await page.click("[data-remote-sync-row]")
  await until(async () => /Synced/.test(await page.locator(`${sheet("qa-bucket")} [data-remote-sync-row]`).innerText()), 15000)
  check("Sync now from the sheet: the files went up", [...s3.objects.keys()].some((k) => k === `Vault/${NOTE}`), [...s3.objects.keys()].length)
  await wait(400)
  await page.screenshot({ path: `${OUT}remote-save-sheet.png` })
  await page.keyboard.press("Escape")
  await wait(500)

  // The settings sheet lists it.
  check("its settings are a command", await command(page, "Open Remote save settings", 800))
  await page.waitForSelector("[data-remote-save-settings]")
  check("the settings sheet lists the remote and Add a remote", (await page.locator('[data-remote-setting="qa-bucket"]').count()) === 1 && (await page.locator("[data-remote-add]").count()) === 1)
  check("the settings sheet says where the keys are", (await page.locator("[data-remote-save-settings]").innerText()).includes("never in the vault"))
  await page.screenshot({ path: `${OUT}remote-save-settings.png` })
  await page.keyboard.press("Escape")
  await wait(500)

  // The block: a file from elsewhere, then Sync now from it.
  s3.objects.set("Vault/From the phone.md", { body: Buffer.from("# From the phone\n"), etag: '"qa-phone"' })
  await page.click('[data-remote-sync="qa-bucket"]')
  await until(async () => /1 down/.test(await page.locator('[data-remote-row="qa-bucket"] [data-remote-status]').innerText()), 15000)
  check("Sync now from the block: a file from elsewhere is in the vault", readFileSync(path.join(VAULT, "From the phone.md"), "utf8").includes("From the phone"))
  await page.screenshot({ path: `${OUT}remote-save-block.png` })
  const ambient = await page.locator("[data-tip^='Remote save']").count()
  check("the status bar has its item", ambient === 1, ambient)
  await ctx.close()

  // ---------- phone, then dark
  for (const dark of [false, true]) {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light" })
    const p = watch(await phone.newPage(), { console: true })
    await p.goto(`${B}#file/${encodeURIComponent(NOTE)}`)
    await p.waitForSelector('[data-remote-row="qa-bucket"]', { timeout: 15000 })
    await wait(600)
    const tag = dark ? "dark" : "phone"
    await p.screenshot({ path: `${OUT}remote-save-${tag}-block.png` })
    const tap = await p.locator('[data-remote-row="qa-bucket"] [data-remote-sync]').boundingBox()
    check(`${tag}: Sync now in the block is a 44px target`, tap && tap.width >= 44 && tap.height >= 44, tap)
    await p.locator('[data-remote-row="qa-bucket"] button').first().tap()
    await p.waitForSelector(sheet("qa-bucket"))
    await wait(700)
    const wide = await p.evaluate(() => [...document.querySelectorAll("[data-remote-sheet] *")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.tagName))
    check(`${tag}: the sheet fits the width`, !wide.length, wide.slice(0, 5))
    const small = await p.evaluate(() => [...document.querySelectorAll("[data-remote-sheet] input")].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length)
    check(`${tag}: fields are 16px (no zoom on focus)`, small === 0, small)
    await p.screenshot({ path: `${OUT}remote-save-${tag}-sheet.png` })
    await p.evaluate(() => {
      let e = document.querySelector("[data-remote-sheet]")
      while (e && !(e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement
      if (e) e.scrollTop = e.scrollHeight
    })
    await wait(400)
    await p.screenshot({ path: `${OUT}remote-save-${tag}-sheet-end.png` })
    await phone.close()
  }
} finally {
  for (const r of (await api("GET", "remote-save")).remotes) await api("DELETE", `remote-save/remotes/${r.id}`)
  await api("DELETE", `file?path=${encodeURIComponent(NOTE)}`)
  await api("DELETE", `file?path=${encodeURIComponent("From the phone.md")}`)
  rmSync(path.join(VAULT, ".trash", NOTE), { force: true })
  putBackWs()
  await s3.close()
}
await done()
