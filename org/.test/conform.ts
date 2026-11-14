// Each corpus/**/*.org parsed by us and by Emacs (cached in expected/), the trees compared node by node.
//   node org/.test/conform.ts [filter...] [--elements | --objects] [--max 5] [--quiet]
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parse } from "../parser/index.ts"
import { makeCtx } from "../parser/driver.ts"
import { settingsOf } from "../parser/settings.ts"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const CORPUS = path.join(HERE, "corpus"), EXPECTED = path.join(HERE, "expected")
const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const maxAt = args.indexOf("--max"), MAX = maxAt >= 0 ? Number(args[maxAt + 1]) : 5
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--max")
const MODE = flag("--elements") ? "elements" : flag("--objects") ? "objects" : "full"

export const OBJECTS = new Set(["bold", "citation", "citation-reference", "code", "entity", "export-snippet", "footnote-reference",
  "inline-babel-call", "inline-src-block", "italic", "line-break", "latex-fragment", "link", "macro", "radio-target",
  "statistics-cookie", "strike-through", "subscript", "superscript", "table-cell", "target", "timestamp", "underline", "verbatim"])

type J = null | boolean | number | string | J[] | { [k: string]: J }
type Obj = { [k: string]: J }

const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith(".org") ? [path.join(d, e.name)] : []).sort()

let emacs: boolean | null = null
const hasEmacs = () => emacs ??= (() => { try { execFileSync("emacs", ["--version"], { stdio: "ignore" }); return true } catch { return false } })()

/** Emacs's tree for each file, from the cache when its sample hasn't changed. */
function expected(list: string[]): Map<string, Obj> {
  const out = new Map<string, Obj>(), todo: [string, string, string][] = []
  for (const f of list) {
    const rel = path.relative(CORPUS, f), hash = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16)
    const cache = path.join(EXPECTED, rel.replace(/\.org$/, ".json"))
    try {
      const c = JSON.parse(fs.readFileSync(cache, "utf8"))
      if (c.hash === hash) { out.set(f, c.tree); continue }
    } catch { /* not cached */ }
    todo.push([f, cache, hash])
  }
  if (todo.length && !hasEmacs()) { console.log(`skipped ${todo.length} samples: not cached and no emacs here`); return out }
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50), tmp = chunk.map(([, c]) => `${c}.raw`)
    for (const t of tmp) fs.mkdirSync(path.dirname(t), { recursive: true })
    execFileSync("emacs", ["-Q", "--batch", "-l", path.join(HERE, "oracle/dump.el"), ...chunk.flatMap(([f], j) => [f, tmp[j]])], { stdio: ["ignore", "ignore", "pipe"] })
    chunk.forEach(([f, cache, hash], j) => {
      const tree = toUtf16(JSON.parse(fs.readFileSync(tmp[j], "utf8")), fs.readFileSync(f, "utf8"))
      fs.rmSync(tmp[j])
      fs.writeFileSync(cache, JSON.stringify({ hash, tree }) + "\n")
      out.set(f, tree)
    })
  }
  return out
}

const POS = new Set(["begin", "end", "contents-begin", "contents-end", "post-affiliated"])

/** Emacs counts characters; the parser counts UTF-16 units, as JavaScript and CodeMirror do. */
function toUtf16(tree: Obj, text: string): Obj {
  const cps = Array.from(text)
  if (cps.length === text.length) return tree
  const map: number[] = [0]
  for (const c of cps) map.push(map[map.length - 1] + c.length)
  const fix = (v: J): J => Array.isArray(v) ? v.map(fix) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, POS.has(k) && typeof x === "number" ? map[x] : fix(x)])) : v
  return fix(tree) as Obj
}

const camel = (k: string) => k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

/** Emacs's node in the parser's names: camelCase, upper-case keys in `properties`. */
function fromEmacs(v: J): J {
  if (Array.isArray(v)) return v.map(fromEmacs)
  if (!v || typeof v !== "object") return v
  const out: Obj = {}, props: Obj = {}
  for (const [k, x] of Object.entries(v)) {
    if (!/^[a-z][a-z0-9-]*$/.test(k)) { if (x !== null) props[k] = x; continue }
    out[k === "type" ? "type" : camel(k)] = fromEmacs(x)
  }
  if (Object.keys(props).length) out.properties = props
  return out
}

/** The parser's node as plain JSON: plain text as its string, as Emacs gives it. */
function fromOurs(v: unknown): J {
  if (Array.isArray(v)) return v.map(fromOurs)
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, fromOurs(x)]))
  if (!v || typeof v !== "object") return (v ?? null) as J
  const o = v as Obj
  if (o.type === "plain-text") return o.value
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fromOurs(x)]))
}

const isNode = (v: J): v is Obj => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string"
const isObjectish = (v: J) => typeof v === "string" || (isNode(v) && OBJECTS.has(v.type as string))

/** Elements only: objects, and values holding them (titles, tags, timestamps), left out. */
function elementsOnly(v: J): J {
  if (!isNode(v)) return v
  const out: Obj = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === "children") out.children = (x as J[]).filter((c) => !isObjectish(c)).map(elementsOnly)
    else if (isNode(x) && OBJECTS.has(x.type as string)) continue
    else if (Array.isArray(x) && x.some((c) => isObjectish(c) || (Array.isArray(c) && c.some(isObjectish)))) continue
    else out[k] = x
  }
  return out
}

type Diff = { at: string; want: J; got: J }

const same = (a: J, b: J) => (a ?? null) === (b ?? null) || (a === null && b === false) || (a === false && b === null)
const label = (n: Obj) => `${n.type}@${n.begin}`

/** What differs, Emacs's keys only (the parser may carry more). */
function diff(want: J, got: J, at: string, out: Diff[]) {
  if (out.length > 200) return
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) { out.push({ at, want: brief(want), got: brief(got) }); return }
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const w = want[i], g = got[i]
      if (w === undefined || g === undefined) { out.push({ at: `${at}[${i}]`, want: brief(w ?? null), got: brief(g ?? null) }); break }
      diff(w, g, `${at}[${i}]${isNode(w) ? ` ${label(w)}` : ""}`, out)
    }
    return
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object" || Array.isArray(got)) { out.push({ at, want: brief(want), got: brief(got) }); return }
    if (isNode(want) && want.type !== got.type) { out.push({ at: `${at}.type`, want: want.type, got: got.type ?? null }); return }
    for (const [k, w] of Object.entries(want)) diff(w, got[k] ?? null, `${at}.${k}`, out)
    return
  }
  if (!same(want, got)) out.push({ at, want, got })
}

const brief = (v: J): J => isNode(v) ? `<${v.type} ${v.begin}-${v.end}>` : Array.isArray(v) ? `[${v.length} items]` : v

/** Every element whose children are objects, from Emacs's tree: what --objects checks our objects in. */
function objectHosts(v: J, out: Obj[] = []): Obj[] {
  if (!isNode(v)) return out
  const kids = (v.children ?? []) as J[]
  if (!OBJECTS.has(v.type as string) && kids.length && kids.some(isObjectish) && typeof v.contentsBegin === "number") out.push(v)
  for (const c of kids) objectHosts(c, out)
  return out
}

function check(file: string, tree: Obj): Diff[] {
  const text = fs.readFileSync(file, "utf8"), want = fromEmacs(tree) as Obj, out: Diff[] = []
  if (MODE === "objects") {
    const ctx = makeCtx(text, settingsOf(text))
    for (const h of objectHosts(want)) {
      let got: J
      try { got = fromOurs(ctx.objects(h.contentsBegin as number, h.contentsEnd as number, h.type as string)) } catch (e) { got = `threw ${(e as Error).message}` }
      diff(h.children as J, got, label(h), out)
    }
    return out
  }
  let got: J
  try { got = fromOurs(parse(text)) } catch (e) { return [{ at: "parse", want: "a tree", got: `threw ${(e as Error).stack?.split("\n").slice(0, 4).join(" | ")}` }] }
  if (MODE === "elements") diff(elementsOnly(want), elementsOnly(got), "", out)
  else diff(want, got, "", out)
  return out
}

const all = files(CORPUS).filter((f) => !filters.length || filters.some((x) => path.relative(CORPUS, f).includes(x)))
const trees = expected(all)
let pass = 0, fail = 0
for (const f of all) {
  const tree = trees.get(f)
  if (!tree) continue
  const d = check(f, tree), rel = path.relative(CORPUS, f)
  if (!d.length) { pass++; if (!flag("--quiet")) console.log(`ok   ${rel}`); continue }
  fail++
  console.log(`FAIL ${rel} (${d.length >= 200 ? "200+" : d.length} differences)`)
  for (const x of d.slice(0, MAX)) console.log(`     ${x.at || "(root)"}: want ${JSON.stringify(x.want)}, got ${JSON.stringify(x.got)}`)
}
console.log(`\n${MODE}: ${pass} of ${pass + fail} samples match Emacs`)
process.exitCode = fail ? 1 : 0
