// OpenClaw's made-up state and workspace (fixtures/), never this machine's.
import fs from "node:fs"
import path from "node:path"

/** Under `dir`: each <name>.sql made its database, times moved so the newest reply is an hour ago, events of 512 bytes
 *  and more zstd-compressed (as OpenClaw stores them). */
export async function openclawFixture(dir: string) {
  fs.cpSync(path.join(import.meta.dirname, "fixtures"), dir, { recursive: true })
  const { DatabaseSync } = await import("node:sqlite")
  const { zstdCompressSync } = await import("node:zlib")
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".sql"))
  const times = files.filter((f) => f.startsWith("agents")).flatMap((f) => [...fs.readFileSync(path.join(dir, f), "utf8").matchAll(/\b1[78]\d{11}\b/g)].map((m) => Number(m[0])))
  const shift = Date.now() - 3600000 - Math.max(...times)
  for (const f of files) {
    const db = new DatabaseSync(path.join(dir, f.slice(0, -4)))
    db.exec(fs.readFileSync(path.join(dir, f), "utf8").replace(/\b1[78]\d{11}\b/g, (t) => String(Number(t) + shift))
      .replace(/\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (t) => new Date(Date.parse(t) + shift).toISOString()))
    const big = f.startsWith("agents") ? db.prepare("SELECT session_id, seq, event_json FROM transcript_events WHERE length(event_json) >= 512 AND event_json NOT LIKE '{\"type\":\"session\"%'").all() : []
    for (const r of big as { session_id: string; seq: number; event_json: string }[]) {
      const ev = JSON.parse(r.event_json), nb = Buffer.byteLength(r.event_json)
      const nav = { version: 1, report: { kind: "canonical", hasParentId: true, entry: { id: ev.id, parentId: ev.parentId, timestamp: ev.timestamp, type: ev.type } },
        navigation: {}, reset: {}, model: { type: ev.type, id: ev.id, message: { role: ev.message?.role } }, modelBytes: nb, modelWithoutCheckpointBytes: nb, withoutCustomDataBytes: nb }
      db.prepare("UPDATE transcript_events SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = ?")
        .run(zstdCompressSync(Buffer.from(r.event_json)), nb, JSON.stringify(nav), r.session_id, r.seq)
    }
    db.close()
    fs.rmSync(path.join(dir, f))
  }
}
