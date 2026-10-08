import { FileCode } from "lucide-react"
import { definePlugin } from "@vaultite"
import { CodeStatsBlock } from "./CodeStats"

export default definePlugin({
  icon: FileCode,
  blocks: { "code-stats": (ctx) => <CodeStatsBlock {...ctx} /> },
  preview: "projects",
  mockLive: () => ({
    "code-stats": { updated_at: new Date().toISOString(), projects: { "demo-app": {
      lines: 12400, files: 96, code: 8200, tests: 2300, comments: 1100, docs: 800,
      languages: [{ name: "TypeScript", lines: 10100 }, { name: "CSS", lines: 900 }, { name: "Markdown", lines: 800 }, { name: "Shell", lines: 600 }],
    } } },
  }),
})
