// Code stats: lines in each project's checkout (`path:`), split into code, tests, comments, docs; cached, recounted after
// 15 min. Repos under ~/Documents aren't readable under launchd: they keep the counts they had.
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bullets, Plugin } from "@vaultite/core/plugins.ts"
import { type Item } from "@vaultite/core/vault.ts"

export const plugin = new Plugin(import.meta.url)
const TTL = 900
const HOME = os.homedir()
const MAX_BYTES = 1_000_000 // bigger files are generated or data
let refreshing = false

type Syntax = { line?: string[]; block?: [string, string] }
const C: Syntax = { line: ["//"], block: ["/*", "*/"] }
const HASH: Syntax = { line: ["#"] }
/** Extension: [language, comment syntax]. Files with other extensions aren't counted (JSON, lockfiles, images...). */
const LANGS: Record<string, [string, Syntax | "docs"]> = {
  ts: ["TypeScript", C], tsx: ["TypeScript", C], mts: ["TypeScript", C], cts: ["TypeScript", C],
  js: ["JavaScript", C], jsx: ["JavaScript", C], mjs: ["JavaScript", C], cjs: ["JavaScript", C],
  swift: ["Swift", C], go: ["Go", C], rs: ["Rust", C], java: ["Java", C], kt: ["Kotlin", C], cs: ["C#", C],
  c: ["C", C], h: ["C", C], cc: ["C++", C], cpp: ["C++", C], hpp: ["C++", C], m: ["Objective-C", C], php: ["PHP", C],
  css: ["CSS", { block: ["/*", "*/"] }], scss: ["CSS", C], less: ["CSS", C],
  html: ["HTML", { block: ["<!--", "-->"] }], vue: ["Vue", { block: ["<!--", "-->"] }], svelte: ["Svelte", { block: ["<!--", "-->"] }],
  py: ["Python", HASH], rb: ["Ruby", HASH], sh: ["Shell", HASH], bash: ["Shell", HASH], zsh: ["Shell", HASH],
  r: ["R", HASH], pl: ["Perl", HASH], yml: ["YAML", HASH], yaml: ["YAML", HASH], toml: ["TOML", HASH],
  sql: ["SQL", { line: ["--"], block: ["/*", "*/"] }], lua: ["Lua", { line: ["--"] }], tex: ["TeX", { line: ["%"] }],
  md: ["Markdown", "docs"], mdx: ["Markdown", "docs"], rst: ["reStructuredText", "docs"], txt: ["Text", "docs"],
}
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e|qa|fixtures|testdata)\//i
const TEST_FILE = /(^|[._/-])(test|spec)s?[._-][^/]*$|^test_|\/test_[^/]*$/i
const TEST_CLASS = /[a-z]Tests?\.(swift|kt|java|cs|m)$/ // FooTests.swift
const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage)\/|\.min\.(js|css)$|(^|\/)(package-lock|yarn\.lock|pnpm-lock)/

/** [code, comment] lines of one file's text (blank lines are neither). */
export function countLines(text: string, syntax: Syntax): [number, number] {
  let code = 0, comment = 0, open: string | null = null
  for (const raw of text.split("\n")) {
    let s = raw.trim()
    if (!s) continue
    let hasCode = false, hasComment = false
    while (s) {
      if (open) {
        hasComment = true
        const end = s.indexOf(open)
        if (end < 0) { s = ""; break }
        s = s.slice(end + open.length).trim()
        open = null
        continue
      }
      const b = syntax.block
      if (b && s.startsWith(b[0])) { open = b[1]; s = s.slice(b[0].length); continue }
      if (syntax.line?.some((l) => s.startsWith(l))) { hasComment = true; break }
      hasCode = true
      if (b && s.includes(b[0]) && !s.includes(b[1], s.indexOf(b[0]))) open = b[1] // a block opened after code
      break
    }
    if (hasCode) code++
    else if (hasComment) comment++
  }
  return [code, comment]
}

function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("/usr/bin/git", ["-C", dir, ...args], { timeout: 30000, maxBuffer: 64 << 20 }, (err, stdout) => resolve(err ? "" : stdout))
  })
}

export type Counts = { code: number; tests: number; comments: number; docs: number; files: number }
const zero = (): Counts => ({ code: 0, tests: 0, comments: 0, docs: 0, files: 0 })

/** The counts of a git checkout: totals, and by language (most lines first); null if it isn't one. */
export async function countRepo(dir: string): Promise<Item | null> {
  const head = (await git(dir, "rev-parse", "HEAD")).trim()
  if (!head) return null
  const files = (await git(dir, "ls-files", "-z")).split("\0").filter((f) => f && !SKIP.test(f))
  const total = zero(), langs: Record<string, Counts> = {}
  for (const f of files) {
    const ext = path.extname(f).slice(1).toLowerCase()
    const lang = LANGS[ext]
    if (!lang) continue
    let text: string
    try {
      const buf = await readFile(path.join(dir, f))
      if (buf.length > MAX_BYTES || buf.includes(0)) continue
      text = buf.toString("utf8")
    } catch { continue } // deleted but not staged, a submodule
    const [name, syntax] = lang
    const l = (langs[name] ??= zero())
    const add = (k: keyof Counts, n: number) => { total[k] += n; l[k] += n }
    add("files", 1)
    if (syntax === "docs") {
      add(TEST_DIR.test(f) ? "tests" : "docs", text.split("\n").filter((s) => s.trim()).length)
      continue
    }
    const [code, comments] = countLines(text, syntax)
    if (TEST_DIR.test(f) || TEST_FILE.test(f) || TEST_CLASS.test(f)) add("tests", code + comments)
    else { add("code", code); add("comments", comments) }
  }
  const lines = (c: Counts) => c.code + c.tests + c.comments + c.docs
  const languages = Object.entries(langs).map(([name, c]) => ({ name, ...c, lines: lines(c) }))
    .filter((x) => x.lines).sort((a, b) => b.lines - a.lines)
  return { head, ...total, lines: lines(total), languages }
}

async function build(projects: Item[], old: Item) {
  const out: Item = {}
  for (const p of projects) {
    if (!p.path) continue
    const dir = String(p.path).replace(/^~(?=$|\/)/, HOME)
    if (dir.startsWith(`${HOME}/Documents/`)) {
      if (old[p.slug]) out[p.slug] = old[p.slug]
      continue
    }
    const counted = await countRepo(dir)
    if (counted) out[p.slug] = { ...counted, counted_at: new Date().toISOString() }
    else if (old[p.slug]) out[p.slug] = old[p.slug] // not checked out on this machine: keep another machine's count
  }
  return { projects: out, updated_at: new Date().toISOString().replace(/\.\d+Z$/, "+00:00") }
}

async function refresh(projects: Item[]) {
  if (refreshing) return
  refreshing = true
  try {
    plugin.writeCache(await build(projects, plugin.readCache()?.projects ?? {}))
  } catch (e) {
    console.error(`code-stats: refresh failed: ${(e as Error).message}`)
  } finally {
    refreshing = false
  }
}

/** {"projects": {slug: {head, lines, code, tests, comments, docs, files, languages}}, "updated_at"}: the cache,
 *  recounted in the background when stale. */
plugin.route("GET", "code-stats", () => {
  const cache = plugin.readCache() ?? {}
  const age = cache.updated_at ? (Date.now() - Date.parse(cache.updated_at)) / 1000 : 1e9
  if (!(age <= TTL)) void refresh(plugin.vault.items("projects"))
  return Object.keys(cache).length ? cache : { projects: {}, updated_at: null }
})

function projectOf(ctx: { options: Item; path: string }) {
  const name = String(ctx.options.project || "").toLowerCase()
  const ps = plugin.vault.has("projects") ? plugin.vault.items("projects") : []
  return ps.find((p) => (name ? p.name.toLowerCase() === name : p.id + ".md" === ctx.path)) ?? null
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "0%")

plugin.block("code-stats", (ctx) => {
  const p = projectOf(ctx)
  const s: Item | null = p ? plugin.readCache()?.projects?.[p.slug] : null
  if (!s) return p ? (p.path ? "_Not counted yet._" : "_No local checkout: add a `path` to this project._") : ""
  const parts = [bullets([
    `Lines: ${s.lines} in ${s.files} files`,
    ...(["code", "tests", "comments", "docs"] as const).map((k) => `${k[0].toUpperCase() + k.slice(1)}: ${s[k]} (${pct(s[k], s.lines)})`),
  ])]
  const n = Number.isInteger(ctx.options.languages) ? ctx.options.languages : 4
  const langs: Item[] = (s.languages ?? []).slice(0, n)
  if (langs.length) parts.push("Languages:\n" + bullets(langs.map((l) => `${l.name}: ${l.lines} lines (${pct(l.lines, s.lines)})`)))
  return parts.join("\n\n")
})
