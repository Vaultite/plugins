## Style settings
Settings that the vault's CSS declares, drawn in this plugin's sheet and applied live: the app's own (accent colour,
line width) and those of each CSS snippet that's on (`.vaultite/snippets/*.css`, turned on in appearance.json's
`snippets`). Fonts and text sizes are the app's (`vau docs app`), not here.

- **Values**: `.vaultite/plugins/style-settings/data.json`, flat, as Obsidian's Style Settings keeps them (its data.json
  carries over): `"<section id>@@<setting id>": value`, a light/dark colour as `...@@light` and `...@@dark`. A key left
  out is the setting's default. `vau style-settings list` gives every key, its value and what it takes; `vau
  style-settings set <key> <value>` checks and writes one (`null`: the default).
- **Declaring settings** in a snippet: a `/* @settings */` comment of YAML, `name`, `id` and `settings` (Obsidian's
  format: `heading`, `info-text`, `class-toggle`, `class-select`, `variable-text`, `variable-number`,
  `variable-number-slider`, `variable-select`, `variable-color`, `variable-themed-color`; colour `format`s hex, rgb,
  rgb-values, rgb-split, hsl, hsl-values, hsl-split, hsl-split-decimal, with `opacity` and `alt-format`). A class goes on
  `<body>`; a variable is set on `:root` and `body`, so the app's own (`--primary`) follow it. `color-gradient` isn't
  supported. An Obsidian theme's own settings don't apply: the app takes only its colours.
