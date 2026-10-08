// Admonitions for agents: each ```ad-<type> fence read as its callout (`fence:<lang>`, GET /api/render).
import { Plugin } from "@vaultite/core/plugins.ts"
import { toCallout, TYPES } from "./ad.ts"

export const plugin = new Plugin(import.meta.url)

for (const t of TYPES) plugin.provide(`fence:ad-${t}`, ({ text }: { text: string }) => toCallout(t, text).md)
