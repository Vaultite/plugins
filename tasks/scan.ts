// The tasks in a note: every checkbox line outside code fences and frontmatter, with the heading it's under.
import { parseTask, type Task } from "./task.ts"

export type Found = Task & {
  path: string
  /** Its line in the file, 0-based. */
  line: number
  /** The line as written. */
  text: string
  /** The nearest heading above it, or "". */
  heading: string
}

export function tasksIn(text: string, path: string, globalFilter = ""): Found[] {
  const lines = text.split("\n")
  const out: Found[] = []
  let i = 0
  if (lines[0] === "---") {
    const end = lines.findIndex((l, j) => j > 0 && /^(---|\.\.\.)\s*$/.test(l))
    if (end > 0) i = end + 1
  }
  let fence: string | null = null, heading = ""
  for (; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, "")
    const f = /^\s*(`{3,}|~{3,})/.exec(l)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*[`~]+\s*$/.test(l)) fence = null
      continue
    }
    if (fence) continue
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l)
    if (h) { heading = h[1]; continue }
    if (!l.includes("[")) continue
    const t = parseTask(l)
    if (!t) continue
    if (globalFilter && !l.includes(globalFilter)) continue
    out.push({ ...t, path, line: i, text: l, heading })
  }
  return out
}
