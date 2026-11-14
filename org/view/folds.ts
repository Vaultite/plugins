// Which headlines are folded, kept per file while the app runs (switching reading and editing keeps them), first as
// the file says (#+STARTUP: overview, content; a :VISIBILITY: property; ARCHIVE'd subtrees closed).
import { useCallback, useSyncExternalStore } from "react"
import { isText, type OrgNode } from "../parser/index.ts"
import { kids, prop } from "./tree.ts"

/** folded: only the headline; children: its sub-headlines but not its text; absent: open. */
export type Fold = "folded" | "children"
export type Folds = { of: (key: string) => Fold | undefined; set: (key: string, f: Fold | undefined) => void; setMany: (m: Map<string, Fold | undefined>) => void }

const kept = new Map<string, Map<string, Fold>>()
const listeners = new Set<() => void>()
let version = 0
const changed = () => { version++; for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** How the file opens: its STARTUP keyword and each headline's VISIBILITY. */
function initial(root: OrgNode, keys: Map<OrgNode, string>, startup: string[], archiveTag: string): Map<string, Fold> {
  const out = new Map<string, Fold>()
  const s = new Set(startup.map((w) => w.toLowerCase()))
  const all: Fold | null = s.has("overview") || s.has("fold") ? "folded" : s.has("content") ? "children" : null
  const go = (n: OrgNode, depth: number) => {
    for (const c of kids(n)) {
      if (isText(c) || c.type !== "headline") continue
      const key = keys.get(c)!
      const vis = (prop(c, "VISIBILITY") ?? "").toLowerCase()
      const tags = Array.isArray(c.tags) ? (c.tags as string[]) : []
      if (tags.includes(archiveTag) || vis === "folded") out.set(key, "folded")
      else if (vis === "children" || vis === "content") out.set(key, "children")
      else if (vis === "all" || vis === "showall") { /* open */ }
      else if (all === "folded" && depth === 0) out.set(key, "folded")
      else if (all === "children") out.set(key, "children")
      go(c, depth + 1)
    }
  }
  go(root, 0)
  return out
}

/** A file's folds, as the file says first. */
export function foldsOf(path: string, root: OrgNode, keys: Map<OrgNode, string>, startup: string[], archiveTag: string): Map<string, Fold> {
  if (!kept.has(path)) kept.set(path, initial(root, keys, startup, archiveTag))
  return kept.get(path)!
}

/** Its folds as an editor left them. */
export function putFolds(path: string, all: Map<string, Fold>) {
  kept.set(path, all)
  changed()
}

export function useFolds(path: string, root: OrgNode, keys: Map<OrgNode, string>, startup: string[], archiveTag: string): Folds {
  useSyncExternalStore(subscribe, () => version)
  const m = foldsOf(path, root, keys, startup, archiveTag)
  const set = useCallback((key: string, f: Fold | undefined) => {
    const cur = kept.get(path)!
    if (f) cur.set(key, f); else cur.delete(key)
    changed()
  }, [path])
  const setMany = useCallback((all: Map<string, Fold | undefined>) => {
    const cur = kept.get(path)!
    for (const [k, f] of all) if (f) cur.set(k, f); else cur.delete(k)
    changed()
  }, [path])
  return { of: (key) => m.get(key), set, setMany }
}
