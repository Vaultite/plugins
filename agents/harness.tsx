// Each harness as the app draws it: its name, mark (its plugin's, when that's on) and colour, and the permission modes.
import { Bot, Lock, LockOpen, PencilRuler, Sparkles, type LucideIcon } from "lucide-react"
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

export const MODES: { id: Mode; icon: LucideIcon; label: (h: Harness) => string; hint: string; tip: (h: Harness) => string }[] = [
  { id: "ask", icon: Lock, label: () => "Supervised", hint: "asks first", tip: (h) => (h === "claude" ? "Claude asks before it changes a file or runs a command" : "Codex reads freely, and asks before it changes a file or runs anything that writes") },
  { id: "edits", icon: LockOpen, label: () => "Auto-accept edits", hint: "edits freely", tip: (h) => (h === "claude" ? "Claude edits files without asking; it still asks before commands" : "Codex edits and runs commands in its folder, asking only to go beyond it") },
  { id: "read", icon: PencilRuler, label: (h) => (h === "claude" ? "Plan" : "Read only"), hint: "changes nothing", tip: (h) => `${SHORT[h]} reads and plans, and changes nothing` },
]

export const STATUS: Record<string, string> = { thinking: "Thinking", working: "Working", writing: "Writing", waiting: "Waiting for you", delegating: "Working with an agent", preparing: "Setting up worktree" }
