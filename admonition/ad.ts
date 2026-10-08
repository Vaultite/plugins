// An Admonition fence (```ad-<type>, its title:, collapse:, icon: and color: lines first) as the callout it stands for,
// for both sides: the app draws that, agents read it.

/** The types Admonition and callouts share (their other names too); a fence of another type stays code. */
export const TYPES = ["note", "abstract", "summary", "tldr", "info", "todo", "tip", "hint", "important", "success", "check", "done",
  "question", "help", "faq", "warning", "caution", "attention", "failure", "fail", "missing", "danger", "error", "bug", "example",
  "quote", "cite"]

/** The fence's text as a callout's Markdown (`> [!tip]- Title`), and its icon (a Lucide name or an emoji), if any. */
export function toCallout(type: string, text: string) {
  const lines = text.replace(/\n$/, "").split("\n"), opts: Record<string, string> = {}
  for (let m; lines.length && (m = /^(title|collapse|icon|color):[ \t]*(.*)$/i.exec(lines[0])); lines.shift()) opts[m[1].toLowerCase()] = m[2].trim()
  while (lines.length && !lines[0].trim()) lines.shift()
  const fold = /^(closed?|true)$/i.test(opts.collapse ?? "") ? "-" : /^open$/i.test(opts.collapse ?? "") ? "+" : ""
  const body = lines.map((l) => (l ? `> ${l}` : ">")).join("\n")
  return { md: `> [!${type}]${fold} ${opts.title ?? ""}`.trimEnd() + (lines.length ? `\n${body}` : ""), icon: opts.icon?.replace(/^lucide-/, "") }
}
