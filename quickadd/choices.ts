// Quick add's choices, for both sides: their shape, Obsidian QuickAdd's read as these, and where a capture goes in a note.

/** A choice. A capture adds `format` to `file` (none: the open note), at its end or top (`prepend`), or of the section
 *  under `heading` (made at the end when missing). A template makes a note from `template` in `folder`, named `name`. A
 *  multi offers `choices` (others' names). `command`: in the palette (and so a new tab's buttons). */
export type Choice = {
  id: string; name: string; type: "capture" | "template" | "multi"; command?: boolean; open?: boolean
  file?: string; format?: string; heading?: string; prepend?: boolean
  template?: string; folder?: string; nameFormat?: string
  choices?: string[]
}

type QuickAdd = {
  id?: string; name?: string; type?: string; command?: boolean; choices?: QuickAdd[]; openFile?: boolean
  captureTo?: string; captureToActiveFile?: boolean; format?: { enabled?: boolean; format?: string }; prepend?: boolean; task?: boolean
  insertAfter?: { enabled?: boolean; after?: string; insertAtEnd?: boolean }
  templatePath?: string; fileNameFormat?: { enabled?: boolean; format?: string }; folder?: { enabled?: boolean; folders?: string[] }
}

/** QuickAdd's data.json `choices` as these; a multi's own are listed after it. Macros (JavaScript) are left out. */
export function fromQuickAdd(list: QuickAdd[] = [], out: Choice[] = []): Choice[] {
  for (const q of list) {
    const base = { id: q.id || q.name || String(out.length), name: q.name || "Untitled", command: !!q.command, open: !!q.openFile }
    if (q.type === "Multi") {
      out.push({ ...base, type: "multi", choices: (q.choices ?? []).map((c) => c.name ?? "") })
      fromQuickAdd(q.choices, out)
    } else if (q.type === "Capture") {
      const after = q.insertAfter?.enabled ? q.insertAfter : null
      out.push({ ...base, type: "capture", file: q.captureToActiveFile ? "" : q.captureTo ?? "",
        format: (q.task ? "- [ ] " : "") + (q.format?.enabled ? q.format.format ?? "" : "{{VALUE}}"),
        ...(after ? { heading: after.after ?? "", prepend: !after.insertAtEnd } : { prepend: !!q.prepend }) })
    } else if (q.type === "Template") {
      out.push({ ...base, type: "template", template: q.templatePath ?? "", open: q.openFile !== false,
        folder: q.folder?.enabled ? q.folder.folders?.[0] : undefined, nameFormat: q.fileNameFormat?.enabled ? q.fileNameFormat.format : undefined })
    }
  }
  return out
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

/** `doc` with `text` added: at its end or top (after the frontmatter), or of the section under `heading` (a heading's
 *  text, with or without its #s), which is made at the end when there's none. */
export function insert(doc: string, text: string, heading = "", top = false) {
  const lines = doc ? doc.replace(/\n$/, "").split("\n") : []
  const fm = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0
  const trim = (e: number, from: number) => { while (e > from && !lines[e - 1].trim()) e--; return e }
  const name = heading.replace(/^#+\s*/, "").trim()
  const end = trim(lines.length, fm)
  let at = top ? fm : end
  if (name) {
    const h = lines.findIndex((l, i) => i >= fm && HEADING.exec(l)?.[2] === name)
    if (h < 0) return [...lines.slice(0, end), ...(end ? [""] : []), /^#/.test(heading) ? heading.trim() : `## ${name}`, text].join("\n") + "\n"
    const level = HEADING.exec(lines[h])![1].length
    const next = lines.findIndex((l, i) => i > h && (HEADING.exec(l)?.[1].length ?? 7) <= level)
    at = top ? h + 1 : trim(next < 0 ? lines.length : next, h + 1)
  }
  lines.splice(at, 0, text)
  return lines.join("\n") + "\n"
}

/** The format's questions: `{{VALUE}}` (and `{{NAME}}`) as "", `{{VALUE:name}}` by name, `{{VALUE:a,b}}` a pick. */
export const asks = (format: string) =>
  [...new Set([...format.matchAll(/\{\{(?:VALUE|NAME)(?::([^}]*))?\}\}/gi)].map((m) => m[1]?.trim() ?? ""))]

/** The format with its answers (by question, as `asks` names them) and the open note (`{{LINKCURRENT}}`). */
export function fillIn(format: string, answers: Record<string, string>, current?: string) {
  const stem = current?.replace(/^.*\//, "").replace(/\.md$/i, "") ?? ""
  return format.replace(/\{\{(?:VALUE|NAME)(?::([^}]*))?\}\}/gi, (_m, q?: string) => answers[q?.trim() ?? ""] ?? "")
    .replace(/\{\{LINKCURRENT\}\}/gi, stem ? `[[${stem}]]` : "").replace(/\{\{FILENAMECURRENT\}\}/gi, stem)
}
