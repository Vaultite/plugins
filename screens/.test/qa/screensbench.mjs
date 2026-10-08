// Screen sharing's speed, measured rather than guessed: updates a second, the time between them, input to update and
// the bytes, for each network delay and with the relay's pipeline on and off (rfb.ts), read
// from the page's own meter (meter.ts, window.__vauScreens). The page reaches the server through a proxy here that
// adds a delay each way (and a bandwidth, BW), as a tailnet or a phone's network would.
//
// The screen is a fake VNC server by default: Tight JPEG updates (frames the browser renders up front, so their size
// and decoding are real), ENCODE ms to "encode" each, in two scenes: `video` (a region changes RATE times a second:
// scrolling, a video) and `typing` (it changes once per key the page sends: input to update). REAL=1 uses this Mac's
// real screen instead (needs a login the server remembers; move something on it meanwhile for `video`).
// Installs the plugin, writes its settings when fake: throwaway server only.
//   node screens/.test/qa/screensbench.mjs <base url> <vault path>
//   env: DELAYS=0,20,60 (ms each way)  VARIANTS="name:pipeline=off,images=novnc|..."  SCENES=video,typing  SECONDS=5  BW=0 (Mbit/s, 0: no limit)
//        ROUNDS=3 (each variant this many times, in turns: the medians are printed; other work on the Mac skews one run)
//        PIXELS=1  FAKE_ENC=jpeg|zrle  ENCODE=6  RATE=60  W=2560 H=1600 (the screen)  RW=1280 RH=800 (the region that changes)  JSON=1  REAL=1
import net from "node:net"
import zlib from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { install, qa, wait } from "../../../qa.mjs"

const { args: [B, VAULT], browser } = await qa(import.meta.url)
install(B, "screens")
const env = (k, d) => process.env[k] ?? d
const list = (k, d) => env(k, d).split(",").map((x) => x.trim()).filter(Boolean)
const DELAYS = list("DELAYS", "0,20,60").map(Number), SCENES = list("SCENES", "video,typing")
// Each variant: a name and the page's switches (connection.ts), as localStorage keys after "screens:".
const VARIANTS = env("VARIANTS", "before:pipeline=off,images=novnc|pipeline:pipeline=on,images=novnc|now:pipeline=on,images=fast").split("|").map((v) => {
  const [name, sets = ""] = v.split(":")
  return { name, sets: Object.fromEntries(sets.split(",").filter(Boolean).map((kv) => kv.split("="))) }
})
const ROUNDS = Number(env("ROUNDS", 3)), SECONDS = Number(env("SECONDS", 5)), BW = Number(env("BW", 0)), ENCODE = Number(env("ENCODE", 6)), RATE = Number(env("RATE", 60))
const W = Number(env("W", 2560)), H = Number(env("H", 1600)), RW = Number(env("RW", 1280)), RH = Number(env("RH", 800))
const REAL = !!process.env.REAL
// PIXELS=1: also read the picture's pixels every frame (ground truth for the meter; it slows the page down a lot).
const PIXELS = !!process.env.PIXELS
// How the fake screen encodes: tight-jpeg (what noVNC asks for first) or zrle (a page of text: what a server without
// Tight sends; noVNC inflates and decodes it in script).
const FAKE_ENC = env("FAKE_ENC", "jpeg")
const until = async (f, ms = 10000) => { const t = Date.now(); for (;;) { const v = await f(); if (v || Date.now() - t > ms) return v; await wait(100) } }

// --- the proxy: every byte to and from the server, `delay` ms later each way, at most BW Mbit/s
const target = new URL(B)
let delay = 0
const proxy = net.createServer((client) => {
  const up = net.connect(Number(target.port || 80), target.hostname)
  // In order: one queue a direction, sent from the front once its time came.
  const pipe = (from, to) => {
    let free = 0, timer = null
    const queue = []
    const drain = () => {
      timer = null
      while (queue.length && queue[0].at <= Date.now()) { const { chunk } = queue.shift(); if (!to.destroyed) to.write(chunk) }
      if (queue.length) timer = setTimeout(drain, Math.max(1, queue[0].at - Date.now()))
      else if (from.destroyed) to.destroy()
    }
    from.on("data", (chunk) => {
      const now = Date.now()
      const at = BW ? Math.max(now + delay, free) + (chunk.length * 8) / (BW * 1000) : now + delay
      free = at
      queue.push({ at, chunk })
      timer ??= setTimeout(drain, Math.max(1, at - now))
    })
    from.on("close", () => { if (!queue.length) to.destroy() })
    from.on("error", () => {})
  }
  pipe(client, up)
  pipe(up, client)
})
await new Promise((r) => proxy.listen(0, "127.0.0.1", r))
const BASE = `http://127.0.0.1:${proxy.address().port}/`

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errors = []
page.on("pageerror", (e) => errors.push(e.message))
if (process.env.VERBOSE) page.on("console", (m) => { if (/rfb|vnc|websocket|screen/i.test(m.text())) console.log(`  page: ${m.text().slice(0, 200)}`) })

// --- the fake screen
let scene = "video"
let frames = []
let sent = 0
/** Typing: from a key reaching the fake screen to its update leaving it (the page's input time minus this is the network
 *  and the page). */
const keyToSend = []
if (!REAL) {
  // Frames: an animated picture the size of the region, as JPEG (the browser's encoder, quality 0.6: Tight's level 6).
  await page.goto(`${B}`)
  frames = (await page.evaluate(async ([w, h]) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h
    const g = c.getContext("2d"), out = []
    for (let i = 0; i < 24; i++) {
      const grad = g.createLinearGradient(0, 0, w, h)
      grad.addColorStop(0, `hsl(${i * 15} 60% 50%)`); grad.addColorStop(1, `hsl(${i * 15 + 120} 60% 30%)`)
      g.fillStyle = grad; g.fillRect(0, 0, w, h)
      g.fillStyle = "#fff"; g.font = "28px sans-serif"
      for (let y = 40; y < h; y += 44) g.fillText(`Line ${y / 44 + i} of a page that scrolls, with some text in it`, 30 + ((i * 7) % 40), y)
      for (let k = 0; k < 12; k++) { g.beginPath(); g.arc((k * 211 + i * 30) % w, (k * 97 + i * 20) % h, 40, 0, 7); g.fill() }
      const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.6))
      out.push(await new Promise((r) => { const f = new FileReader(); f.onload = () => r(String(f.result).split(",")[1]); f.readAsDataURL(b) }))
    }
    return out
  }, [RW, RH])).map((s) => Buffer.from(s, "base64"))
  // ZRLE: pages of dark text on white, scrolling, as 64-pixel tiles of raw pixels (deflate makes them small).
  let tiles = []
  if (FAKE_ENC === "zrle") {
    tiles = (await page.evaluate(async ([w, h]) => {
      const c = document.createElement("canvas"); c.width = w; c.height = h
      const g = c.getContext("2d", { willReadFrequently: true }), out = []
      for (let i = 0; i < 8; i++) {
        g.fillStyle = "#fff"; g.fillRect(0, 0, w, h)
        g.fillStyle = "#222"; g.font = "15px sans-serif"
        for (let y = 20 - ((i * 9) % 22); y < h; y += 22) g.fillText(`Line ${Math.round(y / 22) + i * 3}: some text in a document that scrolls by, as a page does`, 24, y)
        const px = g.getImageData(0, 0, w, h).data, parts = []
        for (let ty = 0; ty < h; ty += 64) for (let tx = 0; tx < w; tx += 64) {
          const tw = Math.min(64, w - tx), th = Math.min(64, h - ty), t = new Uint8Array(1 + tw * th * 3)
          let k = 1
          for (let y = ty; y < ty + th; y++) for (let x = tx; x < tx + tw; x++) { const o = (y * w + x) * 4; t[k++] = px[o + 2]; t[k++] = px[o + 1]; t[k++] = px[o] }
          parts.push(t)
        }
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0
        for (const p of parts) { all.set(p, at); at += p.length }
        out.push(await new Promise((r) => { const f = new FileReader(); f.onload = () => r(String(f.result).split(",")[1]); f.readAsDataURL(new Blob([all])) }))
      }
      return out
    }, [RW, RH])).map((s) => Buffer.from(s, "base64"))
  }

  const compact = (n) => n <= 0x7f ? Buffer.from([n]) : n <= 0x3fff ? Buffer.from([(n & 0x7f) | 0x80, n >> 7]) : Buffer.from([(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, n >> 14])
  const rectHead = (x, y, w, h, enc) => { const b = Buffer.alloc(12); b.writeUInt16BE(x, 0); b.writeUInt16BE(y, 2); b.writeUInt16BE(w, 4); b.writeUInt16BE(h, 6); b.writeInt32BE(enc, 8); return b }
  const RX = Math.floor((W - RW) / 2), RY = Math.floor((H - RH) / 2)
  const vnc = net.createServer((c) => {
    c.setNoDelay(true)
    let buf = Buffer.alloc(0), stage = 0, n = 0
    let armed = false, full = false, changed = true, busy = false, keyAt = 0
    // ZRLE's one zlib stream for the whole connection, flushed after each rectangle.
    const deflate = zlib.createDeflate({ level: 1 })
    const zrle = (raw) => new Promise((r) => { const out = []; const on = (d) => out.push(d); deflate.on("data", on); deflate.write(raw); deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => { deflate.off("data", on); r(Buffer.concat(out)) }) })
    const flush = () => {
      if (!armed || busy || !(changed || full)) return
      busy = true
      setTimeout(async () => {
        if (c.destroyed) return
        const parts = [Buffer.from([0, 0, 0, full ? 2 : 1])]
        if (full) parts.push(rectHead(0, 0, W, H, 2), Buffer.from([0, 0, 0, 0, 40, 40, 40, 255]))
        if (FAKE_ENC === "zrle") {
          const z = await zrle(tiles[n++ % tiles.length])
          const len = Buffer.alloc(4); len.writeUInt32BE(z.length)
          parts.push(rectHead(RX, RY, RW, RH, 16), len, z)
        } else {
          const jpeg = frames[n++ % frames.length]
          parts.push(rectHead(RX, RY, RW, RH, 7), Buffer.from([0x90]), compact(jpeg.length), jpeg)
        }
        busy = false
        armed = full = changed = false
        sent++
        if (keyAt) { keyToSend.push(Date.now() - keyAt); keyAt = 0 }
        c.write(Buffer.concat(parts))
      }, ENCODE)
    }
    const tick = setInterval(() => { if (scene === "video") { changed = true; flush() } }, 1000 / RATE)
    c.on("close", () => clearInterval(tick))
    c.on("error", () => {})
    c.write("RFB 003.008\n")
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (stage === 0) { if (buf.length < 12) return; buf = buf.subarray(12); c.write(Buffer.from([1, 1])); stage = 1; continue }
        if (stage === 1) { if (buf.length < 1) return; buf = buf.subarray(1); c.write(Buffer.from([0, 0, 0, 0])); stage = 2; continue }
        if (stage === 2) {
          if (buf.length < 1) return
          buf = buf.subarray(1)
          const init = Buffer.alloc(24 + 4)
          init.writeUInt16BE(W, 0); init.writeUInt16BE(H, 2)
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4)
          init.writeUInt32BE(4, 20); init.write("Fake", 24)
          c.write(init); stage = 3; continue
        }
        if (!buf.length) return
        const t = buf[0]
        const need = t === 0 ? 20 : t === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity) : t === 3 ? 10 : t === 4 ? 8 : t === 5 ? 6
          : t === 6 ? (buf.length >= 8 ? 8 + Math.abs(buf.readInt32BE(4)) : Infinity) : t === 255 ? 12 : 1
        if (buf.length < need) return
        const m = buf.subarray(0, need)
        buf = buf.subarray(need)
        if (t === 3) { armed = true; if (!m[1]) full = true; flush() }
        if (t === 4 && m[1] && scene === "typing") { changed = true; keyAt ||= Date.now(); flush() }
      }
    })
  })
  await new Promise((r) => vnc.listen(0, "127.0.0.1", r))
  mkdirSync(path.join(VAULT, ".vaultite/plugins/screens"), { recursive: true })
  writeFileSync(path.join(VAULT, ".vaultite/plugins/screens/data.json"), JSON.stringify({ localPort: vnc.address().port }))
  await wait(6000) // the server's screen list is kept 5 s
}

const state = () => page.evaluate(() => document.querySelector("[data-screen-state]")?.getAttribute("data-screen-state") ?? null)
const results = []
const q = (x) => (x ? `${x[0]}/${x[1]}` : "-")
const line = (r) => `delay ${String(r.delay).padStart(3)} ms  ${r.variant.padEnd(9)} ${r.scene.padEnd(6)}  ${String(r.fps).padStart(5)} fps  gap ${q(r.gap).padEnd(9)} input ${q(r.input).padEnd(9)} wait ${q(r.wait).padEnd(9)} draw ${q(r.draw).padEnd(9)} js ${r.js} ms  ${r.kbps} KB/s${REAL ? "" : `  sent ${r.serverSent}/s`}${r.screenKey != null ? `  key at screen ${r.screenKey} ms` : ""}${r.pixelFps != null ? `  | pixels: ${r.pixelFps} fps${r.pixelInput ? `, input ${q(r.pixelInput)}` : ""}` : ""}`
for (let round = 0; round < ROUNDS; round++) {
  for (const d of DELAYS) {
    delay = d
    // In turns: the variants in another order each round.
    const order = VARIANTS.map((_, i) => VARIANTS[(i + round) % VARIANTS.length])
    for (const { name: mode, sets } of order) {
      await page.goto(BASE)
      await page.evaluate((sets) => { for (const k of ["pipeline", "images", "depth", "tiles"]) localStorage.removeItem(`screens:${k}`); for (const [k, v] of Object.entries(sets)) localStorage.setItem(`screens:${k}`, v) }, sets)
      await page.goto(`${BASE}#view/screen%2Flocal`)
      if (!(await until(async () => (await state()) === "connected", 15000))) {
        console.log(`FAIL delay ${d} ms, ${mode}: not connected (${await state()})`)
        continue
      }
      for (const sc of SCENES) {
        scene = sc
        await page.mouse.click(720, 450)
        await wait(1500)
        const s0 = sent
        keyToSend.length = 0
        // Ground truth, apart from the meter: the picture's pixels at the middle of the screen, read every frame the page
        // draws; each change is when an update was really on screen.
        if (PIXELS) await page.evaluate(() => {
          const c = document.querySelector("[data-screen-canvas] canvas")
          const g = c?.getContext("2d", { willReadFrequently: true })
          const seen = (window.__changes = [])
          let last = "", on = true
          window.__stopWatch = () => { on = false }
          const look = () => {
            if (!on || !g) return
            const px = g.getImageData(Math.floor(c.width / 2) - 20, Math.floor(c.height / 2) - 20, 40, 40).data
            let h = 0
            for (let i = 0; i < px.length; i += 16) h = (h * 31 + px[i] + px[i + 1] * 7 + px[i + 2] * 13) | 0
            const k = String(h)
            if (k !== last) { last = k; seen.push(performance.timeOrigin + performance.now()) }
            requestAnimationFrame(look)
          }
          requestAnimationFrame(look)
        })
        const presses = []
        let typing = null
        if (sc === "typing") {
          typing = (async () => { const end = Date.now() + SECONDS * 1000; while (Date.now() < end) { presses.push(Date.now()); await page.keyboard.press("a"); await wait(200) } })()
        }
        await wait(SECONDS * 1000)
        await typing
        const changes = PIXELS ? await page.evaluate(() => { window.__stopWatch(); return window.__changes }) : []
        const all = await page.evaluate((s) => window.__vauScreens(s), SECONDS)
        const m = all.find((c) => c.shown) ?? all[0]
        if (process.env.VERBOSE) console.log(`  connections: ${all.map((c) => `${c.id} ${c.status}${c.shown ? " shown" : ""}`).join(", ")}  tab: ${await state()}`)
        const r = { round, delay: d, variant: mode, scene: sc, fps: m.fps, gap: m.gap, input: m.input, wait: m.wait, span: m.span, draw: m.draw, js: m.js,
          kbps: m.kbps, frameKb: m.frameKb, encodings: m.encodings, serverSent: REAL ? null : Math.round(((sent - s0) / SECONDS) * 10) / 10,
          screenKey: keyToSend.length ? [...keyToSend].sort((a, b) => a - b)[Math.floor(keyToSend.length / 2)] : null,
          pixelFps: !PIXELS ? null : Math.round(((changes.length - 1) / SECONDS) * 10) / 10,
          pixelInput: (() => {
            const lat = presses.flatMap((p) => { const c = changes.find((t) => t > p); return c ? [c - p] : [] }).sort((a, b) => a - b)
            return lat.length ? [Math.round(lat[Math.floor((lat.length - 1) / 2)]), Math.round(lat[Math.floor((lat.length - 1) * 0.95)])] : null
          })() }
        results.push(r)
        if (process.env.VERBOSE) console.log(`  round ${round + 1}: ${line(r)}`)
        // SHOT=<file.png>: the tab with its speed stats shown, once.
        if (process.env.SHOT && !process.env.SHOT_DONE) {
          process.env.SHOT_DONE = "1"
          await page.click('[data-screen] [aria-label="Speed stats"]')
          await wait(2500)
          await page.screenshot({ path: process.env.SHOT })
          await page.click('[data-screen] [aria-label="Speed stats"]')
        }
        if (process.env.FRAMES) {
          const t0 = m.frames[0]?.start ?? 0, ms = (x) => (x === null ? null : Math.round(x - t0))
          for (const f of m.frames.slice(0, Number(process.env.FRAMES) || 12)) console.log(`    start ${ms(f.start)}  end ${ms(f.t)}  shown ${ms(f.shown)}  ${f.bytes} B  ${f.rects} rects`)
        }
      }
    }
  }
  console.error(`round ${round + 1} of ${ROUNDS} done`)
}
// The median of the rounds, each number on its own.
const med = (xs) => { const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const pair = (rs, k) => { const a = med(rs.map((r) => r[k]?.[0])), b = med(rs.map((r) => r[k]?.[1])); return a === null ? null : [a, b] }
for (const d of DELAYS) for (const sc of SCENES) for (const { name } of VARIANTS) {
  const rs = results.filter((r) => r.delay === d && r.scene === sc && r.variant === name)
  if (!rs.length) continue
  console.log(line({ delay: d, variant: name, scene: sc, fps: med(rs.map((r) => r.fps)), gap: pair(rs, "gap"), input: pair(rs, "input"), wait: pair(rs, "wait"),
    draw: pair(rs, "draw"), js: med(rs.map((r) => r.js)), kbps: med(rs.map((r) => r.kbps)), serverSent: med(rs.map((r) => r.serverSent)), screenKey: med(rs.map((r) => r.screenKey)),
    pixelFps: med(rs.map((r) => r.pixelFps)), pixelInput: pair(rs, "pixelInput") }))
}
if (process.env.JSON) console.log(JSON.stringify(results))
if (errors.length) console.log("page errors:", errors.slice(0, 5))
await browser.close()
proxy.close()
process.exit(0)
