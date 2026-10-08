// What the app's side reads from the server (GET /api/git/status, the ops), as plugin.ts answers it.

export type FileStatus = {
  path: string; from?: string
  x: string; y: string
  staged: boolean; unstaged: boolean; untracked: boolean; conflict: boolean
}
export type Commit = { sha: string; t: number; author: string; subject: string }

export type Snapshot = {
  git: boolean
  cloud: { name: string; sure: boolean; warning: string } | null
  /** What a change under way is doing ("Pulling"), whoever started it. */
  busy: string | null
  lastSync: { t: number; ok: boolean; auto?: boolean; error?: string; summary?: string } | null
  auto: { interval: number; idle: number }
  push: boolean
  repo: { top: string; prefix: string } | null
  branch?: string | null; upstream?: string | null; ahead?: number; behind?: number; remotes?: string[]
  merging?: boolean; conflicts?: string[]
  /** Every changed file (`files` is at most the first 1000). */
  total?: number
  files?: FileStatus[]
  lastCommit?: Commit | null
}

export type Version = Commit & { path: string; change: string }
export type Committed = { sha: string; message: string; files: string[] } | null
export type SyncResult = { committed: Committed; pulled: number; pushed: number; conflicts: string[]; remote: string | null; notes: string[] }

/** One letter for a file's change: M, A, D, R, U (untracked), C (conflict). */
export function letter(f: FileStatus, side: "staged" | "unstaged") {
  if (f.conflict) return "C"
  if (f.untracked) return "U"
  const c = side === "staged" ? f.x : f.y
  return c === "T" ? "M" : c === "C" ? "A" : c
}
export const LETTER_TINT: Record<string, string> = {
  M: "var(--yellow)", A: "var(--green)", U: "var(--green)", D: "var(--red)", R: "var(--blue)", C: "var(--red)",
}
export const LETTER_WORD: Record<string, string> = {
  M: "Modified", A: "Added", U: "New", D: "Deleted", R: "Renamed", C: "Conflict",
}
