#!/usr/bin/env node
// A stand-in for GitHub's gh in tests and QA: `pr create` answers a made-up pull request's link, `pr view` it once
// made (FAKE_GH_STATE/gh-pr.json; a test edits its state to merge it); `pr view 12` and `pr checkout 12` are another,
// someone else's #12 on branch glow-header (its head at the remote's refs/pull/12/head). Each call goes to gh.jsonl.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const STATE = process.env.FAKE_GH_STATE || ""
const argv = process.argv.slice(2)
const made = STATE && path.join(STATE, "gh-pr.json")
if (STATE) fs.appendFileSync(path.join(STATE, "gh.jsonl"), JSON.stringify({ argv, cwd: process.cwd() }) + "\n")
const OTHER = { number: 12, title: "Make the header glow", url: "https://github.com/alice/lighthouse/pull/12", state: "OPEN", headRefName: "glow-header" }
const other = (ref) => /^(#?12|https:\/\/github\.com\/alice\/lighthouse\/pull\/12)$/.test(ref ?? "")
if (argv[0] === "pr" && argv[1] === "create") {
  const title = argv[argv.indexOf("--title") + 1]
  const head = argv[argv.indexOf("--head") + 1]
  if (made) fs.writeFileSync(made, JSON.stringify({ number: 7, url: "https://github.com/alice/lighthouse/pull/7", state: "OPEN", title, mergedAt: null, closedAt: null, head }))
  console.log("https://github.com/alice/lighthouse/pull/7")
} else if (argv[0] === "pr" && argv[1] === "view" && argv[2] && !argv[2].startsWith("-")) {
  if (!other(argv[2])) { console.error(`no pull requests found for ${argv[2]}`); process.exit(1) }
  console.log(JSON.stringify(OTHER))
} else if (argv[0] === "pr" && argv[1] === "view") {
  // (the branch's own: #7 where it was made, #12 on glow-header)
  const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()
  if (branch === OTHER.headRefName) { console.log(JSON.stringify({ ...OTHER, mergedAt: null, closedAt: null })); process.exit(0) }
  const pr = made && fs.existsSync(made) ? JSON.parse(fs.readFileSync(made, "utf8")) : null
  if (!pr || (pr.head && pr.head !== branch)) { console.error("no pull requests found for branch"); process.exit(1) }
  console.log(JSON.stringify(pr))
} else if (argv[0] === "pr" && argv[1] === "checkout" && other(argv[2])) {
  const git = (...a) => execFileSync("git", a, { stdio: "ignore" })
  git("fetch", "origin", `+refs/pull/12/head:refs/heads/${OTHER.headRefName}`)
  git("switch", OTHER.headRefName)
} else { console.error(`fake gh: ${argv.join(" ")} isn't faked`); process.exit(1) }
