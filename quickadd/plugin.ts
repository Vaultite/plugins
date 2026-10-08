// Quick add on the server: the choices in the store (its settings, else Obsidian QuickAdd's), and `quickadd.run`, which
// the app's commands and agents both run: what a format asks is asked in the user's window (`ask`) or given.
import fs from "node:fs"
import { OpError, Plugin, type OpCtx } from "@vaultite/core/plugins.ts"
import { asks, fillIn, fromQuickAdd, insert, type Choice } from "./choices.ts"

export const plugin = new Plugin(import.meta.url)
const v = () => plugin.vault
const read = (p: string) => fs.promises.readFile(v().abs(p), "utf8").catch(() => null)

/** Its own choices, else QuickAdd's (`from` says which). */
export function choices(): { choices: Choice[]; from: "own" | "quickadd" | null } {
  const own = plugin.settings({}).choices
  if (Array.isArray(own)) return { choices: own as Choice[], from: "own" }
  try {
    const qa = JSON.parse(fs.readFileSync(v().abs(".obsidian/plugins/quickadd/data.json"), "utf8"))
    return { choices: fromQuickAdd(qa.choices), from: "quickadd" }
  } catch { return { choices: [], from: null } }
}
plugin.state(() => ({ quickadd: choices() }))

type Run = { name: string; answers: Record<string, string>; ask: boolean; current?: string; ctx: OpCtx }

/** The user's pick or text in their window's palette (no items: text), or a refusal saying what to give. */
async function question(r: Run, q: string, items: string[] = []) {
  if (!r.ask) throw new OpError(q ? `${r.name} asks "${q}": give it in values ({"${q}": "..."})` : `${r.name} asks for a value: give value`)
  const a = await r.ctx.op("ui.choose", { prompt: items.length || !q ? r.name : q, items, other: !items.length }) as { picked: { label: string } | null; typed: string | null }
  const got = a?.typed ?? a?.picked?.label
  if (got == null) throw new OpError("Cancelled")
  return got
}

/** A format filled: its questions asked once a run, then the Templates plugin's {{date}}, {{time}}, {{title}}. */
async function fill(r: Run, format: string, title: string) {
  for (const q of asks(format)) {
    if (r.answers[q] !== undefined) continue
    const pick = q.includes(",") ? q.split(",").map((x) => x.trim()) : []
    r.answers[q] = await question(r, q, pick)
  }
  const text = fillIn(format, r.answers, r.current)
  return plugin.peer("templates")?.exports.fill?.(text, title) ?? text
}

const md = (p: string) => (/\.[^/]+$/.test(p) ? p : `${p}.md`)
const clean = (p: string) => p.trim().replace(/^\/+|\/+$/g, "")

async function capture(c: Choice, r: Run) {
  const path = c.file?.trim() ? md(clean(await fill(r, c.file, ""))) : r.current
  if (!path) throw new OpError(`${c.name} adds to the open note: give file`)
  const text = (await fill(r, c.format || "{{VALUE}}", path.replace(/^.*\/|\.md$/g, ""))).replace(/\n+$/, "")
  const base = await read(path)
  await r.ctx.op("file.write", { path, text: insert(base ?? "", text, c.heading, c.prepend), ...(base !== null && { base }) })
  return path
}

async function fromTemplate(c: Choice, r: Run) {
  const dir = await plugin.ask("templates:folder", "Templates"), n = clean(c.template ?? "").replace(/\.md$/i, "")
  const t = [`${n}.md`, `${dir}/${n}.md`].find((p) => n && v().entries.has(p))
  const src = t && await read(t)
  if (!t || src == null) throw new OpError(`${c.name}'s template "${c.template ?? ""}" isn't there: fix it in the Quick add settings`)
  const name = (await fill(r, c.nameFormat || "{{VALUE}}", "")).replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "Untitled"
  const where = clean(c.folder ? await fill(r, c.folder, name) : "")
  let path = md(`${where ? `${where}/` : ""}${name}`)
  for (let i = 1; fs.existsSync(v().abs(path)); i++) path = md(`${where ? `${where}/` : ""}${name} ${i}`)
  const text = await fill(r, src, name)
  // (Templater's <% %>, when it's on)
  const x = await plugin.ask("template:expand", { text, path }, { text, template: t, path, mode: "new" })
  if (!x) throw new OpError("Cancelled")
  await r.ctx.op("file.write", { path: x.path || path, text: x.text })
  return x.path || path
}

const find = (list: Choice[], name: string) =>
  list.find((c) => c.id === name) ?? list.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())

plugin.op({
  id: "quickadd.run",
  cli: "quickadd",
  mcp: true,
  summary: "Run one of the user's Quick add choices: add text to a note (a capture), or make a note from a template.",
  help: `A choice's format asks for {{VALUE}} (value) and named {{VALUE:Topic}}s (values, by name); {{DATE}},
{{DATE:YYYY-MM-DD}}, {{TIME}}, {{LINKCURRENT}} (file, the open note) are filled in. A group (multi) needs one of its
choices named instead. Answers the note's path. \`vau quickadd list\` lists the choices.

  vau quickadd "Log idea" "Ask Alice Park about Lighthouse"
  vau quickadd Meeting --values '{"Topic": "Budget"}'`,
  kind: "write",
  lock: false,
  params: {
    choice: { type: "string", required: true, description: "the choice, by name or id" },
    value: { type: "string", description: "what {{VALUE}} (and {{NAME}}) is" },
    values: { type: "object", description: "named values, {\"Topic\": \"Budget\"}" },
    file: { type: "string", format: "path", description: "the open note: {{LINKCURRENT}}, and where a capture without a file goes" },
    ask: { type: "boolean", description: "ask the user in their window for what's missing (the app's commands do)" },
  },
  args: ["choice", "value"],
  run: async (p, ctx) => {
    const list = choices().choices
    const named = find(list, String(p.choice))
    if (!named) throw new OpError(`There's no choice "${p.choice}": ${list.map((x) => x.name).join(", ") || "none yet"}`)
    let c: Choice = named
    const r: Run = { name: named.name, answers: { ...(p.values ?? {}), ...(p.value !== undefined && { "": String(p.value) }) }, ask: !!p.ask, current: p.file || undefined, ctx }
    for (let depth = 0; c.type === "multi"; depth++) {
      const subs = (c.choices ?? []).map((n) => find(list, n)).filter((x): x is Choice => !!x)
      if (!r.ask || depth > 5) throw new OpError(`${c.name} is a group: run one of ${subs.map((x) => x.name).join(", ")}`)
      const label = await question(r, "", subs.map((x) => x.name))
      c = subs.find((x) => x.name === label)!
      r.name = c.name
    }
    const path = c.type === "capture" ? await capture(c, r) : await fromTemplate(c, r)
    return { choice: c.name, path, open: c.open ?? c.type === "template" }
  },
  text: (r) => `${r.choice}: ${r.path}`,
})

plugin.op({
  id: "quickadd.list",
  cli: "quickadd list",
  mcp: false,
  summary: "The user's Quick add choices: each one's name, kind and what it asks for.",
  kind: "read",
  run: async () => choices(),
  text: (r) => r.choices.map((c: Choice) => `- ${c.name} (${c.type}${c.type === "capture" ? `, to ${c.file || "the open note"}` : c.type === "template" ? `, from ${c.template}` : `: ${(c.choices ?? []).join(", ")}`})`
    + (asks(`${c.file ?? ""}${c.format ?? ""}${c.nameFormat ?? ""}`).length ? `: asks ${asks(`${c.file ?? ""}${c.format ?? ""}${c.nameFormat ?? ""}`).map((q) => q || "a value").join(", ")}` : "")).join("\n") || "No choices yet.",
})
