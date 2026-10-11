#!/usr/bin/env node
// A stand-in for GitHub's gh in tests and QA: `pr create` answers a made-up pull request's link, `pr view` it once
// made; each call goes to FAKE_GH_STATE/gh.jsonl.
import fs from "node:fs"
import path from "node:path"

const STATE = process.env.FAKE_GH_STATE || ""
const argv = process.argv.slice(2)
const made = STATE && path.join(STATE, "gh-pr.json")
if (STATE) fs.appendFileSync(path.join(STATE, "gh.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\n")
if (argv[0] === "pr" && argv[1] === "create") {
  const title = argv[argv.indexOf("--title") + 1]
  if (made) fs.writeFileSync(made, JSON.stringify({ number: 7, url: "https://github.com/alice/lighthouse/pull/7", state: "OPEN", title }))
  console.log("https://github.com/alice/lighthouse/pull/7")
} else if (argv[0] === "pr" && argv[1] === "view") {
  if (!made || !fs.existsSync(made)) { console.error("no pull requests found for branch"); process.exit(1) }
  console.log(fs.readFileSync(made, "utf8"))
} else { console.error(`fake gh: ${argv.join(" ")} isn't faked`); process.exit(1) }
