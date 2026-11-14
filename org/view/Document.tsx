// An Org file drawn as a note, for reading (and embeds): #+TITLE: as its title, its author and date under it, then the
// tree. Folds fold; links go where they point.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn, type Store } from "@vaultite"
import { isText, parse, settingsOf, type OrgNode } from "../parser/index.ts"
import { useView, ViewCtx, type View } from "./context.ts"
import { Elements } from "./Elements.tsx"
import { useFolds, type Fold } from "./folds.ts"
import { Objects } from "./Objects.tsx"
import { headlineKeys, indexDoc, kids } from "./tree.ts"
import "../org.css"

export type DocumentProps = {
  text: string; path: string; store?: Store
  /** Its own tab ("page"), the phone's sheet, an embed, or the Plugins page's preview. */
  place: "page" | "sheet" | "embed" | "preview"
  /** Embedded as `![[file.org#Heading]]`: only that headline. */
  subpath?: string
}

const stemOf = (path: string) => path.split("/").pop()!.replace(/\.org$/i, "")

export function OrgDocument({ text, path, store, place, subpath }: DocumentProps) {
  const root = useMemo(() => parse(text), [text])
  const settings = useMemo(() => settingsOf(text), [text])
  const doc = useMemo(() => indexDoc(root), [root])
  const keys = useMemo(() => headlineKeys(root), [root])
  const startup = useMemo(() => (doc.keywords.get("STARTUP") ?? "").split(/\s+/), [doc])
  const folds = useFolds(path, root, keys, startup, settings.archiveTag)
  const host = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<{ pos: number } | null>(null)

  const jump = useCallback((pos: number) => {
    const open = new Map<string, Fold | undefined>()
    const go = (n: OrgNode) => {
      for (const c of kids(n)) {
        if (isText(c) || c.type !== "headline" || pos < c.begin || pos >= c.end) continue
        open.set(keys.get(c)!, undefined)
        go(c)
      }
    }
    go(root)
    if ([...open.keys()].some((k) => folds.of(k))) folds.setMany(open)
    setTarget({ pos })
  }, [root, keys, folds])
  useEffect(() => {
    if (!target || !host.current) return
    const all = [...host.current.querySelectorAll<HTMLElement>("[data-org-at]")]
    const at = (e: HTMLElement) => Number(e.dataset.orgAt)
    const el = all.find((e) => at(e) === target.pos) ?? all.filter((e) => at(e) <= target.pos).sort((a, b) => at(b) - at(a))[0]
    if (!el) return
    el.scrollIntoView({ block: "start", behavior: "smooth" })
    el.classList.remove("org-flash"); void el.offsetWidth; el.classList.add("org-flash")
  }, [target])

  const view: View = { store, path, text, root, doc, settings, folds, keys, jump, compact: place !== "page" }
  const scoped = useMemo(() => {
    if (!subpath) return null
    const want = subpath.replace(/^\*+\s*/, "").trim().toLowerCase()
    return doc.titles.get(want) ?? null
  }, [subpath, doc])

  const title = doc.keywords.get("TITLE")?.trim()
  const reading = place === "page"
  const meta = [doc.keywords.get("AUTHOR"), dateText(doc.keywords.get("DATE"))].filter((x): x is string => !!x?.trim())
  const filetags = (doc.keywords.get("FILETAGS") ?? "").split(/[:\s]+/).filter(Boolean)
  return (
    <ViewCtx.Provider value={view}>
      <div ref={host} className={cn("note-prose org-doc", view.compact && "compact", place === "preview" && "org-preview", place === "embed" && "org-embed")} data-org-doc>
        {reading && <h1 className="org-doctitle title-font">{title || stemOf(path)}</h1>}
        {(place === "page" || place === "sheet") && (meta.length > 0 || filetags.length > 0) && (
          <p className="org-meta">
            {meta.map((m, i) => <span key={i}>{m}</span>)}
            {filetags.map((t) => <a key={t} className="tag">{t}</a>)}
          </p>
        )}
        {scoped ? <Elements of={[scoped]} /> : <Elements of={kids(root)} />}
        <InlineNotes />
      </div>
    </ViewCtx.Provider>
  )
}

/** #+DATE: as written, without a timestamp's brackets. */
const dateText = (d?: string) => d?.replace(/^[<[]|[>\]]$/g, "").trim()

/** Footnotes written in the text ([fn::...]): listed at the end, as an export would. */
function InlineNotes() {
  const v = useView()
  const inline = v.doc.footnotes.filter((l) => v.doc.definitions.get(l)?.type === "footnote-reference")
  if (!inline.length) return null
  return (
    <section className="org-notes">
      {inline.map((l) => {
        const def = v.doc.definitions.get(l)!, ref = v.doc.refs.get(l)
        return (
          <div key={l} className="org-fn">
            <a className="org-fn-n" role="link" tabIndex={0} onClick={() => { if (ref !== undefined) v.jump(ref) }}>{v.doc.footnotes.indexOf(l) + 1}</a>
            <div className="org-fn-body"><Objects of={kids(def)} /></div>
          </div>
        )
      })}
    </section>
  )
}
