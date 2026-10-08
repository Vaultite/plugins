// GitHub: live numbers for each project with `repo:` or `path:`, from the API (public) or the checkout; cached, refreshed
// after an hour. ~/Documents isn't readable under launchd: checkouts there keep the numbers they had.
import { execFile } from "node:child_process"
import os from "node:os"
import { bullets, Plugin } from "@vaultite/core/plugins.ts"
import { type Item } from "@vaultite/core/vault.ts"

export const plugin = new Plugin(import.meta.url)
const TTL = 3600
const UA = "vaultite/1.0 (personal dashboard)"
const HOME = os.homedir()
let refreshing = false

class HTTPStatus extends Error {
  status: number
  constructor(status: number, url: string) {
    super(`HTTP Error ${status}: ${url}`)
    this.name = "HTTPError"
    this.status = status
  }
}

async function gh(p: string) {
  const r = await fetch("https://api.github.com" + p, {
    headers: { "User-Agent": UA, "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new HTTPStatus(r.status, p)
  return r.json()
}

function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("/usr/bin/git", ["-C", dir, ...args], { timeout: 30000 }, (err, stdout) => resolve(err ? "" : stdout.trim()))
  })
}

/** Last commit and 30-day commit count across all local branches (worktrees included). */
async function localStats(dir: string): Promise<Item> {
  if (!(await git(dir, "rev-parse", "--git-dir"))) return {}
  const last = await git(dir, "log", "--all", "-1", "--format=%cI")
  const n = await git(dir, "rev-list", "--all", "--count", "--since=30.days.ago")
  return { last_commit: last || null, commits_30d: /^\d+$/.test(n) ? Number(n) : null }
}

/** [stats, open issues] for a public repo, or null if it isn't reachable (private, rate limited). */
async function githubStats(repo: string): Promise<[Item, Item[]] | null> {
  let info: Item
  try {
    info = await gh(`/repos/${repo}`)
  } catch (e) {
    if (e instanceof HTTPStatus) return null
    throw e
  }
  const since = new Date(Date.now() - 30 * 86400000).toISOString().replace(/\.\d+Z$/, "Z")
  const stats: Item = { stars: info.stargazers_count, forks: info.forks_count }
  const releases: Item[] = await gh(`/repos/${repo}/releases?per_page=100`)
  stats.latest_release = releases.find((r) => !r.draft && !r.prerelease)?.tag_name ?? (releases.length ? releases[0].tag_name : null)
  stats.release_downloads = releases.reduce((s, r) => s + (r.assets ?? []).reduce((t: number, a: Item) => t + a.download_count, 0), 0)
  let commits: Item[] = []
  for (let page = 1; page <= 5; page++) {
    const batch: Item[] = await gh(`/repos/${repo}/commits?since=${since}&per_page=100&page=${page}`)
    commits = [...commits, ...batch]
    if (batch.length < 100) break
  }
  stats.commits_30d = commits.length
  const last = commits.length ? commits[0] : ((await gh(`/repos/${repo}/commits?per_page=1`)) as Item[])[0] ?? null
  stats.last_commit = last ? last.commit.committer.date : null
  const issues = ((await gh(`/repos/${repo}/issues?state=open&per_page=100`)) as Item[])
    .filter((i) => !("pull_request" in i))
    .map((i) => ({ number: i.number, title: i.title, url: i.html_url, created_at: i.created_at, comments: i.comments }))
  stats.open_issues = issues.length
  return [stats, issues]
}

const newer = (a: string | null | undefined, b: string | null | undefined) => !!a && (!b || Date.parse(a) > Date.parse(b))

async function build(projects: Item[], old: Item) {
  const out: Item = {}
  for (const p of projects) {
    const prev = old[p.slug] ?? {}
    let stats: Item = {}, issues: Item[] = [], source = "local"
    if (p.repo) {
      let res: [Item, Item[]] | null = null
      try {
        res = await githubStats(p.repo)
      } catch (e) { // network / rate limit
        console.error(`github: ${p.repo}: ${(e as Error).message}`)
      }
      if (res) {
        [stats, issues] = res
        source = "github"
      }
    }
    const dir = p.path ? String(p.path).replace(/^~(?=$|\/)/, HOME) : null
    const local: Item = dir && !dir.startsWith(`${HOME}/Documents/`)
      ? await localStats(dir)
      : { last_commit: prev.stats?.last_commit ?? null, commits_30d: prev.stats?.commits_30d ?? null }
    if (source === "local") {
      for (const [k, v] of Object.entries(local)) if (v !== null && v !== undefined) stats[k] = v
    } else if (newer(local.last_commit, stats.last_commit)) {
      stats.last_commit = local.last_commit // unpushed or feature-branch work is newer
    }
    if (Object.keys(stats).length) out[p.slug] = { stats, issues, source }
  }
  return { projects: out, updated_at: new Date().toISOString().replace(/\.\d+Z$/, "+00:00") }
}

async function refresh(projects: Item[]) {
  if (refreshing) return
  refreshing = true
  try {
    plugin.writeCache(await build(projects, plugin.readCache()?.projects ?? {}))
  } catch (e) {
    console.error(`github: refresh failed: ${(e as Error).message}`)
  } finally {
    refreshing = false
  }
}

/** {"projects": {slug: {stats, issues, source}}, "updated_at"}: the cache, refreshed in the background when stale. */
plugin.route("GET", "github", () => {
  const cache = plugin.readCache() ?? {}
  const age = cache.updated_at ? (Date.now() - Date.parse(cache.updated_at)) / 1000 : 1e9
  if (!(age <= TTL)) void refresh(plugin.vault.items("projects"))
  return Object.keys(cache).length ? cache : { projects: {}, updated_at: null }
})

/** The project a block is about: the file it's in, or the one its `project:` option names. */
function projectOf(ctx: { options: Item; path: string }) {
  const name = String(ctx.options.project || "").toLowerCase()
  const ps = plugin.vault.has("projects") ? plugin.vault.items("projects") : []
  return ps.find((p) => (name ? p.name.toLowerCase() === name : p.id + ".md" === ctx.path)) ?? null
}

/** The numbers from the cache (refreshed by the app), then the open issues. */
plugin.block("github", (ctx) => {
  const p = projectOf(ctx)
  const hit = p ? plugin.readCache()?.projects?.[p.slug] : null
  if (!hit) return p ? "_No GitHub numbers for this project yet._" : ""
  const s: Item = hit.stats ?? {}, o = ctx.options
  const names: [string, string][] = [["stars", "Stars"], ["forks", "Forks"], ["open_issues", "Open issues"],
    ["latest_release", "Latest release"], ["release_downloads", "Downloads"], ["commits_30d", "Commits in the last 30 days"],
    ["last_commit", "Last commit"]]
  const parts = o.stats !== false ? [bullets(names.filter(([k]) => s[k] !== null && s[k] !== undefined).map(([k, label]) => `${label}: ${s[k]}`))] : []
  const n = Number.isInteger(o.issues) ? o.issues : 5
  const issues: Item[] = (hit.issues ?? []).slice(0, n)
  if (issues.length) parts.push("Open issues:\n" + bullets(issues.map((i) => `#${i.number} [${i.title}](${i.url})`)))
  return parts.join("\n\n")
})
