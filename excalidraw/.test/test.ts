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

  // An agent's drawing (scene.ts): typed actions checked, then made; where no window shows it, written to the file.
  s.vau("plugin", "on", "companion")
  await s.api("PATCH", "config/plugin/companion", { mode: "pair" })
  const P = "Drawings/Plan.excalidraw"
  const [st, d] = await s.api("POST", "ops/companion.draw", { path: P, actions: [{ op: "add", type: "rectangle", id: "login", x: 0, y: 0, label: "Log in", fill: "blue" },
    { op: "add", type: "ellipse", id: "home", x: 300, y: 0, label: "Home" }, { op: "add", type: "arrow", id: "go", from: "login", to: "home" }] })
  const els = JSON.parse(s.read(P)).elements as Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
  const go = els.find((e) => e.id === "go"), label = els.find((e) => e.containerId === "login")
  check("draw: with no window showing it, the actions are written to the file", st === 200 && d.how === "written" && go?.startBinding?.elementId === "login" &&
    go?.endBinding?.elementId === "home" && label?.text === "Log in" && els.find((e) => e.id === "login")?.boundElements.length === 2, d)
  const before = s.read(P)
  const [bad, why] = await s.api("POST", "ops/companion.draw", { path: P, actions: [{ op: "change", id: "home", label: "Start" }, { op: "move", id: "nope", x: 1, y: 1 }] })
  check("draw: an action that doesn't fit is refused, and none is made", bad === 400 && /action 2 \(move\): no element "nope"/.test(why?.error) && s.read(P) === before, [bad, why])
  const [, shown] = await s.api("GET", `render?path=${encodeURIComponent(P)}`)
  check("excalidraw: a drawing reads as its items, arrows as a -> b", String(shown).includes('login rectangle "Log in" at 0,0') && String(shown).includes('go arrow login "Log in" -> home "Home"'), shown)
  const [no] = await s.api("POST", "ops/companion.comment", { path: P, text: "Hi", find: "login" })
  check("companion: a drawing has no margin for comments", no === 400)
} finally {
  s.stop()
}

// Actions on a scene: labels follow their shapes, arrows their ends; deleting a shape frees its arrows' ends.
const sc = await import("../scene.ts")
{
  const a = sc.applyActions([], [{ op: "add", id: "a", x: 0, y: 0, w: 100, h: 50, label: "A" }, { op: "add", type: "diamond", id: "b", x: 300, y: 0, w: 100, h: 50 }, { op: "add", id: "ab", from: "a", to: "b" }])
  const moved = sc.applyActions(a.elements, [{ op: "move", id: "b", dy: 200 }]).elements
  const arrow = moved.find((e) => e.id === "ab")!, text = moved.find((e) => e.containerId === "a")!
  check("scene: an arrow's end follows the shape it's bound to", arrow.y + arrow.points[1][1] > 150 && arrow.x > 50, arrow)
  check("scene: a label sits in the middle of its shape", Math.abs(text.x + text.width / 2 - 50) < 1 && Math.abs(text.y + text.height / 2 - 25) < 1, text)
  const gone = sc.applyActions(moved, [{ op: "delete", id: "b" }]).elements
  check("scene: deleting a shape frees its arrow's end", gone.find((e) => e.id === "ab")!.endBinding === null && sc.itemsOf(gone).length === 2)
  check("scene: described with the user's pointer and selection", /near a "A"/.test(sc.describe(a.elements, { pointer: { x: 10, y: 10 }, selected: ["b"] })) &&
    /Selected: b diamond at 300,0 100x50/.test(sc.describe(a.elements, { selected: ["b"] })))
  let err = ""
  try { sc.applyActions(a.elements, [{ op: "add", id: "a", x: 0, y: 0 }]) } catch (e) { err = (e as Error).message }
  check("scene: an id that's taken is refused", err === 'action 1 (add): id "a" is taken', err)
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
