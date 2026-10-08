// Reddit: your posts about one project (settings: project, user). Reddit blocks scripts here, so Claude reads them
// through the browser (REFRESH.md) and PUTs them to /api/reddit, into the plugin's cache: live data, never a file.
import { bullets, Plugin, section } from "@vaultite/core/plugins.ts"
import { type Item, str } from "@vaultite/core/vault.ts"

export const plugin = new Plugin(import.meta.url)

plugin.route("GET", "reddit", () => ({ ...(plugin.readCache() ?? { posts: [], updated_at: null }), ...plugin.settings({}) }))

/** {"posts": [{id, title, subreddit, url, created, score, upvote_ratio, comments}]} */
plugin.route("PUT", "reddit", (req) => {
  const posts = req.body.posts || []
  plugin.writeCache({ user: req.body.user ?? null, posts, updated_at: new Date().toISOString().replace(/\.\d+Z$/, "+00:00") })
  return { ok: true, posts: posts.length }
})

/** The project a block is about: the file it's in, or the one its `project:` option names. */
function projectOf(ctx: { options: Item; path: string }) {
  const name = String(ctx.options.project || "").toLowerCase()
  const ps = plugin.vault.has("projects") ? plugin.vault.items("projects") : []
  return ps.find((p) => (name ? p.name.toLowerCase() === name : p.id + ".md" === ctx.path)) ?? null
}

/** The posts about the project Reddit is set up for, if the block's project is that one. */
plugin.block("reddit", (ctx) => {
  const p = projectOf(ctx), conf = plugin.settings({})
  if (!p || p.name.toLowerCase() !== String(conf.project || "").toLowerCase()) return ""
  const posts: Item[] = plugin.readCache()?.posts || []
  return section("On Reddit", bullets(posts.map((x) => `[${x.title}](${x.url}) in r/${str(x.subreddit) || "None"}: ${str(x.score) || "None"} points, ` +
    `${str(x.comments) || "None"} comments (${str(x.created || "").slice(0, 10)})`), "No posts yet."))
})
