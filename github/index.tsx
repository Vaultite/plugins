import { GitBranch } from "lucide-react"
import { definePlugin } from "@vaultite"
import { GitHubBlock } from "./GitHub"

export default definePlugin({
  icon: GitBranch,
  blocks: { github: (ctx) => <GitHubBlock {...ctx} /> },
  preview: "projects",
  mockLive: () => ({
    github: { updated_at: new Date().toISOString(), projects: { "demo-app": { source: "github", issues: [], stats: {
      stars: 42, forks: 3, open_issues: 1, latest_release: "v0.3.0", release_downloads: 120, last_commit: new Date().toISOString(), commits_30d: 12,
    } } } },
  }),
})
