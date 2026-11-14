// The vault files an Org file links to: its file: links (and #+INCLUDE / #+SETUPFILE), relative to the file.
import { isText, type OrgNode, parse, walk } from "../parser/index.ts"

const FILE_KINDS = new Set(["file", "file+sys", "file+emacs"])
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic)$/i

export const isFileLink = (n: OrgNode) => n.type === "link" && FILE_KINDS.has(String(n.kind))
export const isImage = (p: string) => IMAGE.test(p)

/** A link's path from the folder `dir` as a vault path, or null when it isn't in the vault (absolute, ~, out of it). */
export function vaultPath(dir: string, p: string): string | null {
  if (!p || p.startsWith("/") || p.startsWith("~") || /^[a-z][\w+.-]*:/i.test(p)) return null
  const out = dir ? dir.split("/") : []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") { if (!out.length) return null; out.pop() } else out.push(seg)
  }
  return out.length ? out.join("/") : null
}

/** The file a keyword names: #+INCLUDE: "notes.org" or #+SETUPFILE: setup.org. */
export function keywordFile(n: OrgNode): string | null {
  if (n.type !== "keyword" || (n.key !== "INCLUDE" && n.key !== "SETUPFILE")) return null
  const v = String(n.value ?? "").trim(), m = /^"([^"]+)"|^(\S+)/.exec(v)
  const f = (m?.[1] ?? m?.[2] ?? "").replace(/^file:/, "").replace(/::.*$/, "")
  return f && !/^[a-z][\w+.-]*:/i.test(f) ? f : null
}

/** What the graph resolves: a relative path as `./path` (from the file's folder), the search option (::*Heading) off. */
export const orgLinks = (text: string) => treeLinks(parse(text))

export function treeLinks(doc: OrgNode): string[] {
  const out = new Set<string>()
  const add = (p: string) => {
    if (!p || p.startsWith("/") || p.startsWith("~")) return
    out.add(/^\.\.?\//.test(p) ? p : `./${p}`)
  }
  for (const n of walk(doc)) {
    if (isText(n)) continue
    if (isFileLink(n)) add(String(n.path ?? ""))
    else { const f = keywordFile(n); if (f) add(f) }
  }
  return [...out]
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")

/** `to` as a path from the folder `dir` (A/B, A/c.org: ../c.org). */
export function relativePath(dir: string, to: string): string {
  const a = dir ? dir.split("/") : [], b = to.split("/")
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/")
}

/** A file or folder moved from `from` to `to`: where a vault path is now. */
export const follow = (from: string, to: string) => (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)

/** The Org file `text`, once at `was` and now at `now`, with its relative file: links pointing where their files are
 *  now (`moved`: a vault path's new one); null when none changed. Only each link's path is rewritten. */
export function relinked(text: string, was: string, now: string, moved: (p: string) => string, doc: OrgNode = parse(text)): string | null {
  const edits: [number, number, string][] = []
  for (const n of walk(doc)) {
    if (isText(n) || !isFileLink(n)) continue
    const p = String(n.path ?? ""), target = vaultPath(dirOf(was), p)
    if (target === null) continue
    let there = moved(target)
    if (there === target && !/\.\w+$/.test(target)) there = moved(`${target}.md`).replace(/\.md$/, "")
    if (there === target && dirOf(now) === dirOf(was)) continue
    let rel = relativePath(dirOf(now), there)
    if (p.startsWith("./") && !rel.startsWith("../")) rel = `./${rel}`
    if (rel === p) continue
    const src = text.slice(n.begin, n.end), at = src.indexOf(p, src.startsWith("[[") ? 2 : 0)
    if (at >= 0) edits.push([n.begin + at, n.begin + at + p.length, rel])
  }
  if (!edits.length) return null
  let out = text
  for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + r + out.slice(b)
  return out
}
