// What the navigator lists, from the store's notes: folders and tags with counts, and a place's notes sorted and
// grouped by date. No app imports, so the tests run it in Node.

export type Note = { path: string; title: string; mtime: number; ctime: number; tags?: string[] }
export type Sort = "modified" | "created" | "title"
/** A place notes are listed from: "folder:<path>" ("folder:" is every note), "tag:<name>", or "recent". */
export type Place = string
export type Node = { key: string; name: string; count: number; kids: Node[] }

export const SORTS: Sort[] = ["modified", "created", "title"]
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
export const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const inFolder = (path: string, folder: string, deep: boolean) =>
  !folder || (deep ? path.startsWith(`${folder}/`) : folderOf(path) === folder)
const hasTag = (n: Note, tag: string) => (n.tags ?? []).some((t) => { const l = t.toLowerCase(); return l === tag || l.startsWith(`${tag}/`) })

/** A tree of `paths` split at "/" (folders, nested tags), each counting the notes `keysOf` puts in it or under it
 *  (`deep`), or only in it. */
function tree(paths: string[], notes: Note[], keysOf: (n: Note) => string[], deep: boolean): Node[] {
  const byKey = new Map<string, Node>(), roots: Node[] = []
  const add = (key: string): Node => {
    const low = key.toLowerCase()
    let n = byKey.get(low)
    if (n) return n
    n = { key, name: key.slice(key.lastIndexOf("/") + 1), count: 0, kids: [] }
    byKey.set(low, n)
    const up = key.includes("/") ? add(key.slice(0, key.lastIndexOf("/"))).kids : roots
    up.push(n)
    return n
  }
  for (const p of paths) add(p)
  for (const n of notes) {
    const seen = new Set<Node>()
    for (const k of keysOf(n)) {
      const parts = k.split("/")
      for (let i = deep ? 1 : parts.length; i <= parts.length; i++) seen.add(add(parts.slice(0, i).join("/")))
    }
    for (const node of seen) node.count++
  }
  const order = (ns: Node[]) => { ns.sort((a, b) => collator.compare(a.name, b.name)); ns.forEach((n) => order(n.kids)) }
  order(roots)
  return roots
}
export const folderTree = (folders: string[], notes: Note[], deep: boolean) =>
  tree(folders, notes, (n) => (folderOf(n.path) ? [folderOf(n.path)] : []), deep)
export const tagTree = (notes: Note[]) => tree([], notes, (n) => n.tags ?? [], true)

/** The notes a place lists (`recent`: paths, newest first, kept in that order). */
export function notesIn(notes: Note[], place: Place, deep: boolean, recent: string[]): Note[] {
  if (place === "recent") { const at = new Map(notes.map((n) => [n.path, n])); return recent.flatMap((p) => at.get(p) ?? []) }
  if (place.startsWith("tag:")) { const t = place.slice(4).toLowerCase(); return notes.filter((n) => hasTag(n, t)) }
  const f = place.slice(7)
  return notes.filter((n) => inFolder(n.path, f, deep || !f))
}

export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
export const timeOf = (n: Note, sort: Sort) => (sort === "created" ? n.ctime || n.mtime : n.mtime)
export function sortNotes(list: Note[], sort: Sort): Note[] {
  const byName = (a: Note, b: Note) => collator.compare(nameOf(a.path), nameOf(b.path))
  return [...list].sort(sort === "title" ? byName : (a, b) => timeOf(b, sort) - timeOf(a, sort) || byName(a, b))
}

/** The list's headings: Pinned first, then by date (Today, Yesterday, Previous 7 and 30 days, months) unless sorted by
 *  title. `month` names a month, with its year when it isn't this one. */
export function groupNotes(list: Note[], sort: Sort | null, pinned: Set<string>, now: Date, month: (d: Date, year: boolean) => string) {
  const out: { label: string; notes: Note[] }[] = []
  const put = (label: string, n: Note) => { const last = out.at(-1); if (last?.label === label) last.notes.push(n); else out.push({ label, notes: [n] }) }
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const since = [[day, "Today"], [day - 864e5, "Yesterday"], [day - 7 * 864e5, "Previous 7 days"], [day - 30 * 864e5, "Previous 30 days"]] as const
  for (const n of list) if (pinned.has(n.path)) put("Pinned", n)
  const rest = out.length ? "Notes" : ""
  for (const n of list) {
    if (pinned.has(n.path)) continue
    if (!sort || sort === "title") { put(rest, n); continue }
    const t = timeOf(n, sort), d = new Date(t)
    put(since.find(([at]) => t >= at)?.[1] ?? month(d, d.getFullYear() !== now.getFullYear()), n)
  }
  return out
}
