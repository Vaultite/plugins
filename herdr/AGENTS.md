## herdr
The herdr (herdr.dev) already running on this machine, reached through its socket (`~/.config/herdr/herdr.sock`, or a named
session's: the setting `session`); Vaultite never installs or starts it, and with none running this plugin does nothing.
Its panes are terminals: `view:terminal/herdr-<terminal id>` is one of the user's herdr panes (it opens through `herdr
terminal attach`, and closing the tab leaves it running; End session closes the pane in herdr), and a terminal Vaultite
started in herdr (`newTerminals` on) is a tab in herdr's "Vaultite" workspace, its pane labelled with the terminal's own
id (`claude-k3j2h1g0`), so `vau terminal` reads, types into and ends it like any other. The sidebar panel lists every
workspace's panes with their agents' states (herdr's detection: working, waiting for an answer, idle). From a shell
inside herdr, the `herdr` CLI drives it (`herdr --skill` explains); don't close panes or workspaces you didn't open.
