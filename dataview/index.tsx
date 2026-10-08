// Dataview's frontend: ```dataview fences (View.tsx), a calm note for ```dataviewjs, and inline queries in notes
// (inline.ts), kept live by one listener for the vault's changes.
import { Database } from "lucide-react"
import { definePlugin, useVaultChange, type BlockCtx } from "@vaultite"
import { DataviewFence, DataviewJsFence } from "./View"
import { changed, inlineQueries } from "./inline"

function Watch() {
  useVaultChange(() => changed(), (p) => !p.startsWith("."))
  return null
}

export default definePlugin({
  icon: Database,
  fences: {
    dataview: (ctx) => <DataviewFence {...ctx} />,
    dataviewjs: () => <DataviewJsFence />,
  },
  editor: (ctx) => (ctx.kind === "markdown" && ctx.path ? inlineQueries(ctx.path) : []),
  background: () => <Watch />,
  slash: () => [
    { id: "dataview:table", title: "Dataview table", section: "Database", keywords: "dataview dql query table obsidian", detail: "A Dataview query",
      line: true, text: "```dataview\nTABLE $|\nFROM \"\"\n```\n" },
    { id: "dataview:tasks", title: "Dataview tasks", section: "Database", keywords: "dataview dql query task todo obsidian", detail: "Open tasks",
      line: true, text: "```dataview\nTASK\nWHERE !completed$|\n```\n" },
  ],
  preview: () => <DataviewFence {...({ text: "TABLE author, rating FROM #book", path: "" } as BlockCtx)} />,
  mockLive: () => ({
    "dataview/query": { title: "#book", result: { type: "table", id: true, headers: ["File", "Author", "Rating"], rows: [
      { path: "Books/Dune.md", cells: [{ $: "link", path: "Books/Dune.md", exists: true }, "Frank Herbert", 9] },
      { path: "Books/Piranesi.md", cells: [{ $: "link", path: "Books/Piranesi.md", exists: true }, "Susanna Clarke", 8] },
    ] } },
  }),
})
