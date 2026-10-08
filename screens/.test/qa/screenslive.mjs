// Screen sharing's connections: kept across tabs, a phone turning and the layout changing; listed with their state in
// the Screens block and the sidebar's panel, which can disconnect them; a typed login kept for the page; the pointer
// shown at once; phones' trackpad, touch mode, pinch to zoom and key row; full screen. Serves a fake VNC server (a VNC
// password it takes whatever the answer, a plain picture, every pointer event logged) as this Mac's screen.
// Installs the plugin and writes its settings: throwaway server only.
//   node screens/.test/qa/screenslive.mjs <base url> <vault path> [out dir]
import { webkit } from "playwright-core"
import net from "node:net"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { install, qa, until, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = "/tmp/screenslive-shots/"], browser, check, errs, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })

// --- the fake VNC server: 1600x1000, a VNC password (any answer works), keys and pointer events logged. `opened` and
// `open` count VNC sessions (a client that answered the version), not the server's checks that the port answers.
const W = 1600, H = 1000
let opened = 0, open = 0
const pointer = [], keys = []
const server = net.createServer((c) => {
  let counted = false
  c.on("close", () => { if (counted) open-- })
  let buf = Buffer.alloc(0), stage = 0
  const pic = Buffer.alloc(W * H * 4, 0x40)
  c.write("RFB 003.008\n")
  c.on("data", (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (stage === 0) { if (buf.length < 12) return; buf = buf.subarray(12); counted = true; opened++; open++; c.write(Buffer.from([1, 2])); stage = 1; continue }
      if (stage === 1) { if (buf.length < 1) return; buf = buf.subarray(1); c.write(Buffer.alloc(16, 7)); stage = 2; continue }
      if (stage === 2) { if (buf.length < 16) return; buf = buf.subarray(16); c.write(Buffer.from([0, 0, 0, 0])); stage = 3; continue }
      if (stage === 3) {
        if (buf.length < 1) return
        buf = buf.subarray(1)
        const init = Buffer.alloc(24 + 8)
        init.writeUInt16BE(W, 0); init.writeUInt16BE(H, 2)
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]).copy(init, 4)
        init.writeUInt32BE(8, 20); init.write("Fake Mac", 24)
        c.write(init); stage = 4; continue
      }
      if (!buf.length) return
      const t = buf[0]
      const need = t === 0 ? 20 : t === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity) : t === 3 ? 10 : t === 4 ? 8 : t === 5 ? 6
        : t === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity) : 1
      if (buf.length < need) return
      const m = buf.subarray(0, need)
      buf = buf.subarray(need)
      if (t === 3 && !m[1]) {
        const head = Buffer.alloc(4 + 12)
        head.writeUInt16BE(1, 2); head.writeUInt16BE(W, 8); head.writeUInt16BE(H, 10)
        c.write(Buffer.concat([head, pic]))
      }
      if (t === 5) pointer.push({ mask: m[1], x: m.readUInt16BE(2), y: m.readUInt16BE(4) })
      if (t === 4) keys.push({ down: !!m[1], sym: m.readUInt32BE(4) })
    }
  })
  c.on("error", () => {})
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
install(B, "screens")
mkdirSync(path.join(VAULT, ".vaultite/plugins/screens"), { recursive: true })
writeFileSync(path.join(VAULT, ".vaultite/plugins/screens/data.json"), JSON.stringify({ localPort: server.address().port }))
await wait(6000) // the server's screen list is kept 5 s


// ===== desktop
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = watch(await ctx.newPage())
const go = (hash) => page.evaluate((h) => { location.hash = h }, hash)
const state = () => page.evaluate(() => document.querySelector("[data-screen-state]")?.getAttribute("data-screen-state") ?? null)
const canvas = (p = page) => p.evaluate(() => {
  const c = document.querySelector("[data-screen-canvas] canvas")
  if (!c) return null
  const r = c.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, cw: c.width, ch: c.height, cursor: c.style.cursor }
})

await page.goto(`${B}#view/screen%2Flocal`)
await page.waitForSelector("[data-screen-login]", { timeout: 10000 })
check("a VNC password is asked for", await page.locator('[data-screen-login] input[name="password"]').isVisible())
await page.fill('[data-screen-login] input[name="password"]', "secret")
await page.click('[data-screen-login] button[type="submit"]')
check("connected after the password", await until(async () => (await state()) === "connected", 8000), await state())
check("the pointer shows at once (an arrow until the screen sends its own)", /url\(/.test((await canvas())?.cursor ?? ""), (await canvas())?.cursor)
await page.screenshot({ path: `${OUT}connected.png` })
const first = opened

// Another page in the tab and back: the same connection, no login.
await go("#view/screens")
await page.waitForSelector("[data-screen-row]", { timeout: 8000 })
await wait(400)
check("away: still connected, in the background", open === 1 && opened === first, { open, opened })
const row = page.locator('[data-screens-block] [data-screen-row]').first()
check("Screens block: says it's connected, in the background", /Connected.*in the background/.test(await row.innerText()), await row.innerText())
check("Screens block: a Disconnect button", await row.locator('[aria-label^="Disconnect"]').isVisible())
await page.screenshot({ path: `${OUT}block.png` })
await go("#view/screen%2Flocal")
check("back: connected at once, no login", await until(async () => (await state()) === "connected", 3000) && !(await page.locator("[data-screen-login]").count()), await state())
check("back: the same connection", opened === first && open === 1, { open, opened })
const cv = await canvas()
check("back: the picture fits the pane", cv && cv.cw === W && cv.ch === H && cv.w > 600, cv)
pointer.length = 0
await page.mouse.click(cv.x + cv.w / 2, cv.y + cv.h / 2)
await wait(300)
const pc = pointer.find((p) => p.mask === 1)
check("back: a click lands where it was aimed", pc && Math.abs(pc.x - W / 2) < 6 && Math.abs(pc.y - H / 2) < 6, pc)

// The sidebar panel: shown (it's hidden by default), it says connected, and its x disconnects.
await page.evaluate(() => fetch("/api/config/sidebars", { method: "PATCH", headers: { "content-type": "application/json" },
  body: JSON.stringify({ left: ["screens:screens", "files:files"] }) }))
const srow = page.locator('[data-screens-panel] [data-screen-row]').first()
check("sidebar: the screen's row says connected", await until(async () => (await srow.count()) && /connected/.test(await srow.innerText()), 8000), (await srow.count()) && await srow.innerText())
await srow.hover()
await srow.locator('[aria-label^="Disconnect"]').click()
check("sidebar's x: the tab says it's disconnected", await until(async () => (await state()) === "off", 8000), await state())
check("sidebar's x: the connection is closed", await until(() => open === 0, 3000), { open })
check("sidebar: no longer connected", !/connected/.test(await srow.innerText()), await srow.innerText())
await page.screenshot({ path: `${OUT}disconnected.png` })

// Connect again: the password typed on this page is used, no form.
await page.click("[data-screen-connect]")
check("Connect: connected again without asking", await until(async () => (await state()) === "connected", 8000) && !(await page.locator("[data-screen-login]").count()), await state())
// The tab's own Disconnect.
await page.click('[data-screen] [aria-label="Disconnect"]')
check("the tab's Disconnect", await until(async () => (await state()) === "off", 8000) && await until(() => open === 0, 3000), { s: await state(), open })
await page.click("[data-screen-connect]")
await until(async () => (await state()) === "connected", 8000)

// Full screen: over the whole window, the same connection; Shift-Esc leaves.
const before = opened
await page.click('[data-screen] [aria-label="Full screen"]')
await wait(800)
const fb = await page.evaluate(() => { const el = document.querySelector("[data-screen-full]"); if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height } })
check("full screen: covers the window", fb && fb.w >= 1279 && fb.h >= 799, fb)
check("full screen: the same connection, still connected", opened === before && (await state()) === "connected", { opened, before })
await page.screenshot({ path: `${OUT}full.png` })
await page.keyboard.press("Shift+Escape")
await wait(500)
check("full screen: Shift-Esc leaves", !(await page.locator("[data-screen-full]").count()))
check("no page errors (desktop)", !errs.length, errs)
await ctx.close()
check("closing the page closes the connection", await until(() => open === 0, 3000), { open })

// ===== a phone
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
const pp = watch(await phone.newPage())
const cdp = await phone.newCDPSession(pp)
const touchAt = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
const pstate = () => pp.evaluate(() => document.querySelector("[data-screen-state]")?.getAttribute("data-screen-state") ?? null)
await pp.goto(`${B}#view/screen%2Flocal`)
await pp.waitForSelector("[data-screen-login]", { timeout: 10000 })
await pp.fill('[data-screen-login] input[name="password"]', "secret")
await pp.click('[data-screen-login] button[type="submit"]')
check("phone: connected", await until(async () => (await pstate()) === "connected", 8000), await pstate())
const phoneFirst = opened
await wait(500)
let pcv = await canvas(pp)
check("phone: the picture fits the width", pcv && pcv.x >= 0 && pcv.x + pcv.w <= 391, pcv)

// Trackpad (the default): a drag moves the pointer by about as much as the finger, scaled to the picture.
const mid = { x: pcv.x + pcv.w / 2, y: pcv.y + pcv.h / 2 }
pointer.length = 0
await touchAt("touchStart", [[mid.x, mid.y + 150]])
for (let i = 1; i <= 10; i++) { await touchAt("touchMove", [[mid.x + i * 4, mid.y + 150]]); await wait(16) }
await touchAt("touchEnd", [])
await wait(300)
const moved = pointer.at(-1)
check("trackpad: a drag moves the pointer right, no button", moved && moved.x > W / 2 + 40 && Math.abs(moved.y - H / 2) < 4 && pointer.every((p) => p.mask === 0), pointer.slice(-3))
check("trackpad: the screen's pointer is drawn", await pp.evaluate(() => [...document.querySelectorAll("body > canvas")].some((c) => c.style.visibility !== "hidden" && c.width > 0)))
pointer.length = 0
await touchAt("touchStart", [[mid.x - 100, mid.y + 100]])
await touchAt("touchEnd", [])
await wait(300)
const tap = pointer.find((p) => p.mask === 1)
check("trackpad: a tap clicks where the pointer is (not under the finger)", tap && Math.abs(tap.x - moved.x) < 2 && Math.abs(tap.y - moved.y) < 2, { tap, moved })
pointer.length = 0
await touchAt("touchStart", [[mid.x - 30, mid.y], [mid.x + 30, mid.y]])
await touchAt("touchEnd", [])
await wait(300)
check("trackpad: two fingers tapping right-click", pointer.some((p) => p.mask === 4), pointer)
// Two fingers moving up together: scroll down (wheel button 5).
pointer.length = 0
await touchAt("touchStart", [[mid.x - 30, mid.y + 100], [mid.x + 30, mid.y + 100]])
for (let i = 1; i <= 8; i++) { await touchAt("touchMove", [[mid.x - 30, mid.y + 100 - i * 12], [mid.x + 30, mid.y + 100 - i * 12]]); await wait(16) }
await touchAt("touchEnd", [])
await wait(300)
check("two fingers up: scroll down", pointer.filter((p) => p.mask === 0x10).length >= 3 && !pointer.some((p) => p.mask === 0x8), pointer.map((p) => p.mask))
// Pinch out: zoom in (fewer of the picture's pixels shown, bigger), and Fit goes back.
await touchAt("touchStart", [[mid.x - 20, mid.y], [mid.x + 20, mid.y]])
for (let i = 1; i <= 10; i++) { await touchAt("touchMove", [[mid.x - 20 - i * 12, mid.y], [mid.x + 20 + i * 12, mid.y]]); await wait(16) }
await touchAt("touchEnd", [])
await wait(400)
pcv = await canvas(pp)
check("pinch: zoomed in", pcv && pcv.cw < W * 0.6, pcv)
await pp.screenshot({ path: `${OUT}phone-zoomed.png` })
await pp.click('[aria-label="Fit to the pane"]')
await wait(300)
pcv = await canvas(pp)
check("Fit: the whole picture again", pcv && pcv.cw === W, pcv)

// Touch mode (the ... menu): a tap clicks under the finger.
await pp.click('[aria-label="Screen options"]')
await pp.click("text=Touch: tap where you click")
await wait(300)
pcv = await canvas(pp)
pointer.length = 0
await touchAt("touchStart", [[pcv.x + pcv.w / 4, pcv.y + pcv.h / 4]])
await touchAt("touchEnd", [])
await wait(300)
const tt = pointer.find((p) => p.mask === 1)
check("touch mode: a tap clicks under the finger", tt && Math.abs(tt.x - W / 4) < 12 && Math.abs(tt.y - H / 4) < 12, tt)
check("touch mode: kept for this device", await pp.evaluate(() => JSON.stringify(localStorage)).then((s) => s.includes("touch")))

// The keyboard: a key row with the modifiers; cmd + c sends Alt (a Mac's Command) around the c.
await pp.click('[aria-label="Keyboard"]')
await wait(300)
check("keyboard: the key row shows", await pp.locator("[data-screen-keys]").isVisible())
await pp.screenshot({ path: `${OUT}phone-keys.png` })
keys.length = 0
await pp.locator("[data-screen-keys] button", { hasText: "cmd" }).click()
await pp.keyboard.insertText("c")
await wait(300)
check("keyboard: cmd then c sends Command-C", JSON.stringify(keys.map((k) => [k.down, k.sym])) === JSON.stringify([[true, 0xffe9], [true, 0x63], [false, 0x63], [false, 0xffe9]]), keys)
await pp.locator("[data-screen-keys] button", { hasText: "esc" }).click()
await wait(200)
check("keyboard: esc", keys.some((k) => k.sym === 0xff1b))

// Turning the phone (and so the layout, phone to desktop): the same connection, the picture refitted.
await pp.setViewportSize({ width: 844, height: 390 })
await wait(1200)
check("turned: still connected, the same connection", (await pstate()) === "connected" && opened === phoneFirst && open === 1, { s: await pstate(), opened, phoneFirst, open })
pcv = await canvas(pp)
check("turned: the picture fits the new pane", pcv && pcv.h <= 390 && pcv.w > 300, pcv)
await pp.screenshot({ path: `${OUT}phone-turned.png` })
await pp.setViewportSize({ width: 390, height: 844 })
await wait(1200)
check("turned back: the same connection", (await pstate()) === "connected" && opened === phoneFirst, { opened, phoneFirst })
// Full screen on a phone: the screen over the app.
await pp.click('[aria-label="Full screen"]')
await wait(500)
const pf = await pp.evaluate(() => { const el = document.querySelector("[data-screen-full]"); if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height } })
check("phone full screen: over the whole window", pf && pf.w >= 389 && pf.h >= 843, pf)
await pp.screenshot({ path: `${OUT}phone-full.png` })
await pp.click('[aria-label="Leave full screen"]')
await phone.close()
await browser.close()

// ===== Safari's engine on a phone (iPhones run it in every browser): it connects, draws, taps reach the screen.
let wk = null
try { wk = await webkit.launch() } catch { console.log("skip WebKit: not installed") }
if (wk) {
  const wctx = await wk.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const wp = watch(await wctx.newPage(), { label: "WebKit" })
  await wp.goto(`${B}#view/screen%2Flocal`)
  await wp.waitForSelector("[data-screen-login]", { timeout: 30000 }).catch(async (e) => { await wp.screenshot({ path: `${OUT}webkit-timeout.png` }); throw e })
  await wp.fill('[data-screen-login] input[name="password"]', "secret")
  await wp.click('[data-screen-login] button[type="submit"]')
  const ws = () => wp.evaluate(() => document.querySelector("[data-screen-state]")?.getAttribute("data-screen-state") ?? null)
  check("WebKit phone: connected", await until(async () => (await ws()) === "connected", 8000), await ws())
  await wait(500)
  const wc = await canvas(wp)
  check("WebKit phone: the picture fits the width", wc && wc.cw === W && wc.x >= 0 && wc.x + wc.w <= 391, wc)
  pointer.length = 0
  await wp.touchscreen.tap(wc.x + wc.w / 2, wc.y + wc.h / 2)
  await wait(400)
  check("WebKit phone: a tap clicks", pointer.some((p) => p.mask === 1), pointer)
  await wp.click('[aria-label="Full screen"]')
  await wait(400)
  const wf = await wp.evaluate(() => { const el = document.querySelector("[data-screen-full]"); if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height } })
  check("WebKit phone: full screen covers the window", wf && wf.w >= 389 && wf.h >= 843, wf)
  await wp.screenshot({ path: `${OUT}webkit-full.png` })
  await wk.close()
}
server.close()
await done()
