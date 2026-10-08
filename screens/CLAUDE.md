# Notes for `screens/`

- noVNC (`Screen.tsx`, its own chunk) on a socket the server relays to the screen's VNC port (`plugin.ts`): `local` is
  this Mac's Screen Sharing (Apple's auth, type 30), other ids from settings, `@<machine>` through that machine.
- App mode crops one app's window: `windows.js` (JXA, no permission prompts) lists windows in points, and the view takes
  over noVNC's private `_updateClip` / `_updateScale` (pinned version: `novnc.d.ts`).
- Remembered logins live in the relaying machine's `data/config.json`. QA: `screens/qa/screens.mjs` (a fake VNC server).
- Sockets (owner only): `/api/screens/vnc/<screen>` sends one text message (`ready` with a remembered login, or
  `refused`/`error`), then VNC bytes; the page sends `remember`/`forget`/`stats`. `/api/screens/windows/<screen>` sends
  `windows` and takes `open`. The relay pipelines updates (`rfb.ts`) unless `pipeline: false`.
- Checked only against the fake VNC server: the phone key row's Mac keys (`MAC_MODS`: Alt_L as Command, Meta_L as
  Option) and speed on a real Mac screen (`screens/qa/screensbench.mjs`, `REAL=1`). Suspect these first when cmd/opt or lag misbehave.
