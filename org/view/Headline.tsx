// A headline as a note's heading: its level's size and colour, foldable as the app folds a note's headings (a chevron in
// the margin, … where text is hidden), its keyword, priority, tags and planning dates; inline tasks as a small box.
import { ChevronDown } from "lucide-react"
import { cn } from "@vaultite"
import { isText, type OrgNode } from "../parser/index.ts"
import { isCancelled, Keyword, Priority, Tags } from "./Chips.tsx"
import { useView } from "./context.ts"
import { Elements, Planning } from "./Elements.tsx"
import { Objects } from "./Objects.tsx"
import { kids, num, objs, str } from "./tree.ts"

const interactive = (t: EventTarget | null) => t instanceof Element && !!t.closest("a, button, input, [role=link]")
const touch = () => typeof matchMedia === "function" && matchMedia("(hover: none)").matches

export function Headline({ n, inline = false }: { n: OrgNode; inline?: boolean }) {
  const v = useView()
  const key = v.keys.get(n) ?? ""
  const fold = inline ? undefined : v.folds.of(key)
  const commented = !!n.commentedp
  if (commented) return null
  const level = Math.max(1, num(n, "level") ?? 1), shown = Math.min(level, 6)
  const kw = str(n, "todoKeyword"), done = str(n, "todoType") === "done"
  const tags = Array.isArray(n.tags) ? (n.tags as string[]) : []
  const archived = tags.includes(v.settings.archiveTag)
  const cs = kids(n).filter((c): c is OrgNode => !isText(c))
  const section = cs[0]?.type === "section" ? cs[0] : null
  const subs = cs.filter((c) => c.type === "headline")
  const inSection = section ? kids(section).filter((c): c is OrgNode => !isText(c)) : []
  const planning = inSection[0]?.type === "planning" ? inSection[0] : null
  const body = planning ? inSection.slice(1) : inSection
  const foldable = !inline && (body.length > 0 || subs.length > 0)
  const hidden = fold === "folded" ? foldable : fold === "children" && body.length > 0
  const toggle = () => v.folds.set(key, fold ? undefined : "folded")
  const prio = num(n, "priority")
  const H = inline ? "div" : (`h${shown}` as "h1")
  return (
    <section className={cn("org-sec", inline && "org-inlinetask", archived && "is-dim")} data-level={level}>
      <H className={cn("org-h", !inline && `org-h${shown}`, done && "is-done", kw && done && isCancelled(kw) && "is-cancelled")} data-org-at={n.begin}
        onClick={(e) => { if (foldable && touch() && !interactive(e.target)) toggle() }}>
        {foldable && (
          <button type="button" className={cn("org-fold", fold === "folded" && "is-folded")} aria-label={fold === "folded" ? "Unfold" : "Fold"} aria-expanded={fold !== "folded"}
            onClick={(e) => { e.stopPropagation(); toggle() }}><ChevronDown size={14} strokeWidth={2.5} /></button>
        )}
        {kw && <Keyword kw={kw} done={done} />}
        {prio !== null && <Priority code={prio} highest={v.settings.priorityHighest} lowest={v.settings.priorityLowest} />}
        <span className="org-title-text"><Objects of={objs(n.title)} /></span>
        {hidden && <button type="button" className="org-more" aria-label="Unfold" onClick={(e) => { e.stopPropagation(); v.folds.set(key, undefined) }}>…</button>}
        <Tags tags={tags} />
      </H>
      {planning && <Planning n={planning} done={done} />}
      {fold === undefined && <Elements of={body} />}
      {fold !== "folded" && subs.map((h) => <Headline key={h.begin} n={h} />)}
    </section>
  )
}

