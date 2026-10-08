# Refresh the Reddit plugin's posts (manual, needs a browser signed in to Reddit)

Reddit refuses plain scripted requests (its `.json` endpoints answer 403 without a browser session), so this can't run on
its own. An agent refreshes it through a browser it can drive where Reddit is signed in as the user (`user` in the
plugin's settings): a browser automation tool, or the user's own browser with an extension.

**Strictly read-only.** Only GET requests. Never post, vote, comment, message, follow or save.

## Steps

1. Open `https://www.reddit.com/api/me.json` in a tab of your own.
2. Run this script in that page (it also works from any reddit.com page) and take what it returns:

   The project name to look for is `project` in `GET /api/reddit` (the plugin's settings, e.g. "Lighthouse").

   ```js
   const me = (await (await fetch('/api/me.json')).json()).data;
   const user = me.name;
   const all = []; let after = null;
   for (let i = 0; i < 10; i++) {
     const j = await (await fetch(`/user/${user}/submitted.json?limit=100&raw_json=1${after ? '&after=' + after : ''}`)).json();
     all.push(...j.data.children.map(c => c.data));
     after = j.data.after; if (!after) break;
   }
   const posts = all
     .filter(p => /lighthouse/i.test(`${p.title} ${p.selftext} ${p.url}`))   // the project's name
     .map(p => {
       const o = { id: p.id, title: p.title, subreddit: p.subreddit,
         url: 'https://www.reddit.com' + p.permalink,
         created: new Date(p.created_utc * 1000).toISOString(),
         score: p.score, upvote_ratio: p.upvote_ratio, comments: p.num_comments };
       if (p.view_count != null) o.views = p.view_count;   // Reddit returns null for views today
       return o;
     });
   return JSON.stringify({ user, posts });
   ```

   It can be long: make sure nothing truncates it.
3. Save the returned string to a scratch file and PUT it:

   ```sh
   curl -s -X PUT -H 'Content-Type: application/json' --data-binary @reddit.json \
     http://127.0.0.1:8793/api/reddit
   ```
4. Check: `curl -s localhost:8793/api/reddit | head -c 300`.

The posts go to the plugin's cache (`.vaultite/cache/reddit.json` in the vault, hidden), not a file: they're live numbers.
Shape: `{"user", "posts": [{"id", "title", "subreddit", "url", "created", "score", "upvote_ratio", "comments", "views"?}]}`.
