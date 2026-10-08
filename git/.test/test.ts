// Git: status parsing, messages, the iCloud warning and the commit-and-sync flow against throwaway repositories (a bare
// one in a temp folder as the remote, two clones to make conflicts); then the plugin on a throwaway server.
//   node test.ts git   (VAULTITE_APP: the app's checkout)
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Git as a stranger: none of this machine's config (signing, hooks, credentials), a made-up author.
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultite-git-test-"))
const CONFIG = path.join(TMP, "gitconfig")
fs.writeFileSync(CONFIG, "[user]\n\tname = Alice Park\n\temail = alice@example.com\n[init]\n\tdefaultBranch = main\n")
process.env.GIT_CONFIG_GLOBAL = CONFIG
process.env.GIT_CONFIG_NOSYSTEM = "1"
const { check, done, serve } = await import("../../testkit.ts") // (after: its servers get this environment)

const G = await import("../git.ts")
const bin = G.gitBinary()!
check("git is found", !!bin, bin)
const sh = (cwd: string, ...args: string[]) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const write = (dir: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8")
async function until(fn: () => unknown, ms = 5000) {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 200))) { try { if (fn()) return true } catch { /* not yet */ } if (Date.now() > end) return false }
}

// ---------- parsing

{
  const z = [
    "# branch.oid 1111111111111111111111111111111111111111", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaa aaa Notes/Idea.md",
    "1 A. N... 000000 100644 100644 000 bbb People/Alice Park.md",
    "2 R. N... 100644 100644 100644 ccc ccc R100 Notes/New name.md", "Notes/Old name.md",
    "u UU N... 100644 100644 100644 100644 d1 d2 d3 Daily/2026-10-06.md",
    "? Inbox/Clip one.md",
    "1 MM N... 100644 100644 100644 eee fff Outside/x.md",
  ].join("\0") + "\0"
  const s = G.parseStatus(z)
  check("status: branch, upstream, ahead and behind", s.branch === "main" && s.upstream === "origin/main" && s.ahead === 2 && s.behind === 1, s)
  const by = Object.fromEntries(s.files.map((f) => [f.path, f]))
  check("status: modified in the tree, not staged", by["Notes/Idea.md"].unstaged && !by["Notes/Idea.md"].staged && G.letter(by["Notes/Idea.md"], "unstaged") === "M")
  check("status: added, staged; names with spaces", by["People/Alice Park.md"]?.staged && G.letter(by["People/Alice Park.md"], "staged") === "A")
  check("status: a rename keeps where it came from", by["Notes/New name.md"]?.from === "Notes/Old name.md" && G.letter(by["Notes/New name.md"], "staged") === "R")
  check("status: a conflict", by["Daily/2026-10-06.md"]?.conflict && G.letter(by["Daily/2026-10-06.md"], "unstaged") === "C")
  check("status: untracked", by["Inbox/Clip one.md"]?.untracked && G.letter(by["Inbox/Clip one.md"], "unstaged") === "U")
  check("status: staged and changed again", by["Outside/x.md"].staged && by["Outside/x.md"].unstaged)
  const sub = G.parseStatus(z, "Notes/")
  check("status: a vault in a subfolder sees its own files, as its paths", sub.files.map((f) => f.path).sort().join("|") === "Idea.md|New name.md" && sub.files.find((f) => f.path === "New name.md")?.from === "Old name.md", sub.files)
  check("status: a fresh repository", G.parseStatus("# branch.oid (initial)\0# branch.head main\0").oid === null)
}

// ---------- messages

{
  const d = new Date(2026, 9, 6, 9, 5, 7)
  check("template: {{date}}", G.commitMessage("vault backup: {{date}}", { date: d, files: [] }) === "vault backup: 2026-10-06 09:05:07")
  check("template: {{numFiles}}, {{hostname}}, a date format", G.commitMessage("{{numFiles}} files from {{hostname}} on {{date}}", { date: d, dateFormat: "DD/MM/YYYY HH:mm", files: ["a.md", "b.md"], host: "studio" }) === "2 files from studio on 06/10/2026 09:05")
  check("template: {{files}}, capped", G.commitMessage("{{files}}", { files: Array.from({ length: 12 }, (_, i) => `n${i}.md`) }).endsWith("and 2 more"))
  check("template: empty falls back", G.commitMessage("  ", { date: d, files: [] }).startsWith("vault backup: 2026-10-06"))
  check("redact: credentials in a remote's address", G.redact("fatal: https://alice:ghp_abcdef123@github.com/a/b.git") === "fatal: https://***@github.com/a/b.git")
  check("redact: a bare token", G.redact("token ghp_abcdef123456 refused").includes("ghp_***"))
  check("friendly: who you are", G.friendly({ code: 128, out: "", err: "*** Please tell me who you are." }).startsWith("Git doesn't know who you are"))
  check("friendly: a remote asking for a password", G.friendly({ code: 128, out: "", err: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }).startsWith("The remote refused"))
}

// ---------- the timer

{
  const min = 60_000, now = 100 * min
  const base = { now, interval: 0, idle: 0, lastAuto: 0, lastCommit: 0, lastEdit: 0, pending: 0 }
  check("timer: off when both are 0", G.autoDue({ ...base, pending: 3, lastEdit: now - 90 * min }) === null)
  check("timer: every 10 minutes, since the last sync or commit", G.autoDue({ ...base, interval: 10, lastAuto: now - 11 * min, lastCommit: now - 20 * min }) === "interval" &&
    G.autoDue({ ...base, interval: 10, lastAuto: now - 11 * min, lastCommit: now - 5 * min }) === null)
  check("timer: after 2 minutes without an edit, with changes", G.autoDue({ ...base, idle: 2, pending: 1, lastEdit: now - 3 * min, lastAuto: now - 30 * min }) === "idle")
  check("timer: not while still editing", G.autoDue({ ...base, idle: 2, pending: 1, lastEdit: now - 1 * min }) === null)
  check("timer: not with nothing pending", G.autoDue({ ...base, idle: 2, pending: 0, lastEdit: now - 3 * min }) === null)
  check("timer: not again for the same edits", G.autoDue({ ...base, idle: 2, pending: 1, lastEdit: now - 5 * min, lastAuto: now - 3 * min }) === null)
}

// ---------- the iCloud warning

{
  const home = path.join(TMP, "home")
  const icloud = path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Vault")
  fs.mkdirSync(icloud, { recursive: true })
  const link = path.join(home, "vault-link")
  fs.symlinkSync(icloud, link)
  const c = G.cloudOf(icloud, home)
  check("iCloud: a vault in iCloud Drive", c?.name === "iCloud Drive" && c.sure, c)
  check("iCloud: through a symlink too", G.cloudOf(link, home)?.name === "iCloud Drive")
  const gd = path.join(home, "Library/CloudStorage/GoogleDrive-alice@example.com/My Drive/Vault")
  fs.mkdirSync(gd, { recursive: true })
  check("cloud: Google Drive's folder", G.cloudOf(gd, home)?.name === "Google Drive")
  const plain = path.join(home, "Vault")
  fs.mkdirSync(plain)
  check("cloud: a plain folder isn't", G.cloudOf(plain, home) === null)
  fs.mkdirSync(path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Documents"), { recursive: true })
  fs.mkdirSync(path.join(home, "Documents/Vault"), { recursive: true })
  const dd = G.cloudOf(path.join(home, "Documents/Vault"), home)
  check("iCloud: Desktop & Documents is a guess, said as one", dd?.name === "iCloud Drive" && !dd.sure, dd)
  const w = G.cloudWarning(c!)
  check("iCloud: the warning says why and which to use", w.includes("can fight") && w.includes("Use one") && w.includes(".git") && w.includes("File history"), w)
}

// ---------- the flow, against a bare remote and two clones

const REMOTE = path.join(TMP, "remote.git")
const A = path.join(TMP, "a"), B = path.join(TMP, "b")
sh(TMP, "init", "-q", "--bare", REMOTE)
fs.mkdirSync(A)
const ga = G.runner(A, bin), gb = G.runner(B, bin)
{
  check("repo: none yet", (await G.repoOf(ga)) === null)
  sh(A, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(A, ".gitignore"), G.GITIGNORE)
  write(A, "Notes/Idea.md", "# Idea\n\nA lighthouse.\n")
  write(A, ".vaultite/cache/github.json", "{}")
  write(A, ".DS_Store", "x")
  const repo = (await G.repoOf(ga))!
  check("repo: found, at the top", repo && repo.prefix === "", repo)
  const st = await G.status(ga, repo)
  check("gitignore: the cache and the OS's files are left out", st.files.map((f) => f.path).sort().join("|") === ".gitignore|Notes/Idea.md", st.files)
  const c = await G.commit(ga, repo, { message: "First", vaultDir: A })
  check("commit: everything when nothing is staged", c?.files.length === 2 && sh(A, "log", "--format=%s").trim() === "First", c)
  check("commit: nothing to commit is null", (await G.commit(ga, repo, { message: "Again", vaultDir: A })) === null)
  // No remote: sync commits only
  write(A, "Notes/Idea.md", "# Idea\n\nA lighthouse, painted.\n")
  const r0 = await G.sync(ga, repo, { commit: { message: "Paint", vaultDir: A } })
  check("sync: without a remote it commits and says so", r0.committed?.message === "Paint" && r0.notes.some((n) => n.includes("No remote")), r0)
  sh(A, "remote", "add", "origin", REMOTE)
  const r1 = await G.sync(ga, repo, { commit: { message: "unused", vaultDir: A } })
  check("sync: the first push sets the upstream", r1.pushed === 2 && sh(A, "rev-parse", "--abbrev-ref", "@{u}").trim() === "origin/main", r1)
}
sh(TMP, "clone", "-q", REMOTE, B)
{
  const ra = (await G.repoOf(ga))!, rb = (await G.repoOf(gb))!
  // An agent commits only its own file; the user's edit stays pending.
  write(A, "Notes/Idea.md", "# Idea\n\nA lighthouse, painted red.\n")
  write(A, "Notes/Agent.md", "Written by an agent.\n")
  const mine = await G.commit(ga, ra, { message: "Added the agent's note", files: ["Notes/Agent.md"], trailers: ["Vaultite-Agent: Claude Code"], vaultDir: A })
  const left = (await G.status(ga, ra)).files.map((f) => f.path)
  check("commit: files only, the rest left as it was", mine?.files.join() === "Notes/Agent.md" && left.join() === "Notes/Idea.md", { mine, left })
  check("commit: the agent's trailer", sh(A, "log", "-1", "--format=%B").includes("Vaultite-Agent: Claude Code"))
  check("commit: files that didn't change are nothing", (await G.commit(ga, ra, { message: "x", files: ["Notes/Nope.md"], vaultDir: A })) === null)
  await G.commit(ga, ra, { message: "Red", vaultDir: A })
  // B, meanwhile, changes the same line and syncs first.
  write(B, "Notes/Idea.md", "# Idea\n\nA lighthouse, painted blue.\n")
  const rB = await G.sync(gb, rb, { commit: { message: "Blue", vaultDir: B } })
  check("sync: B pulls A's commits and pushes its own", rB.pulled === 0 && rB.pushed === 1 && rB.conflicts.length === 0, rB)
  const steps: string[] = []
  let locked = 0
  const rA = await G.sync(ga, ra, { commit: { message: "unused", vaultDir: A }, step: (s) => steps.push(s), lock: async (fn) => { locked++; return fn() } })
  check("conflict: the sync stops at it, listing the file", rA.conflicts.join() === "Notes/Idea.md" && rA.pushed === 0, rA)
  check("conflict: the merge ran with the vault to itself", locked === 1 && steps.includes("Pulling"), { locked, steps })
  check("conflict: nothing lost (both sides in the file, A's commit kept)", read(A, "Notes/Idea.md").includes("painted red") && read(A, "Notes/Idea.md").includes("painted blue") &&
    sh(A, "show", "HEAD:Notes/Idea.md").includes("painted red"))
  check("conflict: a merge waits", G.merging(ra))
  let refused = ""
  try { await G.commit(ga, ra, { message: "", vaultDir: A }) } catch (e) { refused = (e as Error).message }
  check("conflict: commit refuses while markers are left", refused.includes("conflict markers") && refused.includes("Notes/Idea.md"), refused)
  const again = await G.sync(ga, ra, { commit: { message: "x", vaultDir: A } })
  check("conflict: sync doesn't go on past it", again.conflicts.join() === "Notes/Idea.md" && !again.committed, again)
  sh(A, "add", "Notes/Idea.md") // (marked resolved with its markers still in)
  refused = ""
  try { await G.commit(ga, ra, { message: "", vaultDir: A }) } catch (e) { refused = (e as Error).message }
  check("conflict: marked resolved with markers left, still refused", refused.includes("conflict markers"), refused)
  write(A, "Notes/Idea.md", "# Idea\n\nA lighthouse, painted red and blue.\n")
  const merged = await G.commit(ga, ra, { message: "", vaultDir: A })
  check("conflict: resolved, commit finishes the merge", !!merged && !G.merging(ra) && sh(A, "log", "-1", "--format=%p").trim().split(" ").length === 2, merged)
  const rA2 = await G.sync(ga, ra, { commit: { message: "x", vaultDir: A } })
  check("conflict: then it syncs", rA2.pushed >= 1 && !rA2.conflicts.length, rA2)
  const rB2 = await G.sync(gb, rb, { commit: { message: "x", vaultDir: B } })
  check("sync: B gets the merge", rB2.pulled >= 1 && read(B, "Notes/Idea.md").includes("red and blue"), rB2)

  // Abort: a second conflict, aborted, puts A back as it was.
  write(B, "Notes/Agent.md", "B's words.\n"); await G.sync(gb, rb, { commit: { message: "B", vaultDir: B } })
  write(A, "Notes/Agent.md", "A's words.\n")
  const rA3 = await G.sync(ga, ra, { commit: { message: "A", vaultDir: A } })
  check("abort: a conflict", rA3.conflicts.join() === "Notes/Agent.md", rA3)
  sh(A, "merge", "--abort")
  check("abort: as before the pull, A's commit kept", read(A, "Notes/Agent.md") === "A's words.\n" && !G.merging(ra))
  // Settle it from B's side for the rest.
  sh(A, "reset", "-q", "--hard", "origin/main")

  // A pull that would overwrite a new file stops without losing it.
  write(B, "Notes/Same.md", "B's\n"); await G.sync(gb, rb, { commit: { message: "B same", vaultDir: B } })
  write(A, "Notes/Same.md", "A's, not committed\n")
  let err = ""
  try { await G.sync(ga, ra, { commit: false }) } catch (e) { err = (e as Error).message }
  check("pull: an untracked file in the way stops it, kept", err.includes("Couldn't merge") && read(A, "Notes/Same.md") === "A's, not committed\n", err)
  fs.rmSync(path.join(A, "Notes/Same.md"))
  await G.sync(ga, ra, { commit: false })

  // History: a rename followed, each version's text.
  sh(A, "mv", "Notes/Idea.md", "Notes/Lighthouse.md")
  write(A, "Notes/Lighthouse.md", "# Lighthouse\n\nPainted red and blue.\n")
  await G.commit(ga, ra, { message: "Renamed", vaultDir: A })
  const versions = await G.fileLog(ga, ra, "Notes/Lighthouse.md")
  check("history: follows the rename", versions[0].subject === "Renamed" && versions.some((v) => v.path === "Notes/Idea.md"), versions.map((v) => [v.subject, v.path]))
  const first = versions[versions.length - 1]
  check("history: the first version's text", (await G.show(ga, ra, first.sha, first.path)) === "# Idea\n\nA lighthouse.\n")
  check("history: a file that wasn't there is null", (await G.show(ga, ra, first.sha, "Notes/Lighthouse.md")) === null)
  let bad = ""
  try { await G.show(ga, ra, "--output=/tmp/x", "a.md") } catch (e) { bad = (e as Error).message }
  check("show: an option isn't a commit", bad.includes("isn't a commit"))
  const commits = await G.log(ga, 5)
  check("log: the repository's last commits", commits[0].subject === "Renamed" && commits[0].files >= 1, commits)
}

// A vault in a folder of a bigger repository: its own paths.
{
  const big = path.join(TMP, "big")
  fs.mkdirSync(path.join(big, "vault/Notes"), { recursive: true })
  sh(big, "init", "-q")
  write(big, "README.md", "outside\n")
  write(big, "vault/Notes/One.md", "one\n")
  const g = G.runner(path.join(big, "vault"), bin)
  const repo = (await G.repoOf(g))!
  check("subfolder: the vault's prefix", repo.prefix === "vault/", repo)
  check("subfolder: only the vault's files, as its paths", (await G.status(g, repo)).files.map((f) => f.path).join() === "Notes/One.md")
  await G.commit(g, repo, { message: "One", files: ["Notes/One.md"], vaultDir: path.join(big, "vault") })
  check("subfolder: a file's history and text", (await G.fileLog(g, repo, "Notes/One.md")).length === 1 && (await G.show(g, repo, "HEAD", "Notes/One.md")) === "one\n")
}

// ---------- the plugin, on a throwaway server

const srv = await serve(["git"])
try {
  const { api, vau, vault } = srv
  const [, s0] = await api("GET", "git/status")
  check("server: the sandbox isn't a repository", s0.git === true && s0.repo === null && s0.cloud === null, s0)
  const [ic, init] = await api("POST", "ops/git.init", {})
  check("server: git.init", ic === 200 && init.initialized && init.gitignore && fs.readFileSync(path.join(vault, ".gitignore"), "utf8").includes(".vaultite/cache/"), init)
  const st = vau("git", "status")
  check("vau git status: what's pending", st.includes("On main") && st.includes("changed files") && st.includes("No commits yet"), st)
  const out = vau("git", "commit", "-m", "First backup")
  check("vau git commit -m", /Committed \d+ files \(\w{7}\): First backup/.test(out), out)
  fs.writeFileSync(path.join(vault, "Notes/Agent work.md"), "An agent's note.\n")
  fs.appendFileSync(path.join(vault, "ME.md"), "\nThe user's own edit.\n")
  const [, c2] = await api("POST", "ops/git.commit", { message: "Wrote a note", files: ["Notes/Agent work.md"] })
  const [, s1] = await api("GET", "git/status")
  check("server: an agent's commit takes only its file", c2.committed?.files.join() === "Notes/Agent work.md" && s1.files.some((f: { path: string }) => f.path === "ME.md"), { c2, files: s1.files })
  // A remote: the bare one's clone C makes a conflict.
  const bare = path.join(TMP, "server-remote.git")
  sh(TMP, "init", "-q", "--bare", bare)
  check("server: git.remote", vau("git", "remote", bare).includes("Remote origin"))
  const sy = vau("git", "sync", "Backup with the user's edit")
  check("vau git sync: commits and pushes", sy.includes("pushed") && sh(TMP, "--git-dir", bare, "log", "-1", "--format=%s").trim() === "Backup with the user's edit", sy)
  const C = path.join(TMP, "c")
  sh(TMP, "clone", "-q", bare, C)
  fs.writeFileSync(path.join(C, "ME.md"), "Rewritten elsewhere.\n")
  sh(C, "commit", "-qam", "Elsewhere"); sh(C, "push", "-q")
  fs.writeFileSync(path.join(vault, "ME.md"), "Rewritten here.\n")
  const [cc, conflict] = await api("POST", "ops/git.sync", {})
  check("server: a conflict stops the sync", cc === 200 && conflict.conflicts.join() === "ME.md", conflict)
  const [, events] = await api("GET", "inbox/events")
  const ev = events.events.find((e: { source: string }) => e.source === "git")
  check("server: said in the Inbox, with the files and a link to Source control", ev?.title.includes("merge conflicts") && ev.body.includes("ME.md") && ev.link === "view:git", ev)
  const [, s2] = await api("GET", "git/status")
  check("server: the status shows the conflict", s2.merging && s2.conflicts.join() === "ME.md", s2)
  const [ab] = await api("POST", "ops/git.abort", {})
  check("server: git.abort", ab === 200 && fs.readFileSync(path.join(vault, "ME.md"), "utf8") === "Rewritten here.\n")
  sh(vault, "reset", "-q", "--hard", "origin/main")
  // History and restore
  const lg = vau("git", "log", "Notes/Agent work.md")
  check("vau git log <file>", lg.includes("Wrote a note"), lg)
  const sha = sh(vault, "log", "-1", "--format=%H", "--", "Notes/Agent work.md").trim()
  fs.writeFileSync(path.join(vault, "Notes/Agent work.md"), "Changed.\n")
  await new Promise((r) => setTimeout(r, 400))
  const [rc, rs] = await api("POST", "ops/git.restore", { path: "Notes/Agent work.md", commit: sha })
  check("server: git.restore writes it back through the API", rc === 200 && rs.changed && fs.readFileSync(path.join(vault, "Notes/Agent work.md"), "utf8") === "An agent's note.\n", rs)
  const [, fh] = await api("GET", `history?path=${encodeURIComponent("Notes/Agent work.md")}`)
  const gv = fh.others?.find((o: { source: string }) => o.source === "git")
  check("File history lists the file's commits beside its own versions", gv?.label === "Git" && gv.versions.some((v: { title: string }) => v.title === "Wrote a note"), fh)
  const [vc, vt] = await api("GET", `history/version?path=${encodeURIComponent("Notes/Agent work.md")}&source=git&id=${sha}`)
  check("File history reads a commit's text", vc === 200 && vt === "An agent's note.\n", [vc, vt])
  const [, diff] = await api("GET", "git/diff?path=ME.md")
  check("server: git/diff gives both sides", typeof diff.head === "string" && typeof diff.now === "string", diff)
  // The timer: due by its interval (the last commit two hours ago), it commits with the template and pushes.
  check("timer: a job of the schedule", vau("schedule", "list").includes("git/auto: every 1m"))
  await api("PATCH", "config/plugin/git", { autoInterval: 30, message: "auto: {{numFiles}} from {{hostname}}" })
  execFileSync(bin, ["commit", "-q", "--allow-empty", "-m", "Two hours ago"], { cwd: vault, env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 7200_000).toISOString() } })
  // (the server's own tick may run it first: then this one is refused as running, which is fine)
  try { vau("schedule", "run", "git/auto") } catch (e) { if (!String((e as Error).message).includes("is running")) throw e }
  const idle = () => !JSON.parse(vau("schedule", "list", "--json")).find((r: { id: string; running: boolean }) => r.id === "git/auto")?.running
  const auto = await until(() => /^auto: \d+ from \S+/.test(sh(vault, "log", "-1", "--format=%s").trim()) && idle(), 15000)
  check("timer: commit and sync with the template", auto && sh(TMP, "--git-dir", bare, "log", "-1", "--format=%s").trim() === sh(vault, "log", "-1", "--format=%s").trim(), sh(vault, "log", "-3", "--format=%s"))
  const head = sh(vault, "rev-parse", "HEAD")
  vau("schedule", "run", "git/auto")
  check("timer: not again until the interval is up", sh(vault, "rev-parse", "HEAD") === head)
  await api("PATCH", "config/plugin/git", { autoInterval: null, message: null })
  const [tc, tk] = await api("POST", "git/token", { token: "ghp_madeup123456" })
  const [, tg] = await api("GET", "git/token")
  check("server: a token is kept on this machine, never answered back", tc === 200 && tk.set && tg.set && !JSON.stringify(tg).includes("ghp_") &&
    !fs.readdirSync(vault, { recursive: true }).some((f) => String(f).includes("config.json") && fs.readFileSync(path.join(vault, String(f)), "utf8").includes("ghp_")), tg)
  await api("POST", "git/token", { token: "" })
} finally {
  srv.stop()
  fs.rmSync(TMP, { recursive: true, force: true })
}
done()
