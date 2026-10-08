// Live numbers on a project's card (from GET /api/github, this machine's cache of the GitHub API and local git): stars,
// open issues, downloads, commits this month; and the open issues below the links.
import { CircleDot, Download, GitCommitHorizontal, MessageSquare, Star } from "lucide-react"
import { Empty, fmtAgo, List, numberText, Stat, useLive, type BlockCtx } from "@vaultite"
import type { Project } from "@plugins/core/projects/types"
import { projectFor } from "@plugins/core/projects/Projects"

type Stats = { stars?: number; forks?: number; open_issues?: number; latest_release?: string; release_downloads?: number; last_commit?: string; commits_30d?: number }
type Issue = { number: number; title: string; url: string; created_at: string; comments?: number }
export type Feed = { projects: Record<string, { stats: Stats; issues: Issue[]; source: string }>; updated_at: string | null }

const useProject = (p: Project) => useLive<Feed>("github").data?.projects[p.slug]

export function ProjectStats({ project }: { project: Project }) {
  const s = useProject(project)?.stats ?? {}
  const stats = [
    s.stars != null && { icon: Star, label: "Stars", value: s.stars },
    s.open_issues != null && { icon: CircleDot, label: "Open issues", value: s.open_issues },
    s.release_downloads != null && { icon: Download, label: "Downloads", value: s.release_downloads, hint: s.latest_release ?? undefined },
    s.commits_30d != null && { icon: GitCommitHorizontal, label: "Commits this month", value: s.commits_30d, hint: s.last_commit && `last one ${fmtAgo(s.last_commit)}` },
  ].filter(Boolean) as { icon: typeof Star; label: string; value: number; hint?: string | null }[]
  if (!stats.length) return null
  return (
    <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {stats.map((x) => <Stat key={x.label} label={x.label} value={numberText(x.value)} hint={x.hint || undefined} />)}
    </div>
  )
}

export function ProjectIssues({ project, limit = 5 }: { project: Project; limit?: number }) {
  const issues = useProject(project)?.issues ?? []
  if (!issues.length || limit <= 0) return null
  return (
    <div className="mt-4">
      <div className="text-[13px] font-semibold text-muted-foreground">Open issues</div>
      <List>
        {issues.slice(0, limit).map((i) => (
          <a key={i.number} href={i.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 py-2.5 hover:opacity-80">
            <span className="w-10 shrink-0 text-[13px] text-muted-foreground tabular-nums">#{i.number}</span>
            <span className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-[20px]">{i.title}</span>
            {!!i.comments && (
              <span className="flex items-center gap-1 text-[13px] text-muted-foreground"><MessageSquare className="size-3.5" />{i.comments}</span>
            )}
          </a>
        ))}
      </List>
    </div>
  )
}

/** ```block-github: the numbers, then the open issues. Options: `stats: false`, `issues: 3` (0 hides them),
 *  `project: Lighthouse` (another project than the file's). */
export function GitHubBlock(ctx: BlockCtx) {
  const p = projectFor(ctx)
  if (!p) return <Empty>No project here. Put this block in a project file, or name one: project: Lighthouse</Empty>
  const { stats, issues } = ctx.options
  return (
    <div>
      {stats !== false && <ProjectStats project={p} />}
      <ProjectIssues project={p} limit={typeof issues === "number" ? issues : 5} />
    </div>
  )
}
