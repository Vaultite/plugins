// A Logseq graph's files, from its folder or a zip of it: pages, journals, assets, drawings, whiteboards, config.
import fs from "node:fs"
import path from "node:path"
import { entryBytes, isZip, zipEntries } from "@vaultite/core/plugins.ts"

export type GraphFile = { rel: string; size: number; read: () => Promise<Buffer> }
export type Graph = { name: string; files: GraphFile[]; skipped: string[] }

/** Logseq's own folders and what a synced folder leaves: never the user's pages. */
const NOISE = /(^|\/)(\.[^/]*|node_modules|__MACOSX|logseq\/bak|logseq\/\.recycle|logseq\/version-files|version-files)(\/|$)|(^|\/)(Thumbs\.db|desktop\.ini)$/i
const MARKS = /(^|\/)(pages|journals)\/[^/]+\.(md|markdown|org)$|(^|\/)logseq\/config\.edn$/i

function walk(dir: string, base = ""): GraphFile[] {
  const out: GraphFile[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (NOISE.test(rel)) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(abs, rel))
    else if (e.isFile()) out.push({ rel, size: fs.statSync(abs).size, read: () => fs.promises.readFile(abs) })
  }
  return out
}

/** The graph's top: the folder its pages/, journals/ or logseq/config.edn are in (a zip often wraps it in one). */
function top(rels: string[]): string {
  const hits = rels.filter((r) => MARKS.test(r)).map((r) => r.replace(/(pages|journals|logseq)\/[^/]+$/i, ""))
  if (!hits.length) {
    const dirs = new Set(rels.map((r) => (r.includes("/") ? r.slice(0, r.indexOf("/") + 1) : "")))
    return dirs.size === 1 && !dirs.has("") ? [...dirs][0] : ""
  }
  return hits.sort((a, b) => a.length - b.length)[0]
}

export function openGraph(source: string): Graph {
  const stat = fs.statSync(source)
  let files: GraphFile[]
  if (stat.isDirectory()) files = walk(source)
  else if (isZip(source)) {
    files = zipEntries(source).filter((e) => !NOISE.test(e.name) && !e.name.endsWith("/"))
      .map((e) => ({ rel: e.name, size: e.size, read: () => entryBytes(source, e) }))
  } else throw new Error("a Logseq graph is a folder (with pages/ and journals/) or a zip of one")
  const root = top(files.map((f) => f.rel))
  files = files.filter((f) => f.rel.startsWith(root)).map((f) => ({ ...f, rel: f.rel.slice(root.length) }))
  const name = (root.replace(/\/$/, "").split("/").pop() || path.basename(source).replace(/\.zip$/i, "")) || "Logseq"
  return { name, files, skipped: [] }
}
