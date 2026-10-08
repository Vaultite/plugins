import { definePlugin } from "@vaultite"
import { RedditBlock } from "./Reddit"

export default definePlugin({
  blocks: { reddit: (ctx) => <RedditBlock {...ctx} /> },
  preview: "projects",
  mockLive: () => ({
    reddit: { project: "Demo app", user: "you", updated_at: new Date().toISOString(), posts: [
      { id: "a", title: "I made a small open source tool", subreddit: "opensource", url: "#", created: new Date(Date.now() - 864e5 * 3).toISOString(), score: 120, upvote_ratio: 0.96, comments: 24 },
      { id: "b", title: "Demo app 0.3 is out", subreddit: "programming", url: "#", created: new Date(Date.now() - 864e5 * 20).toISOString(), score: 45, upvote_ratio: 0.9, comments: 8 },
    ] },
  }),
})
