// Links: the web opens as the app opens it, file: links open vault files in the app (an image with no description is
// drawn), [[*heading]], [[#custom-id]], [[target]] and id: jump inside the file. Links that would run code stay text.
import type { KeyboardEvent, MouseEvent, ReactNode } from "react"
import { followLink, linkClick, rawUrl, resolver } from "@vaultite"
import { isFileLink, isImage, vaultPath } from "../export/links.ts"
import type { OrgChild, OrgNode } from "../parser/index.ts"
import { useView, type View } from "./context.ts"
import { Objects } from "./Objects.tsx"
import { kids, str } from "./tree.ts"

const WEB = new Set(["http", "https", "ftp", "mailto", "news", "doi"])

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/")

export type Resolved = { kind: "web"; url: string } | { kind: "file"; path: string; found: boolean } | { kind: "here"; pos: number | null } | { kind: "inert" }

/** What a link needs of its file: where it is, the vault, the file's indexes and settings. */
export type LinkCtx = Pick<View, "path" | "store" | "doc" | "settings">

export function resolve(v: LinkCtx, n: OrgNode): Resolved {
  const kind = str(n, "kind") ?? "", path = str(n, "path") ?? "", raw = str(n, "rawLink") ?? path
  if (WEB.has(kind)) return { kind: "web", url: kind === "doi" ? `https://doi.org/${path}` : raw }
  if (isFileLink(n)) {
    const p = vaultPath(dirOf(v.path), path)
    if (p === null) return { kind: "inert" }
    if (p === v.path) return { kind: "here", pos: searchIn(v, str(n, "searchOption") ?? "") }
    const found = !!v.store && !!resolver(v.store)(p, v.path)?.file
    return { kind: "file", path: p, found }
  }
  if (kind === "custom-id") return { kind: "here", pos: v.doc.customIds.get(path)?.begin ?? null }
  if (kind === "id") return { kind: "here", pos: v.doc.ids.get(path)?.begin ?? null }
  if (kind === "fuzzy") return { kind: "here", pos: searchIn(v, path) }
  const abbrev = v.settings.linkAbbrevs.get(kind)
  if (abbrev) {
    const url = abbrev.includes("%s") ? abbrev.replace("%s", encodeURIComponent(path)) : abbrev + path
    if (/^https?:/i.test(url)) return { kind: "web", url }
  }
  return { kind: "inert" }
}

/** A search inside the file: *Heading, #custom-id, a target, a #+NAME:, else a headline's title. */
function searchIn(v: LinkCtx, s: string): number | null {
  if (!s) return null
  if (s.startsWith("*")) return v.doc.titles.get(s.slice(1).trim().toLowerCase())?.begin ?? null
  if (s.startsWith("#")) return v.doc.customIds.get(s.slice(1))?.begin ?? null
  const k = s.toLowerCase()
  return v.doc.targets.get(k) ?? v.doc.titles.get(k)?.begin ?? null
}

/** Opens what a link resolved to: the web and vault files as the app opens them; a place in the file by `jump`. */
export function follow(v: LinkCtx, r: Resolved, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }, jump: (pos: number) => void) {
  if (r.kind === "web" && v.store) void followLink(v.store, { url: r.url }, linkClick(e), v.path)
  else if (r.kind === "file" && v.store) void followLink(v.store, { wiki: r.path }, linkClick(e), v.path)
  else if (r.kind === "here" && r.pos !== null) jump(r.pos)
}

export function Link({ n }: { n: OrgNode }) {
  const v = useView()
  const desc = kids(n), r = resolve(v, n), path = str(n, "path") ?? ""
  const img = imageOf(v, n)
  if (img && !desc.length) return <Img src={img} alt={path.split("/").pop() ?? ""} />
  const label: ReactNode = desc.length ? descLabel(v, desc) : str(n, "rawLink") ?? path
  const go = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); follow(v, r, e, v.jump) }
  const key = (e: KeyboardEvent) => { if (e.key === "Enter") go(e as unknown as MouseEvent) }
  if (r.kind === "web") return <a className="external-link" href={r.url} data-url={r.url} target="_blank" rel="noreferrer" onClick={go} onAuxClick={(e) => { if (e.button === 1) go(e) }}>{label}</a>
  if (r.kind === "file") return <a className={r.found ? "wikilink" : "wikilink missing"} data-wiki={r.path} role="link" tabIndex={0} onClick={go} onKeyDown={key} onAuxClick={(e) => { if (e.button === 1) go(e) }}>{label}</a>
  if (r.kind === "here") return <a className={r.pos === null ? "wikilink missing" : "wikilink"} role="link" tabIndex={0} onClick={go} onKeyDown={key}>{label}</a>
  return <span className="org-quiet" data-tip={str(n, "rawLink") ?? undefined}>{label}</span>
}

/** A description that is itself an image link: the picture, linking to the target. */
function descLabel(v: LinkCtx, desc: OrgChild[]): ReactNode {
  const only = desc.length === 1 && desc[0].type === "link" ? (desc[0] as OrgNode) : null
  const img = only ? imageOf(v, only) : null
  return img ? <Img src={img} alt="" /> : <Objects of={desc} />
}

function imageOf(v: LinkCtx, n: OrgNode): string | null {
  const kind = str(n, "kind") ?? "", path = str(n, "path") ?? ""
  if (!isImage(path)) return null
  if (kind === "http" || kind === "https") return str(n, "rawLink")
  if (!isFileLink(n)) return null
  const p = vaultPath(dirOf(v.path), path)
  return p === null ? null : rawUrl(p)
}

function Img({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} loading="lazy" className="org-img" />
}
