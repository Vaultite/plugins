// Hermes Agent's made-up home and a profile (fixtures/), never this machine's.
import fs from "node:fs"
import path from "node:path"

/** Under `dir`: each state.sql made its state.db, times in seconds moved so the newest is an hour ago. */
export async function hermesFixture(dir: string) {
  fs.cpSync(path.join(import.meta.dirname, "fixtures"), dir, { recursive: true })
  const { DatabaseSync } = await import("node:sqlite")
  const sqls = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".sql"))
  const TIME = /\b1[78]\d{8}(\.\d+)?\b/g
  const shift = Date.now() / 1000 - 3600 - Math.max(...sqls.flatMap((f) => [...fs.readFileSync(path.join(dir, f), "utf8").matchAll(TIME)].map((m) => Number(m[0]))))
  for (const f of sqls) {
    const db = new DatabaseSync(path.join(dir, f.replace(/\.sql$/, ".db")))
    db.exec(fs.readFileSync(path.join(dir, f), "utf8").replace(TIME, (t) => String(Number(t) + shift)))
    db.close()
    fs.rmSync(path.join(dir, f))
  }
}
