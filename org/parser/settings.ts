// What changes how a file parses: Org's defaults, then the file's own #+TODO:, #+PRIORITIES: and #+LINK: lines.

export type Settings = {
  /** Keywords that open a headline, each with whether it's done. */
  todo: Map<string, "todo" | "done">
  /** Priorities as character codes (numbers as themselves). */
  priorityHighest: number
  priorityLowest: number
  priorityDefault: number
  /** Link types a plain or angle link may have (https, file, id...). */
  linkTypes: string[]
  /** Link abbreviations from #+LINK: (name -> replacement). */
  linkAbbrevs: Map<string, string>
  archiveTag: string
  commentKeyword: string
  footnoteSection: string
  /** Headlines this deep or deeper are inline tasks; null: inline tasks off (Emacs's default). */
  inlinetaskMinLevel: number | null
  /** #+CATEGORY:, else null. */
  category: string | null
}

// Emacs's default link types (org-link-parameters once org-mode is on, as `emacs -Q` reports them).
export const LINK_TYPES = ["id", "eww", "rmail", "mhe", "irc", "info", "gnus", "docview", "bibtex", "bbdb", "w3m", "doi", "file+sys",
  "file+emacs", "shell", "news", "mailto", "https", "http", "ftp", "shortdoc", "help", "file", "elisp"]

const HASH_PLUS = /^[ \t]*#\+\S.*$/gm
const KEYWORD = /^[ \t]*#\+(\S+?):[ \t]*(.*?)[ \t]*$/
// Blocks whose contents are verbatim: a keyword line inside one isn't a keyword.
const VERBATIM_BEGIN = /^[ \t]*#\+begin_(comment|example|export|src|verse)\b/i

/** The file's keyword lines (#+KEY: value) outside verbatim blocks, keys upper case, in order. */
function keywordLines(text: string): [string, string][] {
  const out: [string, string][] = []
  // Per block name, the next #+end_ line found (its end), or -1 once there are none left: each name is searched once.
  const ends = new Map<string, { re: RegExp; at: number; end: number }>()
  const nextEnd = (name: string, from: number) => {
    let c = ends.get(name)
    if (!c) ends.set(name, c = { re: new RegExp(`^[ \\t]*#\\+end_${name}[ \\t]*$`, "gim"), at: -2, end: -1 })
    if (c.at === -1 || c.at >= from) return c.at === -1 ? -1 : c.end
    c.re.lastIndex = from
    const e = c.re.exec(text)
    c.at = e ? e.index : -1
    c.end = e ? e.index + e[0].length : -1
    return c.end
  }
  HASH_PLUS.lastIndex = 0
  for (let m = HASH_PLUS.exec(text); m; m = HASH_PLUS.exec(text)) {
    const begin = VERBATIM_BEGIN.exec(m[0])
    if (begin) {
      const end = nextEnd(begin[1].toLowerCase(), m.index + m[0].length)
      if (end >= 0) HASH_PLUS.lastIndex = end
      continue
    }
    const k = KEYWORD.exec(m[0])
    if (k) out.push([k[1].toUpperCase(), k[2]])
  }
  return out
}

/** TODO keywords from #+TODO: lines: the words after a lone `|` are done, else the last one; `KEY(k)` is KEY. */
function todoKeywords(lines: string[]) {
  const todo = new Map<string, "todo" | "done">()
  if (!lines.length) return todo.set("TODO", "todo").set("DONE", "done")
  for (const line of lines) {
    const words = line.split(/\s+/).filter(Boolean)
    const bar = words.indexOf("|"), done = bar >= 0 && bar < words.length - 1 ? bar + 1 : words.length - (bar >= 0 ? 2 : 1)
    words.forEach((w, i) => { if (w !== "|") todo.set(w.replace(/\(.*\)$/, ""), i >= done ? "done" : "todo") })
  }
  return todo
}

const priority = (w: string) => /^\d+$/.test(w) ? Number(w) : w.charCodeAt(0)

export function settingsOf(text: string, given: Partial<Settings> = {}): Settings {
  const kws = keywordLines(text), values = (...keys: string[]) => kws.filter(([k]) => keys.includes(k)).map(([, v]) => v)
  const todo = todoKeywords(values("TODO", "SEQ_TODO", "TYP_TODO"))
  const p = values("PRIORITIES").map((v) => v.split(/[ \t]+/)).find((w) => w.length >= 3)
  const linkAbbrevs = new Map<string, string>()
  for (const v of values("LINK")) { const m = /^(\S+)[ \t]+(.+)$/.exec(v); if (m) linkAbbrevs.set(m[1], m[2]) }
  const category = values("CATEGORY").pop() ?? null
  return {
    todo,
    priorityHighest: p ? priority(p[0]) : 65, priorityLowest: p ? priority(p[1]) : 67, priorityDefault: p ? priority(p[2]) : 66,
    linkTypes: LINK_TYPES, linkAbbrevs, archiveTag: "ARCHIVE", commentKeyword: "COMMENT", footnoteSection: "Footnotes",
    inlinetaskMinLevel: null, category,
    ...given,
  }
}
