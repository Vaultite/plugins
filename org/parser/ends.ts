// Where blocks, drawers and LaTeX environments can end: every closing line of the text, found in one pass and
// looked up by position, so checking whether a construct is closed doesn't rescan the text.
import type { Ctx } from "./driver.ts"

type Ends = { block: Map<string, number[]>; latex: Map<string, number[]>; dynamic: number[]; drawer: number[] }

const BLOCK_END = /^[ \t]*#\+end_(\S+)[ \t]*$/gim
const DYNAMIC_END = /^[ \t]*#\+end:?[ \t]*$/gim
const DRAWER_END = /^[ \t]*:end:[ \t]*$/gim
const LATEX_END = /\\end\{([A-Za-z0-9*]+)\}[ \t]*$/gim

const cache = new WeakMap<Ctx, Ends>()

/** Line starts of `re`'s matches, by its first group (lower case) when it has one. JS's ^ and $ also match at
 *  \r and U+2028, Emacs's only at \n: those are left out. */
function scan(s: string, re: RegExp, grouped: true): Map<string, number[]>
function scan(s: string, re: RegExp, grouped: false): number[]
function scan(s: string, re: RegExp, grouped: boolean) {
  const byName = new Map<string, number[]>(), all: number[] = []
  for (const m of s.matchAll(re)) {
    const end = m.index + m[0].length
    if (end < s.length && s[end] !== "\n") continue
    const start = s.lastIndexOf("\n", m.index - 1) + 1
    if (/[\r\u2028\u2029]/.test(s.slice(start, end))) continue
    if (!grouped) { all.push(start); continue }
    const k = m[1].toLowerCase(), list = byName.get(k)
    if (list) list.push(start)
    else byName.set(k, [start])
  }
  return grouped ? byName : all
}

function ends(ctx: Ctx): Ends {
  let e = cache.get(ctx)
  if (!e) {
    const s = ctx.s
    e = { block: scan(s, BLOCK_END, true), latex: scan(s, LATEX_END, true), dynamic: scan(s, DYNAMIC_END, false), drawer: scan(s, DRAWER_END, false) }
    cache.set(ctx, e)
  }
  return e
}

/** The first of the sorted `list` in [from, limit), or -1. */
function first(list: number[] | undefined, from: number, limit: number) {
  if (!list) return -1
  let lo = 0, hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] < from) lo = mid + 1
    else hi = mid
  }
  return lo < list.length && list[lo] < limit ? list[lo] : -1
}

/** The line closing `#+begin_<name>` (`#+end_<name>`), from `from` to `limit`: its start, or -1. */
export const blockEnd = (ctx: Ctx, name: string, from: number, limit: number) => first(ends(ctx).block.get(name.toLowerCase()), from, limit)
export const latexEnd = (ctx: Ctx, name: string, from: number, limit: number) => first(ends(ctx).latex.get(name.toLowerCase()), from, limit)
export const dynamicEnd = (ctx: Ctx, from: number, limit: number) => first(ends(ctx).dynamic, from, limit)
export const drawerEnd = (ctx: Ctx, from: number, limit: number) => first(ends(ctx).drawer, from, limit)
