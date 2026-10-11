## Agents
Claude Code and Codex threads (a sidebar panel `agents:threads`, each thread a `view:agents/<id>` tab): each runs the
user's own CLI on the server's machine in the thread's folder (the vault, or a project's `path`), `claude` with stream
JSON or `codex app-server`, with the thread's permissions (`ask`, `edits`, `read`) and model. Threads are kept on that
machine, never in the vault. From an agent or a script: `vau agents ask "<message>"` (`--harness codex --cwd <folder>`
for a new thread, `--thread <id>` to follow up) waits for the answer; `vau agents list` lists them.
