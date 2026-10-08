// What a sync leaves out: gitignore-like patterns ("*.pdf" anywhere, "Archive/" a folder, ".vaultite/cache/**"), and
// what it never touches whatever the settings say.

/** Never synced: the OS's and git's own, iCloud's placeholders, half-written copies, Remotely Save's bookkeeping. */
const NEVER = [".DS_Store", ".git/", ".localized", "*.icloud", "*.tmp-*", "_remotely-save-metadata-on-remote.*", ".vaultite-remote-save.json"]

function toRegex(pattern: string): RegExp | null {
  let p = pattern.trim().replace(/\\/g, "/")
  if (!p || p.startsWith("#")) return null
  const dir = p.endsWith("/")
  p = p.replace(/^\/+/, "").replace(/\/+$/, "")
  // A pattern without a slash names a file or folder anywhere; with one, a path from the vault's top.
  const anywhere = !pattern.trim().replace(/\/+$/, "").includes("/")
  let re = ""
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === "*" && p[i + 1] === "*") {
      i++
      if (p[i + 1] === "/") { i++; re += "(?:.*/)?" } else re += ".*"
    } else if (c === "*") re += "[^/]*"
    else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  // A folder's pattern takes everything in it; a file's, also a folder of that name.
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${re}${dir ? "/.*" : "(?:/.*)?"}$`)
}

/** A test of vault paths against `patterns` (and what's never synced). */
export function skipper(patterns: string[]) {
  const res = [...NEVER, ...patterns].map(toRegex).filter((r): r is RegExp => !!r)
  return (rel: string) => res.some((r) => r.test(rel))
}
