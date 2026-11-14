// Moving through the text by lines, the way Org's syntax is defined.

/** Start of the line `pos` is on. */
export const bol = (s: string, pos: number) => s.lastIndexOf("\n", pos - 1) + 1

/** End of the line `pos` is on (its newline, or the text's end). */
export function eol(s: string, pos: number) {
  const i = s.indexOf("\n", pos)
  return i < 0 ? s.length : i
}

/** Start of the next line (past the newline), or the text's end. */
export function nextLine(s: string, pos: number) {
  const i = s.indexOf("\n", pos)
  return i < 0 ? s.length : i + 1
}

const BLANK = /[ \t]*(?:\n|$)/y

/** Whether the line starting at `pos` is blank. */
export function blankLine(s: string, pos: number) {
  BLANK.lastIndex = pos
  return BLANK.test(s)
}

/** Past the blank lines from `pos` (a line's start) up to `limit`: where the next element starts, and how many. */
export function skipBlank(s: string, pos: number, limit: number): [number, number] {
  let n = 0
  while (pos < limit && blankLine(s, pos)) {
    pos = Math.min(nextLine(s, pos), limit)
    n++
  }
  return [pos, n]
}

/** Back over blank lines ending at `pos` (a line's start), not before `floor`: where the content before them ends. */
export function backBlank(s: string, pos: number, floor: number) {
  while (pos > floor) {
    const start = bol(s, pos - 1)
    if (start < floor || !blankLine(s, start)) break
    pos = start
  }
  return pos
}

/** A sticky regex matched at `pos`: its match, or null. Patterns must carry the `y` flag. */
export function at(re: RegExp, s: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos
  return re.exec(s)
}
