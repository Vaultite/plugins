// obsidian.d.ts as a list: each exported class and interface with its members ("static x" for static ones), and the
// exported functions and constants. (A line parser: the file's own formatting, one member per line at depth 1.)
//   node dts.mjs <obsidian.d.ts> > api.json
import fs from "node:fs"
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n")
const out = { classes: {}, interfaces: {}, values: [] }
let cur = null, depth = 0, doc = "", inDoc = false
for (const raw of lines) {
  const l = raw.trim()
  if (l.startsWith("/**")) { inDoc = !l.endsWith("*/"); doc = l; continue }
  if (inDoc) { doc += l; if (l.endsWith("*/")) inDoc = false; continue }
  if (depth === 0) {
    let m = /^export (?:declare )?(?:abstract )?(class|interface) (\w+)(?:<.*?>)?(?: extends ([\w.]+))?/.exec(l)
    if (m) { cur = { kind: m[1], extends: m[3] ?? null, members: [] }; (m[1] === "class" ? out.classes : out.interfaces)[m[2]] = cur }
    else if ((m = /^export (?:declare )?(?:function|const|let|var|enum) (\w+)/.exec(l))) out.values.push(m[1])
    else cur = null
  } else if (depth === 1 && cur && l && !l.startsWith("//") && !l.startsWith("*")) {
    const m = /^(?:(private|protected) )?(?:(static) )?(?:readonly )?(?:get |set )?(\w+|'[^']+'|"[^"]+")(\??)\s*(<[^(]*>)?\s*([(:])/.exec(l)
    if (m && !m[1] && m[3] !== "constructor") {
      const name = (m[2] ? "static " : "") + m[3].replace(/['"]/g, "")
      if (!cur.members.some((x) => x.name === name)) cur.members.push({ name, kind: m[6] === "(" ? "method" : "prop", optional: !!m[4], deprecated: doc.includes("@deprecated") })
    }
  }
  if (!l.startsWith("*")) for (const ch of l.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "")) { if (ch === "{") depth++; else if (ch === "}") depth-- }
  doc = ""
}
out.values = [...new Set(out.values)]
console.log(JSON.stringify(out, null, 1))
