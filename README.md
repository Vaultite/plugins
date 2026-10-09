# Vaultite plugins

Vaultite's own plugins that don't ship with the app, and the plugin directory's data. Each top-level folder is one
plugin, installed like anyone's: `vau plugin install Vaultite/plugins/<id>`, or from the Plugins page's Browse.

- `directory/`: `listed.json` (repositories the topic search misses), `blocked.json` (versions with a known problem) and
  `index.json`, the directory the app reads (built by the app's `tools/plugin-index.ts`).

## License

[MIT](LICENSE). `plugin-compat/lib/` holds copies of buffer, base64-js, ieee754, Moment.js and path-browserify under
their own licences (`plugin-compat/lib/LICENSES.md`).

The plugins named after Obsidian community plugins are Vaultite's own, written to read the same files; they contain
none of those plugins' code, which the user downloads from its authors when they choose the original. Obsidian is a
trademark of Dynalist Inc., and the logos in plugins' `icon.svg` (Excalidraw, Git, Hevy, Reddit, Tailscale) are
trademarks of their owners; none of them is affiliated with or endorses Vaultite.
