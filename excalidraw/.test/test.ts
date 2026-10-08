// Excalidraw on a throwaway server: drawings are JSON files, its fonts come from the app (not the network), and
// Obsidian's .excalidraw.md is read and written back.   node excalidraw/.test/test.ts
import fs from "node:fs"
import path from "node:path"
import { APP, check, done, serve } from "../../testkit.ts"

const { obsidian } = await import("../codec.ts")
const s = await serve(["excalidraw"])
try {
  const font = fs.readdirSync(path.join(APP, "node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont")).find((f) => f.endsWith(".woff2"))!
  const r = await fetch(`${s.base}api/excalidraw/fonts/Excalifont/${font}`)
  const bytes = Buffer.from(await r.arrayBuffer())
  check("excalidraw: serves its fonts as bytes", r.status === 200 && bytes.length > 1000, r.status)
  check("excalidraw: refuses paths out of its fonts", (await s.api("GET", "excalidraw/fonts/../package.json"))[0] >= 400 &&
    (await s.api("GET", "excalidraw/fonts/Excalifont/..%2F..%2Findex.js"))[0] === 400)
  const drawing = JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }, null, 2)
  const [made, body] = await s.api("POST", "file", { path: "Drawings/Plan.excalidraw", text: drawing })
  const [, drawn] = await s.api("GET", "file?path=Drawings/Plan.excalidraw")
  check("excalidraw: a drawing is written and read as text", made < 300 && drawn.text === drawing, body)
  const [, hist] = await s.api("GET", "history?path=Drawings/Plan.excalidraw")
  check("excalidraw: drawings are text files (history keeps them)", !!hist && hist.path === "Drawings/Plan.excalidraw", hist)
} finally {
  s.stop()
}

// Obsidian's .excalidraw.md: read (compressed), written back with only the drawing and its text elements changed
const scene = { type: "excalidraw", version: 2, source: "t", appState: {}, files: {},
  elements: [{ id: "t1", type: "text", text: "Hello", originalText: "Hello" }, { id: "r1", type: "rectangle", link: "[[Plan]]" }] }
const file = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\nKeep this line.\n\n# Excalidraw Data\n\n## Text Elements\nOld ^t1\n\n%%\n## Embedded Files\nabc123: [[Pics/cat.png]]\n\n## Drawing\n```compressed-json\nN4Ig\n```\n%%\n"
const out = obsidian.write(file, JSON.stringify(scene))
const back = obsidian.read(out)
check("excalidraw: Obsidian drawing written compressed and read back", /```compressed-json\n/.test(out) && back.elements.length === 2 && back.embedded.abc123 === "Pics/cat.png", out)
check("excalidraw: Obsidian's text elements rewritten, the rest kept", out.includes("## Text Elements\nHello ^t1\n\n[[Plan]] ^r1\n\n%%\n## Embedded Files") &&
  out.startsWith("---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\nKeep this line.\n"), out)
done()
