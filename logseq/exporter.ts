// Vaultite notes as a Logseq graph: pages/, journals/, assets/, draws/ and logseq/config.edn.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { zipFiles } from "@vaultite/core/plugins.ts"
import { type Entry, type Vault, writeAtomic } from "@vaultite/core/vault.ts"
import { writeDate } from "./dates.ts"
import { DEFAULT_CONFIG, type GraphConfig, graphConfig } from "./edn.ts"
import { type Back, blockText, propValue } from "./back.ts"
import { outlineOf } from "./markdown.ts"
import { labelOf } from "./labels.ts"
import { fileOfTitle, safePart } from "./names.ts"

export type ExportResult = { pages: number; journals: number; assets: number; blocks: number; zip?: Buffer }
type Note = { e: Entry; title: string | null; date: string | null }

const CONFIG = `{:meta/version 1
 :preferred-workflow :todo
 :file/name-format :triple-lowbar
 :journal/page-title-format "MMM do, yyyy"
 :journal/file-name-format "yyyy_MM_dd"}
`

/** A note's Logseq title: its path in the folder, or the alias that path was made from (a title with a ":" or "/"). */
function titleOf(path: string, fm: Record<string, unknown>, folder: string): string {
  const rel = (folder ? path.slice(folder.length + 1) : path).replace(/\.(md|org)$/i, "")
  const a = fm.aliases, aliases = (Array.isArray(a) ? a : a ? [a] : []).map(String)
  const made = aliases.find((x) => x.split("/").map(safePart).join("/").toLowerCase() === rel.toLowerCase())
  return made ?? rel
}

const uuidOf = (seed: string) => {
  const h = crypto.createHash("sha1").update(seed).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export async function exportGraph(vault: Vault, folder: string, opts: { journals: boolean; zip: boolean; out?: string }): Promise<ExportResult> {
  await vault.sync()
  const inFolder = (rel: string) => !folder || rel.startsWith(`${folder}/`)
  const cfgFile = folder ? `${folder}/.logseq/config.edn` : ".logseq/config.edn"
  let cfgText = fs.existsSync(vault.abs(cfgFile)) ? fs.readFileSync(vault.abs(cfgFile), "utf8") : CONFIG
  if (!/:file\/name-format/.test(cfgText)) cfgText = cfgText.replace("{", "{:file/name-format :triple-lowbar\n ")
  const cfg: GraphConfig = { ...DEFAULT_CONFIG, ...graphConfig(cfgText) }

  const days = new Map<string, string>()
  for (const d of vault.items("days")) if (typeof d.date === "string" && /^\d{4}-\d\d-\d\d$/.test(d.date)) days.set(`${String(d.id)}.md`, d.date)
  const notes: Note[] = []
  for (const e of vault.entries.values()) {
    if (!/\.md$/i.test(e.rel) || e.archived) continue
    const date = days.get(e.rel) ?? null
    if (date) { if (opts.journals) notes.push({ e, title: null, date }); continue }
    if (!inFolder(e.rel) || e.rel.includes("/.logseq/") || (e.fm.type === "cards" && String(e.fm.ext_id ?? "").startsWith("logseq-"))) continue
    notes.push({ e, title: titleOf(e.rel, e.fm, folder), date: null })
  }
  const byRel = new Map(notes.map((n) => [n.e.rel, n]))
  const files = new Map<string, Buffer | string>()
  const assets = new Map<string, string>()
  const ids = new Map<string, string>()
  const texts = new Map<string, string>()
  const attachments = (() => { const f = vault.configWithDefaults("files").attachmentFolder; return typeof f === "string" && f.trim() && !f.startsWith(".") ? f.trim().replace(/^\/+|\/+$/g, "") : "Attachments" })()

  const back: Back = {
    cfg,
    note: (target, from) => {
      const rel = vault.resolveLink(target, from)
      const n = rel ? byRel.get(rel) : undefined
      if (n) {
        const a = n.e.fm.aliases
        return { title: n.date ? writeDate(n.date, cfg.journalTitleFormat) : n.title!, rel: n.e.rel, aliases: (Array.isArray(a) ? a : a ? [a] : []).map(String).filter((x) => x !== n.title) }
      }
      if (rel && /\.org$/i.test(rel) && inFolder(rel)) return { title: titleOf(rel, {}, folder), rel, aliases: [] }
      if (rel && !/\.md$/i.test(rel)) return { file: copyAsset(rel) }
      return null
    },
    blockLabel: (rel, id) => {
      const text = texts.get(rel) ?? (fs.existsSync(vault.abs(rel)) ? fs.readFileSync(vault.abs(rel), "utf8") : "")
      texts.set(rel, text)
      const lines = text.split("\n")
      let at = lines.findIndex((l) => l.trimEnd().endsWith(`^${id}`) && /(^|\s)\^[\w-]+$/.test(l.trimEnd()))
      if (at < 0) return null
      // an id on a line of its own (after a code block, a table) marks the list item it's in
      if (/^\s*\^[\w-]+\s*$/.test(lines[at])) while (at > 0 && !/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[at])) at--
      return labelOf(lines[at])
    },
    blockId: (rel, id) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase()
      const k = `${rel}#${id}`
      if (!ids.has(k)) ids.set(k, uuidOf(k))
      return ids.get(k)!
    },
  }
  function copyAsset(rel: string): string {
    const had = assets.get(rel)
    if (had) return had.startsWith("draws/") ? had : `../${had}`
    const draw = /\.excalidraw$/i.test(rel)
    const inside = rel.startsWith(`${attachments}/`) ? rel.slice(attachments.length + 1) : rel.split("/").pop()!
    let name = draw ? `draws/${rel.split("/").pop()}` : `assets/${inside}`
    for (let k = 1; [...assets.values()].includes(name); k++) name = name.replace(/(\.[^./]+)?$/, ` ${k}$1`)
    assets.set(rel, name)
    if (fs.existsSync(vault.abs(rel))) files.set(name, fs.readFileSync(vault.abs(rel)))
    // a PDF's highlights: Logseq keeps their places beside it (x.edn) and area pictures in x/
    if (/\.pdf$/i.test(rel)) {
      const edn = rel.replace(/\.pdf$/i, ".edn")
      if (fs.existsSync(vault.abs(edn))) files.set(name.replace(/\.pdf$/i, ".edn"), fs.readFileSync(vault.abs(edn)))
    }
    return draw ? name : `../${name}`
  }

  let pages = 0, journals = 0, blocks = 0
  for (const n of notes) {
    const text = n.e.text || fs.readFileSync(vault.abs(n.e.rel), "utf8")
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "")
    const tree = outlineOf(body)
    const props: string[] = []
    for (const [k, v] of Object.entries(n.e.fm)) {
      if (k === "ext_id" || (n.date && (k === "type" || k === "date"))) continue
      if (k === "aliases") {
        const list = (Array.isArray(v) ? v : [v]).map(String).filter((x) => x !== n.title)
        if (list.length) props.push(`alias:: ${list.join(", ")}`)
        continue
      }
      const value = propValue(back, k, v, n.e.rel)
      if (value !== null) props.push(`${k}:: ${value}`)
    }
    const out = blockText(back, tree, n.e.rel)
    blocks += out.blocks
    const page = [...props, ...(props.length && out.text ? [""] : []), out.text].join("\n").trimEnd() + "\n"
    if (n.date) { files.set(`${cfg.journalsDir}/${writeDate(n.date, cfg.journalFileFormat)}.md`, page); journals++ }
    else { files.set(`${cfg.pagesDir}/${fileOfTitle(n.title!)}.md`, page); pages++ }
  }
  // .org pages kept from an import go back as they came
  for (const rel of listOthers(vault, folder)) { files.set(`${cfg.pagesDir}/${fileOfTitle(titleOf(rel, {}, folder))}.org`, fs.readFileSync(vault.abs(rel))); pages++ }
  files.set("logseq/config.edn", cfgText)
  const css = folder ? `${folder}/.logseq/custom.css` : ".logseq/custom.css"
  if (fs.existsSync(vault.abs(css))) files.set("logseq/custom.css", fs.readFileSync(vault.abs(css)))
  const result: ExportResult = { pages, journals, assets: assets.size, blocks }
  if (opts.zip) result.zip = zipFiles(Object.fromEntries(files))
  else if (opts.out) for (const [name, data] of files) { const f = path.join(opts.out, ...name.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, data) }
  return result
}

function listOthers(vault: Vault, folder: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    const abs = vault.abs(dir || ".")
    if (!fs.existsSync(abs)) return
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith(".")) continue
      const rel = dir ? `${dir}/${d.name}` : d.name
      if (d.isDirectory()) walk(rel)
      else if (/\.org$/i.test(d.name)) out.push(rel)
    }
  }
  walk(folder)
  return out
}
