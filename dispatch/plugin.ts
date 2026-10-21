// Dispatch: a note's header buttons, command and menu items that hand it to a coding agent (or a shell command), each
// an action of its settings. Terminal's terminal.run starts it, here or on another of the Machines.
import { TERMINAL_AGENT } from "@vaultite/core/agents.ts"
import { OpError, Plugin } from "@vaultite/core/plugins.ts"

export const plugin = new Plugin(import.meta.url)

/** An action: an agent started with `prompt`, or a `command` typed into a new shell. `report: false`: no report asked
 *  (nor terminal ended). `open`: its tab opens in the user's window (unasked only when nothing reports back). */
export type Action = { id: string; label: string; icon?: string; agent?: string; prompt?: string; command?: string; report?: boolean; open?: boolean }

export const DEFAULT_PROMPT = "Read the note {path} and do what it asks."
export const DEFAULT_ACTIONS: Action[] = [{ id: "claude", label: "Claude Code", icon: "claude", agent: "claude", prompt: DEFAULT_PROMPT }]

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

/** Its settings' `actions` read leniently (an id from the label when it has none; one without an agent or a command
 *  left out), else the default. */
export function actions(): Action[] {
  const raw = plugin.settings().actions
  if (!Array.isArray(raw)) return DEFAULT_ACTIONS
  const out: Action[] = []
  for (const x of raw) {
    if (!x || typeof x !== "object") continue
    const r = x as Record<string, unknown>
    const agent = str(r.agent), command = str(r.command)
    if (!(agent && TERMINAL_AGENT.test(agent)) && !command) continue
    const label = str(r.label) || agent || "Command"
    let id = slug(str(r.id)) || slug(label) || "action", n = 2
    while (out.some((a) => a.id === id)) id = `${slug(str(r.id)) || slug(label) || "action"}-${n++}`
    const a: Action = { id, label }
    if (str(r.icon)) a.icon = str(r.icon)
    if (agent && TERMINAL_AGENT.test(agent)) {
      a.agent = agent
      a.prompt = typeof r.prompt === "string" && r.prompt.trim() ? r.prompt : DEFAULT_PROMPT
      if (r.report === false) a.report = false
    }
    else a.command = command
    if (typeof r.open === "boolean") a.open = r.open
    out.push(a)
  }
  return out
}

plugin.state(() => ({ dispatch: { actions: actions(), defaults: DEFAULT_ACTIONS } }))

/** What each button shows as running: the sessions dispatched from here (or passed on to another machine) that still
 *  run, by what they run; one that ends is let go. */
type Run = { action: string; path: string; id: string }
const runs = new Map<string, Run>()
/** Whether session `id` runs: here, or (id@machine) on that machine. */
async function stillRuns(id: string) {
  const [own, machine] = id.split("@")
  if (!machine) return !!(await plugin.ask<boolean>("terminal:runs", false, own))
  return (await plugin.ask<string | null>("terminal:locate", null, own)) === machine
}
async function stillRunning(): Promise<Run[]> {
  const out: Run[] = []
  for (const [k, r] of [...runs]) if (await stillRuns(r.id)) out.push(r); else runs.delete(k)
  return out
}
plugin.route("GET", "dispatch/running", async (req) => {
  if (req.http && await plugin.refusal(req.http, "the terminal")) return []
  return stillRunning()
})

plugin.op({
  owner: "the terminal",
  id: "dispatch.run",
  cli: "dispatch",
  summary: "Hand a file to a coding agent in a new terminal on this machine or another (Claude Code by default), told to read it and do what it asks.",
  help: `Runs one of Dispatch's actions on a file: an agent started with its prompt (the file's path, not its text, so it
reads the latest version and can edit it), or a shell command, in a new terminal shown in the user's window. Without
action, the first one. The actions are the plugin's settings (vau docs dispatch). With machine, on another of the
Machines (one with this vault): its terminal is <id>@<machine>. With account, the agent runs in that one of its
accounts (Claude Code: its config folders). Terminal's terminal.run starts it (vau terminal run: a file without an
action).

  vau dispatch "Notes/Garden plan.md"
  vau dispatch Notes/Idea.md --action codex
  vau dispatch Notes/Idea.md --machine studio --account personal`,
  kind: "write",
  lock: false, // starting a shell holds nothing of the vault
  params: {
    path: { type: "string", format: "path", required: true, description: "the file to hand over (Notes/Idea.md)" },
    action: { type: "string", description: "the action's id (claude); the first one when left out" },
    machine: { type: "string", description: "run it on another of the Machines, by its id (studio); this one when left out" },
    account: { type: "string", description: "the agent's account to run in (personal); the action's own when left out" },
    open: { type: "boolean", description: "open its terminal's tab in the user's window (default: the action's open; an agent that reports to the inbox runs in the background)" },
    allow: { type: "boolean", description: "run a command action this machine hasn't run before (ask the user first: it's a shell command a setting names)" },
    again: { type: "boolean", description: "start another session even when one this file's dispatch started still runs (else that one answers, running: true)" },
  },
  args: ["path"],
  action: { on: ["*"], param: "path", label: "Hand to a coding agent", icon: "bot", menu: false },
  run: async ({ path: rel, action, machine, open, allow, account, again }, ctx) => {
    const list = actions()
    const a = action ? list.find((x) => x.id === action) : list[0]
    if (!a) throw new OpError(action ? `no action '${action}': ${list.map((x) => x.id).join(", ") || "there are none"}` : "there are no actions (the setting actions)")
    if (account && !a.agent) throw new OpError(`${a.label} runs a command, not an agent with accounts`)
    // Terminal's terminal.run starts it (here or on that machine): this is which action, and its dot while it runs.
    const what = a.agent ? { agent: a.agent, prompt: a.prompt ?? DEFAULT_PROMPT, ...(a.report === false ? { report: false } : {}) } : { command: a.command }
    let r: { id: string; path: string; shown: boolean; handed: boolean; running?: boolean; machine?: string; account?: string }
    try {
      r = await ctx.op("terminal.run", { path: rel, ...what, ...(machine ? { machine } : {}), ...(account ? { account } : {}),
        ...((open ?? a.open) !== undefined ? { open: open ?? a.open } : {}), ...(allow ? { allow } : {}), ...(again ? { again } : {}) })
    } catch (e) {
      if (e instanceof OpError && e.status === 404 && /no operation 'terminal\.run'/.test(e.message)) throw new OpError("Dispatch needs a newer Vaultite (with terminal.run)", 409)
      throw e
    }
    runs.set(r.id, { action: a.id, path: rel, id: r.id })
    return { ...r, action: a.id }
  },
  text: (r) => `${r.running ? "Already running:" : "Dispatched"} ${r.path} to ${r.action}${r.account ? ` (${r.account})` : ""}${r.machine ? ` on ${r.machine}` : ""} in ${r.id}${r.shown ? "" : ` (${r.handed
    ? "in the background: its report comes to the inbox" : "no tab open"}; vau terminal screen ${r.machine ? `${r.id.split("@")[0]} on that machine` : r.id})`}.`,
})
