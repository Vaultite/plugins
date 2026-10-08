// Writes compat.json, the compatibility list Browse shows: each tested plugin's status from .test/results/*.tsv (id,
// status: works | partly | fails | n/a | unneeded, then notes), and plugins a sweep saw fail to load as "no".
//   node .test/compat-list.mjs [sweep.json]
import fs from "node:fs"
import path from "node:path"

const here = import.meta.dirname, out = path.join(here, "..", "compat.json")
const list = JSON.parse(fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "{}")
const sweep = process.argv[2]
if (sweep) for (const p of JSON.parse(fs.readFileSync(sweep, "utf8")).plugins) if (p.state === "failed" && !list[p.id]) list[p.id] = "no"
const dir = path.join(here, "results")
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".tsv")) : []) {
  for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n").slice(1)) {
    const [id, web] = line.split("\t")
    // (fails, and n/a: what Obsidian's own app is needed for, both read as not running here)
    const status = web === "fails" || web === "n/a" ? "no" : web
    // (unneeded: Vaultite does its job itself, Obsidian's look or views it restyles)
    if (id && ["works", "partly", "no", "unneeded"].includes(status)) list[id] = status
  }
}
fs.writeFileSync(out, JSON.stringify(Object.fromEntries(Object.entries(list).sort()), null, 2) + "\n")
console.log(`${Object.keys(list).length} plugins in compat.json`)
