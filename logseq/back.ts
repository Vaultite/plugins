// A note's outline written as Logseq writes a page: tasks as TODO/DONE with SCHEDULED and DEADLINE, wikilinks as
// [[page]] and ((block refs)), callouts as #+BEGIN_ blocks, ^ids as id:: properties.
import { dayName, writeDate } from "./dates.ts"
import type { GraphConfig } from "./edn.ts"
import type { Block } from "./outline.ts"
import { PROP } from "./outline.ts"

export type Back = {
  cfg: GraphConfig
  /** What a link's target is in the graph: a page's title, or a file's path there (../assets/x.png, draws/x.excalidraw). */
  note: (target: string, from: string) => { title: string; rel: string; aliases: string[] } | { file: string } | null
  /** A block id as Logseq's uuid (one made from it when it isn't one). */
  blockId: (rel: string, id: string) => string
  /** The text of the block a ^id marks in a note: what a link to it shows by default. */
  blockLabel: (rel: string, id: string) => string | null
}

const ID = /\s\^([\w-]+)\s*$/
const ALONE_ID = /^\s*\^([\w-]+)\s*$/
const TASK = /^\[(.)\](?:\s+(.*)|\s*)$/
const CALLOUT: Record<string, string> = { note: "NOTE", tip: "TIP", important: "IMPORTANT", caution: "CAUTION", warning: "WARNING", pinned: "PINNED", example: "EXAMPLE", quote: "QUOTE" }
const UNIT: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" }

/** "every 2 weeks when done" as a Logseq repeater (.+2w), or null when it can't be one (every Monday). */
export function repeater(every: string): string | null {
  const m = /^every\s+(?:(\d+)\s+)?(day|week|month|year)s?(\s+when done)?$/i.exec(every.trim())
  return m ? `${m[3] ? ".+" : "+"}${m[1] ?? "1"}${UNIT[m[2].toLowerCase()]}` : null
}

type Fields = { rest: string; due?: string; scheduled?: string; priority?: string; every?: string }
const EMOJI: [string, keyof Fields][] = [["📅", "due"], ["⏳", "scheduled"], ["🔁", "every"]]
const PRI: Record<string, string> = { "🔺": "A", "⏫": "A", "🔼": "B", "🔽": "C", "⏬": "C", highest: "A", high: "A", medium: "B", low: "C", lowest: "C" }

/** A task's description with the fields Logseq has taken out of it. */
function fields(text: string): Fields {
  const f: Fields = { rest: text }
  for (const [k, v] of [["due", "due"], ["scheduled", "scheduled"], ["repeat", "every"], ["priority", "priority"]] as const) {
    f.rest = f.rest.replace(new RegExp(`\\s*\\[${k}::\\s*([^\\]]+)\\]`), (_, x: string) => { f[v] = v === "priority" ? PRI[x.trim().toLowerCase()] : x.trim(); return "" })
  }
  for (const [e, k] of EMOJI) {
    f.rest = f.rest.replace(new RegExp(`\\s*${e}\\uFE0F?\\s*(${k === "every" ? "[^📅⏳🛫➕✅❌🆔⛔🏁🔺⏫🔼🔽⏬^]+" : "\\d{4}-\\d\\d-\\d\\d"})`, "u"), (_, x: string) => { f[k] = x.trim(); return "" })
  }
  f.rest = f.rest.replace(/\s*(🔺|⏫|🔼|🔽|⏬)️?/u, (_, p: string) => { f.priority = PRI[p]; return "" })
  f.rest = f.rest.trimEnd()
  return f
}

const MARK = (cfg: GraphConfig): Record<string, string> => ({ " ": cfg.workflow === "now" ? "LATER" : "TODO", "/": cfg.workflow === "now" ? "NOW" : "DOING", x: "DONE", X: "DONE", "-": "CANCELED" })

function link(back: Back, from: string, target: string, label: string | undefined, embed: boolean, size?: string): string {
  const [base, anchor] = target.split("#", 2)
  const hit = base ? back.note(base, from) : back.note(from, from)
  const iso = /^\d{4}-\d\d-\d\d$/.test(base) ? writeDate(base, back.cfg.journalTitleFormat) : null
  if (!hit) {
    const t = iso ?? base
    return embed ? `{{embed [[${t}]]}}` : label && label !== t ? `[${label}]([[${t}]])` : `[[${t}]]`
  }
  if ("file" in hit) {
    const name = label ?? hit.file.split("/").pop()!
    if (hit.file.startsWith("draws/")) return `[[${hit.file}]]`
    if (!embed) return `[${name}](${hit.file})`
    const w = size && /^\d+$/.test(size) ? `{:width ${size}}` : ""
    return `![${hit.file.split("/").pop()}](${hit.file})${w}`
  }
  if (anchor?.startsWith("^")) {
    const id = back.blockId(hit.rel, anchor.slice(1))
    if (embed) return `{{embed ((${id}))}}`
    const own = back.blockLabel(hit.rel, anchor.slice(1))
    return label && own !== null && label.trim() !== own && label.trim() !== "block" ? `[${label}](((${id})))` : `((${id}))`
  }
  // (a link by one of the page's aliases stays one: Logseq finds the page by it too)
  const named = hit.aliases.find((a) => a.toLowerCase() === base.toLowerCase()) ?? hit.title
  if (embed) return `{{embed [[${named}]]}}`
  const alias = label ? hit.aliases.find((a) => a.toLowerCase() === label.toLowerCase()) : undefined
  if (alias) return `[[${alias}]]`
  return label && label.toLowerCase() !== named.toLowerCase() && label.toLowerCase() !== hit.title.toLowerCase() ? `[${label}]([[${named}]])` : `[[${label && label.toLowerCase() === hit.title.toLowerCase() ? hit.title : named}]]`
}

const PATTERN = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]|(!?)\[([^\]\n]*)\]\(([^)\s]+)\)|==([^=\n]+)==/g

/** One line's links, embeds and highlights as Logseq writes them (outside code). */
export function lineBack(back: Back, from: string, text: string, card = false): string {
  return text.split(/(`+[^`\n]*`+|\$\$[^$\n]*\$\$|\$[^$\n]+\$)/).map((part, i) => (i % 2 ? part : part.replace(PATTERN, (all, e1: string, wt?: string, wl?: string, e2?: string, ml?: string, mh?: string, hl?: string) => {
    if (hl !== undefined) return card ? `{{cloze ${hl}}}` : `^^${hl}^^`
    if (wt !== undefined) {
      const sized = e1 && wl && /^\d+(x\d+)?$/.test(wl)
      return link(back, from, wt.trim(), sized ? undefined : wl, !!e1, sized ? wl.split("x")[0] : undefined)
    }
    const href = mh!
    if (ml === "Video" || ml === "YouTube" || ml === "Tweet") return `{{${ml === "Video" ? "video" : ml === "YouTube" ? "youtube" : "tweet"} ${href}}}`
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("#")) return all
    let target = href
    try { target = decodeURIComponent(href) } catch { /* (as written) */ }
    // a link to something not in the vault (a file beside the graph) stays as it was
    return back.note(target.split("#")[0], from) ? link(back, from, target.replace(/\.md$/i, ""), ml || undefined, !!e2) : all
  }))).join("")
}

/** A frontmatter value as a page property's. */
export function propValue(back: Back, key: string, v: unknown, from: string): string | null {
  if (v === null || v === undefined) return ""
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && key !== "tags" && !/\[\[/.test(x) ? x : propValue(back, key, x, from))).join(", ")
  if (typeof v === "object") return JSON.stringify(v)
  return lineBack(back, from, String(v))
}

/** The lines of a block's text after its title, converted: callouts, queries, comments, code. */
function rest(back: Back, from: string, lines: string[], card: boolean, plan: { scheduled?: string; deadline?: string }): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const fence = /^\s*(`{3,}|~{3,})(\w*)/.exec(l)
    if (fence) {
      const end = lines.findIndex((x, j) => j > i && x.trim().startsWith(fence[1]) && /^\s*(`+|~+)\s*$/.test(x))
      const stop = end < 0 ? lines.length - 1 : end
      const inner = lines.slice(i + 1, stop)
      let j = out.length - 1
      while (j > 0 && PROP.test(out[j].trim())) j--
      const q = out[j]?.match(/^%%logseq: (.*)%%$/)
      if (q) out[j] = q[1]
      else if (out[out.length - 1] === "Advanced Logseq query (not converted):" && fence[2] === "clojure") { out[out.length - 1] = "#+BEGIN_QUERY"; out.push(...inner, "#+END_QUERY") }
      else if (fence[2] === "example") out.push("#+BEGIN_EXAMPLE", ...inner, "#+END_EXAMPLE")
      else out.push(...lines.slice(i, stop + 1))
      i = stop
      continue
    }
    const planned = /^%%(SCHEDULED|DEADLINE): (<[^>]+>)%%$/.exec(l.trim())
    if (planned) { plan[planned[1] === "SCHEDULED" ? "scheduled" : "deadline"] = planned[2]; continue }
    if (/^%%\s*$/.test(l.trim())) {
      const end = lines.findIndex((x, j) => j > i && /^\s*%%\s*$/.test(x))
      if (end > 0) {
        const inner = lines.slice(i + 1, end)
        out.push(...(/^\s*:LOGBOOK:/.test(inner[0] ?? "") ? inner : ["#+BEGIN_COMMENT", ...inner, "#+END_COMMENT"]))
        i = end
        continue
      }
    }
    const callout = /^>\s*\[!(\w+)\][-+]?\s*(.*)$/.exec(l)
    if (callout) {
      let end = i + 1
      while (end < lines.length && /^>/.test(lines[end])) end++
      const kind = CALLOUT[callout[1].toLowerCase()] ?? "NOTE"
      const inner = lines.slice(i + 1, end).map((x) => x.replace(/^>\s?/, ""))
      out.push(`#+BEGIN_${kind}`, ...(callout[2] ? [lineBack(back, from, callout[2], card)] : []), ...rest(back, from, inner, card, plan), `#+END_${kind}`)
      i = end - 1
      if (lines[i + 1] === "" && lines[i + 2]?.trim()) i++
      continue
    }
    if (/^\s*(Advanced Logseq query \(not converted\):|%%logseq: .*%%)$/.test(l)) { out.push(l.trim()); continue }
    if (/^\s*(\d{1,9}\\[.)]|\\[*+])\s/.test(l)) { out.push(lineBack(back, from, l.replace(/^(\s*\d{1,9})\\([.)])/, "$1$2").replace(/^(\s*)\\([*+])/, "$1$2"), card)); continue }
    if (/\s\\\^[\w-]+\s*$/.test(l)) { out.push(lineBack(back, from, l.replace(/(\s)\\\^([\w-]+)\s*$/, "$1^$2"), card)); continue }
    out.push(PROP.test(l.trim()) ? l.replace(/::\s*(.*)$/, (_, v: string) => `::${v ? ` ${lineBack(back, from, v)}` : ""}`) : lineBack(back, from, l, card))
  }
  return out
}

export function blockText(back: Back, blocks: Block[], from: string): { text: string; blocks: number } {
  let count = 0
  const write = (b: Block, depth: number): string[] => {
    count++
    let lines = [...b.lines]
    let id: string | null = null
    for (let k = 0; k < lines.length; k++) {
      const alone = ALONE_ID.exec(lines[k])
      if (alone) { id = alone[1]; lines.splice(k, 1); break }
      const m = ID.exec(lines[k])
      if (m && !/^\s*(```|~~~)/.test(lines[k])) { id = m[1]; lines[k] = lines[k].slice(0, m.index); break }
    }
    let title = lines[0] ?? ""
    const props: string[] = []
    const plan: { scheduled?: string; deadline?: string } = {}
    const card = /(^|\s)#card(\s|$)/i.test(title)
    const t = TASK.exec(title)
    if (t) {
      const f = fields(t[2] ?? "")
      const waiting = t[1] === " " && /^WAITING\s/.test(f.rest)
      if (waiting) f.rest = f.rest.replace(/^WAITING\s+/, "")
      const marker = waiting ? "WAITING" : MARK(back.cfg)[t[1]] ?? "TODO"
      title = `${marker}${f.priority ? ` [#${f.priority}]` : ""}${f.rest ? ` ${lineBack(back, from, f.rest, card)}` : ""}`
      const rep = f.every ? repeater(f.every) : null
      if (f.every && !rep) title += ` 🔁 ${f.every}`
      if (f.scheduled) plan.scheduled = `<${f.scheduled} ${dayName(f.scheduled)}${rep ? ` ${rep}` : ""}>`
      if (f.due) plan.deadline = `<${f.due} ${dayName(f.due)}${rep && !f.scheduled ? ` ${rep}` : ""}>`
      lines = [title, ...lines.slice(1)]
    }
    // a %%SCHEDULED%% line keeps the time Logseq wrote
    const exact: { scheduled?: string; deadline?: string } = {}
    const conv = rest(back, from, t ? lines.slice(1) : lines, card, exact)
    for (const k of ["scheduled", "deadline"] as const) if (exact[k] && plan[k] && exact[k]!.slice(1, 11) === plan[k]!.slice(1, 11)) plan[k] = exact[k]
    const head = t ? title : conv[0] ?? ""
    const own = t ? conv : conv.slice(1)
    // its properties: the lines of them right after its title (one further down is text that looks like one)
    let run = 0
    while (run < own.length && PROP.test(own[run].trim())) run++
    const propLines = own.slice(0, run)
    const area = propLines.some((l) => /^hl-type::\s*area$/.test(l.trim())) && /^!\[[^\]]*\]\(.*\)(\{[^}]*\})?$/.test(head)
    if (b.numbered) props.push("logseq.order-list-type:: number")
    if (id) props.push(`id:: ${back.blockId(from, id)}`)
    const other = own.slice(run)
    const planning = [plan.scheduled && `SCHEDULED: ${plan.scheduled}`, plan.deadline && `DEADLINE: ${plan.deadline}`].filter((x): x is string => !!x)
    const all = [area ? "[:span]" : head, ...propLines, ...props, ...planning, ...other]
    const pad = "\t".repeat(depth)
    const blank = !all[0] && all.length > 1
    return [
      `${pad}-${blank ? ` ${all[1]}` : all[0] ? ` ${all[0]}` : ""}`,
      ...all.slice(blank ? 2 : 1).map((l) => (l ? `${pad}  ${l}` : `${pad}  `.trimEnd())),
      ...b.children.flatMap((c) => write(c, depth + 1)),
    ]
  }
  // paragraphs before the first list item: the page's first lines, as Logseq keeps text before its first bullet
  const lead = blocks.findIndex((b) => !b.para)
  const head = (lead < 0 ? blocks : blocks.slice(0, lead)).filter((b) => b.para && !b.children.length && b.lines.every((l) => !/^\s*(```|~~~|\$\$|%%)/.test(l)))
  const others = blocks.slice(head.length)
  const text = [...head.map((b) => b.lines.map((l) => lineBack(back, from, l)).join("\n")), ...others.flatMap((b) => write(b, 0))].join("\n")
  return { text, blocks: count }
}
