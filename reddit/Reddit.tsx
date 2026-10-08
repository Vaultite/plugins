// A project's Reddit posts (the plugin's settings name the project), from GET /api/reddit: the plugin's cache, which
// Claude refreshes through the browser (REFRESH.md).
import { ArrowBigUp, MessagesSquare } from "lucide-react"
import { cn, Empty, fmtAgo, List, numberText, Stat, useLive, type BlockCtx } from "@vaultite"
import type { Project } from "@plugins/core/projects/types"
import { projectFor } from "@plugins/core/projects/Projects"

type Post = { id: string; title: string; subreddit: string; url: string; created: string; score: number; upvote_ratio?: number; comments: number; views?: number }
export type Feed = { project?: string; user?: string; posts: Post[]; updated_at: string | null }

export function RedditPosts({ project }: { project: Project }) {
  const { data } = useLive<Feed>("reddit")
  if (!data || (data.project ?? "").toLowerCase() !== project.name.toLowerCase()) return null
  const posts = data.posts
  if (!posts.length) return <div className="mt-4"><Empty>No Reddit posts yet. Ask Claude to refresh your {project.name} posts.</Empty></div>
  const max = Math.max(...posts.map((p) => p.score), 1)
  const total = (k: "score" | "comments") => posts.reduce((n, p) => n + (p[k] || 0), 0)
  return (
    <div className="mt-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[17px] font-semibold">Reddit</h3>
        {data.updated_at && <span className="text-[12px] text-muted-foreground">updated {fmtAgo(data.updated_at)}</span>}
      </div>
      <div className="mb-4 grid grid-cols-3 gap-4">
        <Stat label="Posts" value={posts.length} />
        <Stat label="Upvotes" value={numberText(total("score"))} />
        <Stat label="Comments" value={numberText(total("comments"))} />
      </div>
      <List>
        {[...posts].sort((a, b) => b.created.localeCompare(a.created)).map((p) => (
          <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block py-3 hover:opacity-80">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[15px] leading-snug font-medium">{p.title}</div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  r/{p.subreddit} · {fmtAgo(p.created)}
                  {p.upvote_ratio != null && ` · ${Math.round(p.upvote_ratio * 100)}% upvoted`}
                  {p.views ? ` · ${numberText(p.views)} views` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[14px] tabular-nums">
                <span className="flex items-center gap-0.5 font-medium"><ArrowBigUp className="size-4 text-[var(--orange)]" />{p.score}</span>
                <span className="flex items-center gap-1 text-muted-foreground"><MessagesSquare className="size-3.5" />{p.comments}</span>
              </div>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full bg-[var(--orange)]")} style={{ width: `${(p.score / max) * 100}%` }} />
            </div>
          </a>
        ))}
      </List>
    </div>
  )
}

/** ```block-reddit: the posts about the file's project (or `project: Lighthouse`). */
export function RedditBlock(ctx: BlockCtx) {
  const p = projectFor(ctx)
  if (!p) return <Empty>No project here. Put this block in a project file, or name one: project: Lighthouse</Empty>
  return <RedditPosts project={p} />
}
