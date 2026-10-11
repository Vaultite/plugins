// Claude chat against a fake claude (fake-claude.mjs): send and stream, a tool use with its permission asked and
// answered both ways, stop, resume after a change of model, the ask op, rename and delete, signed out, not installed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const state = fs.mkdtempSync(path.join(os.tmpdir(), "claude-chat-test-"))
const cli = path.join(state, "claude")
fs.symlinkSync(path.join(import.meta.dirname, "fake-claude.mjs"), cli)
process.env.CLAUDE_CHAT_CLI = cli
process.env.FAKE_CLAUDE_STATE = state
process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin" // (as under launchd: the fake is a node script)

const { check, done, serve } = await import("../../testkit.ts")
const s = await serve(["claude-chat"])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Conv = { id: string; title: string; session: string; started: boolean; entries: Record<string, any>[] } // eslint-disable-line @typescript-eslint/no-explicit-any
const get = async (id: string) => (await s.api("GET", `claude-chat/conversations/${id}`))[1] as { conv: Conv; live: { running: boolean; status: string } }
async function until(id: string, ok: (c: Conv, running: boolean) => boolean, ms = 8000) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(60)) { const r = await get(id); if (ok(r.conv, r.live.running)) return r.conv }
  return (await get(id)).conv
}
const runs = () => fs.readFileSync(path.join(state, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.argv?.includes("--include-partial-messages")) // (not the status's handshake)
const flag = (argv: string[], f: string) => argv[argv.indexOf(f) + 1]

try {
  const [, st] = await s.api("GET", "claude-chat/status?fresh=1")
  check("status: installed and signed in", st.installed && st.loggedIn, st)
  check("status: the CLI's own models", st.models?.some((m: { value: string }) => m.value === "haiku"), st.models)

  const [, made] = await s.api("POST", "claude-chat/conversations")
  const id = made.id as string
  s.write("Notes/Garden.md", "# Garden\n\nTomatoes by the fence\n")
  await s.api("POST", `claude-chat/conversations/${id}/send`, { text: "Hello there, how are you", file: "Notes/Garden.md" })
  let c = await until(id, (c, running) => !running && c.entries.some((e) => e.kind === "assistant" && !e.open))
  const said = c.entries.find((e) => e.kind === "assistant")
  check("send: the answer streamed back as Markdown", said?.text?.startsWith("You said:") && said.text.includes("- one"), c.entries)
  check("send: the conversation took its title from the message", c.title === "Hello there, how are you", c.title)
  const first = runs()[0]
  check("run: in the vault's folder", fs.realpathSync(first.cwd) === fs.realpathSync(s.vault), first.cwd)
  check("run: stream json both ways, permission asks on stdio", first.argv.includes("stream-json") && flag(first.argv, "--permission-prompt-tool") === "stdio", first.argv)
  check("run: a new session by its id", flag(first.argv, "--session-id") === c.session && !first.argv.includes("--resume"), first.argv)
  check("run: the default mode asks", flag(first.argv, "--permission-mode") === "default", first.argv)
  const sent = fs.readFileSync(path.join(state, "log.jsonl"), "utf8").includes("The note open beside this chat: Notes/Garden.md")
  check("send: the open note goes with the message", sent)

  // A tool use: Read, then Edit asked first; Allow lets it write.
  await s.api("POST", `claude-chat/conversations/${id}/send`, { text: "Please edit Notes/Garden.md" })
  c = await until(id, (c) => c.entries.some((e) => e.kind === "ask" && !e.answer))
  const ask = c.entries.find((e) => e.kind === "ask" && !e.answer)
  check("edit: it asks before editing, naming the note", ask?.tool === "Edit" && ask.file === "Notes/Garden.md", ask)
  const read = c.entries.find((e) => e.kind === "tool" && e.name === "Read")
  check("edit: the Read it did links the note", read?.file === "Notes/Garden.md" && read.result?.includes("Garden"), read)
  check("edit: the list says it's waiting", (await s.api("GET", "claude-chat/conversations"))[1].list.find((x: { id: string }) => x.id === id)?.waiting === true)
  await s.api("POST", `claude-chat/conversations/${id}/answer`, { ask: ask!.id, allow: true })
  c = await until(id, (c, running) => !running && c.entries.at(-1)?.kind === "assistant")
  const edit = c.entries.find((e) => e.kind === "tool" && e.name === "Edit")
  check("edit: allowed, the file changed", s.read("Notes/Garden.md").includes("# Garden (edited)"), s.read("Notes/Garden.md"))
  check("edit: its diff is kept", edit?.patch?.[0]?.lines?.includes("+# Garden (edited)"), edit)
  check("edit: the answer after it", c.entries.at(-1)?.text?.includes("I edited"), c.entries.at(-1))
  const [st2] = await s.api("POST", `claude-chat/conversations/${id}/answer`, { ask: ask!.id, allow: true })
  check("edit: an answered question can't be answered again", st2 === 409, st2)

  // Deny: the file stays.
  const before = s.read("Notes/Garden.md")
  await s.api("POST", `claude-chat/conversations/${id}/send`, { text: "edit Notes/Garden.md again" })
  c = await until(id, (c) => c.entries.some((e) => e.kind === "ask" && !e.answer))
  await s.api("POST", `claude-chat/conversations/${id}/answer`, { ask: c.entries.find((e) => e.kind === "ask" && !e.answer)!.id, allow: false })
  c = await until(id, (c, running) => !running)
  check("deny: the file is as it was", s.read("Notes/Garden.md") === before)
  check("deny: Claude hears no", c.entries.filter((e) => e.kind === "tool" && e.name === "Edit").at(-1)?.error === true && c.entries.at(-1)?.text?.includes("left it"), c.entries.slice(-3))

  // Stop, mid-answer.
  await s.api("POST", `claude-chat/conversations/${id}/send`, { text: "be slow please" })
  await until(id, (c) => (c.entries.at(-1)?.text ?? "").includes("word5"))
  await s.api("POST", `claude-chat/conversations/${id}/stop`, {})
  c = await until(id, (c, running) => !running)
  const last = c.entries.filter((e) => e.kind === "assistant").at(-1)
  check("stop: the answer stops part way", !(await get(id)).live.running && !last?.text.includes("word200") && !last?.open, last?.text?.length)
  check("stop: it says so", c.entries.some((e) => e.kind === "note" && e.text === "Stopped."), c.entries.slice(-2))

  // The model changed: the next message starts claude again, resuming the same session.
  s.write(".vaultite/plugins/claude-chat/data.json", JSON.stringify({ model: "haiku", mode: "acceptEdits" }))
  await sleep(300)
  await s.api("POST", `claude-chat/conversations/${id}/send`, { text: "and now?" })
  c = await until(id, (c, running) => !running && c.entries.at(-1)?.text === "You said: and now?\n\n- one\n- two")
  const again = runs().at(-1)
  check("resume: a new process resumes the session", runs().length === 2 && flag(again.argv, "--resume") === c.session && !again.argv.includes("--session-id"), again?.argv)
  check("resume: the old process ending isn't an error", !c.entries.some((e) => e.kind === "note" && e.error), c.entries.filter((e) => e.kind === "note"))
  check("resume: with the new model and mode", flag(again.argv, "--model") === "haiku" && flag(again.argv, "--permission-mode") === "acceptEdits", again?.argv)

  // The op, as an agent or the CLI asks.
  const out = s.vau("claude-chat", "ask", "What is in the garden", "--conversation", id)
  check("op: claude-chat ask waits for the answer", out.includes("You said: What is in the garden") && out.includes(`conversation ${id}`), out)
  const fresh = JSON.parse(s.vau("claude-chat.ask", "Edit Notes/Garden.md", "--json"))
  check("op: a new conversation, and what it did", fresh.conversation !== id && fresh.tools.some((t: string) => t === "Edit Notes/Garden.md"), fresh)
  check("op: the list has both", s.vau("claude-chat", "list").includes(id))

  // Rename, delete.
  await s.api("PATCH", `claude-chat/conversations/${id}`, { title: "Garden chat" })
  check("rename", (await get(id)).conv.title === "Garden chat")
  await s.api("DELETE", `claude-chat/conversations/${fresh.conversation}`)
  const [gone] = await s.api("GET", `claude-chat/conversations/${fresh.conversation}`)
  check("delete", gone === 404, gone)

  // Signed out, then not installed.
  fs.writeFileSync(path.join(state, "logged-out"), "")
  const [, out2] = await s.api("GET", "claude-chat/status?fresh=1")
  check("signed out: status says so", out2.installed && !out2.loggedIn, out2)
  const [, m2] = await s.api("POST", "claude-chat/conversations")
  await s.api("POST", `claude-chat/conversations/${m2.id}/send`, { text: "hi" })
  c = await until(m2.id, (c, running) => !running && c.entries.length > 1)
  check("signed out: the chat says to sign in", c.entries.some((e) => e.kind === "note" && e.signIn), c.entries)
  fs.rmSync(cli)
  const [, out3] = await s.api("GET", "claude-chat/status?fresh=1")
  check("not installed: status says so", !out3.installed, out3)
  const [code] = await s.api("POST", `claude-chat/conversations/${m2.id}/send`, { text: "hi" })
  check("not installed: sending is refused", code === 424, code)

  // Through Tailscale Serve, someone else than the owner is refused.
  const r = await fetch(`${s.base}api/claude-chat/conversations`, { headers: { "Tailscale-User-Login": "someone@example.com" } })
  check("owner only", r.status === 403, r.status)
} finally {
  s.stop()
  fs.rmSync(state, { recursive: true, force: true })
}
done()
