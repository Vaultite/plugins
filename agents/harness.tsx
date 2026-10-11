// Each harness as the app draws it: its name, mark (its plugin's, when that's on) and colour, and the access modes.
import { Bot, Lock, LockOpen, PenLine, Sparkles, type LucideIcon } from "lucide-react"
import { iconNamed } from "@vaultite"
import type { Harness, Mode } from "./types"

export const HARNESSES: Harness[] = ["claude", "codex"]
export const NAME: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" }
export const SHORT: Record<Harness, string> = { claude: "Claude", codex: "Codex" }
export const TINT: Record<Harness, string | undefined> = { claude: "var(--orange)", codex: undefined }

const mark = (name: string, fallback: LucideIcon) => ((props) => {
  const I = iconNamed(name) ?? fallback
  return <I {...props} />
}) as LucideIcon
export const ICON: Record<Harness, LucideIcon> = { claude: mark("claude", Bot), codex: mark("openai", Sparkles) }
export const AgentsIcon = Bot

/** T3 Code's runtime modes, its labels and order; new threads get full access, as there. */
export const MODES: { id: Mode; icon: LucideIcon; label: string; hint: string; tip: string }[] = [
  { id: "ask", icon: Lock, label: "Supervised", hint: "asks first", tip: "Ask before commands and file changes." },
  { id: "edits", icon: PenLine, label: "Auto-accept edits", hint: "edits freely", tip: "Auto-approve edits, ask before other actions." },
  { id: "auto", icon: Sparkles, label: "Auto", hint: "routine is approved", tip: "The agent's own reviewer approves routine actions; others still ask." },
  { id: "full", icon: LockOpen, label: "Full access", hint: "never asks", tip: "Allow commands and edits without prompts." },
]
export const DEFAULT_MODE: Mode = "full"

/** How hard it thinks: each CLI's own levels (Claude Code's --effort, Codex's reasoning effort), T3 Code's labels. */
export const EFFORTS: Record<"claude" | "codex", { id: string; label: string }[]> = {
  claude: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra High" }, { id: "max", label: "Max" }],
  codex: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra High" }],
}

export const STATUS: Record<string, string> = { thinking: "Thinking", working: "Working", writing: "Writing", waiting: "Waiting for you", delegating: "Working with an agent", preparing: "Setting up worktree" }
