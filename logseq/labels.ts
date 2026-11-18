// The label a link to a block shows: its line's text without markup. The import gives links this label; the export
// tells a label of one's own from it (and keeps it: [label](((uuid)))).
export function labelOf(line: string): string {
  const s = line.replace(/\s\^[\w-]+\s*$/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s*)?/, "").replace(/^#{1,6}\s+/, "")
    .replace(/\s*(?:📅|⏳|🛫|➕|✅|❌)\s*\d{4}-\d\d-\d\d|\s*🔁[^📅⏳🛫➕✅❌^]*|\s*[🔺⏫🔼🔽⏬]/gu, "")
    .replace(/!\[\[[^\]]*\]\]/g, "").replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[|\]\]|[*_~^=`]/g, "")
    .replace(/[[\]|]/g, "").replace(/\s+/g, " ").trim()
  return [...s].slice(0, 80).join("").trim() || "block"
}
