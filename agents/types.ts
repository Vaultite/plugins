// What the server keeps of a thread and sends the app (live.ts), the same for every harness.
export type Harness = "claude" | "codex"
export type Mode = "ask" | "edits" | "read"
export type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type Entry =
  /** A turn's start: `end` when it finished; `before`/`after` the checkpoints (git trees) of its folder around it. */
  | { kind: "user"; text: string; at: string; file?: string; images?: string[]; end?: string; before?: string; after?: string
      changes?: Omit<FileDiff, "hunks" | "binary">[] }
  | { kind: "assistant"; text: string; at: string; open?: boolean }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; file?: string; path?: string; result?: string; error?: boolean; patch?: Hunk[] }
  | { kind: "ask"; id: string; tool: string; input: Record<string, unknown>; text: string; at: string; file?: string; path?: string; patch?: Hunk[]; answer?: "allow" | "deny" | "gone" }
  | { kind: "note"; text: string; at: string; error?: boolean; signIn?: boolean }
export type Thread = {
  id: string; title: string; harness: Harness; cwd: string; model: string; mode: Mode
  /** Claude Code's session id (chosen here), or Codex's thread id (once it starts). */
  session: string; started: boolean; created: string; updated: string; entries: Entry[]
  /** Its own worktree (made at its first message, on a new branch), when it asked for one: `cwd` is inside it. */
  worktree?: { top: string; branch: string; from: string; base?: string; pending?: boolean }
}
export type GitState = {
  top: string; branch: string; base: string; upstream: string; ahead: number; behind: number; files: number; remote: string; gh: boolean; worktree: boolean
  pr?: { number: number; url: string; state: string; title: string } | null
}
/** A file's change in the diff panel: `path` relative to the thread's checkout (or its folder). */
export type FileDiff = { path: string; file?: string; added: number; removed: number; hunks: Hunk[]; binary?: boolean; status: "added" | "deleted" | "modified" }
export type Live = { running: boolean; status: string }
export type Changes = { files: { path: string; file?: string; added: number; removed: number }[]; added: number; removed: number }
export type Summary = {
  id: string; title: string; harness: Harness; cwd: string; home: string; project: string; model: string; mode: Mode; updated: string
  running: boolean; waiting: boolean; status: string; asked: string; last: string; changes: Changes; branch?: string; failed?: boolean
}
export type Project = { label: string; path: string; vault?: boolean }
export type Model = { value: string; label: string; description: string }
export type HarnessStatus = { installed: boolean; loggedIn: boolean; version: string; models: Model[]; account?: string }
export type Status = Record<Harness, HarnessStatus>
