// What the server keeps of a thread and sends the app (live.ts), the same for every harness.
export type Harness = "claude" | "codex"
export type Mode = "ask" | "edits" | "read"
export type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type Entry =
  | { kind: "user"; text: string; at: string; file?: string; images?: string[] }
  | { kind: "assistant"; text: string; at: string; open?: boolean }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; file?: string; path?: string; result?: string; error?: boolean; patch?: Hunk[] }
  | { kind: "ask"; id: string; tool: string; input: Record<string, unknown>; text: string; at: string; file?: string; path?: string; patch?: Hunk[]; answer?: "allow" | "deny" | "gone" }
  | { kind: "note"; text: string; at: string; error?: boolean; signIn?: boolean }
export type Thread = {
  id: string; title: string; harness: Harness; cwd: string; model: string; mode: Mode
  /** Claude Code's session id (chosen here), or Codex's thread id (once it starts). */
  session: string; started: boolean; created: string; updated: string; entries: Entry[]
}
export type Live = { running: boolean; status: string }
export type Changes = { files: { path: string; file?: string; added: number; removed: number }[]; added: number; removed: number }
export type Summary = {
  id: string; title: string; harness: Harness; cwd: string; project: string; model: string; mode: Mode; updated: string
  running: boolean; waiting: boolean; status: string; asked: string; last: string; changes: Changes
}
export type Project = { label: string; path: string; vault?: boolean }
export type Model = { value: string; label: string; description: string }
export type HarnessStatus = { installed: boolean; loggedIn: boolean; version: string; models: Model[]; account?: string }
export type Status = Record<Harness, HarnessStatus>
