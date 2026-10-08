// The Dataview Query Language: a query's text as a tree (query type, FROM's sources, data commands, expressions).
// Errors are DqlError with what was expected where, worded for the person who wrote the query.

export class DqlError extends Error {}

export type Expr =
  | { k: "lit"; v: unknown }
  | { k: "var"; name: string }
  | { k: "this" }
  | { k: "link"; target: string; display?: string; embed: boolean }
  | { k: "date"; word: string }
  | { k: "dur"; text: string }
  | { k: "list"; items: Expr[] }
  | { k: "obj"; entries: [string, Expr][] }
  | { k: "field"; of: Expr; name: string }
  | { k: "index"; of: Expr; at: Expr }
  | { k: "call"; fn: string | Expr; args: Expr[] }
  | { k: "lambda"; params: string[]; body: Expr }
  | { k: "un"; op: "!" | "-"; e: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr }

export type Source =
  | { k: "all" }
  | { k: "tag"; tag: string }
  | { k: "folder"; path: string }
  | { k: "link"; target: string; outgoing: boolean }
  | { k: "not"; s: Source }
  | { k: "and" | "or"; a: Source; b: Source }

export type Command =
  | { k: "where"; e: Expr }
  | { k: "sort"; by: { e: Expr; desc: boolean }[] }
  | { k: "group"; e: Expr; as: string }
  | { k: "flatten"; e: Expr; as: string }
  | { k: "limit"; e: Expr }

export type Column = { e: Expr; name: string }
export type Query = {
  type: "list" | "table" | "task" | "calendar"
  withoutId: boolean
  columns: Column[]
  from: Source
  commands: Command[]
}

// ---------- tokens

type Tok = { t: "num" | "str" | "id" | "op" | "link" | "tag" | "eof"; v: string; at: number; space: boolean; raw?: string }

const OPS = ["=>", "!=", "<=", ">=", "==", "(", ")", "[", "]", "{", "}", ",", ".", ":", "+", "-", "*", "/", "%", "<", ">", "=", "!", "&", "|"]
const ID_START = /[\p{L}\p{Emoji_Presentation}_]/u
const ID_PART = /[\p{L}\p{N}\p{Emoji_Presentation}\p{M}_-]/u

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const start = i
    let space = false
    while (i < src.length && /\s/.test(src[i])) { i++; space = true }
    // (a comment: // to the end of the line)
    if (src.startsWith("//", i) && (i === 0 || /\s/.test(src[i - 1]))) { while (i < src.length && src[i] !== "\n") i++; continue }
    if (i >= src.length) break
    const at = i, c = src[i]
    space ||= start !== i
    if (c === '"') {
      let s = "", j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) { const n = src[j + 1]; s += n === "n" ? "\n" : n === "t" ? "\t" : n; j += 2 } else s += src[j++]
      }
      if (j >= src.length) throw new DqlError(`a text starting at ${at + 1} has no closing "`)
      out.push({ t: "str", v: s, at, space }); i = j + 1; continue
    }
    if ((c === "[" && src[i + 1] === "[") || (c === "!" && src.startsWith("[[", i + 1))) {
      const end = src.indexOf("]]", i)
      if (end < 0) throw new DqlError(`a [[link]] starting at ${at + 1} isn't closed`)
      out.push({ t: "link", v: src.slice(c === "!" ? i + 3 : i + 2, end), raw: c === "!" ? "embed" : "", at, space }); i = end + 2; continue
    }
    if (c === "#" && /[\p{L}\p{N}_/-]/u.test(src[i + 1] ?? "")) {
      let j = i + 1
      while (j < src.length && /[\p{L}\p{N}\p{Emoji_Presentation}_/-]/u.test(src[j])) j++
      out.push({ t: "tag", v: src.slice(i, j), at, space }); i = j; continue
    }
    if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!
      out.push({ t: "num", v: m[0], at, space }); i += m[0].length; continue
    }
    if (ID_START.test(c)) {
      let j = i + 1
      // (a dash joins a name only between its parts: "due-date", not "x -" nor "x-1"... "x-1" is Dataview's too)
      while (j < src.length && (ID_PART.test(src[j]) || /\p{Extended_Pictographic}|‍|️/u.test(src[j]))) j++
      while (src[j - 1] === "-") j--
      out.push({ t: "id", v: src.slice(i, j), at, space }); i = j; continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (op) { out.push({ t: "op", v: op, at, space }); i += op.length; continue }
    if (/\p{Extended_Pictographic}/u.test(c)) {
      let j = i + 1
      while (j < src.length && (ID_PART.test(src[j]) || /\p{Extended_Pictographic}|‍|️/u.test(src[j]))) j++
      out.push({ t: "id", v: src.slice(i, j), at, space }); i = j; continue
    }
    throw new DqlError(`unexpected "${c}" at ${at + 1}`)
  }
  out.push({ t: "eof", v: "", at: src.length, space: true })
  return out
}

const CLAUSES = new Set(["from", "where", "sort", "group", "flatten", "limit"])
const kw = (tok: Tok, word: string) => tok.t === "id" && tok.v.toLowerCase() === word

class Parser {
  toks: Tok[]
  i = 0
  src: string
  constructor(src: string) { this.src = src; this.toks = lex(src) }
  get peek() { return this.toks[this.i] }
  at(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)] }
  next() { return this.toks[this.i++] }
  isOp(v: string, o = 0) { const t = this.at(o); return t.t === "op" && t.v === v }
  eat(v: string) { if (this.isOp(v)) { this.i++; return true } return false }
  want(v: string, what = `"${v}"`) { if (!this.eat(v)) this.fail(`expected ${what}`) }
  fail(msg: string): never {
    const t = this.peek
    throw new DqlError(`${msg} ${t.t === "eof" ? "at the end" : `at "${t.raw === "embed" ? "!" : ""}${t.t === "link" ? `[[${t.v}]]` : t.t === "str" ? `"${t.v}"` : t.v}"`}`)
  }
  text(from: number, to: number) { return this.src.slice(this.toks[from].at, this.toks[to].at).trim() }

  // ---------- expressions, loosest first
  expr(): Expr { return this.or() }
  or(): Expr {
    let a = this.and()
    while (kw(this.peek, "or") || this.isOp("|")) { this.next(); a = { k: "bin", op: "or", a, b: this.and() } }
    return a
  }
  and(): Expr {
    let a = this.cmp()
    while (kw(this.peek, "and") || this.isOp("&")) { this.next(); a = { k: "bin", op: "and", a, b: this.cmp() } }
    return a
  }
  cmp(): Expr {
    let a = this.add()
    for (;;) {
      const t = this.peek
      if (t.t !== "op" || !["=", "==", "!=", "<", "<=", ">", ">="].includes(t.v)) return a
      this.next()
      a = { k: "bin", op: t.v === "==" ? "=" : t.v, a, b: this.add() }
    }
  }
  add(): Expr {
    let a = this.mul()
    while (this.isOp("+") || this.isOp("-")) { const op = this.next().v; a = { k: "bin", op, a, b: this.mul() } }
    return a
  }
  mul(): Expr {
    let a = this.unary()
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) { const op = this.next().v; a = { k: "bin", op, a, b: this.unary() } }
    return a
  }
  unary(): Expr {
    if (this.eat("!")) return { k: "un", op: "!", e: this.unary() }
    if (this.eat("-")) return { k: "un", op: "-", e: this.unary() }
    return this.postfix(this.primary())
  }
  postfix(e: Expr): Expr {
    for (;;) {
      if (this.isOp(".") && !this.at(1).space && this.at(1).t === "id") { this.next(); e = { k: "field", of: e, name: this.next().v }; continue }
      if (this.isOp("[") && !this.peek.space) { this.next(); const at = this.expr(); this.want("]"); e = { k: "index", of: e, at }; continue }
      if (this.isOp("(") && !this.peek.space && e.k !== "var") { this.next(); e = { k: "call", fn: e, args: this.args() }; continue }
      return e
    }
  }
  args(): Expr[] {
    const out: Expr[] = []
    if (this.eat(")")) return out
    do out.push(this.expr()); while (this.eat(","))
    this.want(")", `")" after the function's arguments`)
    return out
  }
  /** The bare words of date(today) or dur(1 day), up to the closing ")" (null: they aren't bare). */
  bareArg(): string | null {
    const open = this.i
    if (!this.isOp("(")) return null
    let j = open + 1, depth = 0
    for (; j < this.toks.length; j++) {
      const t = this.toks[j]
      if (t.t === "eof") return null
      if (t.t === "op" && t.v === "(") depth++
      if (t.t === "op" && t.v === ")") { if (!depth) break; depth-- }
    }
    const inner = this.src.slice(this.toks[open].at + 1, this.toks[j].at).trim()
    return inner
  }
  primary(): Expr {
    const t = this.peek
    if (t.t === "num") { this.next(); return { k: "lit", v: Number(t.v) } }
    if (t.t === "str") { this.next(); return { k: "lit", v: t.v } }
    if (t.t === "link") {
      this.next()
      const [target, display] = t.v.split("|")
      return { k: "link", target: target.trim(), ...(display !== undefined ? { display: display.trim() } : {}), embed: t.raw === "embed" }
    }
    if (t.t === "tag") { this.next(); return { k: "lit", v: t.v } }
    if (this.isOp("(")) {
      // A lambda, (x, y) => ..., or an expression in brackets.
      const save = this.i
      this.next()
      const params: string[] = []
      let lambda = true
      if (!this.isOp(")")) {
        do { if (this.peek.t !== "id") { lambda = false; break } params.push(this.next().v) } while (this.eat(","))
      }
      if (lambda && this.eat(")") && this.eat("=>")) return { k: "lambda", params, body: this.expr() }
      this.i = save + 1
      const e = this.expr()
      this.want(")", `")"`)
      return e
    }
    if (this.isOp("[")) {
      this.next()
      const items: Expr[] = []
      if (!this.eat("]")) { do items.push(this.expr()); while (this.eat(",")); this.want("]", `"]" closing the list`) }
      return { k: "list", items }
    }
    if (this.isOp("{")) {
      this.next()
      const entries: [string, Expr][] = []
      if (!this.eat("}")) {
        do {
          const key = this.next()
          if (key.t !== "id" && key.t !== "str") this.fail("expected a key")
          this.want(":")
          entries.push([key.v, this.expr()])
        } while (this.eat(","))
        this.want("}", `"}" closing the object`)
      }
      return { k: "obj", entries }
    }
    if (t.t === "id") {
      const low = t.v.toLowerCase()
      if (CLAUSES.has(low) && !this.isOp("(", 1)) this.fail(`expected a value`)
      this.next()
      if (low === "true" || low === "false") return { k: "lit", v: low === "true" }
      if (low === "null") return { k: "lit", v: null }
      if (low === "this") return { k: "this" }
      if (this.isOp("(") && !this.peek.space) {
        if (low === "date" || low === "dur") {
          const bare = this.bareArg()
          const word = bare !== null && (low === "date" ? /^[\w:+.-]+$/.test(bare) && !/^"/.test(bare) && !this.looksLikeExpr(bare) : /^[\d\s.,a-z]+$/i.test(bare) && /\d/.test(bare))
          if (word && bare !== null) {
            // (skip to its ")")
            let depth = 0
            for (;;) { const x = this.next(); if (x.t === "op" && x.v === "(") depth++; if (x.t === "op" && x.v === ")" && !--depth) break }
            return low === "date" ? { k: "date", word: bare } : { k: "dur", text: bare }
          }
        }
        this.next()
        return { k: "call", fn: t.v, args: this.args() }
      }
      return { k: "var", name: t.v }
    }
    this.fail("expected a value")
  }
  /** date(x) with a field in it (date(due)) is a call; date(today) and date(2026-01-02) are literals. */
  looksLikeExpr(s: string) {
    return !/^(today|now|tomorrow|yesterday|sow|eow|som|eom|soy|eoy|\d{4}-\d{2}(-\d{2}([T ][\d:.]+([+-][\d:]+|Z)?)?)?)$/i.test(s)
  }

  // ---------- sources (FROM)
  source(): Source { return this.srcOr() }
  srcOr(): Source {
    let a = this.srcAnd()
    while (kw(this.peek, "or") || this.isOp("|")) { this.next(); a = { k: "or", a, b: this.srcAnd() } }
    return a
  }
  srcAnd(): Source {
    let a = this.srcAtom()
    while (kw(this.peek, "and") || this.isOp("&")) { this.next(); a = { k: "and", a, b: this.srcAtom() } }
    return a
  }
  srcAtom(): Source {
    const t = this.peek
    if (this.eat("-") || this.eat("!")) return { k: "not", s: this.srcAtom() }
    if (this.eat("(")) { const s = this.source(); this.want(")", `")"`); return s }
    if (t.t === "tag") { this.next(); return { k: "tag", tag: t.v } }
    if (t.t === "str") { this.next(); return { k: "folder", path: t.v } }
    if (t.t === "link") { this.next(); return { k: "link", target: t.v.split("|")[0].trim(), outgoing: false } }
    if (kw(t, "outgoing") && this.isOp("(", 1)) {
      this.next(); this.next()
      const l = this.next()
      if (l.t !== "link") this.fail("outgoing() takes a [[link]]")
      this.want(")", `")"`)
      return { k: "link", target: l.v.split("|")[0].trim(), outgoing: true }
    }
    this.fail(`expected a source (#tag, "folder", [[link]] or outgoing([[link]]))`)
  }

  // ---------- the query
  name(from: number): string {
    if (kw(this.peek, "as")) {
      this.next()
      const n = this.next()
      if (n.t !== "id" && n.t !== "str") this.fail("expected a name after AS")
      return n.v
    }
    return this.text(from, this.i)
  }
  clauseNext() { const t = this.peek; return t.t === "eof" || (t.t === "id" && CLAUSES.has(t.v.toLowerCase())) }
  query(): Query {
    const t = this.next()
    const type = t.t === "id" ? t.v.toLowerCase() : ""
    if (!["list", "table", "task", "calendar"].includes(type)) {
      throw new DqlError(t.t === "eof" ? "the query is empty: start it with LIST, TABLE, TASK or CALENDAR" : `a query starts with LIST, TABLE, TASK or CALENDAR, not "${t.v}"`)
    }
    const q: Query = { type: type as Query["type"], withoutId: false, columns: [], from: { k: "all" }, commands: [] }
    if (kw(this.peek, "without") && kw(this.at(1), "id")) { this.i += 2; q.withoutId = true }
    if (type === "table") {
      if (!this.clauseNext()) {
        do { const from = this.i; const e = this.expr(); q.columns.push({ e, name: this.name(from) }) } while (this.eat(","))
      }
    } else if (type === "list" || type === "calendar") {
      if (!this.clauseNext()) { const from = this.i; const e = this.expr(); q.columns.push({ e, name: this.text(from, this.i) }) }
      if (type === "calendar" && !q.columns.length) throw new DqlError("CALENDAR needs a date to put each file on: CALENDAR file.day")
    }
    let first = true
    while (this.peek.t !== "eof") {
      const c = this.next()
      const w = c.t === "id" ? c.v.toLowerCase() : ""
      if (w === "from") {
        if (!first) throw new DqlError("FROM comes once, right after the query type")
        q.from = this.source()
      } else if (w === "where") q.commands.push({ k: "where", e: this.expr() })
      else if (w === "sort") {
        const by: { e: Expr; desc: boolean }[] = []
        do {
          const e = this.expr()
          let desc = false
          const d = this.peek
          if (d.t === "id" && /^(asc|ascending|desc|descending)$/i.test(d.v)) { this.next(); desc = /^desc/i.test(d.v) }
          by.push({ e, desc })
        } while (this.eat(","))
        q.commands.push({ k: "sort", by })
      } else if (w === "group") {
        if (!kw(this.peek, "by")) this.fail("expected BY after GROUP")
        this.next()
        const from = this.i
        const e = this.expr()
        q.commands.push({ k: "group", e, as: this.name(from) })
      } else if (w === "flatten") {
        const from = this.i
        const e = this.expr()
        q.commands.push({ k: "flatten", e, as: this.name(from) })
      } else if (w === "limit") q.commands.push({ k: "limit", e: this.expr() })
      else { this.i--; this.fail(first && q.columns.length === 0 && type !== "task" ? "expected a field, FROM, WHERE, SORT, GROUP BY, FLATTEN or LIMIT" : "expected FROM, WHERE, SORT, GROUP BY, FLATTEN or LIMIT") }
      first = false
    }
    return q
  }
}

/** A ```dataview fence's text as a query. Throws DqlError. */
export function parseQuery(src: string): Query {
  return new Parser(src).query()
}

/** An inline query's expression (`= this.file.name` without the "="). Throws DqlError. */
export function parseExpr(src: string): Expr {
  const p = new Parser(src)
  const e = p.expr()
  if (p.peek.t !== "eof") p.fail("expected the end of the expression")
  return e
}
