// What the server keeps of a thread and sends the app (live.ts), the same for every harness.
export type Harness = "claude" | "codex"
/** What it may do without asking, T3 Code's runtime modes: full access never asks; auto lets the agent's own reviewer
 *  decide; edits asks only before commands; ask before both. Plan mode is apart (`plan`). */
export type Mode = "full" | "auto" | "edits" | "ask"
export type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type Entry =
  /** A turn's start: `end` when it finished; `before`/`after` its folder's checkpoints (git trees); Claude's `uuid` and
   *  `prev` (its last message before), Codex's `turn`; `steer`: sent while the agent worked, taken into that turn. */
  | { kind: "user"; text: string; at: string; file?: string; images?: string[]; end?: string; before?: string; after?: string
      changes?: Omit<FileDiff, "hunks" | "binary">[]; uuid?: string; prev?: string; turn?: string; steer?: boolean }
  | { kind: "assistant"; text: string; at: string; open?: boolean; uuid?: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; at: string; file?: string; path?: string; result?: string; error?: boolean; patch?: Hunk[]; uuid?: string }
  /** A question for the user: a permission, or the agent's own questions (AskUserQuestion: `answers` by question). */
  | { kind: "ask"; id: string; tool: string; input: Record<string, unknown>; text: string; at: string; file?: string; path?: string; patch?: Hunk[]; answer?: "allow" | "deny" | "gone"
      answers?: Record<string, string>; scope?: "session" | "cancel"; suggestions?: unknown[] }
  /** A plan the agent proposes (Codex's plan mode; Claude's comes as an ExitPlanMode ask): `done` once acted on. */
  | { kind: "plan"; id: string; text: string; at: string; open?: boolean; done?: "here" | "thread" }
  | { kind: "note"; text: string; at: string; error?: boolean; signIn?: boolean }
export type Thread = {
  id: string; title: string; harness: Harness; cwd: string; model: string; mode: Mode
  /** Plan mode: it reads and proposes a plan, changing nothing. `effort`: how hard it thinks (the CLI's own levels). */
  plan?: boolean; effort?: string
  /** How full its context is, as the CLI last said (tokens). */
  context?: { used: number; max: number }
  /** Claude Code's session id (chosen here), or Codex's thread id (once it starts). */
  session: string; started: boolean; created: string; updated: string; entries: Entry[]
  /** Its own worktree (made at its first message, on a new branch), when it asked for one: `cwd` is inside it. */
  worktree?: { top: string; branch: string; from: string; base?: string; pending?: boolean; pr?: number }
  /** Messages written while it worked, sent one by one as each turn ends. */
  queue?: Queued[]
  /** Claude Code: the conversation's last message (`chain`), where its next run resumes after a rewind (`resumeAt`), and
   *  the session a forked thread starts from. */
  chain?: string; resumeAt?: string; fork?: { from: string; at: string }
  /** Done with, as T3 Code has it: settled by hand ("settled"), kept out of auto-settling ("active", Unsettle), or by
   *  itself (`settledAt` alone: its pull request merged or closed, or nothing happened for days). A new turn clears both. */
  settledOverride?: "settled" | "active"; settledAt?: string
  /** Kept on top (Pin thread), away until a time (Snooze), out of the list (Archive). */
  pinnedAt?: string; snoozedUntil?: string; archivedAt?: string
  /** Auto-settle behavior: Disabled keeps it out of settling by itself. */
  autoSettleOff?: boolean
  /** A turn ended while no one had it open (Mark unread sets it too): "Done" in the list until it's opened. */
  unread?: boolean
  /** Its pull request as last seen: what settles it once merged or closed. */
  pr?: { number: number; url: string; state: string; at?: string }
}
/** `images`: the names of its pasted images, saved with the thread. */
export type Queued = { id: string; text: string; at: string; file?: string; images?: string[] }
export type GitState = {
  top: string; branch: string; base: string; upstream: string; ahead: number; behind: number; files: number; remote: string; gh: boolean; worktree: boolean
  pr?: { number: number; url: string; state: string; title: string; at?: string } | null
}
/** A file's change in the diff panel: `path` relative to the thread's checkout (or its folder). */
export type FileDiff = { path: string; file?: string; added: number; removed: number; hunks: Hunk[]; binary?: boolean; status: "added" | "deleted" | "modified" }
export type Live = { running: boolean; status: string }
export type Changes = { files: { path: string; file?: string; added: number; removed: number }[]; added: number; removed: number }
export type Summary = {
  id: string; title: string; harness: Harness; cwd: string; home: string; project: string; model: string; mode: Mode; updated: string
  created: string; running: boolean; waiting: boolean; status: string; asked: string; askedAt: string; last: string; changes: Changes; branch?: string; failed?: boolean
  queued?: number; settledAt?: string; settledOverride?: Thread["settledOverride"]; pr?: Thread["pr"]
  plan?: boolean; pinnedAt?: string; snoozedUntil?: string; archived?: boolean; unread?: boolean; woke?: boolean; autoSettleOff?: boolean
  /** Waiting on the user's answer to its questions (T3 Code's "Input"), not a permission. */
  input?: boolean
  /** When the turn under way began. */
  since?: string; worktree?: boolean
}
export type Project = { label: string; path: string; vault?: boolean }
export type Model = { value: string; label: string; description: string }
export type HarnessStatus = { installed: boolean; loggedIn: boolean; version: string; models: Model[]; account?: string }
export type Status = Record<Harness, HarnessStatus>
