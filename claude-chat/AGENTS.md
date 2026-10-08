## Claude chat
Claude Code as a chat in the app (a sidebar panel and `view:claude-chat/<id>` tabs): each conversation runs the user's
own `claude` CLI on the server's machine in the vault's folder, a Claude Code session resumed for each follow-up, with
the permission mode its settings say (`mode`: ask before edits, accept edits, plan only; `model`). Conversations are
kept on that machine, never in the vault. From an agent or a script, `claude-chat ask "<message>"` sends one and waits
for the answer (`--conversation <id>` follows up; `claude-chat list` lists them); when Claude asks to edit or run
something, the user answers in the chat, so it waits for them. A conversation's session can go on in a terminal: the
chat's More menu, Open in terminal (`vau terminal resume <session id>`).
