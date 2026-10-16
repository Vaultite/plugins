// The agents' plugins here (OpenClaw, Hermes, OpenCode) on a server, end to end on the app's kit (its
// tools/test/agentkit.ts): fake agents in terminals, connect and MCP. Not in test.ts: it starts real terminals.
// VAULTITE_AGENT_LIVE=1: the real agents on a real model too (a few cents); VAULTITE_TEST_PORT, VAULTITE_AGENT_KEEP=1.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parse as parseYaml } from "yaml"
import { APP } from "./testkit.ts"
import { hermesFixture as hermesHome } from "./hermes/.test/fixture.ts"
import { openclawFixture } from "./openclaw/.test/fixture.ts"

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
const at = (rel: string) => import(pathToFileURL(path.join(APP, "tools", "test", rel)).href)
const { check, sleep, skip, section, summary, waitFor } = await at("lib.ts")
const K = await at("agentkit.ts")
const { BASE, LIVE, MODEL, PROJECT, REAL_HOME, TMP, VAULT, api, endAndCheck, esc, fakeLog, findFile, get, liveIn, rand, screenHas, term, today } = K
const t0 = Date.now()
const PLUGINS = ["openclaw", "hermes", "opencode"]

/** The plugins installed from here and on (so allowed on this machine), once: the vault keeps them across restarts. */
function install() {
  const vau = (...a: string[]) => execFileSync(process.execPath, [path.join(APP, "bin", "vau"), "--url", BASE, ...a], { encoding: "utf8", env: { ...K.serverEnv, VAULTITE_URL: BASE } })
  for (const id of PLUGINS) { vau("plugin", "install", path.join(import.meta.dirname, id)); vau("plugin", "on", id) }
}

/** Hermes' made-up home (and its profile), plus a session that ran in a folder with spaces and accents, to resume there. */
async function hermesFixture(dir: string) {
  await hermesHome(dir)
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path.join(dir, "state.db"))
  const t = Date.now() / 1000 - 1800
  db.prepare("INSERT INTO sessions (id, source, model, cwd, started_at, ended_at, title) VALUES (?, 'cli', 'openai/gpt-6-luna', ?, ?, ?, 'Résumé test')")
    .run("20261001_120000_accent", PROJECT, t, t + 60)
  db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', 'Bonjour', ?)").run("20261001_120000_accent", t)
  db.close()
}

/** Fake agents, each keeping a child running like an MCP server. OpenClaw's records `mcp set`; Hermes' starts a session
 *  in its database. */
function writeFakes() {
  K.writeFake("openclaw", `#!/usr/bin/env node
const fs = require("fs"), { spawn } = require("child_process")
const a = process.argv.slice(2)
fs.appendFileSync(process.env.VT_FAKE_LOG, JSON.stringify({ bin: "openclaw", args: a, cwd: process.cwd() }) + "\\n")
if (a[0] === "mcp" && a[1] === "set") { console.log("Saved MCP server " + a[2] + "."); process.exit(0) }
if (a[0] !== "tui") { console.error("fake openclaw: " + a.join(" ")); process.exit(2) }
console.log("FAKE-OPENCLAW " + JSON.stringify(a)); console.log("CWD " + process.cwd())
process.title = "openclaw" // as OpenClaw does: on Linux its command line then reads "openclaw" alone
spawn("sleep", ["3600"], { stdio: "ignore" })
setInterval(() => {}, 1e6)
`)
  K.writeFake("hermes", `#!/usr/bin/env python3
import json, os, sqlite3, subprocess, sys, time
a = sys.argv[1:]
profile = resume = query = None
i = 0
while i < len(a):
    if a[i] in ("-p", "--profile"): profile = a[i + 1]; i += 1
    elif a[i] in ("-r", "--resume"): resume = a[i + 1]; i += 1
    elif a[i] in ("-q", "--query"): query = a[i + 1]; i += 1
    i += 1
with open(os.environ["VT_FAKE_LOG"], "a") as f: f.write(json.dumps({"bin": "hermes", "args": a, "cwd": os.getcwd()}) + "\\n")
print("FAKE-HERMES " + json.dumps(a)); print("CWD " + os.getcwd()); sys.stdout.flush()
if query is not None: sys.exit(0)
if not resume:
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    if profile: home = os.path.join(home, "profiles", profile)
    db = sqlite3.connect(os.path.join(home, "state.db"))
    sid = "fake_%s_%d" % (time.strftime("%Y%m%d_%H%M%S"), os.getpid())
    now = time.time()
    db.execute("INSERT INTO sessions (id, source, model, cwd, started_at) VALUES (?, 'cli', 'openai/fake-model', ?, ?)", (sid, os.getcwd(), now))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', 'Fake hello from the agent test', ?)", (sid, now))
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'Hi', ?)", (sid, now + 1))
    db.commit(); db.close()
    print("SESSION " + sid); sys.stdout.flush()
subprocess.Popen(["sleep", "3600"])
while True: time.sleep(3600)
`)
  K.shellFake("opencode")
}

/** The terminals' python3 (the system's) is a Mac's framework build (Command Line Tools'): it runs as Python.app. */
const PY_FRAMEWORK = (() => {
  try { return execFileSync("python3", ["-c", "import sysconfig; print(sysconfig.get_config_var('PYTHONFRAMEWORK') or '')"], { encoding: "utf8", env: { PATH: K.SYSTEM_PATH } }).trim() !== "" } catch { return false }
})()

// =====================================================================================================================
// Part 1: fixtures and fake agents

async function fixturePart() {
  section("fixtures: the plugins, connect, MCP")
  const OC = path.join(TMP, "openclaw-fixture"), HH = path.join(TMP, "hermes-fixture")
  await openclawFixture(OC)
  await hermesFixture(HH)
  writeFakes()
  K.setEnv(K.fakesPath(), { OPENCLAW_STATE_DIR: OC, OPENCLAW_WORKSPACE_DIR: path.join(OC, "workspace"), HERMES_HOME: HH })
  await K.startServer()
  install()

  // The plugins read the fixtures on this machine (node:sqlite, zstd).
  for (const agent of ["openclaw", "hermes"]) {
    const u = await get(`${agent}?days=7`)
    check(`${agent}: usage per day and model from its databases`, u.total.tokens > 0 && u.models.length > 0 && u.days.length === 7 && u.days.some((d: Any) => d.tokens > 0),
      { total: u.total, models: u.models?.length })
  }
  const oc = await get("openclaw/session/a1f0c3d2-5b6e-4c7a-8d9e-0f1a2b3c4d5a")
  check("openclaw: a conversation (compressed events too)", oc.entries?.length > 0 && oc.key === "agent:main:main", { n: oc.entries?.length, key: oc.key })
  const hs = (await get("hermes?days=7")).sessions[0]
  const ht = hs ? await get(`hermes/session/${encodeURIComponent(hs.id)}`) : null
  check("hermes: a conversation", ht?.entries?.length > 0, ht)
  const om = await get("openclaw/memory"), hm = await get("hermes/memory")
  check("openclaw: its workspace's memory files and daily notes", om.files.length > 0 && om.notes.length > 0, om)
  check("hermes: its soul, memory and what it knows about the user", !!hm.soul && hm.memory?.length > 0 && hm.user?.length > 0, hm)
  const oj = await get("openclaw/cron"), hj = await get("hermes/cron")
  check("openclaw: scheduled jobs", Array.isArray(oj) && oj.length > 0, oj)
  check("hermes: scheduled jobs", hj.jobs?.length > 0, hj)
  for (const page of ["Dashboards/OpenClaw.md", "Dashboards/Hermes.md"]) {
    if (!fs.existsSync(path.join(VAULT, page))) { check(`${page}: the plugin brought its page`, false, "missing"); continue }
    const [c, text] = await api("GET", `render?path=${encodeURIComponent(page)}`)
    const notes = [...String(text).matchAll(/_\(([\w-]+ block: .*?)\)_/g)].map((m) => m[1])
    check(`${page}: renders as text, every block without a problem`, c === 200 && !notes.length, { c, notes })
  }

  // connect: OpenClaw through its CLI (the fake records it), Hermes by editing its config.yaml.
  const [c1, r1] = await api("POST", "ops/openclaw.connect", {})
  const set = fakeLog().filter((x: Any) => x.bin === "openclaw" && x.args[0] === "mcp").pop()
  const saved = set ? JSON.parse(set.args[3]) : null
  check("openclaw connect: runs `openclaw mcp set vaultite <server>` with this server's node, vau and address",
    c1 === 200 && set?.args[2] === "vaultite" && fs.existsSync(saved?.command) && saved?.args[0] === path.join(APP, "bin", "vau") && saved?.args[1] === "mcp" &&
      saved?.env?.VAULTITE_URL === BASE, { c1, r1, set })
  const [c2, r2] = await api("POST", "ops/hermes.connect", {})
  const hy = parseYaml(fs.readFileSync(path.join(HH, "config.yaml"), "utf8"))
  check("hermes connect: adds mcp_servers.vaultite to config.yaml, the rest kept", c2 === 200 && r2.changed === "added" && hy.mcp_servers?.vaultite?.env?.VAULTITE_URL === BASE &&
    hy.model !== undefined, { c2, r2, hy })
  const [, r3] = await api("POST", "ops/hermes.connect", {})
  check("hermes connect: again changes nothing", r3.changed === "unchanged", r3)
  const [c4] = await api("POST", "ops/hermes.connect", { account: "nobody" })
  check("hermes connect: a profile that isn't there is a clear 404", c4 === 404, c4)

  // The MCP server connect saved, spoken to as each agent would.
  if (saved) for (const client of ["openclaw", "hermes"]) await K.mcpTools(saved, client, client)

  await terminalsPart("vaultite")
  await K.stopServer()
  K.stopBackends()
  if (["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].some((p) => fs.existsSync(p))) {
    await K.startServer()
    await K.setBackend("tmux")
    await terminalsPart("tmux")
    await K.stopServer()
    K.stopBackends()
  } else skip("terminals in tmux", "tmux isn't installed")
}

/** The fake agents in terminals of one backend: started, listed, linked by their plugins, surviving a server restart,
 *  resumed, a first prompt passed whole, ended with nothing left, and a missing binary. */
async function terminalsPart(backend: string) {
  section(`fixtures: terminals (${backend === "vaultite" ? "the keeper" : backend})`)
  const tag = backend === "vaultite" ? "keeper" : backend
  const ids: Record<string, string> = { openclaw: `openclaw-${rand()}`, ...(PY_FRAMEWORK ? {} : { hermes: `hermes-${rand()}` }) }
  if (PY_FRAMEWORK) skip(`hermes (${tag}): the fake in terminals`, "this python3 is a framework build (ps shows Python.app, and it leaves its group): it can't stand in for Hermes")
  for (const [agent, id] of Object.entries(ids)) {
    const [c, r] = await term.start(id)
    check(`${agent} (${tag}): a terminal starts it`, c === 200 && r.started && r.agent === agent, r)
    const screen = await screenHas(id, new RegExp(`FAKE-${agent.toUpperCase()}`))
    check(`${agent} (${tag}): it runs in the vault's folder (spaces, accents)`, screen?.includes(`CWD ${VAULT}`), screen?.slice(-400))
    const listed = await waitFor(async () => { const x = await term.one(id); return x?.busy && x.agent === agent ? x : null })
    check(`${agent} (${tag}): Terminals lists it, running`, listed && listed.backend === backend, await term.one(id))
    const live = await liveIn(agent, id)
    check(`${agent} (${tag}): its plugin lists the session as open, linked to its terminal`,
      live && (agent === "openclaw" ? live.name === "agent:main:main" : String(live.id).startsWith("fake_")), live ?? (await get(`${agent}?days=1`)).live)
  }

  // The server restarts (a deploy): the shells live on in the backend, and the plugins find them again.
  await K.stopServer()
  await K.startServer()
  for (const [agent, id] of Object.entries(ids)) {
    const x = await waitFor(() => term.one(id), 10000)
    check(`${agent} (${tag}): its terminal survives a server restart`, x?.busy, x)
    check(`${agent} (${tag}): still linked to its terminal after the restart`, await liveIn(agent, id), (await get(`${agent}?days=1`)).live)
  }
  for (const [agent, id] of Object.entries(ids)) await endAndCheck(`${agent} (${tag})`, id)

  // Resuming: OpenClaw on the session's key, Hermes with -r in the folder the session ran in.
  const ro = "resume-openclaw-b2e1d4c3-6c7f-4d8b-9eaf-1a2b3c4d5e6b"
  await term.start(ro)
  await screenHas(ro, /FAKE-OPENCLAW/)
  const ra = fakeLog().filter((x: Any) => x.bin === "openclaw" && x.args[0] === "tui").pop()?.args ?? []
  check(`openclaw (${tag}): resume runs \`openclaw tui --local --session <its key>\``, ra.includes("--session") && ra[ra.indexOf("--session") + 1] === "agent:main:lighthouse-notes" && ra.includes("--local"), ra)
  const rl = await liveIn("openclaw", ro)
  check(`openclaw (${tag}): the resumed session is open, linked to its terminal`, rl?.name === "agent:main:lighthouse-notes", rl ?? (await get("openclaw?days=1")).live)
  await endAndCheck(`openclaw resumed (${tag})`, ro)
  if (!PY_FRAMEWORK) {
    const rh = "resume-hermes-20261001_120000_accent"
    await term.start(rh)
    const hscreen = await screenHas(rh, /FAKE-HERMES/)
    check(`hermes (${tag}): resume runs \`hermes -r <id>\` in the folder it ran in (spaces, accents)`, hscreen?.includes(`CWD ${PROJECT}`) && /"-r", "20261001_120000_accent"/.test(hscreen), hscreen?.slice(-400))
    const hl = await liveIn("hermes", rh)
    check(`hermes (${tag}): the resumed session is open, linked to its terminal`, hl?.id === "20261001_120000_accent", hl ?? (await get("hermes?days=1")).live)
    await endAndCheck(`hermes resumed (${tag})`, rh)
  }
  if (backend !== "vaultite") return // the rest is the same in every backend

  // A first prompt reaches the agent whole: quotes, a dollar sign, backticks and accents.
  const prompt = `It's "quoted", $HOME and \`date\` stay text: café ü`
  const po = `openclaw-${rand()}`
  await term.start(po, prompt)
  await screenHas(po, /FAKE-OPENCLAW/)
  const pa = fakeLog().filter((x: Any) => x.bin === "openclaw" && x.args[0] === "tui").pop()?.args ?? []
  check("openclaw: a first prompt is passed whole (--message)", pa[pa.indexOf("--message") + 1] === prompt, pa)
  await endAndCheck("openclaw with a prompt", po)
  const ph = `hermes-${rand()}`
  await term.start(ph, prompt)
  await screenHas(ph, /FAKE-HERMES/)
  const pha = fakeLog().filter((x: Any) => x.bin === "hermes").pop()?.args ?? []
  check("hermes: a first prompt is passed whole (chat -q)", pha[pha.indexOf("-q") + 1] === prompt, pha)
  const back = await waitFor(async () => { const x = await term.one(ph); return x && !x.busy ? x : null }, 10000)
  check("hermes: after a one-shot prompt the terminal is a plain shell again", back, await term.one(ph))
  await endAndCheck("hermes with a prompt", ph)

  // OpenCode's terminal starts what its plugin says (a fake here).
  const id = `opencode-${rand()}`
  const [, r] = await term.start(id)
  const x = await screenHas(id, /FAKE-OPENCODE/)
  check("opencode: a terminal starts it in the vault's folder", r.agent === "opencode" && x?.includes(`CWD ${VAULT}`), { r, screen: x?.slice(-300) })
  await endAndCheck("opencode", id)

  // An agent that isn't installed: the terminal says so and stays a shell; connect says so too.
  K.hideFake("openclaw"); K.hideFake("hermes")
  for (const agent of ["openclaw", "hermes"]) {
    const tid = `${agent}-${rand()}`
    await term.start(tid)
    const scr = await screenHas(tid, /not found|No such file/i, 15000)
    const shell = await waitFor(async () => { const y = await term.one(tid); return y && !y.busy ? y : null }, 10000)
    check(`${agent}: missing, its terminal says it isn't found and stays a shell`, scr && shell, { screen: (await term.screen(tid)).slice(-300), shell: await term.one(tid) })
    await endAndCheck(`${agent} missing`, tid)
  }
  // (connect also looks beside the server's Node, where npm -g puts it)
  if (fs.existsSync(path.join(path.dirname(fs.realpathSync(process.execPath)), "openclaw"))) skip("openclaw connect: missing, a clear 409", "openclaw is installed beside this Node")
  else {
    const [cm, rm] = await api("POST", "ops/openclaw.connect", {})
    check("openclaw connect: missing, a clear 409 (isn't installed)", cm === 409 && /isn't installed/.test(JSON.stringify(rm)), { cm, rm })
  }
  K.hideFake("openclaw", true); K.hideFake("hermes", true)
}

// =====================================================================================================================
// Part 2: the real agents on a real model (VAULTITE_AGENT_LIVE=1)

/** An isolated copy of OpenClaw's state: its config with paths moved here, no MCP servers, no gateway, the model set;
 *  the key file linked (never copied); its workspace's files without the first-run ritual. */
function openclawHome(dir: string) {
  const real = path.join(REAL_HOME, ".openclaw")
  const conf = JSON.parse(fs.readFileSync(path.join(real, "openclaw.json"), "utf8"))
  conf.agents ??= {}
  conf.agents.defaults ??= {}
  conf.agents.defaults.workspace = path.join(dir, "workspace")
  conf.agents.defaults.model = { ...(conf.agents.defaults.model ?? {}), primary: `openrouter/${MODEL}` }
  conf.agents.defaults.models = { ...(conf.agents.defaults.models ?? {}), [`openrouter/${MODEL}`]: {} }
  for (const [id, e] of Object.entries(conf.agents.entries ?? {}) as [string, Any][]) {
    e.workspace = path.join(dir, id === "main" ? "workspace" : `workspace-${id}`)
    e.agentDir = path.join(dir, "agents", id, "agent")
  }
  delete conf.mcp
  delete conf.wizard
  if (conf.gateway) delete conf.gateway.auth
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true })
  fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify(conf, null, 2), { mode: 0o600 })
  fs.symlinkSync(path.join(real, ".env"), path.join(dir, ".env"))
  for (const f of ["AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md"]) {
    try { fs.copyFileSync(path.join(real, "workspace", f), path.join(dir, "workspace", f)) } catch { /* not there */ }
  }
}

/** An isolated Hermes home: its config without MCP servers, the model set; .env and auth.json linked; its soul. */
async function hermesLiveHome(dir: string) {
  const real = path.join(REAL_HOME, ".hermes")
  const { parseDocument } = await import("yaml")
  const doc = parseDocument(fs.readFileSync(path.join(real, "config.yaml"), "utf8"))
  doc.delete("mcp_servers")
  doc.setIn(["model", "default"], MODEL)
  doc.setIn(["model", "provider"], "openrouter")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "config.yaml"), String(doc), { mode: 0o600 })
  for (const f of [".env", "auth.json"]) if (fs.existsSync(path.join(real, f))) fs.symlinkSync(path.join(real, f), path.join(dir, f))
  try { fs.copyFileSync(path.join(real, "SOUL.md"), path.join(dir, "SOUL.md")) } catch { /* none */ }
}

/** One line (a TUI sends on Enter): the five MCP tools, then the code word as the answer. `tok` names the code word and
 *  the note to find, `mine` what this agent writes. */
const livePrompt = (label: string, tok: string, mine: string) => `This is an automated test of your Vaultite MCP tools (the MCP server named vaultite); use only those tools and do exactly this: ` +
  `1) read the note "Notes/Agent brief.md" and find its code word; 2) search the vault for "zephyrine${tok}" and see which file matches; ` +
  `3) write_note with title "${label} live ${mine}" and body "Code word: <the code word>. Search found: <that file>."; ` +
  `4) write_log with area "workouts", title "${label} live ${mine}", duration_min 5; 5) inbox_add with title "${label} live ${mine}" and body "Done.". ` +
  `Then reply with only the code word.`

async function livePart() {
  section(`live: the real agents on ${MODEL}`)
  const agentPath = K.agentPath()
  const OC = path.join(TMP, "openclaw-live"), HH = path.join(TMP, "hermes-live")
  const has = {
    openclaw: !!K.which("openclaw", agentPath) && fs.existsSync(path.join(REAL_HOME, ".openclaw", ".env")),
    hermes: !!K.which("hermes", agentPath) && fs.existsSync(path.join(REAL_HOME, ".hermes", ".env")),
  }
  if (has.openclaw) openclawHome(OC)
  if (has.hermes) await hermesLiveHome(HH)
  K.setEnv(agentPath, { OPENCLAW_STATE_DIR: OC, HERMES_HOME: HH })
  await K.startServer()
  await K.setBackend("vaultite")
  const tok = rand(6)
  fs.mkdirSync(path.join(VAULT, "Notes"), { recursive: true })
  const code = `periwinkle-${tok}`
  fs.writeFileSync(path.join(VAULT, "Notes", "Agent brief.md"), `---\ntype: note\n---\nThe code word is ${code}.\n`)
  fs.writeFileSync(path.join(VAULT, "Notes", `Phare notes ${tok}.md`), `---\ntype: note\n---\nThe zephyrine${tok} lamp.\n`)

  for (const agent of ["openclaw", "hermes"] as const) {
    if (!has[agent]) { skip(`live ${agent}`, `${agent} or its key file (~/.${agent}/.env) isn't on this machine`); continue }
    section(`live: ${agent}`)
    const label = agent === "openclaw" ? "OpenClaw" : "Hermes"
    const mine = rand(6) // what this agent writes is named by it
    const [cc, rc] = await api("POST", `ops/${agent}.connect`, {})
    const conf = agent === "openclaw" ? JSON.parse(fs.readFileSync(path.join(OC, "openclaw.json"), "utf8")).mcp?.servers?.vaultite
      : parseYaml(fs.readFileSync(path.join(HH, "config.yaml"), "utf8")).mcp_servers?.vaultite
    check(`live ${agent}: connect saves the vault's MCP server in its config (this server's address)`, cc === 200 && conf?.env?.VAULTITE_URL === BASE, { cc, rc, conf })

    // In a terminal, the prompt sent as it starts (OpenClaw) or typed into it (Hermes: its first prompt is one-shot).
    const id = `${agent}-${rand()}`
    const started = Date.now()
    if (agent === "openclaw") await term.start(id, livePrompt(label, tok, mine))
    else {
      await term.start(id)
      await waitFor(async () => (await term.one(id))?.busy, 20000)
      await screenHas(id, /❯|>|Hermes/i, 60000)
      await sleep(3000)
      await term.send(id, livePrompt(label, tok, mine))
    }
    const wrote = await waitFor(() => findFile("Inbox", new RegExp(`live ${mine}`)) && findFile("Notes", new RegExp(`live ${mine}`)) && findFile("Logs", new RegExp(`live ${mine}`)), 300000, 2000)
    check(`live ${agent}: it used the vault's MCP tools (read, search, write_note, write_log, inbox_add) within 5 min`, wrote, { secs: Math.round((Date.now() - started) / 1000), screen: (await term.screen(id, 60)).slice(-1500) })
    await sleep(5000) // its answer after the last tool
    const w = K.checkWrites(`live ${agent}`, `live ${mine}`, null, code)
    console.log(`     (${agent} wrote as source "${w.noteFm?.source}", inbox from "${w.inboxFm?.from}")`)
    check(`live ${agent}: its writes say who wrote them (source ${agent})`, w.noteFm?.source === agent, w.noteFm)
    check(`live ${agent}: it answered with the code word`, await screenHas(id, new RegExp(esc(code)), 60000), (await term.screen(id, 40)).slice(-800))

    const live = await liveIn(agent, id, 30000)
    check(`live ${agent}: its session shows as open, linked to its terminal`, live, (await get(`${agent}?days=1`)).live)
    const u = await waitFor(async () => { const x = await get(`${agent}?days=1`); return x.sessions.length && x.days.at(-1).tokens > 0 ? x : null }, 30000, 2000)
    const model = MODEL.split("/").pop()!
    const mrow = u?.models.find((m: Any) => String(m.name).includes(model))
    check(`live ${agent}: usage today, for ${model}`, mrow && mrow.tokens > 0 && u.days.at(-1).date === today(), u && { models: u.models, day: u.days.at(-1), total: u.total })
    check(`live ${agent}: a cost for the run (priced)`, mrow && mrow.cost > 0, u && { models: u.models, total: u.total })
    const sid = live?.id ?? u?.sessions[0]?.id
    const conv = sid ? await get(`${agent}/session/${encodeURIComponent(sid)}`) : null
    const calls = (conv?.entries ?? []).filter((e: Any) => e.kind === "tool")
    const called = (t: string) => calls.some((e: Any) => `${e.name} ${e.input}`.includes(t))
    check(`live ${agent}: its conversation, with the prompt and the MCP tool calls`, conv?.entries?.some((e: Any) => e.kind === "user" && e.text.includes(mine)) &&
      ["write_note", "write_log", "inbox_add"].every(called), { tools: calls.map((e: Any) => e.name), n: conv?.entries?.length })
    check(`live ${agent}: its conversation names the vault's tools it called`, ["write_note", "write_log", "inbox_add"].every((t) => calls.some((e: Any) => String(e.name).includes(t))),
      calls.map((e: Any) => e.name))
    const mem = await get(`${agent}/memory`)
    check(`live ${agent}: its memory as the plugin shows it`, agent === "openclaw" ? mem.dir === path.join(OC, "workspace") && mem.files.length > 0 : mem.soul !== null, mem)
    if (agent === "hermes") {
      try {
        execFileSync(K.which("hermes", agentPath)!, ["cron", "create", "--name", `Test job ${tok}`, "0 9 * * *", "Say hi"], { env: { ...K.serverEnv }, stdio: "pipe", timeout: 60000 })
        const jobs = await get("hermes/cron")
        check("live hermes: a scheduled job made with its CLI shows up", jobs.jobs.some((j: Any) => j.name === `Test job ${tok}`), jobs)
      } catch (e) { check("live hermes: a scheduled job made with its CLI shows up", false, String((e as Any).stderr ?? e).slice(0, 400)) }
    } else {
      const jobs = await get("openclaw/cron")
      check("live openclaw: scheduled jobs read (none here)", Array.isArray(jobs), jobs)
      skip("live openclaw: a scheduled job made with its CLI", "openclaw cron add needs a running gateway (this setup runs --local)")
    }

    // The server restarts: the agent goes on in its terminal, still linked.
    await K.stopServer()
    await K.startServer()
    check(`live ${agent}: its terminal survives a server restart`, (await waitFor(() => term.one(id), 10000))?.busy, await term.one(id))
    check(`live ${agent}: still linked to its terminal after the restart`, await liveIn(agent, id), (await get(`${agent}?days=1`)).live)
    await endAndCheck(`live ${agent}`, id)

    // Resume it in a new terminal and ask once more: the same conversation grows.
    if (!sid) { skip(`live ${agent}: resume`, "no session id"); continue }
    const rid = `resume-${agent}-${sid}`
    await term.start(rid)
    const rl = await liveIn(agent, rid, 60000)
    check(`live ${agent}: resumed, the session shows as open in its new terminal`, rl, (await get(`${agent}?days=1`)).live)
    // (typed before the TUI is up, the line is lost: OpenClaw's status line says "ready" once it takes input)
    if (agent === "openclaw") await waitFor(async () => /\bready\b/.test(await term.screen(rid, 40)) || null, 90000, 1000)
    await sleep(5000)
    await term.send(rid, `Reply with exactly: resumed ${tok}`)
    const grew = await waitFor(async () => {
      const c = await get(`${agent}/session/${encodeURIComponent(rl?.id ?? sid)}`)
      // (the first prompt is in it too: the same conversation)
      return c.entries.some((e: Any) => e.kind === "assistant" && e.text.includes(`resumed ${tok}`)) && c.entries.some((e: Any) => e.kind === "user" && e.text.includes(`live ${mine}`)) ? c : null
    }, 120000, 3000)
    check(`live ${agent}: resumed, it answers in the same conversation`, grew, (await term.screen(rid, 40)).slice(-800))
    await endAndCheck(`live ${agent} resumed`, rid)
  }

  // OpenCode: started in a terminal when installed (not signed in here: no prompt is sent).
  if (!K.which("opencode", agentPath)) skip("live opencode", "not installed")
  else {
    const id = `opencode-${rand()}`
    await term.start(id)
    const x = await waitFor(async () => { const y = await term.one(id); return y?.busy ? y : null }, 20000)
    check("live opencode: a terminal starts it", x, { list: await term.one(id), screen: (await term.screen(id, 30)).slice(-500) })
    await endAndCheck("live opencode", id)
  }
  await K.stopServer()
  K.stopBackends()
}

await K.run(async () => {
  await K.makeVault()
  await fixturePart()
  if (LIVE) await livePart()
  else skip("live agents", "set VAULTITE_AGENT_LIVE=1 to run the real agents on a real model")
})
process.exit(summary("plugins agents", t0))
