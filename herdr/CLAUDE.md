# Notes for `herdr/`

- The user's own herdr (herdr.dev), through its socket API (newline JSON, a connection per request; `session.snapshot`
  memoized a second), never bundled or started. It's Terminal's backend `herdr`: panes Vaultite started live in herdr's
  "Vaultite" workspace; others are `herdr-<id>`, `external` (never ended by idleness or a closed tab).
- Tabs attach with `herdr terminal attach --takeover` in a pty, ⌃B doubled (herdr's prefix: ⌃B q would detach),
  mirrored into a headless xterm for pictures (`backendKit.mirrored`). QA: `herdr/qa/herdr.mjs`.
