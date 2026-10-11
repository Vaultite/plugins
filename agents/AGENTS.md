## Agents
Claude Code and Codex threads (a sidebar panel `agents:threads`, each thread a `view:agents/<id>` tab): each runs the
user's own CLI on the server's machine in the thread's folder (the vault, or a project's `path`), `claude` with stream
JSON or `codex app-server`, with the thread's permissions (`ask`, `edits`, `read`) and model. Threads are kept on that
machine, never in the vault. From an agent or a script: `vau agents ask "<message>"` (`--harness codex --cwd <folder>`
for a new thread, `--thread <id>` to follow up) waits for the answer; `vau agents list` lists them.

A thread in a git checkout can have its own worktree (`~/.vaultite/worktrees/<repo>/<branch>`, on a new branch
`agents/<what it was asked>`, made at its first message). Each turn keeps a checkpoint of the folder before and after
(`refs/vaultite-agents/<thread>/`), so its diff is git's; the chat's header commits, pushes and opens a pull request
(with `gh`). Deleting a thread removes its worktree when nothing in it is uncommitted; the branch stays.
