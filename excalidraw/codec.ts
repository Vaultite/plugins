// How a drawing is kept in its file: `.excalidraw` is excalidraw.com's JSON; `.excalidraw.md` is Obsidian's Markdown,
// of which only "## Text Elements" and "## Drawing" (```json or ```compressed-json) are rewritten, the rest kept.
import LZString from "lz-string"

const { compressToBase64, decompressFromBase64 } = LZString

export type Scene = { elements: Record<string, unknown>[]; appState: Record<string, unknown>; files: Record<string, unknown>
  /** Obsidian's images: file id -> the vault file ([[name]]) that holds it. */
  embedded: Record<string, string> }

export type Codec = {
  /** The file's text as a scene; an empty file is an empty drawing. Throws on text that isn't a drawing. */
  read: (text: string) => Scene
  /** The file with this drawing in it (`json`: what Excalidraw serialized), from the file as it is (`prev`). */
  write: (prev: string, json: string) => string
}

function fromJson(json: string, embedded: Record<string, string> = {}): Scene {
  if (!json.trim()) return { elements: [], appState: {}, files: {}, embedded }
  const j = JSON.parse(json)
  if (!j || typeof j !== "object" || (j.type && j.type !== "excalidraw")) throw new Error("not an Excalidraw drawing")
  return { elements: Array.isArray(j.elements) ? j.elements : [], appState: j.appState ?? {}, files: j.files ?? {}, embedded }
}

export const plain: Codec = { read: (text) => fromJson(text), write: (_prev, json) => json }

const DRAWING = /(\n##? Drawing\n[^`]*```(compressed-json|json)\n)([\s\S]*?)(```)/
const EMBEDDED = /^([\w-]+): \[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/gm

function embeddedOf(md: string) {
  const at = md.indexOf("\n## Embedded Files\n")
  if (at < 0) return {}
  const section = md.slice(at + 19).split(/\n(?:%%\n)?##? /)[0]
  return Object.fromEntries([...section.matchAll(EMBEDDED)].map((m) => [m[1], m[2].trim()]))
}

function decompress(s: string) {
  const out = decompressFromBase64(s.replace(/[\r\n]/g, ""))
  if (out === null || out === "") throw new Error("its compressed drawing can't be read")
  return out
}
function compress(s: string) {
  const c = compressToBase64(s)
  let out = ""
  for (let i = 0; i < c.length; i += 256) out += `${c.slice(i, i + 256)}\n\n`
  return out
}

/** "## Text Elements": every text as `<text> ^<id>`, and every other element with a link as `<link> ^<id>`. */
function textElements(elements: Record<string, unknown>[]) {
  let out = ""
  for (const e of elements) {
    if (e.isDeleted) continue
    if (e.type === "text") out += `${e.originalText ?? e.text ?? ""} ^${e.id}\n\n`
    else if (typeof e.link === "string" && e.link) out += `${e.link} ^${e.id}\n\n`
  }
  return out
}

export const obsidian: Codec = {
  read(text) {
    const m = DRAWING.exec(text)
    if (!m) {
      if (!/excalidraw-plugin:/.test(text)) throw new Error("not an Excalidraw drawing")
      return fromJson("", embeddedOf(text)) // made in Obsidian but never drawn in
    }
    return fromJson(m[2] === "compressed-json" ? decompress(m[3]) : m[3], embeddedOf(text))
  },
  write(prev, json) {
    const scene = JSON.parse(json)
    // Images Obsidian keeps as vault files stay there, not in the scene.
    const embedded = embeddedOf(prev)
    if (scene.files) for (const id of Object.keys(embedded)) delete scene.files[id]
    const body = JSON.stringify(scene, null, "\t")
    let out = prev
    const m = DRAWING.exec(out)
    if (m) {
      const block = m[2] === "compressed-json" ? compress(body) : `${body}\n`
      out = out.slice(0, m.index) + m[1] + block + m[4] + out.slice(m.index + m[0].length)
    } else {
      out = `${out.replace(/\n*$/, "\n")}\n%%\n## Drawing\n\`\`\`compressed-json\n${compress(body)}\`\`\`\n%%\n`
    }
    const t = out.indexOf("## Text Elements\n")
    if (t >= 0) {
      const from = t + 17
      const rest = out.slice(from)
      const end = rest.search(/^(?:%%\n)?##? /m)
      if (end >= 0) out = out.slice(0, from) + textElements(scene.elements ?? []) + rest.slice(end)
    }
    return out
  },
}
