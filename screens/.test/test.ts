// Screen sharing's relay (rfb.ts): finds where each update ends, asks ahead (at most DEPTH), answers the page while one
// waits, and turns itself off (asking once) on what it can't read.   node screens/.test/test.ts
import { check, done } from "../../testkit.ts"

const { Pump, BYTES } = await import("../rfb.ts")
const DEPTH = 2
const sent: Buffer[] = []
let room = true
const pump = new Pump((b) => sent.push(Buffer.from(b)), () => room, DEPTH)
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const rect = (w: number, h: number, enc: number) => { const b = Buffer.alloc(12); b.writeUInt16BE(w, 4); b.writeUInt16BE(h, 6); b.writeInt32BE(enc, 8); return b }
const fbu = (...rects: Buffer[][]) => Buffer.concat([Buffer.from([0, 0]), u16(rects.length), ...rects.flat()])
// Every encoding it reads: raw, copyrect, hextile (raw and subrect tiles), zrle, tight (fill, jpeg, palette, copy
// small), the cursor, the desktop's name, and a LastRect ending an update of "many" rectangles.
const update = Buffer.concat([
  fbu([rect(2, 2, 0), Buffer.alloc(16, 9)], [rect(4, 4, 1), Buffer.alloc(4)]),
  fbu([rect(20, 4, 5), Buffer.from([1]), Buffer.alloc(16 * 4 * 4, 1), Buffer.from([2 | 8 | 16]), Buffer.alloc(4), Buffer.from([2]), Buffer.alloc(2 * 6)]),
  fbu([rect(8, 8, 16), u32(5), Buffer.alloc(5)], [rect(8, 8, 7), Buffer.from([0x80, 1, 2, 3])], [rect(8, 8, 7), Buffer.from([0x90, 0x81, 0x01]), Buffer.alloc(129)]),
  fbu([rect(16, 2, 7), Buffer.from([0x40, 1, 1]), Buffer.alloc(6), Buffer.alloc(4)], [rect(1, 1, 7), Buffer.from([0]), Buffer.alloc(3)]),
  fbu([rect(4, 2, -239), Buffer.alloc(4 * 2 * 4 + 2)], [rect(0, 0, -307), u32(3), Buffer.from("Mac")]),
  Buffer.concat([Buffer.from([0, 0, 0xff, 0xff]), rect(2, 1, 0), Buffer.alloc(8), rect(0, 0, -224)]),
  Buffer.from([2]), Buffer.concat([Buffer.from([3, 0, 0, 0]), u32(2), Buffer.from("hi")]),
])
// The handshake: version, security, result; the page's ClientInit; then ServerInit, read once SetPixelFormat comes.
pump.fromServer(Buffer.from("RFB 003.008\n\x01\x01\x00\x00\x00\x00"))
pump.fromClient(Buffer.from("RFB 003.008\n")); pump.fromClient(Buffer.from([1])); pump.fromClient(Buffer.from([1]))
const init = Buffer.concat([u16(64), u16(48), Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]), u32(4), Buffer.from("Fake")])
pump.fromServer(init.subarray(0, 10))
const pixel = Buffer.alloc(20); pixel[4] = 32; pixel[5] = 24
check("relay: SetPixelFormat goes on to the screen", pump.fromClient(pixel) === true)
pump.fromServer(init.subarray(10))
const req = (incremental: number) => Buffer.concat([Buffer.from([3, incremental]), u16(0), u16(0), u16(64), u16(48)])
check("relay: the page's first (full) request goes on", pump.fromClient(req(0)) === true)
// The updates, in chunks of every size.
for (let at = 0, n = 1; at < update.length; at += n, n = (n * 7) % 13 + 1) pump.fromServer(update.subarray(at, at + n))
check("relay: reads every update to its end", pump.stats.frames === 6 && pump.stats.pipeline, pump.stats)
check(`relay: asks ahead while fewer than ${DEPTH} are on their way`, pump.stats.ahead === 1 && sent.length === 1 && sent[0][0] === 3 && sent[0][1] === 1, { ...pump.stats, sent: sent.length })
check("relay: past DEPTH, the page's request goes on (nothing waits at the screen)", pump.fromClient(req(1)) === true && pump.stats.inflight === 6 - 1, pump.stats)
for (let i = 0; i < 6; i++) pump.fromClient(req(1))
check("relay: the page's request while one waits stays here (an answer)", pump.stats.inflight === 0 && pump.fromClient(req(1)) === false, pump.stats)
room = false
pump.fromServer(fbu([rect(1, 1, 1), Buffer.alloc(4)]))
check("relay: no asking ahead while the page's socket is full", pump.stats.ahead === 1 && sent.length === 1, pump.stats)
check("relay: then the page's own request goes on", pump.fromClient(req(1)) === true)
room = true
pump.fromServer(fbu([rect(1, 1, 1000), Buffer.alloc(4)]))
check("relay: an encoding it can't read turns it off, asking once", !pump.stats.pipeline && /1000/.test(pump.stats.why) && sent.length === 2, { ...pump.stats, sent: sent.length })
check("relay: then everything goes on as it is", pump.fromClient(req(1)) === true)
// A length no update could have (it lost track of the stream): off, rather than skipping the screen's bytes forever.
const lost = new Pump(() => {}, () => true)
lost.fromServer(Buffer.from("RFB 003.008\n\x01\x01\x00\x00\x00\x00"))
lost.fromClient(Buffer.from([1]))
lost.fromServer(init)
lost.fromClient(pixel)
lost.fromServer(fbu([rect(8, 8, 16), u32(1 << 30)]))
// At most BYTES on their way: big updates (a slow link) stop the asking ahead sooner than DEPTH would.
const asks: Buffer[] = []
const big = new Pump((b) => asks.push(b), () => true, 16)
big.fromServer(Buffer.from("RFB 003.008\n\x01\x01\x00\x00\x00\x00"))
big.fromClient(Buffer.from([1]))
big.fromServer(Buffer.concat([u16(640), u16(480), init.subarray(4)]))
big.fromClient(pixel)
big.fromClient(req(0))
const raw = fbu([rect(320, 240, 0), Buffer.alloc(320 * 240 * 4)])
for (let i = 0; i < 3; i++) big.fromServer(raw)
check(`relay: no more asking ahead past ${BYTES >> 10} KB on their way`, asks.length === Math.floor(BYTES / raw.length) && big.stats.inflight === 3, { asks: asks.length, ...big.stats })
check("relay: a length bigger than the screen turns it off", !lost.stats.pipeline && /lost track/.test(lost.stats.why), lost.stats)
done()
