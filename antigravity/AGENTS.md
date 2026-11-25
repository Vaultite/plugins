## Antigravity
Google's coding agent CLI, `agy`. Its plan's limits, read live from `agy -p /usage` (print mode: no turn, no
conversation) on the machine the server runs on, at most every 3 minutes, kept only in memory: for each model group
(Gemini; Claude and GPT) its 5-hour and weekly windows, how much is used and when each resets, and the account agy is
signed in as. agy doesn't say the plan's tier. `antigravity_limits` says them; `block-agent-limits` with
`agent: antigravity` shows them, and `machine: <id>` another machine's (where agy runs).
