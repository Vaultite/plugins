// The parse tree: Emacs org-element's shape, so it's checked node for node against Emacs (.test/oracle).
// Positions are UTF-16 offsets into the text, end exclusive; Emacs's `:foo-bar` is `fooBar`, its `:type` is `kind`.

export type OrgText = { type: "plain-text"; value: string; begin: number; end: number }

export type OrgNode = {
  type: string
  begin: number
  end: number
  contentsBegin: number | null
  contentsEnd: number | null
  /** Blank lines after an element, spaces after an object. */
  postBlank: number
  /** Where the element starts after its affiliated keywords (#+NAME:...); null for objects. */
  postAffiliated: number | null
  children?: OrgChild[]
  /** Node properties a headline's (or the document's) property drawer gives it, upper case (CUSTOM_ID); a repeated
   *  `KEY+:` collects its values in a list. */
  properties?: Record<string, string | string[]>
  [prop: string]: unknown
}

export type OrgChild = OrgNode | OrgText

/** A property holding objects rather than a string (a headline's title, an item's tag). */
export type Secondary = OrgChild[]

export type Mode = "first-section" | "section" | "planning" | "property-drawer" | "node-property" | "item" | "table-row" | "top-comment" | null

export const isText = (c: OrgChild | undefined): c is OrgText => c?.type === "plain-text"

export function node(type: string, begin: number, end: number, props: Partial<OrgNode> = {}): OrgNode {
  return { type, begin, end, contentsBegin: null, contentsEnd: null, postBlank: 0, postAffiliated: null, ...props }
}

/** Every node of a tree, depth first, secondary values (titles, tags) included. */
export function* walk(n: OrgChild): Generator<OrgChild> {
  yield n
  if (isText(n)) return
  for (const c of n.children ?? []) yield* walk(c)
  for (const k of SECONDARY) {
    const v = n[k]
    if (Array.isArray(v)) for (const c of v) if (c && typeof c === "object" && "type" in c) yield* walk(c as OrgChild)
  }
}

export const SECONDARY = ["title", "tag", "caption", "value", "scheduled", "deadline", "closed"]
