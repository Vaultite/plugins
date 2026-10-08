// Screen sharing: a screen in a tab. Serves a fake VNC server (security None, a picture of this Mac's windows drawn as
// boxes, logging clicks) as this Mac's screen (the vault's screens settings: localPort), opens the whole screen and
// checks it's drawn and that a click lands where it was aimed, then app mode (one app's window: the frontmost one on
// screen) and that a click there lands inside that window; with Vim on, that keys that type (f, j, Space) go to the
// screen and not to Vim, while ⌘P still opens the palette; then who may open a screen (like the terminal's: proxies,
// other logins and other sites are refused). Installs Screen sharing and Vim, writes the screens settings and
// plugins.json's `enabled`: throwaway server only (on a Mac).
//   node screens/.test/qa/screens.mjs <base url> <vault path> [out dir]
import { execFileSync } from "node:child_process"
import http from "node:http"
import net from "node:net"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { install, qa, wait } from "../../../qa.mjs"
const { args: [B, VAULT, OUT = "/tmp/screens-shots/"], browser, check, watch, done } = await qa(import.meta.url)
mkdirSync(OUT, { recursive: true })

// What's on this Mac's screen (the plugin's own script), in points: the fake picture is 2 pixels a point.
const onScreen = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", path.resolve(import.meta.dirname, "../../windows.js")], { encoding: "utf8" }))
const W = Math.round(onScreen.screens[0].w * 2), H = Math.round(onScreen.screens[0].h * 2)
const front = onScreen.windows.find((w) => w.w > 300 && w.h > 200)

// --- the fake VNC server
const clicks = [], keys = []
const server = net.createServer((c) => {
  let buf = Buffer.alloc(0), stage = 0
  const pic = Buffer.alloc(W * H * 4, 0x30)
  for (const w of [...onScreen.windows].reverse()) {
    const x0 = Math.max(0, Math.round(w.x * 2)), y0 = Math.max(0, Math.round(w.y * 2))
    const x1 = Math.min(W, Math.round((w.x + w.w) * 2)), y1 = Math.min(H, Math.round((w.y + w.h) * 2))
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pic.writeUInt32LE(w === front ? 0x00c83c3c : 0x00c85a3c, (y * W + x) * 4)
  }
  c.write("RFB 003.008\n")
  c.on("data", (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (stage === 0) { if (buf.length < 12) return; buf = buf.subarray(12); c.write(Buffer.from([1, 1])); stage = 1; continue }
      if (stage === 1) { if (buf.length < 1) return; buf = buf.subarray(1); c.write(Buffer.from([0, 0, 0, 0])); stage = 2; continue }
      if (stage === 2) {
        if (buf.length < 1) return
        buf = buf.subarray(1)
        const init = Buffer.alloc(24 + 8)
        init.writeUInt16BE(W, 0); init.writeUInt16BE(H, 2)
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]).copy(init, 4)
        init.writeUInt32BE(8, 20); init.write("Fake Mac", 24)
        c.write(init); stage = 3; continue
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
      if (t === 5 && m[1]) clicks.push({ x: m.readUInt16BE(2), y: m.readUInt16BE(4) })
      if (t === 4 && m[1]) keys.push(m.readUInt32BE(4))
    }
  })
  c.on("error", () => {})
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port
// Screen sharing installed and on from this repository (and the app's Vim, turned on below).
install(B, "screens")
await fetch(new URL("api/config/plugins", B), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: ["screens"] }) })
mkdirSync(path.join(VAULT, ".vaultite/plugins/screens"), { recursive: true })
writeFileSync(path.join(VAULT, ".vaultite/plugins/screens/data.json"), JSON.stringify({ localPort: port }))
await wait(300)

const list = await (await fetch(new URL("api/screens", B))).json()
check("GET /api/screens: this Mac's screen, answering", list[0]?.id === "local" && list[0].online && list[0].port === port, list)

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = watch(await ctx.newPage())

/** The canvas noVNC draws in, its box on the page and the picture's size in it. */
const canvas = () => page.evaluate(() => {
  const c = document.querySelector("[data-screen-canvas] canvas")
  if (!c) return null
  const r = c.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, cw: c.width, ch: c.height }
})

await page.goto(`${B}#view/screen%2Flocal`)
await page.waitForSelector("[data-screen-canvas] canvas", { timeout: 10000 })
await wait(1500)
let cv = await canvas()
check("whole screen: the picture is all of it, fitted to the pane", cv && cv.cw === W && cv.ch === H && Math.abs(cv.w / cv.h - W / H) < 0.01, cv)
await page.screenshot({ path: `${OUT}whole.png` })
// A click at a quarter of the picture lands at a quarter of the screen.
clicks.length = 0
await page.mouse.click(cv.x + cv.w / 4, cv.y + cv.h / 4)
await wait(400)
const c1 = clicks[0]
check("whole screen: a click lands where it was aimed", c1 && Math.abs(c1.x - W / 4) < 6 && Math.abs(c1.y - H / 4) < 6, { c1, want: [W / 4, H / 4] })

if (front) {
  // App mode: the tab's menu lists the running apps; the frontmost window's app shows alone.
  await page.goto(`${B}#view/screen%2Flocal%2F${encodeURIComponent(front.app)}`)
  await page.waitForSelector("[data-screen-canvas] canvas", { timeout: 10000 })
  const ww = Math.round(Math.min(W - front.x * 2, front.w * 2)), wh = Math.round(Math.min(H - front.y * 2, front.h * 2))
  // Bringing the app to the front changes the window list, and the cut-out follows it: wait for it to settle on the
  // window rather than measuring at a fixed moment.
  for (let t = Date.now(); Date.now() - t < 10000; await wait(250)) {
    cv = await canvas()
    if (cv && Math.abs(cv.cw - ww) <= 2 && Math.abs(cv.ch - wh) <= 2) break
  }
  check(`app mode: only ${front.app}'s window is drawn`, cv && Math.abs(cv.cw - ww) <= 2 && Math.abs(cv.ch - wh) <= 2, { cv, want: [ww, wh] })
  check("app mode: the tab is titled with the app", await page.locator(`text=${front.app}`).first().isVisible())
  await page.screenshot({ path: `${OUT}app.png` })
  clicks.length = 0
  await page.mouse.click(cv.x + cv.w / 2, cv.y + cv.h / 2)
  await wait(400)
  const c2 = clicks[0], want = { x: front.x * 2 + ww / 2, y: front.y * 2 + wh / 2 }
  check("app mode: a click lands in the window's middle", c2 && Math.abs(c2.x - want.x) < 8 && Math.abs(c2.y - want.y) < 8, { c2, want })
} else console.log("skip app mode: no window on this Mac's screen")

// The app's menu: Whole screen goes back without a new tab.
await page.click('[aria-label="Show one app"]')
await page.click("text=Whole screen")
await wait(1500)
cv = await canvas()
check("menu: Whole screen shows all of it again", cv && cv.cw === W && cv.ch === H, cv)

// Vim on: the screen keeps the keys that type (data-keeps-keys), so f, j, Space and Ctrl+W are the screen's, not link
// hints, scrolling or the leader; ⌘P is still the app's.
const plugins = (enabled) => fetch(new URL("api/config/plugins", B), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) })
await plugins(["screens", "vim"])
await wait(1500)
cv = await canvas()
await page.mouse.click(cv.x + cv.w / 2, cv.y + cv.h / 2)
keys.length = 0
for (const k of ["f", "j", "Space", "Control+w"]) { await page.keyboard.press(k); await wait(150) }
await wait(300)
check("vim: f, j, Space and Ctrl+W reach the screen", ["f", "j", " ", "w"].every((ch) => keys.includes(ch.charCodeAt(0))), keys)
check("vim: no link hints over the screen", await page.locator("[data-hint]").count() === 0)
await page.keyboard.press("Meta+p")
await wait(400)
check("vim: ⌘P still opens the palette", await page.locator('[role="dialog"] input').count() > 0)
await page.keyboard.press("Escape")
await plugins(["screens"])

// A phone: the picture fits and the keyboard button is there.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
const pp = await phone.newPage()
await pp.goto(`${B}#view/screen%2Flocal`)
await pp.waitForSelector("[data-screen-canvas] canvas", { timeout: 10000 })
await wait(1500)
const pc = await pp.evaluate(() => { const r = document.querySelector("[data-screen-canvas] canvas").getBoundingClientRect(); return { x: r.x, w: r.width } })
check("phone: the picture fits the width", pc.x >= 0 && pc.x + pc.w <= 391, pc)
check("phone: a keyboard button", await pp.locator('[aria-label="Keyboard"]').isVisible())
await pp.screenshot({ path: `${OUT}phone.png` })
await phone.close()

// Who may open a screen: the same as a shell.
function handshake(headers) {
  const u = new URL("api/screens/vnc/local", B)
  return new Promise((resolve) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } })
    req.on("upgrade", (_res, socket, head) => {
      let buf = Buffer.alloc(0)
      const done = (v) => { socket.destroy(); resolve(v) }
      const got = (d) => {
        buf = Buffer.concat([buf, d])
        if (buf.length < 2) return
        let len = buf[1] & 127, at = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 }
        if (buf.length < at + len) return
        try { done(JSON.parse(buf.subarray(at, at + len).toString()).t) } catch { done("?") }
      }
      socket.on("data", got)
      if (head.length) got(head)
      setTimeout(() => done("timeout"), 3000)
    })
    req.on("response", (res) => resolve(`http ${res.statusCode}`))
    req.on("error", (e) => resolve(e.message))
    req.end()
  })
}
check("this Mac: ready", (await handshake({})) === "ready")
check("another site: refused", (await handshake({ Origin: "https://example.com" })) === "refused")
check("through a proxy: refused", (await handshake({ "X-Forwarded-For": "10.0.0.9" })) === "refused")
check("another tailnet login: refused", (await handshake({ "Tailscale-User-Login": "someone-else@example.com" })) === "refused")
check("a screen that isn't there: refused", await (async () => {
  const ws = new WebSocket(new URL("api/screens/vnc/nope", B).href.replace(/^http/, "ws"))
  return new Promise((r) => { ws.onmessage = (e) => r(JSON.parse(e.data).t === "refused"); setTimeout(() => r(false), 3000) })
})())

await browser.close()
server.close()
await done()
