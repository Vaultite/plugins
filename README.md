# Vaultite plugins

Vaultite's own plugins that don't ship with the app, and the plugin directory's data. Each top-level folder is one
plugin, installed like anyone's: `vau plugin install Vaultite/plugins/<id>`, or from the Plugins page's Browse.

- `directory/`: `listed.json` (repositories the topic search misses), `blocked.json` (versions with a known problem) and
  `index.json`, the directory the app reads (built by the app's `tools/plugin-index.ts`).
