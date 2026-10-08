// Quick add's part of the store (plugin.ts: `quickadd` in /api/state): the choices, its own or Obsidian QuickAdd's.
import type { Choice } from "./choices"

declare module "@vaultite" {
  interface PluginState { quickadd?: { choices: Choice[]; from: "own" | "quickadd" | null } }
}
