// Templater on the server: the Templates plugin's `template:expand` runs a template's commands (prompts in the user's
// window, through ui.choose), folder templates fill new notes, and `templater.new` makes a note for an agent.
import fs from "node:fs"
import { OpError, Plugin, type Request } from "@vaultite/core/plugins.ts"
import { CURSOR, run, type Host, type Mode } from "./tp.ts"

export const plugin = new Plugin(import.meta.url)

const FM = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/
const v = () => plugin.vault
const read = (p: string) => fs.promises.readFile(v().abs(p), "utf8").catch(() => null)
type Ask = Pick<Host, "prompt" | "suggest">

/** A Host over the vault: `ask` is who answers the prompts (the user's window, or an agent's answers). */
function host(template: string, target: string, mode: Mode, ask: Ask): Host {
  return {
    template, target, mode, now: new Date(), abs: (p) => v().abs(p), read, ...ask,
    resolve: (link) => {
      const k = link.trim().replace(/\.md$/i, "").toLowerCase()
      const all = [...v().entries.keys()]
      return all.find((p) => p.toLowerCase() === `${k}.md`) ?? all.find((p) => p.toLowerCase().endsWith(`/${k}.md`)) ?? null
    },
    file: (p) => {
      const e = v().entries.get(p)
      return e ? { fm: e.fm, tags: e.tags, created: e.stat.born, modified: Number(e.stat.ns / 1000000n) } : null
    },
  }
}

/** Prompts in the window the user was in last (the app's palette): their answer, or null when dismissed. */
function inWindow(req?: Request): Ask {
  const choose = (params: Record<string, unknown>) => plugin.runOp("ui.choose", params, undefined, req?.http).then((r) => r.result, () => null) as
    Promise<{ picked: { index: number; label: string } | null; typed: string | null } | null>
  return {
    prompt: async (question, value) => {
      const r = await choose({ prompt: question || "Your answer", items: value ? [value] : [], current: value ?? undefined, other: true })
      return r?.typed ?? r?.picked?.label ?? null
    },
    suggest: async (labels, placeholder) => {
      const r = await choose({ prompt: placeholder || undefined, items: labels.map((l, i) => ({ id: String(i), label: l.trim() || "(empty)" })) })
      return r?.picked ? r.picked.index : null
    },
  }
}

/** Prompts answered by an agent's `answers`, by question (a suggester's by its placeholder: the label, or the item). */
function given(answers: Record<string, unknown>, unanswered: string[]): Ask {
  const take = (q: string) => { if (Object.hasOwn(answers, q)) return answers[q]; unanswered.push(q); return undefined }
  return {
    prompt: async (q, value) => { const a = take(q); return a === undefined ? value : String(a) },
    suggest: async (labels, ph, items) => {
      const a = take(ph)
      if (a === undefined) return null
      const i = labels.indexOf(String(a)), j = items.findIndex((x) => String(x) === String(a))
      return i >= 0 ? i : j >= 0 ? j : null
    },
  }
}

const notice = (skipped: { why: string }[]) => !skipped.length ? undefined : skipped.length === 1
  ? `Templater left a command as written: it ${skipped[0].why}.` : `Templater left ${skipped.length} commands as written: they need JavaScript Vaultite doesn't run.`

/** The templates folder (the Templates plugin's), and a template by name or path in it. */
const folder = () => plugin.ask("templates:folder", "Templates")
async function templatePath(name: string) {
  const dir = await folder(), n = name.trim().replace(/^\/+/, "").replace(/\.md$/i, "")
  const all = [...v().entries.keys()]
  return [`${n}.md`, `${dir}/${n}.md`].find((p) => v().entries.has(p)) ?? all.find((p) => p.startsWith(`${dir}/`) && p.toLowerCase().endsWith(`/${n.toLowerCase()}.md`)) ?? null
}

/** A template's {{date}}s filled and its frontmatter merged into `into`'s, as the Templates plugin does. */
const fill = (text: string, title: string, into = ""): string => plugin.peer("templates")?.exports.fill?.(text, title, into) ?? text

// Notes the app just made from a template here: their commands ran already.
const expanded = new Set<string>()

plugin.provide("template:expand", async (b: { text?: string; template?: string; path?: string; mode?: string }, req?: Request) => {
  const r = await run(String(b.text ?? ""), host(String(b.template ?? ""), String(b.path ?? ""), b.mode === "insert" ? "insert" : "new", inWindow(req)))
  if (!r) return null
  if (b.mode !== "insert") { expanded.add(r.path); setTimeout(() => expanded.delete(r.path), 60_000) }
  return { text: r.text, path: r.path, notice: notice(r.skipped) }
})

// ---------- new notes: folder templates, and commands in notes other plugins make

type Settings = { onCreate: boolean; folders: Record<string, string> }
/** Its settings, else Obsidian's Templater's in a vault that also opens there. */
function settings(): Settings {
  const own = plugin.settings({}) as { onCreate?: unknown; folderTemplates?: unknown }
  let theirs: { trigger_on_file_creation?: boolean; enable_folder_templates?: boolean; folder_templates?: { folder: string; template: string }[] } = {}
  try { theirs = JSON.parse(fs.readFileSync(v().abs(".obsidian/plugins/templater-obsidian/data.json"), "utf8")) } catch { /* (none) */ }
  const folders = own.folderTemplates && typeof own.folderTemplates === "object" ? own.folderTemplates as Record<string, string>
    : theirs.trigger_on_file_creation && theirs.enable_folder_templates !== false
      ? Object.fromEntries((theirs.folder_templates ?? []).filter((f) => f.folder && f.template).map((f) => [f.folder, f.template])) : {}
  return { onCreate: typeof own.onCreate === "boolean" ? own.onCreate : !!theirs.trigger_on_file_creation, folders }
}

/** The template of the deepest folder holding `path` ("/" holds every note). */
function folderTemplate(path: string, folders: Record<string, string>) {
  const hit = Object.keys(folders).map((f) => f.replace(/^\/+|\/+$/g, "")).filter((f) => !f || path.startsWith(`${f}/`)).sort((a, b) => b.length - a.length)[0]
  return hit === undefined ? null : folders[hit] ?? folders[`/${hit}`] ?? folders[`${hit}/`] ?? folders["/"]
}

async function created(path: string, agent: boolean) {
  await v().lock(async () => {}) // (after the write that made it)
  if (expanded.has(path) || path.startsWith(`${await folder()}/`)) return
  const s = settings(), text = await read(path)
  if (text == null) return
  let template = path, src = text
  if (!text.replace(FM, "").trim()) {
    const name = folderTemplate(path, s.folders), t = name && await templatePath(name)
    const body = t && await read(t)
    if (!t || body == null) return
    template = t
    src = fill(body, path.slice(path.lastIndexOf("/") + 1, -3), text)
  } else if (!s.onCreate || agent || !text.includes("<%")) return
  const r = await run(src, host(template, path, "create", inWindow()))
  if (!r || r.text === text) return
  await plugin.runOp("file.write", { path, text: r.text, base: text })
  if (r.path !== path) await plugin.runOp("file.move", { from: path, to: r.path })
}

plugin.onCreate((path, _fm, writer) => {
  if (path.endsWith(".md")) setImmediate(() => void created(path, !!writer?.agent).catch((e) => console.error("templater:", e)))
})

// ---------- for agents

plugin.op({
  id: "templater.new",
  cli: "templater new",
  mcp: true,
  summary: "Make a note from one of the user's Templater templates (<% %>), its prompts answered.",
  help: `Runs a template of the Templates folder as the app would (dates, tp.file, includes; JavaScript beyond Templater's
common commands is left as written) into a new note. Prompts and suggesters take their answers from answers, by their
question (a suggester's placeholder): the text, or the label or item picked. An unanswered prompt gets its default;
the answer lists them.

  vau templater new Meeting --title "Lighthouse review" --answers '{"Topic": "Budget", "Kind of meeting": "Team sync"}'`,
  kind: "write",
  params: {
    template: { type: "string", required: true, description: "the template: its name in the templates folder, or its path" },
    title: { type: "string", description: "the new note's name (a template may rename it)" },
    folder: { type: "string", description: "where it goes (else where notes of the template's type are, else the top)" },
    answers: { type: "object", description: "the prompts' answers, by question: {\"Topic\": \"Budget\"}" },
  },
  args: ["template"],
  run: async ({ template, title, folder: dir, answers }, ctx) => {
    const t = await templatePath(String(template)), tdir = await folder()
    const src = t && await read(t)
    if (!t || src == null) throw new OpError(`no template "${template}" in ${tdir}/: vau files ${tdir} lists them`)
    const type = /^type:[ \t]*["']?([\w-]+)/m.exec(FM.exec(src)?.[0] ?? "")?.[1]
    const where = String(dir ?? (type && [...v().entries.values()].find((e) => e.type === type && !e.rel.startsWith(`${tdir}/`))?.rel.replace(/\/?[^/]*$/, "")) ?? "").replace(/^\/+|\/+$/g, "")
    const name = String(title ?? "Untitled").trim() || "Untitled"
    const unanswered: string[] = []
    const r = await run(fill(src, name), host(t, `${where ? `${where}/` : ""}${name}.md`, "new", given((answers ?? {}) as Record<string, unknown>, unanswered)))
    if (!r) throw new OpError("the template stopped: a prompt it can't go on without has no answer (answers)")
    if (v().entries.has(r.path)) throw new OpError(`${r.path} is there already: give another title`)
    await ctx.op("file.write", { path: r.path, text: r.text.replace(CURSOR, "") })
    return { path: r.path, unanswered, notRun: r.skipped.map((s) => s.raw) }
  },
  text: (r: { path: string; unanswered: string[]; notRun: string[] }) => [`Made ${r.path}`,
    ...r.unanswered.map((q) => `- no answer for "${q}": its default`), ...r.notRun.map((c) => `- left as written: ${c}`)].join("\n"),
})
