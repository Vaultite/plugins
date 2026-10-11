// Text a model writes for a thread, as T3 Code has it (its prompts): the title, a new worktree's branch, a commit
// message, a pull request's title and body. The thread's own CLI, non-interactive, with a small model; null on failure.
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { claudeCli } from "./claude.ts"
import { codexCli } from "./codex.ts"
import { type Any, env, str } from "./core.ts"
import type { Harness } from "./types.ts"

const MODEL: Record<Harness, string> = { claude: "haiku", codex: "gpt-6-luna" }
const limit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[truncated]` : s)

function run(bin: string, args: string[], input: string, cwd: string, ms = 90_000) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    let out = "", done = false
    const child = spawn(bin, args, { cwd, env: env(), stdio: ["pipe", "pipe", "ignore"] })
    const finish = (code: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out }) } }
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(124) }, ms)
    child.stdout.setEncoding("utf8").on("data", (d: string) => { out += d })
    child.on("error", () => finish(127))
    child.on("close", (code) => finish(code ?? 1))
    child.stdin.on("error", () => { /* it exited */ })
    child.stdin.end(input)
  })
}

/** The model's answer as the schema's object (every key a string), or null. */
async function generate(harness: Harness, cwd: string, prompt: string, keys: string[]): Promise<Record<string, string> | null> {
  const schema = { type: "object", properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])), required: keys, additionalProperties: false }
  const pick = (o: Any) => (o && typeof o === "object" && keys.every((k) => typeof o[k] === "string") ? Object.fromEntries(keys.map((k) => [k, str(o[k])])) : null)
  try {
    if (harness === "claude") {
      const cli = claudeCli()
      if (!cli) return null
      // (no tools, no MCP, nothing kept: only the prompt)
      const r = await run(cli, ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", MODEL.claude, "--tools", "", "--strict-mcp-config",
        "--permission-mode", "dontAsk", "--no-session-persistence"], prompt, cwd)
      if (r.code) return null
      const j = JSON.parse(r.out.trim().split("\n").pop() ?? "")
      return pick(j.structured_output) ?? pick(JSON.parse(str(j.result) || "null"))
    }
    const cli = codexCli()
    if (!cli) return null
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-text-"))
    try {
      const schemaFile = path.join(tmp, "schema.json"), outFile = path.join(tmp, `out-${crypto.randomBytes(3).toString("hex")}.json`)
      fs.writeFileSync(schemaFile, JSON.stringify(schema))
      const r = await run(cli, ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--model", MODEL.codex, "--config", 'model_reasoning_effort="low"',
        "--output-schema", schemaFile, "--output-last-message", outFile, "-"], prompt, cwd)
      if (r.code || !fs.existsSync(outFile)) return null
      return pick(JSON.parse(fs.readFileSync(outFile, "utf8")))
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  } catch { return null }
}

const TITLE = `Generate a title that will help the user recognize this coding thread weeks later.
Return JSON with key title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid project names already visible in the UI, quotes, labels, filler, and trailing punctuation.`

const RETITLE = (was: string) => `Regenerate the title for an existing coding thread so the user can recognize it weeks later.
The previous title was ${JSON.stringify(was)}.
Return JSON with key title.

Read the USER messages first and identify the latest explicit durable goal; use ASSISTANT messages only to resolve vague
references. Title the durable subject and desired outcome, not the current workflow state. 3-8 words, fewer than 40
characters, no quotes, labels or trailing punctuation. Keep the previous title if it is already accurate.`

/** A thread's title: from its first message, or (`was`, Regenerate title) from the whole thread. */
export async function titleFor(harness: Harness, message: string, was?: string) {
  const prompt = was === undefined ? `${TITLE}\n\nUser message:\n${limit(message, 8000)}` : `${RETITLE(was)}\n\nThread contents:\n${message.slice(-8000)}`
  const r = await generate(harness, os.tmpdir(), prompt, ["title"])
  const title = r?.title.replace(/^["'“”]+|["'“”.!?]+$/g, "").trim().slice(0, 60)
  return title || null
}

/** A branch's descriptive part (no prefix) for what a thread was asked. */
export async function branchFor(harness: Harness, cwd: string, message: string) {
  const prompt = ["You generate concise git branch names.", "Return a JSON object with key: branch.", "Rules:",
    "- Branch should describe the requested work from the user message.", "- Return a valid Git branch name without spaces.",
    "- Keep it short and specific (2-6 words), in lowercase with hyphen-separated words.",
    "- Return only the descriptive branch fragment, without a prefix or namespace. The application adds the configured prefix.",
    "", "User message:", limit(message, 8000)].join("\n")
  const r = await generate(harness, cwd, prompt, ["branch"])
  const b = r?.branch.toLowerCase().replace(/^[\w-]+\//, "").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
  return b || null
}

/** A commit message for the changes: its subject and body. */
export async function commitFor(harness: Harness, cwd: string, branch: string, files: string, patch: string) {
  const prompt = ["You write concise git commit messages.", "Return a JSON object with keys: subject, body.", "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period", "- body can be empty string or short bullet points",
    "- capture the primary user-visible or developer-visible change", "", `Branch: ${branch || "(detached)"}`, "",
    "Staged files:", limit(files, 6000), "", "Staged patch:", limit(patch, 40_000)].join("\n")
  const r = await generate(harness, cwd, prompt, ["subject", "body"])
  const subject = r?.subject.split("\n")[0].trim().replace(/\.+$/, "").slice(0, 72)
  return subject ? [subject, r!.body.trim()].filter(Boolean).join("\n\n") : null
}

/** A pull request's title and body (Markdown, with Summary and Testing). */
export async function prFor(harness: Harness, cwd: string, base: string, head: string, commits: string, stat: string, patch: string) {
  const prompt = ["You write source control change request content.", "Return a JSON object with keys: title, body.", "Rules:",
    "- title should be concise and specific", "- body must be markdown and include headings '## Summary' and '## Testing'",
    "- under Summary, provide short bullet points", "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
    "", `Base branch: ${base}`, `Head branch: ${head}`, "", "Commits:", limit(commits, 12_000), "", "Diff stat:", limit(stat, 12_000), "",
    "Diff patch:", limit(patch, 40_000)].join("\n")
  const r = await generate(harness, cwd, prompt, ["title", "body"])
  return r?.title.trim() ? { title: r.title.trim().slice(0, 120), body: r.body.trim() } : null
}
