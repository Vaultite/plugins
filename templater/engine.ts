// Templater's commands without running JavaScript: `<% expr %>` is written out, `<%* code %>` runs, where code is a
// small safe part of JavaScript read and evaluated here (let/const, =, +=, if/else, tR, operators, strings and their
// methods, calls of the tp API). As in Templater, the whole template is one program (an `if {` in one command can end
// in another). Anything else (loops, functions, app, moment) isn't run: its command stays as written.

/** A command that needs more JavaScript than this runs; `at`: which of the template's parts. */
export class Unsupported extends Error { at?: number }
/** The user cancelled a prompt that ends the template (`throw_on_cancel`). */
export class Cancelled extends Error {}

// ---------- the template's parts

export type Part = { text: string } | { code: string; run: boolean; raw: string }

/** Where the code that starts at `i` ends: at `stop` (the first one outside strings and comments), or -1. */
function scan(src: string, i: number, stop: string): number {
  while (i < src.length) {
    const c = src[i]
    if (src.startsWith(stop, i)) return i
    if (c === "'" || c === '"' || c === "`") i = skipString(src, i)
    else if (src.startsWith("//", i)) { // (to the line's end, or a command's)
      const n = src.indexOf("\n", i), e = stop === "%>" ? src.indexOf(stop, i) : -1
      i = e >= 0 && (n < 0 || e < n) ? e : n < 0 ? src.length : n
    }
    else if (src.startsWith("/*", i)) { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2 }
    else i++
  }
  return -1
}
/** Past the string (or template literal) that starts at `i`. */
function skipString(src: string, i: number): number {
  const q = src[i]
  for (i++; i < src.length; i++) {
    if (src[i] === "\\") i++
    else if (src[i] === q) return i + 1
    else if (q === "`" && src.startsWith("${", i)) { const e = scan(src, i + 2, "}"); if (e < 0) return src.length; i = e }
  }
  return i
}

/** A template's text and commands, with the whitespace control applied (`-` one newline, `_` all whitespace). */
export function parts(src: string): Part[] {
  const out: Part[] = []
  let i = 0, trimNext = ""
  const text = (t: string, right: string) => {
    if (trimNext === "_") t = t.trimStart(); else if (trimNext === "-") t = t.replace(/^\r?\n/, "")
    if (right === "_") t = t.trimEnd(); else if (right === "-") t = t.replace(/\r?\n$/, "")
    if (t) out.push({ text: t })
  }
  for (;;) {
    const at = src.indexOf("<%", i)
    if (at < 0) { text(src.slice(i), ""); return out }
    const open = /^<%([-_]?)([*+]?)([-_]?)/.exec(src.slice(at))!
    const end = scan(src, at + open[0].length, "%>")
    if (end < 0) { text(src.slice(i), ""); return out }
    text(src.slice(i, at), open[1] || open[3])
    let code = src.slice(at + open[0].length, end)
    trimNext = /[-_]$/.test(code) ? code.slice(-1) : ""
    if (trimNext) code = code.slice(0, -1)
    out.push({ code, run: open[2] === "*", raw: src.slice(at, end + 2) })
    i = end + 2
  }
}

// ---------- reading the code

// (a template's text, the start of a `<% %>`, the end of a command, as tokens of their own)
type Tok = { k: "num" | "str" | "tpl" | "id" | "op" | "text" | "out" | "sep" | "end"; v: string; c: number; parts?: string[] }
type Node =
  | { t: "lit"; v: unknown } | { t: "id"; name: string } | { t: "tpl"; parts: (string | Node)[] } | { t: "arr"; items: Node[] }
  | { t: "get"; obj: Node; key: Node; opt: boolean } | { t: "call"; fn: Node; args: Node[] }
  | { t: "un"; op: string; a: Node } | { t: "bin"; op: string; a: Node; b: Node } | { t: "cond"; c: Node; a: Node; b: Node }
type Stmt = ({ t: "let"; name: string; v: Node | null } | { t: "set"; name: string; op: string; v: Node }
  | { t: "if"; cond: Node; a: Stmt[]; b: Stmt[] } | { t: "expr"; e: Node } | { t: "text"; v: string } | { t: "out"; e: Node }) & { c: number }

const OPS = ["===", "!==", "...", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "+=", "-=", "++", "--", "**",
  ..."+-*/%!<>=(){}[],;:?."]
const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }
const unescape = (s: string) => s.replace(/\\(u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\r?\n|.)/gi, (_m, e: string) =>
  /^[ux]/i.test(e) && e.length > 1 ? String.fromCodePoint(parseInt(e.replace(/[ux{}]/gi, ""), 16)) : /^\r?\n$/.test(e) ? "" : ESC[e] ?? e)

const fail = (why: string, at?: number) => Object.assign(new Unsupported(why), { at })

function tokens(src: string, at: number): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (src.startsWith("//", i)) { const n = src.indexOf("\n", i); i = n < 0 ? src.length : n; continue }
    if (src.startsWith("/*", i)) { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(src.slice(i))
    if (num) { out.push({ k: "num", v: num[0], c: at }); i += num[0].length; continue }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
    if (id) { out.push({ k: "id", v: id[0], c: at }); i += id[0].length; continue }
    if (c === "'" || c === '"') { const e = skipString(src, i); out.push({ k: "str", v: unescape(src.slice(i + 1, e - 1)), c: at }); i = e; continue }
    if (c === "`") {
      const e = skipString(src, i), body = src.slice(i + 1, e - 1), ps: string[] = []
      let j = 0, last = 0
      while (j < body.length) {
        if (body[j] === "\\") j += 2
        else if (body.startsWith("${", j)) { const k = scan(body, j + 2, "}"); ps.push(body.slice(last, j), body.slice(j + 2, k)); j = last = k + 1 }
        else j++
      }
      ps.push(body.slice(last))
      out.push({ k: "tpl", v: "", c: at, parts: ps })
      i = e
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw fail(`"${c}"`, at)
    out.push({ k: "op", v: op, c: at }); i += op.length
  }
  return out
}

/** The template as one program's tokens. */
function program(ps: Part[]): Tok[] {
  const ts: Tok[] = []
  ps.forEach((p, c) => {
    if ("text" in p) ts.push({ k: "text", v: p.text, c })
    else ts.push(...(p.run ? [] : [{ k: "out", v: "", c } as Tok]), ...tokens(p.code, c), { k: "sep", v: "", c })
  })
  return [...ts, { k: "end", v: "", c: ps.length - 1 }]
}

const PREC: Record<string, number> = { "??": 1, "||": 2, "&&": 3, "==": 4, "!=": 4, "===": 4, "!==": 4, "<": 5, ">": 5, "<=": 5, ">=": 5, "+": 6, "-": 6, "*": 7, "/": 7, "%": 7 }
const LITERALS: Record<string, unknown> = { true: true, false: false, null: null, undefined }

function parser(ts: Tok[]) {
  let p = 0
  const peek = (o = 0) => ts[p + o], next = () => ts[p++]
  const is = (v: string, o = 0) => { const t = peek(o); return (t.k === "op" || t.k === "id") && t.v === v }
  const bad = (why: string, t = peek()): never => { throw fail(why, t.c) }
  const eat = (v: string) => (is(v) ? next() : bad(`"${v}" where "${peek().v || "the end"}" is`))
  const name = () => { const t = next(); return t.k === "id" ? t.v : bad(`a name where "${t.v}" is`, t) }

  function expr(): Node {
    const c = binary(0)
    if (!is("?")) return c
    next()
    const a = expr()
    eat(":")
    return { t: "cond", c, a, b: expr() }
  }
  function binary(min: number): Node {
    let a = unary()
    for (;;) {
      const t = peek(), prec = t.k === "op" ? PREC[t.v] : undefined
      if (prec === undefined || prec <= min) return a
      next()
      a = { t: "bin", op: t.v, a, b: binary(prec) }
    }
  }
  function unary(): Node {
    for (const op of ["!", "-", "+", "typeof", "await"]) if (is(op)) { next(); return { t: "un", op, a: unary() } }
    return postfix(primary())
  }
  function postfix(n: Node): Node {
    for (;;) {
      if (is(".") || is("?.")) {
        const opt = next().v === "?."
        if (opt && is("(")) { next(); n = { t: "call", fn: n, args: list(")") }; continue }
        n = { t: "get", obj: n, key: { t: "lit", v: name() }, opt }
      } else if (is("[")) { next(); n = { t: "get", obj: n, key: expr(), opt: false }; eat("]") }
      else if (is("(")) { next(); n = { t: "call", fn: n, args: list(")") } }
      else return n
    }
  }
  function list(close: string): Node[] {
    const items: Node[] = []
    while (!is(close)) { items.push(expr()); if (!is(close)) eat(",") }
    next()
    return items
  }
  function primary(): Node {
    const t = next()
    if (t.k === "num") return { t: "lit", v: Number(t.v) }
    if (t.k === "str") return { t: "lit", v: t.v }
    if (t.k === "tpl") return { t: "tpl", parts: t.parts!.map((s, i) => (i % 2 ? parser([...tokens(s, t.c), { k: "end", v: "", c: t.c }]).expression() : unescape(s))) }
    if (t.k === "id") return t.v in LITERALS ? { t: "lit", v: LITERALS[t.v] } : { t: "id", name: t.v }
    if (t.v === "(") { const e = expr(); eat(")"); return is("=>") ? bad("a function") : e }
    if (t.v === "[") return { t: "arr", items: list("]") }
    return bad(t.v ? `"${t.v}"` : "an unfinished command", t)
  }

  function statement(): Stmt[] {
    const t = peek(), c = t.c
    if (t.k === "sep" || is(";")) { next(); return [] }
    if (t.k === "text") { next(); return [{ t: "text", v: t.v, c }] }
    if (t.k === "out") {
      next()
      const e = expr()
      if (peek().k !== "sep") bad(`"${peek().v}"`)
      next()
      return [{ t: "out", e, c }]
    }
    if (is("{")) { next(); const b = block("}"); eat("}"); return b }
    let s: Stmt[]
    if (is("let") || is("const") || is("var")) {
      next()
      s = []
      do { const n = name(); s.push({ t: "let", name: n, v: is("=") ? (next(), expr()) : null, c }) } while (is(",") && next())
    } else if (is("if")) {
      next(); eat("(")
      const cond = expr()
      eat(")")
      const a = statement()
      let q = 0 // (an else may be in the next command)
      while (peek(q).k === "sep") q++
      if (!is("else", q)) return [{ t: "if", cond, a, b: [], c }]
      p += q + 1
      return [{ t: "if", cond, a, b: statement(), c }]
    } else if (t.k === "id" && ["=", "+=", "-="].some((o) => is(o, 1))) {
      const n = name()
      s = [{ t: "set", name: n, op: next().v, v: expr(), c }]
    } else {
      if (t.k === "id" && /^(for|while|do|function|return|class|new|try|throw|switch|import|async|this|delete|else)$/.test(t.v)) bad(`"${t.v}"`)
      s = [{ t: "expr", e: expr(), c }]
    }
    if (is(";")) next()
    return s
  }
  function block(close: string): Stmt[] {
    const out: Stmt[] = []
    while (!is(close) && peek().k !== "end") out.push(...statement())
    return out
  }
  return {
    expression() { const e = expr(); if (peek().k !== "end") bad(`"${peek().v}"`); return e },
    program() { return block("") },
  }
}

/** The template's program: a command that can't be read becomes text, as written (then the rest is read again). */
function compile(ps: Part[], skipped: Rendered["skipped"]): { stmts: Stmt[]; ps: Part[] } {
  for (;;) {
    try { return { stmts: parser(program(ps)).program(), ps } } catch (e) {
      let at = e instanceof Unsupported && e.at !== undefined ? e.at : -1
      while (at >= 0 && "text" in ps[at]) at--
      if (at < 0) throw e
      const raw = (ps[at] as { raw: string }).raw
      skipped.push({ raw, why: `needs ${(e as Error).message}, which Vaultite doesn't run` })
      ps = ps.map((x, i) => (i === at ? { text: raw } : x))
    }
  }
}

// ---------- running it

const BLOCKED = new Set(["constructor", "__proto__", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"])
const STRING = new Set(["toLowerCase", "toUpperCase", "trim", "trimStart", "trimEnd", "replace", "replaceAll", "split", "slice", "substring",
  "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "charAt", "at", "concat", "localeCompare", "normalize", "toString"])
const ARRAY = new Set(["join", "includes", "indexOf", "lastIndexOf", "slice", "concat", "at", "toString"])
const NUMBER = new Set(["toFixed", "toString"])

/** obj[key], for what a template may read: its values' own keys, strings', lists' and numbers' safe methods. */
function member(obj: unknown, key: unknown): unknown {
  const k = String(key)
  if (BLOCKED.has(k)) throw new Unsupported(k)
  const method = (set: Set<string>, proto: object) => set.has(k) ? (...a: unknown[]) => (proto as Record<string, (...a: unknown[]) => unknown>)[k].apply(obj, a) : undefined
  if (typeof obj === "string") return k === "length" || /^\d+$/.test(k) ? obj[k as never] : method(STRING, String.prototype)
  if (Array.isArray(obj)) return k === "length" || /^\d+$/.test(k) ? obj[k as never] : method(ARRAY, Array.prototype)
  if (typeof obj === "number") return method(NUMBER, Number.prototype)
  if (obj && typeof obj === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(obj))) return Object.hasOwn(obj, k) ? (obj as Record<string, unknown>)[k] : undefined
  return undefined
}

/** The names a template's commands share (one scope, as in Templater), its output so far (`tR`), its commands as
 *  written and the ones that failed. */
type Scope = { vars: Map<string, unknown>; out: string; raws: string[]; skipped: Rendered["skipped"] }

async function ev(n: Node, s: Scope): Promise<unknown> {
  switch (n.t) {
    case "lit": return n.v
    case "id":
      if (n.name === "tR") return s.out
      if (!s.vars.has(n.name)) throw new Unsupported(n.name)
      return s.vars.get(n.name)
    case "tpl": { let out = ""; for (const p of n.parts) out += typeof p === "string" ? p : text(await ev(p, s)); return out }
    case "arr": { const out = []; for (const x of n.items) out.push(await ev(x, s)); return out }
    case "get": {
      const obj = await ev(n.obj, s)
      if (obj == null) { if (n.opt) return undefined; throw new TypeError(`can't read "${await ev(n.key, s)}" of ${obj}`) }
      return member(obj, await ev(n.key, s))
    }
    case "call": {
      const fn = await ev(n.fn, s)
      if (typeof fn !== "function") throw new Unsupported(n.fn.t === "get" && n.fn.key.t === "lit" ? String(n.fn.key.v) : "a call")
      const args = []
      for (const a of n.args) args.push(await ev(a, s))
      return await fn(...args)
    }
    case "un": {
      const a = await ev(n.a, s)
      return n.op === "!" ? !a : n.op === "-" ? -(a as number) : n.op === "+" ? +(a as number) : n.op === "typeof" ? typeof a : a
    }
    case "bin": {
      const a = await ev(n.a, s)
      if (n.op === "&&") return a && ev(n.b, s)
      if (n.op === "||") return a || ev(n.b, s)
      if (n.op === "??") return a ?? ev(n.b, s)
      const b = await ev(n.b, s) as never, x = a as never
      switch (n.op) {
        case "+": return x + b
        case "-": return x - b
        case "*": return x * b
        case "/": return x / b
        case "%": return x % b
        case "==": return x == b // eslint-disable-line eqeqeq
        case "!=": return x != b // eslint-disable-line eqeqeq
        case "===": return x === b
        case "!==": return x !== b
        case "<": return x < b
        case ">": return x > b
        case "<=": return x <= b
        default: return x >= b
      }
    }
    case "cond": return (await ev(n.c, s)) ? ev(n.a, s) : ev(n.b, s)
  }
}

async function step(st: Stmt, s: Scope): Promise<void> {
  if (st.t === "text") s.out += st.v
  else if (st.t === "out") s.out += text(await ev(st.e, s))
  else if (st.t === "let") s.vars.set(st.name, st.v ? await ev(st.v, s) : undefined)
  else if (st.t === "set") {
    if (st.name !== "tR" && !s.vars.has(st.name)) throw new Unsupported(st.name)
    const was = st.name === "tR" ? s.out : s.vars.get(st.name), v = await ev(st.v, s)
    const now = st.op === "+=" ? (was as string) + (v as string) : st.op === "-=" ? (was as number) - (v as number) : v
    if (st.name === "tR") s.out = text(now); else s.vars.set(st.name, now)
  } else if (st.t === "if") await exec((await ev(st.cond, s)) ? st.a : st.b, s)
  else await ev(st.e, s)
}

/** Each statement in turn; one that fails leaves its command as written (once), undoing what the command's earlier
 *  statements wrote, and the rest go on. */
async function exec(stmts: Stmt[], s: Scope): Promise<void> {
  let cmd = { c: -1, out: "" }
  for (const st of stmts) {
    if (st.c !== cmd.c) cmd = { c: st.c, out: s.out }
    if (s.skipped.some((x) => x.at === st.c)) continue
    try { await step(st, s) } catch (e) {
      if (e instanceof Cancelled) throw e
      s.out = cmd.out + s.raws[st.c]
      s.skipped.push({ raw: s.raws[st.c], at: st.c, why: e instanceof Unsupported ? `needs ${e.message}, which Vaultite doesn't run` : (e as Error).message })
    }
  }
}

/** A value as a template writes it: nothing for null and undefined. */
export const text = (v: unknown) => (v == null ? "" : String(v))

/** What a template made: its text, and the commands that weren't run (left as written), each with why. */
export type Rendered = { text: string; skipped: { raw: string; why: string; at?: number }[] }

/** Run a template's commands, with `vars` the names it may use (tp). A command that can't run stays as it was. */
export async function render(src: string, vars: Record<string, unknown>): Promise<Rendered> {
  const skipped: Rendered["skipped"] = []
  const { stmts, ps } = compile(parts(src), skipped)
  const s: Scope = { vars: new Map(Object.entries(vars)), out: "", raws: ps.map((p) => ("raw" in p ? p.raw : "")), skipped }
  await exec(stmts, s)
  return { text: s.out, skipped }
}
