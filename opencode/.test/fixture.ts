// OpenCode's made-up database (fixtures/opencode.sql) and model catalogue (fixtures/models.json), never this machine's.
import fs from "node:fs"
import path from "node:path"

/** Its database under `dir`, times moved so the newest is an hour ago; the environment pointing at it. */
export async function opencodeFixture(dir: string) {
  const sql = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "opencode.sql"), "utf8")
  const shift = Date.now() - 3600000 - Math.max(...[...sql.matchAll(/\b1[78]\d{11}\b/g)].map((m) => Number(m[0])))
  const { DatabaseSync } = await import("node:sqlite")
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, "opencode.db"))
  db.exec(sql.replace(/\b1[78]\d{11}\b/g, (t) => String(Number(t) + shift)))
  db.close()
  return { OPENCODE_DATA_DIR: dir, OPENCODE_CACHE_DIR: path.join(import.meta.dirname, "fixtures") }
}
