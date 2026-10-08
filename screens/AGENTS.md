## Screen sharing
Another computer's screen in a tab, over VNC, relayed by the server (the page never reaches the VNC port itself). A tab
`view:screen/local@<machine>` is that Mac's own screen (macOS Screen Sharing, which must be on: System Settings >
General > Sharing), `view:screen/<id>` a VNC server from the settings; `view:screen/<screen>/<App>` shows only that app's
front window (a Mac's; the tab brings the app to the front, starting it if needed). `view:screens` and the block
`screens` list them. Settings, `.vaultite/plugins/screens/data.json`: `{"screens": [{"id": "box", "label": "Box",
"host": "100.64.0.9", "port": 5900}], "localPort": 5900}`, and like Terminal's, `allowUsers` / `allowRemote` (only this
Mac's owner may open a screen by default). Logins a user asks a machine to remember are in its `data/config.json`
(`screens.<id>`), never the vault. A page keeps each screen's connection while a tab shows it and 10 minutes after
(the `screens` block and panel say which are connected, and disconnect them); on phones the tab's menu chooses trackpad
or touch, kept per device (not in the vault). The relay asks the screen for updates ahead of the page, so the network's
round trip doesn't pace the picture (`"pipeline": false` in the settings turns that off); a tab's speed stats (its gauge
button) show updates a second, input to update and bytes, and `GET /api/screens/stats` the relay's side.
