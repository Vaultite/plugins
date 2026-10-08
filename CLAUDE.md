# Vaultite plugins

Plugins that live outside the app's repo, written against the public plugin API only: the same rules as any vault
plugin (`vau docs vault-plugins`, the app's `plugins/CLAUDE.md`). The app's checkout is `../vaultite` (`$VAULTITE_APP`).

- One folder per plugin, its id as the name, `manifest.json` at its top with `repo: "Vaultite/plugins"`.
- Types against the app: `ln -s ../vaultite/node_modules node_modules` once, then `npm run typecheck`.
- Check one: `node ../vaultite/tools/check_plugins.ts --plugin <id> --installable`. A release is a tag
  `<id>/v<version>` matching its manifest's `version`.
- After tagging a release, rebuild the directory or Browse won't show it (the repo is private, so `index.yml` never runs):
  `GITHUB_TOKEN=$(gh auth token) node ../vaultite/tools/plugin-index.ts --listed directory/listed.json --blocked
  directory/blocked.json --out directory/index.json`, commit and push.
- Tests: `node test.ts [id...]` checks each plugin and runs its `<id>/.test/test.ts` (hidden: never installed, not part
  of its version) on a throwaway server (`testkit.ts`: a sandbox vault, ports 8930-8939, the plugin installed and on).
  QA scripts, `<id>/.test/qa/<name>.mjs <base url>`, use the app's `web/qa/lib` (`qa.mjs` here) and install the
  plugin themselves: only against a throwaway server.
- Try one in a throwaway server, never the user's vault (the app's CLAUDE.md, Running).
- Comments at most 2 lines; docs short. No one's personal data: made-up names (Alice Park, Lighthouse).

## Plugins
- **GitHub and Code stats**: cached in `.vaultite/cache/`. The server can't read ~/Documents (macOS privacy under
  launchd), so checkouts there keep the numbers they had.
- **Reddit**: Reddit blocks scripts here, so refresh through the browser following `reddit/REFRESH.md` exactly
  (read-only on Reddit).
- **Tailscale**: reads `tailscale serve status` and `tailscale status` live (blocks `tailscale`, `tailnet`); labels in
  `.vaultite/plugins/tailscale/data.json` (by port; `host` for one machine's). When you add or remove a `tailscale
  serve` mapping, update that file too.
- **Imports** (ops that POST to `/api/logs`: upserts, reruns are safe): `vau hevy import <workouts.csv>` (its times are
  in this machine's zone; `--tz Area/City` re-dates) and `vau apple-health import <export.zip>` (`--skip strength`
  when Hevy brings those). Each reads a file on the server's machine, so only its owner may run it.
- **Git**: runs the user's git in the vault's folder (`git.ts`: argv, its own session, prompts off; ops are the API,
  the panel uses them too). Tests and QA use throwaway repositories (a bare one in a temp folder as the remote) with
  `GIT_CONFIG_GLOBAL` pointing at a made-up author, never the machine's config or GitHub.
- **Claude chat**: the user's `claude` with stream JSON both ways; permission asks reach it only with
  `--permission-prompt-tool stdio` (else they're denied). Tests and QA use `claude-chat/.test/fake-claude.mjs` (recorded
  lines replayed, `CLAUDE_CHAT_CLI` and `FAKE_CLAUDE_STATE` on the server), never the real CLI.
