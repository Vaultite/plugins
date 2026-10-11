## Agents
Claude Code and Codex threads (a sidebar panel `agents:threads`, each thread a `view:agents/<id>` tab): each runs the
user's own CLI on the server's machine in the thread's folder (the vault, or a project's `path`), `claude` with stream
JSON or `codex app-server`, with the thread's access (`ask` supervised, `edits`, `auto`, `full`: new threads get full
access), plan mode, model and effort. Threads are kept on that machine, never in the vault. From an agent or a script:
`vau agents ask "<message>"` (`--harness codex --cwd <folder>` for a new thread, `--thread <id>` to follow up) waits
for the answer; `vau agents list` lists them.

A thread in a git checkout can have its own worktree (`~/.vaultite/worktrees/<repo>/<branch>`, on a new branch
`agents/<a name the model writes>`, made at its first message), or be made from a pull request (`gh`). Each turn keeps
a checkpoint of the folder before and after (`refs/vaultite-agents/<thread>/`), so its diff is git's and Edit from here
can put the files back; the chat's header commits (the model writes the message), pushes and opens a pull request.
Deleting a thread removes its worktree when nothing in it is uncommitted and no other thread works there; the branch
stays.

Threads settle by hand, or by themselves once their pull request is merged or closed, or after three quiet days.

A turn under way keeps its process's pid with the thread: after a restart or an update, the next start ends that
process if it's still there and the turn goes on (a message saying so). Open in terminal mid-turn stops it here and the
terminal goes on; the app won't run that session again while a process has it (`pgrep -f <session>`).
