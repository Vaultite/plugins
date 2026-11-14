// Objects: what's inside paragraphs, titles and cells, drawn as the app draws a note's inline Markdown.
import { Fragment, type ReactNode } from "react"
import { isText, type OrgChild, type OrgNode } from "../parser/index.ts"
import { Cookie, TimeChip } from "./Chips.tsx"
import { Math as TeX } from "./Code.tsx"
import { useView } from "./context.ts"
import { Link } from "./Link.tsx"
import { kids, str } from "./tree.ts"

export function Objects({ of }: { of: OrgChild[] }) {
  return <>{of.map((c, i) => <Fragment key={i}>{object(c)}{!isText(c) && c.postBlank > 0 ? " ".repeat(c.postBlank) : null}</Fragment>)}</>
}

/** Org's special strings as an export writes them: --- and -- as dashes, ... as an ellipsis, \- a soft hyphen. */
export const special = (t: string) => t.replace(/\\-/g, "\u00ad").replace(/---/g, "\u2014").replace(/--/g, "\u2013").replace(/\.\.\./g, "\u2026")

function object(c: OrgChild): ReactNode {
  if (isText(c)) return special(c.value)
  const inner = () => <Objects of={kids(c)} />
  switch (c.type) {
    case "bold": return <strong>{inner()}</strong>
    case "italic": return <em>{inner()}</em>
    case "underline": return <u>{inner()}</u>
    case "strike-through": return <s className="org-strike">{inner()}</s>
    case "code": case "verbatim": return <code>{str(c, "value")}</code>
    case "subscript": return <sub>{inner()}</sub>
    case "superscript": return <sup>{inner()}</sup>
    case "entity": return str(c, "utf8") ?? `\\${str(c, "name")}`
    case "line-break": return <br />
    case "link": return <Link n={c} />
    case "timestamp": return <TimeChip ts={c} />
    case "statistics-cookie": return <Cookie value={str(c, "value") ?? ""} />
    case "latex-fragment": return <Fragment>{latex(str(c, "value") ?? "")}</Fragment>
    case "footnote-reference": return <FootnoteRef n={c} />
    case "target": return <span className="org-target" data-org-at={c.begin} />
    case "radio-target": return <span className="org-target" data-org-at={c.begin}>{inner()}</span>
    case "macro": return <Macro n={c} />
    case "inline-src-block": return <code data-tip={str(c, "language") ?? undefined}>{str(c, "value")}</code>
    case "inline-babel-call": return <code className="org-quiet">call_{str(c, "call")}({str(c, "arguments")})</code>
    case "citation": return <span className="org-quiet">[{citeKeys(c).map((k) => `@${k}`).join("; ")}]</span>
    case "export-snippet": return null
    case "table-cell": return inner()
    default: return c.children ? inner() : typeof c.value === "string" ? c.value : null
  }
}

const citeKeys = (c: OrgNode) => kids(c).flatMap((r) => (!isText(r) && r.type === "citation-reference" ? [str(r, "key") ?? ""] : []))

/** \(..\), \[..\], $..$, $$..$$ or a bare \command, drawn with KaTeX. */
function latex(v: string): ReactNode {
  const m = /^\\\(([\s\S]*)\\\)$/.exec(v) ?? /^\$([^$][\s\S]*)\$$/.exec(v)
  if (m) return <TeX tex={m[1]} />
  const d = /^\\\[([\s\S]*)\\\]$/.exec(v) ?? /^\$\$([\s\S]*)\$\$$/.exec(v)
  if (d) return <TeX tex={d[1]} display />
  return <TeX tex={v} />
}

function FootnoteRef({ n }: { n: OrgNode }) {
  const v = useView()
  const label = v.doc.labels.get(n) ?? str(n, "label") ?? ""
  const nth = v.doc.footnotes.indexOf(label) + 1
  const def = v.doc.definitions.get(label)
  return (
    <sup className={def ? "footnote-ref" : "footnote-ref missing"} data-org-at={n.begin}>
      <a role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); if (def) v.jump(def === n ? n.begin : def.begin) }}>{nth || "?"}</a>
    </sup>
  )
}

/** {{{name(args)}}}: the file's #+MACRO: or Org's own (title, author, date, keyword, property); else as written. */
function Macro({ n }: { n: OrgNode }) {
  const v = useView()
  const key = (str(n, "key") ?? "").toLowerCase(), args = Array.isArray(n.args) ? (n.args as string[]) : []
  const kw = (k: string) => v.doc.keywords.get(k.toUpperCase()) ?? ""
  const own = v.doc.macros.get(key)
  const text = own !== undefined ? own.replace(/\$(\d)/g, (_, i) => args[Number(i) - 1] ?? "")
    : key === "title" || key === "author" || key === "date" || key === "email" ? kw(key)
    : key === "keyword" ? kw(args[0] ?? "")
    : key === "input-file" ? v.path.split("/").pop() ?? ""
    : key === "n" ? null : null
  if (text === null) return <span className="org-quiet">{str(n, "value")}</span>
  return <>{text}</>
}
