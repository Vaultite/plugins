# Vaultite plugins

Plugins that live outside the app's repo, written against the public plugin API only: the same rules as any vault
plugin (`vau docs vault-plugins`, the app's `plugins/CLAUDE.md`). The app's checkout is `../vaultite` (`$VAULTITE_APP`).

- One folder per plugin, its id as the name, `manifest.json` at its top with `repo: "Vaultite/plugins"`.
- Types against the app: `ln -s ../vaultite/node_modules node_modules` once, then `npm run typecheck`.
- Check one: `node ../vaultite/tools/check_plugins.ts --plugin <id> --installable`. A release is a tag
  `<id>/v<version>` matching its manifest's `version`.
- After tagging a release, rebuild the directory, or Browse won't show it until `index.yml`'s daily run:
  `GITHUB_TOKEN=$(gh auth token) node ../vaultite/tools/plugin-index.ts --listed directory/listed.json --blocked
  directory/blocked.json --out directory/index.json`, commit and push.
- Every folder here shows in the app's Get plugins: public plugins only. One person's plugins (their tools, accounts,
  data) go in a repository of their own.
- Tests: `node test.ts [id...]` checks each plugin and runs its `<id>/.test/test.ts` (hidden: never installed, not part
  of its version) on a throwaway server (`testkit.ts`: a sandbox vault, ports 8930-8939, the plugin installed and on).
  QA scripts, `<id>/.test/qa/<name>.mjs <base url>`, use the app's `web/qa/lib` (`qa.mjs` here) and install the
  plugin themselves: only against a throwaway server. `inProcess` (testkit) runs the app in the test's own process, for
  what only its objects show (a plugin's services, an op asked as someone else).
- Try one in a throwaway server, never the user's vault (the app's CLAUDE.md, Running).
- Comments at most 2 lines; docs short. No one's personal data: made-up names (Alice Park, Lighthouse).

## Plugins
- **Git**: runs the user's git in the vault's folder (`git.ts`: argv, its own session, prompts off; ops are the API,
  the panel uses them too). Tests and QA use throwaway repositories (a bare one in a temp folder as the remote) with
  `GIT_CONFIG_GLOBAL` pointing at a made-up author, never the machine's config or GitHub.
- **Coding agents** (Cursor, Grok Bot, Hermes, OpenClaw, OpenCode) build on the app's agents API
  (`@vaultite/core/agents.ts`). Their tests read made-up homes (`<id>/.test/fixtures`, pointed at by env vars), never
  this machine's; `node test_agents.ts` runs them in real terminals with fake agents (`VAULTITE_AGENT_LIVE=1`: the
  real ones, a few cents), on the app's `tools/test/agentkit.ts`.
