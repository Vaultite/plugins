// Muse in this process: an agent's made-up home read as who it is, runs, memory, dreams, feed and setup, on this
// machine; then the same home on an agent machine (Machines' file agent, python3), its news to the Inbox.
//   node muse/.test/test.ts
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { APP, check, done, inProcess } from "../../testkit.ts"

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-muse-")) // (an agent named Wren, made up)
fs.cpSync(path.join(import.meta.dirname, "fixtures"), home, { recursive: true })
const s = await inProcess(["muse"], { env: { MUSE_HOME: home } })
const { api } = s
try {
  const A = "1111aaaa-0000-4000-8000-000000000001", B = "2222bbbb-0000-4000-8000-000000000002"
  const run = (id: string, at: number) => fs.utimesSync(path.join(home, "agents", `agent-${id}`), at / 1000, at / 1000)
  run(A, Date.now() - 7200000); run(B, Date.now() - 3600000)
  let [c, o] = await api("GET", "muse")
  check("muse: who it is (IDENTITY.md's name), its persona files and what's left to fill in them", c === 200 && o.name === "Wren" &&
    o.files[0].name === "IDENTITY.md" && o.files.find((f: Any) => f.name === "IDENTITY.md").unfilled.join() === "Vibe" &&
    o.files.find((f: Any) => f.name === "USER.md").unfilled.join() === "Timezone,Context" &&
    o.files.find((f: Any) => f.name === "PROACTIVE_PREFERENCES.md").unfilled.join() === "Never tell me about,When" &&
    o.files.find((f: Any) => f.name === "SOUL.md").unfilled.length === 0, o)
  check("muse: its counts, connectors, jobs (archived ones too) and objectives", o.counts.runs === 2 && o.counts.dreams === 2 && o.counts.notes === 2 &&
    o.connectors.filter((x: Any) => x.status === "connected").map((x: Any) => x.name).join() === "google_calendar" &&
    o.jobs.find((j: Any) => j.id === "heartbeat").schedule === "every 30m" && o.jobs.find((j: Any) => j.id === "launch-check").schedule === "daily at 08:00 (America/Los_Angeles)" &&
    o.jobs.find((j: Any) => j.id === "tour").archived === true && o.jobs.find((j: Any) => j.id === "tour").enabled === false &&
    o.objectives.find((x: Any) => x.id === "shopping").outcome === "insufficient", o)
  ;[c, o] = await api("GET", "muse/runs?limit=5")
  const [feedRun, talk] = o.runs ?? []
  check("muse runs: newest first, each its kind (by what started it), a title, tool calls, model and tokens", c === 200 && o.total === 2 &&
    feedRun.id === B && feedRun.kind === "Feed" && feedRun.title === "Work this hour's beat." && feedRun.tools === 1 &&
    talk.kind === "Conversation" && talk.title === "What's left before the Lighthouse launch?" && talk.model === "made-up-model-1" && talk.tokens === 12000, o)
  ;[c, o] = await api("GET", `muse/session/${A}`)
  check("muse session: what the user said, the answer and a tool call with its result; guidance folds away, thinking is left out", c === 200 &&
    o.entries.map((e: Any) => e.kind === "tool" ? e.name : e.kind).join() === "Guidance,user,read,assistant" &&
    o.entries[2].result.includes("Press kit") && o.title === "Conversation: What's left before the Lighthouse launch?", o)
  ;[c] = await api("GET", "muse/session/..%2Fetc")
  check("muse session: not a path", c === 400, c)
  ;[c, o] = await api("GET", "muse/memory?notes=1")
  check("muse memory: MEMORY.md, the latest note's facts with their quotes, its bank (not an empty file)", c === 200 && o.facts.length === 2 &&
    o.days.length === 1 && o.days[0].date === "2026-10-10" && o.days[0].facts[1].kind === "preference" && o.days[0].facts[1].quote === "Keep it short." &&
    o.bank.find((b: Any) => b.name === "world").items[0] === "Lighthouse is a small studio." && o.notes === 2, o)
  ;[c, o] = await api("GET", "muse/memory?notes=2")
  check("muse memory: a note's other lines", o.days[1].notes.join() === "Prepared the first tip of the tour.", o.days)
  ;[c, o] = await api("GET", "muse/dreams?dreams=1")
  check("muse dreams: the newest, its prose only, and what it understands of the user", c === 200 && o.total === 2 &&
    o.dreams[0].text === "A quiet day: one question about the launch, answered in two lines." && o.synthesis.text.startsWith("Alice tests"), o)
  ;[c, o] = await api("GET", "muse/feed?stories=5")
  check("muse feed: newest slot first, each story with its links", c === 200 && o.stories.length === 2 && o.stories[0].title === "A new open model for code" &&
    o.stories[0].part === "midday" && o.stories[0].links.length === 2 && o.stories[0].text.includes("[scores well]"), o)
  const block = async (name: string, options = {}) => String((await api("GET", `render/block?name=${name}&options=${JSON.stringify(options)}`))[1])
  const text = (await block("muse-memory", { notes: 1 })) + (await block("muse-runs"))
  check("muse: its blocks as text", text.includes("## What Wren knows") && text.includes("Alice prefers short answers. (preference, medium)") &&
    text.includes("Feed: Work this hour's beat."), text)
  // The same agent on an agent machine: a made-up one, Machines' file agent (python3) in its home, dialing in through
  // the public MCP listener; its blocks drawn here (it runs no Vaultite), what's new to the Inbox.
  delete process.env.MUSE_HOME
  const vm = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-muse-vm-"))
  fs.cpSync(path.join(import.meta.dirname, "fixtures"), vm, { recursive: true })
  // (this server listed in Machines, as a relay must be)
  s.write(".vaultite/plugins/machines/data.json", JSON.stringify({ machines: [{ id: "studio", label: "Studio", url: "http://127.0.0.1:8793" }] }))
  for (const id of ["machines", "inbox"]) await api("POST", "ops/plugin.enable", { id })
  const { PublicMcp } = await import(pathToFileURL(path.join(APP, "plugins/core/mcp/public.ts")).href)
  const pub = new PublicMcp(s.app.plugins.find((p: Any) => p.id === "mcp"), PublicMcp.cloudOnly())
  pub.start()
  pub.settings.url = `http://127.0.0.1:${await pub.ready}`
  const dial = async (args: string[]) => {
    const p = spawn("python3", [path.join(APP, "plugins/core/machines/dial.py"), ...args], { env: { ...process.env, HOME: vm, NO_PROXY: "127.0.0.1,localhost" } })
    let out = ""
    p.stdout.on("data", (d) => { out += d }); p.stderr.on("data", (d) => { out += d })
    return { code: await new Promise<number | null>((r) => p.on("exit", r)), out }
  }
  const until = async (fn: () => Promise<boolean>) => { for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true; return false }
  try {
    const enrolled = await dial(["enroll", pub.settings.url, "sandbox", "Sandbox"])
    const code = /Enrollment code: (\d{8})/.exec(enrolled.out)?.[1]
    const [ac] = await api("POST", "ops/machines.approve", { code })
    const online = ac === 200 && await until(async () => !!(await api("GET", "machines/sandbox/info"))[1].online)
    check("machine: its file agent enrolled and online", online, [enrolled, ac])
    ;[c, o] = await api("GET", "muse?machine=sandbox")
    check("machine: who it is, read through the file agent", c === 200 && o.name === "Wren", [c, o])
    ;[c, o] = await api("GET", "muse")
    check("machine: found without being named", o.machine === "sandbox", o)
    ;[c, o] = await api("GET", "muse/runs?machine=sandbox")
    check("machine: its runs", o.runs?.map((r: Any) => r.kind).sort().join() === "Conversation,Feed", o)
    ;[c, o] = await api("GET", `muse/session/sandbox:${A}`)
    check("machine: a run's conversation", o.entries?.at(-1)?.text === "Two things: the press kit and the pricing page.", o)
    const dreams = String((await api("GET", `render/block?name=muse-dreams&options=${JSON.stringify({ machine: "sandbox" })}`))[1])
    check("machine: its blocks drawn here", /## Wren's dreams[\s\S]*A quiet day/.test(dreams), dreams)
    const news = s.app.plugins.find((p: Any) => p.id === "muse").exports.news as () => Promise<void>
    const told = async () => ((await api("GET", "inbox/events"))[1].events as Any[]).filter((e) => e.source === "muse")
    await news()
    check("news: the first look announces nothing old", (await told()).length === 0, await told())
    fs.writeFileSync(path.join(vm, "dreams/2026-10-11.md"), "## Dream\n\n2026-10-11\n\nThe launch list got shorter.\n")
    await news(); await news()
    const said = await told()
    check("news: a new dream, once, linked to its file there", said.map((e) => e.title).join() === "Wren dreamt" &&
      said[0].link === `view:machine-files/sandbox|${vm}/dreams|${vm}/dreams/2026-10-11.md`, said)
  } finally {
    await dial(["stop"])
    pub.stop()
    fs.rmSync(vm, { recursive: true, force: true })
  }
} finally {
  s.stop()
  fs.rmSync(home, { recursive: true, force: true })
}
done()
