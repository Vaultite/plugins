// Elements drawn as a note's blocks: paragraphs, lists with checkboxes, tables, code, quotes, callouts, drawers.
import { Fragment, useState, type ReactNode } from "react"
import { Bug, Check, ChevronRight, CircleCheck, CircleHelp, ClipboardList, Flame, Info, List as ListIcon, Pencil, Quote, TriangleAlert, X, Zap, type LucideIcon } from "lucide-react"
import { cn } from "@vaultite"
import { isText, type OrgChild, type OrgNode } from "../parser/index.ts"
import { isImage } from "../export/links.ts"
import { ClockRow, PlanChip } from "./Chips.tsx"
import { CodeBlock, Math as TeX } from "./Code.tsx"
import { useView } from "./context.ts"
import { Headline } from "./Headline.tsx"
import { Objects } from "./Objects.tsx"
import { captionOf, kids, nodeOf, num, plain, str } from "./tree.ts"

export function Elements({ of }: { of: OrgChild[] }) {
  return <>{of.map((c, i) => (isText(c) ? null : <Fragment key={`${c.type}@${c.begin}:${i}`}>{element(c)}</Fragment>))}</>
}

/** No blank line after it in the file: the next block follows closely, as in the note's own reading view. */
const tight = (n: OrgNode) => (n.postBlank === 0 ? "org-tight" : undefined)
const named = (n: OrgNode) => (str(n, "name") ? n.begin : undefined)

function element(n: OrgNode): ReactNode {
  switch (n.type) {
    case "section": case "dynamic-block": return <Elements of={kids(n)} />
    case "headline": return <Headline n={n} />
    case "paragraph": return <Paragraph n={n} />
    case "plain-list": return <List n={n} />
    case "table": return <Table n={n} />
    case "src-block": return <Named n={n}><CodeBlock code={str(n, "value") ?? ""} lang={str(n, "language") ?? ""} /></Named>
    case "example-block": case "fixed-width": return <Named n={n}><CodeBlock code={str(n, "value") ?? ""} /></Named>
    case "export-block": return <CodeBlock code={str(n, "value") ?? ""} lang={(str(n, "kind") ?? "").toLowerCase()} />
    case "quote-block": return <blockquote data-org-at={named(n)}><Elements of={kids(n)} /></blockquote>
    case "verse-block": return <p className="org-verse"><Objects of={kids(n)} /></p>
    case "center-block": return <div className="org-center"><Elements of={kids(n)} /></div>
    case "special-block": return <Callout n={n} />
    case "latex-environment": return <TeX tex={str(n, "value") ?? ""} display />
    case "drawer": return <Drawer n={n} />
    case "property-drawer": return <Properties n={n} />
    case "clock": return <ClockRow n={n} />
    case "planning": return <Planning n={n} done={false} />
    case "horizontal-rule": return <hr />
    case "footnote-definition": return <FootnoteDef n={n} />
    case "babel-call": return <p className="org-quiet"><code>#+CALL: {str(n, "value")}</code></p>
    case "diary-sexp": return <p className="org-quiet"><code>{str(n, "value")}</code></p>
    case "inlinetask": return <Headline n={n} inline />
    case "keyword": case "comment": case "comment-block": return null
    default: return n.children ? <Elements of={kids(n)} /> : null
  }
}

function Named({ n, children }: { n: OrgNode; children: ReactNode }) {
  const caption = captionOf(n)
  if (!str(n, "name") && !caption.length) return <>{children}</>
  return <figure className="org-figure" data-org-at={n.begin}>{children}{caption.length > 0 && <figcaption className="org-caption"><Objects of={caption} /></figcaption>}</figure>
}

/** A paragraph; one that is only a picture is a figure, its #+CAPTION: under it. */
function Paragraph({ n }: { n: OrgNode }) {
  const cs = kids(n)
  const solid = cs.filter((c) => !(isText(c) && !c.value.trim()))
  const picture = solid.length === 1 && solid[0].type === "link" && !(solid[0] as OrgNode).children?.length && isImage(str(solid[0] as OrgNode, "path") ?? "")
  const width = attrWidth(n)
  if (picture || captionOf(n).length) {
    return (
      <figure className="org-figure" data-org-at={named(n)} style={width ? { maxWidth: width } : undefined}>
        <Objects of={cs} />
        {captionOf(n).length > 0 && <figcaption className="org-caption"><Objects of={captionOf(n)} /></figcaption>}
      </figure>
    )
  }
  return <p data-org-at={named(n)} className={tight(n)}><Objects of={cs} /></p>
}

/** #+ATTR_HTML: :width 300 (or #+ATTR_ORG:) as a width. */
function attrWidth(n: OrgNode): string | null {
  for (const k of ["attr_org", "attrOrg", "attr_html", "attrHtml"]) {
    const v = n[k], s = Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : ""
    const m = /:width\s+(\d+(?:\.\d+)?)(px|%|em)?/.exec(s)
    if (m) return `${m[1]}${m[2] ?? "px"}`
  }
  return null
}

// ---- Lists

function List({ n }: { n: OrgNode }) {
  const items = kids(n).filter((c): c is OrgNode => !isText(c) && c.type === "item")
  const kind = str(n, "kind")
  if (kind === "descriptive") {
    return <dl className="org-dl">{items.map((i) => <DescItem key={i.begin} n={i} />)}</dl>
  }
  if (kind === "ordered") {
    const bullet = str(items[0] ?? n, "bullet") ?? "1."
    const alpha = /^[a-z]/.test(bullet.trim()) ? "lower-alpha" : /^[A-Z]/.test(bullet.trim()) ? "upper-alpha" : undefined
    return <ol className={tight(n)} style={alpha ? { listStyleType: alpha } : undefined}>{items.map((i) => <Item key={i.begin} n={i} />)}</ol>
  }
  return <ul className={tight(n)}>{items.map((i) => <Item key={i.begin} n={i} />)}</ul>
}

function Box({ n }: { n: OrgNode }) {
  const state = str(n, "checkbox")
  if (!state) return null
  return <input type="checkbox" checked={state === "on"} data-trans={state === "trans" ? "" : undefined} disabled readOnly aria-checked={state === "trans" ? "mixed" : state === "on"} />
}

/** An item: its box, its first paragraph on the box's line, the rest under it. */
function Item({ n }: { n: OrgNode }) {
  const cs = kids(n), first = cs[0] && !isText(cs[0]) && cs[0].type === "paragraph" ? cs[0] : null
  const counter = num(n, "counter")
  return (
    <li value={counter ?? undefined} className={cn(str(n, "checkbox") === "on" && "is-done")}>
      <Box n={n} />
      {first && <span className="org-item-text"><Objects of={trimEnd(kids(first))} /></span>}
      <Elements of={first ? cs.slice(1) : cs} />
    </li>
  )
}

function DescItem({ n }: { n: OrgNode }) {
  const cs = kids(n), tag = Array.isArray(n.tag) ? (n.tag as OrgChild[]) : []
  return (
    <>
      <dt className={cn(str(n, "checkbox") === "on" && "is-done")}><Box n={n} /><Objects of={tag} /></dt>
      <dd><Elements of={cs} /></dd>
    </>
  )
}

/** The newline ending a paragraph's text, gone (it would leave a space before the next block). */
function trimEnd(cs: OrgChild[]): OrgChild[] {
  const last = cs[cs.length - 1]
  if (!last || !isText(last)) return cs
  return [...cs.slice(0, -1), { ...last, value: last.value.replace(/\s+$/, "") }]
}

// ---- Tables

const NUMBER = /^[-+]?[$€£¥]?(?:\d{1,3}(?:[,  ]\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?\s?[%kKmM]?$/
const ALIGN = /^<([lrc])?\d*>$/

function Table({ n }: { n: OrgNode }) {
  if (str(n, "kind") === "table.el") return <CodeBlock code={str(n, "value") ?? ""} />
  const rows = kids(n).filter((c): c is OrgNode => !isText(c) && c.type === "table-row")
  const cellsOf = (r: OrgNode) => kids(r).filter((c): c is OrgNode => !isText(c) && c.type === "table-cell")
  const texts = (r: OrgNode) => cellsOf(r).map((c) => plain(kids(c)).trim())
  // A row of <l>, <r10>, <c> sets the columns' alignment and isn't drawn.
  const align: (string | undefined)[] = []
  const shown = rows.filter((r) => {
    if (str(r, "kind") === "rule") return true
    const t = texts(r)
    if (t.length && t.every((x) => !x || ALIGN.test(x)) && t.some((x) => x)) {
      t.forEach((x, i) => { const m = ALIGN.exec(x); if (m?.[1]) align[i] = m[1] === "l" ? "left" : m[1] === "r" ? "right" : "center" })
      return false
    }
    return true
  })
  const groups: OrgNode[][] = [[]]
  for (const r of shown) {
    if (str(r, "kind") === "rule") { if (groups[groups.length - 1].length) groups.push([]) } else groups[groups.length - 1].push(r)
  }
  if (!groups[groups.length - 1].length) groups.pop()
  const head = groups.length > 1 && shown[0] && str(shown[0], "kind") !== "rule" ? groups.shift()! : null
  const body = groups.flat()
  const width = Math.max(0, ...shown.map((r) => cellsOf(r).length))
  for (let i = 0; i < width; i++) {
    if (align[i]) continue
    const vals = body.map((r) => texts(r)[i] ?? "").filter(Boolean)
    if (vals.length && vals.filter((x) => NUMBER.test(x)).length / vals.length >= 0.5) align[i] = "right"
  }
  const caption = captionOf(n)
  const row = (r: OrgNode, th: boolean) => (
    <tr key={r.begin}>
      {Array.from({ length: width }, (_, i) => {
        const c = cellsOf(r)[i], Tag = th ? "th" : "td"
        const short = !c || plain(kids(c)).trim().length <= 24
        return <Tag key={i} align={align[i] as "left" | "right" | "center" | undefined} className={short ? "md-cell-short" : undefined}>{c ? <Objects of={kids(c)} /> : null}</Tag>
      })}
    </tr>
  )
  return (
    <figure className={cn("org-figure org-table", tight(n))} data-org-at={named(n)}>
      <div className="md-table-view">
        <table>
          {head && <thead>{head.map((r) => row(r, true))}</thead>}
          {groups.map((g, i) => <tbody key={i}>{g.map((r) => row(r, false))}</tbody>)}
        </table>
      </div>
      {caption.length > 0 && <figcaption className="org-caption"><Objects of={caption} /></figcaption>}
    </figure>
  )
}

// ---- Blocks

const CALLOUTS: Record<string, [string, LucideIcon]> = {
  note: ["note", Pencil], abstract: ["abstract", ClipboardList], summary: ["abstract", ClipboardList], tldr: ["abstract", ClipboardList],
  info: ["info", Info], todo: ["todo", CircleCheck], tip: ["tip", Flame], hint: ["tip", Flame], important: ["tip", Flame],
  success: ["success", Check], check: ["success", Check], done: ["success", Check], question: ["question", CircleHelp], help: ["question", CircleHelp],
  faq: ["question", CircleHelp], warning: ["warning", TriangleAlert], caution: ["warning", TriangleAlert], attention: ["warning", TriangleAlert],
  failure: ["failure", X], fail: ["failure", X], missing: ["failure", X], danger: ["danger", Zap], error: ["danger", Zap], bug: ["bug", Bug],
  example: ["example", ListIcon], quote: ["quote", Quote], cite: ["quote", Quote],
}

/** #+begin_note (any special block) as the app's callout; its parameters, when given, are its title. */
function Callout({ n }: { n: OrgNode }) {
  const kind = (str(n, "kind") ?? "note").toLowerCase()
  const [type, Icon] = CALLOUTS[kind] ?? [kind, Pencil]
  const title = (str(n, "parameters") ?? "").trim() || kind.charAt(0).toUpperCase() + kind.slice(1)
  return (
    <div className="callout" data-callout={type} data-org-at={named(n)}>
      <div className="callout-title"><span className="callout-icon"><Icon size={16} /></span><span className="callout-title-text">{title}</span></div>
      <div className="callout-content"><Elements of={kids(n)} /></div>
    </div>
  )
}

/** A drawer, closed until opened: its name and a word on what's in it. */
function Folded({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn("org-drawer", open && "is-open")}>
      <button type="button" className="org-drawer-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="org-drawer-fold" aria-hidden />
        <span>{name}</span>{note && <span className="org-drawer-note">{note}</span>}
      </button>
      {open && <div className="org-drawer-body">{children}</div>}
    </div>
  )
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

function Drawer({ n }: { n: OrgNode }) {
  const name = str(n, "drawerName") ?? "Drawer"
  const clocks = kids(n).filter((c): c is OrgNode => !isText(c) && c.type === "clock")
  const minutes = clocks.reduce((m, c) => { const d = /^(\d+):(\d{2})$/.exec(str(c, "duration") ?? ""); return m + (d ? Number(d[1]) * 60 + Number(d[2]) : 0) }, 0)
  const note = clocks.length ? `${clocks.length === 1 ? "1 clock" : `${clocks.length} clocks`}${minutes ? `, ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}` : ""}` : undefined
  return <Folded name={title(name)} note={note}><Elements of={kids(n)} /></Folded>
}

function Properties({ n }: { n: OrgNode }) {
  const props = kids(n).filter((c): c is OrgNode => !isText(c) && c.type === "node-property")
  if (!props.length) return null
  return (
    <Folded name="Properties" note={String(props.length)}>
      <dl className="org-props">
        {props.map((p) => <Fragment key={p.begin}><dt>{str(p, "key")}</dt><dd>{str(p, "value")}</dd></Fragment>)}
      </dl>
    </Folded>
  )
}

/** SCHEDULED, DEADLINE and CLOSED as dated chips. */
export function Planning({ n, done }: { n: OrgNode; done: boolean }) {
  const chips = (["deadline", "scheduled", "closed"] as const).map((k) => [k, nodeOf(n[k])] as const).filter(([, t]) => t)
  if (!chips.length) return null
  return <div className="org-planning">{chips.map(([k, t]) => <PlanChip key={k} kind={k} ts={t!} done={done} />)}</div>
}

function FootnoteDef({ n }: { n: OrgNode }) {
  const v = useView()
  const label = str(n, "label") ?? ""
  const nth = v.doc.footnotes.indexOf(label) + 1, ref = v.doc.refs.get(label)
  return (
    <div className="org-fn" data-org-at={n.begin}>
      <a className="org-fn-n" role="link" tabIndex={0} data-tip={ref !== undefined ? "Back to the text" : undefined}
        onClick={() => { if (ref !== undefined) v.jump(ref) }}>{nth || label}</a>
      <div className="org-fn-body"><Elements of={kids(n)} /></div>
    </div>
  )
}
