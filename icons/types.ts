// Icons' part of the store (plugin.ts: `icons` in /api/state): each folder's or file's icon and colour, by path.
import type { FileIcon } from "@vaultite"

declare module "@vaultite" {
  interface PluginState { icons?: Record<string, FileIcon> }
}
