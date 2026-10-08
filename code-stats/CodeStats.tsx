// Lines of code on a project's card (from GET /api/code-stats, this machine's count of the project's local checkout):
// one bar split into code, tests, comments and docs, then its languages.
import { Empty, numberText, Stat, useLive, type BlockCtx } from "@vaultite"
import { projectFor } from "@plugins/core/projects/Projects"

type Lang = { name: string; lines: number }
type Counts = { lines: number; files: number; code: number; tests: number; comments: number; docs: number; languages: Lang[] }
type Feed = { projects: Record<string, Counts>; updated_at: string | null }

const PARTS = [
  { key: "code", label: "Code", color: "var(--blue)" },
  { key: "tests", label: "Tests", color: "var(--green)" },
  { key: "comments", label: "Comments", color: "var(--orange)" },
  { key: "docs", label: "Docs", color: "var(--purple)" },
] as const

const short = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : numberText(n))
const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0)

/** ```block-code-stats: lines split into code, tests, comments and docs, then the languages. Options: `languages: 3`
 *  (0 hides them), `project: Lighthouse` (another project than the file's). */
export function CodeStatsBlock(ctx: BlockCtx) {
  const p = projectFor(ctx)
  const feed = useLive<Feed>("code-stats").data
  if (!p) return <Empty>No project here. Put this block in a project file, or name one: project: Lighthouse</Empty>
  const s = feed?.projects[p.slug]
  if (!s) return feed ? <Empty>{p.path ? "Not counted yet." : "No local checkout: add a path to this project."}</Empty> : null
  const n = typeof ctx.options.languages === "number" ? ctx.options.languages : 4
  const langs = s.languages.slice(0, n)
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Lines" value={short(s.lines)} hint={`${numberText(s.files)} files`} />
        {PARTS.slice(0, 3).map((x) => <Stat key={x.key} label={x.label} value={short(s[x.key])} hint={`${pct(s[x.key], s.lines)}%`} />)}
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img"
        aria-label={PARTS.map((x) => `${x.label} ${pct(s[x.key], s.lines)}%`).join(", ")}>
        {PARTS.map((x) => s[x.key] > 0 && <div key={x.key} style={{ width: `${(s[x.key] / s.lines) * 100}%`, background: x.color }} />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
        {PARTS.map((x) => (
          <span key={x.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: x.color }} />
            {x.label} <span className="tabular-nums">{short(s[x.key])}</span>
          </span>
        ))}
      </div>
      {langs.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {langs.map((l) => (
            <span key={l.name} className="rounded-full bg-muted px-2.5 py-0.5 text-[12px]">
              {l.name} <span className="text-muted-foreground tabular-nums">{pct(l.lines, s.lines)}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
