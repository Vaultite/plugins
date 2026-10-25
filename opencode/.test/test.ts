// OpenCode in this process: usage and a session's conversation from a made-up database, its agent in a terminal, its
// page as text.   node opencode/.test/test.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, done, inProcess } from "../../testkit.ts"
import { opencodeFixture } from "./fixture.ts"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-opencode-"))
const s = await inProcess(["opencode"], { env: await opencodeFixture(home) })
const { api } = s
try {
  let [c, u] = await api("GET", "opencode?days=7")
  check("usage as OpenCode recorded it, a fork's copied reply once, a subagent's in its parent, a streaming reply left out",
    c === 200 && u.total.cost === 0.14 && u.total.tokens === 17100 && u.total.unpriced === 0 && u.total.cache_hit === 0.675 &&
    u.plan === null && u.limits === null && Array.isArray(u.live) && u.days.length === 7, [c, u?.total])
  check("a worktree next to its repository is the same project", u.projects.length === 1 && u.projects[0].name === "lighthouse" &&
    u.projects[0].sessions === 3, u.projects)
  check("models by name from OpenCode's catalogue, else the id", u.models.map((m: any) => m.name).join(",") ===
    "Claude Sonnet 5,gpt-5.4,Claude Haiku 4.5,Big Pickle", u.models)
  const [a, b] = [u.sessions.find((x: any) => x.id === "ses_fixtureA001"), u.sessions.find((x: any) => x.id === "ses_fixtureB001")]
  check("sessions: titles (the first prompt for a placeholder), cost, model, time working, top-level only",
    u.sessions.length === 3 && a?.title === "Upload retry fix" && a.cost === 0.1 && a.tokens === 14000 && a.model === "Claude Sonnet 5" &&
    Math.abs(a.active_min - 149 / 60) < 0.01 && a.cwd === "/Users/sam/lighthouse" && b?.title === "Make the header sticky" &&
    b.project === "lighthouse" && u.sessions[0].id === "ses_fixtureB001", u.sessions)
  let t: any
  ;[c, t] = await api("GET", "opencode/session/ses_fixtureA001")
  check("session: found by id, with title, folder, model and times", c === 200 && t.title === "Upload retry fix" &&
    t.cwd === "/Users/sam/lighthouse" && t.model === "Claude Sonnet 5" && t.project === "lighthouse" && t.first && t.last > t.first,
    [c, { ...t, entries: undefined }])
  const kinds = t.entries?.map((e: any) => e.kind).join(",")
  check("session: what was said and each tool call, nothing else (reasoning, steps, synthetic text)",
    kinds === "user,assistant,tool,tool,tool,assistant" && t.total === 6 && t.entries[0].text === "Fix the flaky upload test", kinds)
  const [bash, task, readf] = [t.entries[2], t.entries[3], t.entries[4]]
  check("session: a tool call is one line with its result", bash.name === "bash" && bash.summary === "Run the upload tests" &&
    bash.error === true && bash.result === "1 failing: upload retries" && JSON.parse(bash.input).command === "npm test -- upload" &&
    task.summary === "Find the retry code" && readf.summary === "/Users/sam/lighthouse/test/upload.test.ts" && readf.result === "it('retries', ...)" &&
    t.entries[5].text === "Fixed: the retry **waits** now.", [bash, task, readf, t.entries[5]])
  ;[, t] = await api("GET", "opencode/session/ses_fixtureA001?limit=2&before=4")
  check("session: pages", t.start === 2 && t.entries.length === 2 && t.entries[0].name === "bash", [t.start, t.entries?.length])
  ;[, t] = await api("GET", "opencode/session/ses_fixtureB001")
  check("session: an untitled one is its first prompt", t.title === "Make the header sticky" && t.model === "gpt-5.4", t.title)
  ;[c] = await api("GET", "opencode/session/nope")
  check("session: an unknown session is a 404", c === 404, c)
  ;[c] = await api("GET", "opencode/session/..%2F..%2Fetc")
  check("session: not a path", c === 404, c)
  const agent = s.service("agent:opencode") as (o: any) => Promise<any>
  const gone = await agent({ resume: "ses_notOnThisMac", context: "", state: null })
  check("in a terminal: a session that isn't on this machine isn't resumed", gone.command.startsWith("printf") && gone.command.includes("no OpenCode session"), gone)
  const run = await agent({ resume: "ses_fixtureA001", context: "Inside Vaultite.", state: (x: string) => `echo ${x}` })
  const cfg = JSON.parse(/OPENCODE_CONFIG_CONTENT='([^']*)'/.exec(run.command)?.[1] ?? "{}")
  check("in a terminal: resumes in the session's folder, told where it runs (instructions) and marking its state (a plugin)",
    run.command.endsWith("opencode --session 'ses_fixtureA001'") && run.cwd === "/Users/sam/lighthouse" &&
    fs.readFileSync(cfg.instructions[0], "utf8") === "Inside Vaultite." && fs.readFileSync(new URL(cfg.plugin[0]), "utf8").includes('"working":"echo working"'), [run, cfg])
  const fresh = await agent({ resume: null, context: "", state: null, prompt: "Say hi", model: "opencode/big-pickle" })
  check("in a terminal: a new session runs the model it's given, without the update dialog", fresh.command === "OPENCODE_DISABLE_AUTOUPDATE=1 opencode -m 'opencode/big-pickle' --prompt 'Say hi'", fresh)
  const [, oc] = await api("GET", "render?path=Dashboards/OpenCode.md")
  check("its page: sessions, usage, projects and models as text", typeof oc === "string" && oc.includes("## OpenCode sessions") &&
    oc.includes("Make the header sticky") && oc.includes("## OpenCode by project") && oc.includes("lighthouse: $0.14") &&
    oc.includes("## OpenCode by model") && oc.includes("Big Pickle: $0.00"), String(oc).slice(0, 600))
} finally {
  s.stop()
  fs.rmSync(home, { recursive: true, force: true })
}
done()
