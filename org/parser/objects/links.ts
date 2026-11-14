// Links (regular [[..][..]], angle <..>, plain, and radio links), targets <<..>> and radio targets <<<..>>>.
import type { OrgNode } from "../ast.ts"
import type { Settings } from "../settings.ts"
import { BREAKABLE_CLASS, cpBefore, isAlnum, isBreakable, isPunct, isSpace, wordStart } from "./chars.ts"
import { match, nextIndex, obj, withContents, type Lex } from "./lex.ts"

const REGULAR = /\[\[((?:[^[\]\\]|\\(?:\\\\)*[[\]]|\\+[^[\]])+)\]/y

/** A regular link `[[path]]` or `[[path][description]]` at `pos`: the description ends at the first `]]`. */
export function regularLink(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  const m = match(REGULAR, s, pos, end)
  if (!m) return null
  let e = pos + m[0].length, cb = -1, ce = -1
  if (s[e] === "[") {
    ce = nextIndex(L, "]]", e + 2)
    if (ce < 0 || ce + 2 > end) return null
    cb = e + 1
    e = ce + 2
  } else if (s[e] === "]" && e < end) e++
  else return null
  const raw = expandAbbrev(L.ctx.settings, unescape(m[1].replace(/[ \t]*\n[ \t]*/g, " ")))
  const props = { format: "bracket", rawLink: raw, ...analyse(raw, L.ctx.settings) }
  return cb < 0 ? obj("link", pos, e, props) : withContents(L, "link", pos, e, cb, ce, props)
}

/** Backslashes before a bracket or at the end are escapes: halved, an odd one escaping the bracket. */
const unescape = (p: string) => p.replace(/(\\+)(?=[[\]]|$)/g, (b) => b.slice(0, b.length >> 1))

/** `#+LINK:` abbreviations: `name:tag` (or `name`) with the tag put in place of %s (url-encoded for %h) or added. */
function expandAbbrev(settings: Settings, raw: string): string {
  if (!settings.linkAbbrevs.size) return raw
  const colon = raw.indexOf(":"), name = colon < 0 ? raw : raw.slice(0, colon), tag = colon < 0 ? "" : raw.slice(colon + 1)
  const rep = settings.linkAbbrevs.get(name)
  if (rep === undefined) return raw
  if (rep.includes("%s")) return rep.replace("%s", tag)
  if (rep.includes("%h")) return rep.replace("%h", hexify(tag))
  return rep + tag
}

/** Every UTF-8 byte but letters, digits and `-_.~` as %XX. */
const hexify = (t: string) => Array.from(new TextEncoder().encode(t), (b) =>
  /[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("")

const FILE_PATH = /^(?:\.{0,2}\/|~\/|~$)/
const TYPE = /^([^:]+):/

/** A link's kind and path (and file application and search option) from its raw text. */
function analyse(raw: string, settings: Settings): Record<string, unknown> {
  if (raw.startsWith("#")) return { kind: "custom-id", path: raw.slice(1) }
  if (raw.length > 1 && raw.startsWith("(") && raw.endsWith(")")) return { kind: "coderef", path: raw.slice(1, -1) }
  const t = TYPE.exec(raw), type = t && typeIn(settings, t[1])
  if (type) return withFile({ kind: type, typeExplicitP: true, path: raw.slice(t[0].length) })
  if (FILE_PATH.test(raw)) return withFile({ kind: "file", path: raw })
  return { kind: "fuzzy", path: raw }
}

/** A link type as written, if it's one Emacs knows (any case); the file types are all `file`, their app aside. */
function typeIn(settings: Settings, t: string): string | null {
  const low = t.toLowerCase()
  return settings.linkTypes.includes(low) ? t : null
}

function withFile(p: { kind: string; path: string; typeExplicitP?: boolean }): Record<string, unknown> {
  const low = p.kind.toLowerCase()
  if (low !== "file" && !low.startsWith("file+")) return p
  const out: Record<string, unknown> = { ...p, kind: "file" }
  if (low.startsWith("file+")) out.application = p.kind.slice(5)
  const sep = p.path.indexOf("::")
  if (sep >= 0) { out.path = p.path.slice(0, sep); out.searchOption = p.path.slice(sep + 2) }
  return out
}

type Types = { angle: RegExp; plain: RegExp; first: Set<string> }
const typesCache = new WeakMap<string[], Types>()

function typesOf(settings: Settings): Types {
  let t = typesCache.get(settings.linkTypes)
  if (!t) {
    const alt = [...settings.linkTypes].sort((a, b) => b.length - a.length).map((x) => x.replace(/[+.]/g, "\\$&")).join("|")
    t = { angle: new RegExp(`<(${alt}):([^>\\n]*(?:\\n[ \\t]*[^> \\t\\n][^>\\n]*)*)>`, "iy"), plain: new RegExp(`(${alt}):`, "iy"),
      first: new Set(settings.linkTypes.flatMap((x) => [x[0].toLowerCase(), x[0].toUpperCase()])) }
    typesCache.set(settings.linkTypes, t)
  }
  return t
}

/** An angle link `<type:path>` at `pos`: newlines and the blanks around them aren't part of the path. */
export function angleLink(L: Lex, pos: number): OrgNode | null {
  const close = nextIndex(L, ">", pos)
  if (close < 0 || close >= L.end) return null
  const m = match(typesOf(L.ctx.settings).angle, L.s, pos, close + 1)
  if (!m) return null
  const path = m[2].replace(/[ \t]*\n[ \t]*/g, "")
  const kind = typeIn(L.ctx.settings, m[1])!
  return obj("link", pos, pos + m[0].length, { format: "angle", rawLink: `${m[1]}:${m[2]}`, ...withFile({ kind, typeExplicitP: true, path }) })
}

/** Whether a plain link may start at `pos` (a known type's first letter, at the start of a word). */
export function plainStart(L: Lex, pos: number): boolean {
  return typesOf(L.ctx.settings).first.has(L.s[pos]) && wordStart(cpBefore(L.s, pos, L.begin), L.s.charCodeAt(pos))
}

const ATOM = "[^\\][ \\t\\n()<>]", GROUP = `[(<[](?:${ATOM}|[(<[]${ATOM}*[\\])>])*[\\])>]`
const PATH_ITEM = new RegExp(`${ATOM}|${GROUP}`, "uy")

/** A plain link `type:path` at `pos`: the path ends on a letter, a digit, `/`, `-` or a bracketed group. */
export function plainLink(L: Lex, pos: number): OrgNode | null {
  const { s, end } = L
  const m = match(typesOf(L.ctx.settings).plain, s, pos, end)
  if (!m) return null
  const start = pos + m[0].length
  let i = start, n = 0, best = -1
  for (;;) {
    const it = match(PATH_ITEM, s, i, end)
    if (!it) break
    i += it[0].length
    n++
    if (n >= 2 && finalOk(it[0])) best = i
  }
  if (best < 0) return null
  const raw = s.slice(pos, best)
  return obj("link", pos, best, { format: "plain", rawLink: raw, ...withFile({ kind: m[1], typeExplicitP: true, path: raw.slice(m[0].length) }) })
}

/** Whether a path item may end a plain link: a group, `/`, `-`, or a character neither punctuation nor blank. */
function finalOk(item: string) {
  if ("(<[".includes(item[0])) return true
  if (item === "/" || item === "-") return true
  const c = item.codePointAt(0)!
  return !isPunct(c) && !isSpace(c)
}

const TARGET = /<<([^<>\n\s](?:[^<>\n]*[^<>\s])?)>>/y
const RADIO_TARGET = /<<<([^<>\n\s](?:[^<>\n]*[^<>\s])?)>>>/y

export function target(L: Lex, pos: number): OrgNode | null {
  const m = match(TARGET, L.s, pos, L.end)
  return m ? obj("target", pos, pos + m[0].length, { value: m[1] }) : null
}

export function radioTarget(L: Lex, pos: number): OrgNode | null {
  const m = match(RADIO_TARGET, L.s, pos, L.end)
  return m ? withContents(L, "radio-target", pos, pos + m[0].length, pos + 3, pos + 3 + m[1].length, { value: m[1] }) : null
}

/** The document's radio targets as one regex (longest first, any blanks between words, any case), or null. It ends
 * before a character that's neither a letter nor a digit, or one a line may break at. */
export function radioRegex(values: string[]): RegExp | null {
  if (!values.length) return null
  const alts = [...new Set(values)].sort((a, b) => b.length - a.length)
    .map((v) => v.split(/[ \t\n]+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ \\t\\n]+"))
  return new RegExp(`(?:${alts.join("|")})(?=$|[^\\p{L}\\p{Nd}]|[${BREAKABLE_CLASS}])`, "iuy")
}

/** A radio link at `pos`: text a radio target names, not inside a word. */
export function radioLink(L: Lex, pos: number, re: RegExp): OrgNode | null {
  const { s, end } = L
  const before = cpBefore(s, pos, L.begin)
  if (before >= 0 && isAlnum(before) && !isBreakable(before)) return null
  // An Emacs quirk: right after a one-character radio link starting a line (or the container), with no blank
  // between, another one isn't found.
  const back = pos - 2, sep = s[pos - 1], lineStart = back === L.begin || s[back - 1] === "\n"
  if (back >= L.begin && lineStart && !" \t\n".includes(sep) && match(re, s, back, end)?.[0].length === 1) return null
  const m = match(re, s, pos, end)
  if (!m) return null
  const e = pos + m[0].length
  return withContents(L, "link", pos, e, pos, e, { kind: "radio", path: m[0], format: "plain", rawLink: m[0] })
}
