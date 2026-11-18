// Graphs of any size through check.ts, each on a throwaway server of its own; the results as JSON (for REPORT.md).
//   node logseq/.test/graphs.ts out.json name=/path/to/graph [name=/path/to/graph.zip ...]
import fs from "node:fs"
import { serve } from "../../testkit.ts"
import { verify } from "./check.ts"

const [out, ...graphs] = process.argv.slice(2)
const results: unknown[] = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : []
for (const g of graphs) {
  const [name, src] = g.split("=", 2)
  const s = await serve(["logseq"])
  try {
    const r = await verify(s, name, src)
    console.log(`${name}: ${JSON.stringify(r).slice(0, 2000)}\n`)
    const i = results.findIndex((x) => (x as { name: string }).name === name)
    if (i >= 0) results[i] = r
    else results.push(r)
    fs.writeFileSync(out, JSON.stringify(results, null, 1))
  } finally { s.stop() }
}
process.exit(0)
