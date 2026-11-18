// Page titles and the file names Logseq gives them (:file/name-format), both ways.
const decode = (s: string) => s.replace(/(?:%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m) } catch { return m } })

/** A page's title from its file name (no extension). */
export function titleOfFile(stem: string, format: "triple-lowbar" | "legacy"): string {
  if (format === "triple-lowbar") return decode(stem.replace(/___/g, "/"))
  // The legacy format: "." is a namespace's "/", "%2F" one too; a title's own dots were written %2E.
  if (/%2F/i.test(stem) || !stem.includes(".")) return decode(stem)
  return decode(stem.replace(/\./g, "/"))
}

const RESERVED = /[:*?"<>|#\\]|%(?=[0-9a-f]{2})/gi

/** The file name (no extension) Logseq writes for a title, in the triple-lowbar format. */
export function fileOfTitle(title: string): string {
  let s = title.replace(RESERVED, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
  s = s.replace(/\//g, "___")
  if (s.startsWith(".")) s = `%2E${s.slice(1)}`
  return s
}

/** Logseq's page name: titles match in any case. */
export const nameKey = (title: string) => title.trim().toLowerCase().normalize("NFC")

/** A note's file name for a title part: what Vaultite and other Markdown apps don't allow, made safe. */
export function safePart(s: string): string {
  const out = s.replace(/[*"\\<>:|?#^[\]]/g, (c) => (c === ":" ? " -" : c === "?" || c === "*" ? "" : "-")).replace(/\s+/g, " ").trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
  const short = [...out].slice(0, 120).join("").replace(/[.\s]+$/, "")
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(short) ? `${short}-` : short || "Untitled"
}
