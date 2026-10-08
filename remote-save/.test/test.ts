// Remote save without the internet: the sync engine between made-up "devices" (folders, each with its own state) and
// a fake S3 bucket or WebDAV folder in this process, then the plugin on a throwaway server (settings, secrets, ops,
// schedule, the inbox on a conflict).   node test.ts remote-save
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { APP, check, done, ENV, serve } from "../../testkit.ts"
import { fakeS3, fakeWebdav, type Fake } from "./fakes.ts"

const { sync, fsLocal } = await import("../sync.ts")
const { s3Remote } = await import("../s3.ts")
const { webdavRemote } = await import("../webdav.ts")
const { plainCodec, sealedCodec, newKeyInfo, sealedKey, META } = await import("../codec.ts")
const { skipper } = await import("../glob.ts")
type State = import("../sync.ts").State
type Codec = import("../codec.ts").Codec
type Remote = import("../remote.ts").Remote
type Direction = import("../types.ts").Direction

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "remote-save-test-"))
const DAY = "2026-10-06"
const KEYS = { AKIDEXAMPLE: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }

/** A made-up device: a vault folder and its own state of a remote. */
function device(name: string, files: Record<string, string | Buffer> = {}) {
  const root = path.join(TMP, name)
  fs.mkdirSync(root, { recursive: true })
  for (const [p, t] of Object.entries(files)) write(root, p, t)
  return { root, state: { fingerprint: "x", files: {} } as State }
}
function write(root: string, p: string, t: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
  fs.writeFileSync(path.join(root, p), t)
  const later = new Date(Date.now() + Math.random() * 1000) // (an edit within the same millisecond still reads as changed)
  fs.utimesSync(path.join(root, p), later, later)
}
const read = (root: string, p: string) => fs.readFileSync(path.join(root, p), "utf8")
const has = (root: string, p: string) => fs.existsSync(path.join(root, p))
/** Every file a sync would see, with its text. */
function tree(root: string, skip = skipper([".vaultite/cache/", ".trash/"])) {
  const out: Record<string, string> = {}
  const walk = (d: string) => { for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    const rel = d ? `${d}/${f.name}` : f.name
    if (f.isDirectory()) { if (!skip(`${rel}/`)) walk(rel) } else if (!skip(rel)) out[rel] = fs.readFileSync(path.join(root, rel)).toString("base64")
  } }
  walk("")
  return out
}
const same = (a: string, b: string) => JSON.stringify(tree(a)) === JSON.stringify(tree(b))

function run(dev: { root: string; state: State }, remote: Remote, o: { codec?: Codec; direction?: Direction; skip?: string[]; deletions?: boolean; dryRun?: boolean } = {}) {
  return sync({ remote, codec: o.codec ?? plainCodec, local: fsLocal(dev.root), state: dev.state, save: () => {}, direction: o.direction ?? "two-way",
    skip: skipper(o.skip ?? [".vaultite/cache/", ".trash/"]), deletions: o.deletions, dryRun: o.dryRun, day: DAY, concurrency: 3 })
}

const fakes: Fake[] = []
const s3 = await fakeS3("vault", KEYS)
fakes.push(s3)
const bucket = (prefix = "MyVault/", over: Partial<Parameters<typeof s3Remote>[0]> = {}) => s3Remote({ endpoint: s3.url, region: "auto", bucket: "vault", prefix,
  accessKeyId: "AKIDEXAMPLE", secretAccessKey: KEYS.AKIDEXAMPLE, pathStyle: true, ...over })

try {
  // ---------- S3, two-way: two devices sharing a bucket
  const r = bucket()
  const A = device("A", { "Notes/Idea.md": "# Idea\n", "Notes/Plan.md": "plan from A\n", "Pictures/dot.png": Buffer.from([137, 80, 78, 71, 0, 1, 2, 255]),
    "Notes/Café menu.md": "accents\n", ".vaultite/cache/github.json": "{}", ".trash/Old.md": "old\n", ".vaultite/plugins/x/data.json": "{\"a\":1}" })
  let rep = await run(A, r)
  check("first sync: A's files go up", rep.up === 5 && !rep.errors.length && !rep.stopped, rep)
  check("first sync: under the folder in the bucket, the cache and the trash left out", [...s3.objects.keys()].sort().join() ===
    ["MyVault/.vaultite/plugins/x/data.json", "MyVault/Notes/Café menu.md", "MyVault/Notes/Idea.md", "MyVault/Notes/Plan.md", "MyVault/Pictures/dot.png"].join(), [...s3.objects.keys()])
  check("first sync: the bytes are the file's (a plain remote is the vault as it is)", s3.objects.get("MyVault/Pictures/dot.png")!.body.equals(fs.readFileSync(path.join(A.root, "Pictures/dot.png"))))
  check("listing: pages of the bucket are followed", s3.requests.filter((q) => q.includes("list-type=2")).length >= 1)
  rep = await run(A, r)
  check("again: nothing to do", rep.up + rep.down === 0 && rep.unchanged === 5, rep)

  const B = device("B", { "Notes/Idea.md": "# Idea\n", "Notes/Plan.md": "plan from B\n", "Notes/Only B.md": "b\n" })
  rep = await run(B, r)
  check("first sync elsewhere: the same file is adopted, B's own goes up, the rest comes down", rep.adopted === 1 && rep.up >= 2 && rep.down === 3, rep)
  check("first sync elsewhere: a file that differs is kept twice, never lost", rep.conflicts.length === 1 && read(B.root, "Notes/Plan.md") === "plan from B\n" &&
    read(B.root, `Notes/Plan (conflict ${DAY}).md`) === "plan from A\n", rep.conflicts)
  check("first sync elsewhere: never deletes", rep.deletedLocal === 0 && rep.deletedRemote === 0)
  rep = await run(A, r)
  check("two-way: A gets B's files and the conflict copy", rep.down === 3 && same(A.root, B.root), rep)

  // Edits on both, different files
  write(A.root, "Notes/Idea.md", "# Idea\nmore from A\n")
  write(B.root, "Notes/Only B.md", "b edited\n")
  await run(A, r)
  await run(B, r)
  rep = await run(A, r)
  check("two-way: edits on each side reach the other", read(B.root, "Notes/Idea.md").includes("more from A") && read(A.root, "Notes/Only B.md") === "b edited\n" && same(A.root, B.root), rep)

  // The same file changed on both: both versions kept, on both devices
  write(A.root, "Notes/Idea.md", "A's version\n")
  write(B.root, "Notes/Idea.md", "B's version\n")
  await run(A, r)
  rep = await run(B, r)
  check("conflict: this device's version keeps the name, the other is a dated copy", rep.conflicts.length === 1 && read(B.root, "Notes/Idea.md") === "B's version\n" &&
    read(B.root, `Notes/Idea (conflict ${DAY}).md`) === "A's version\n" && rep.conflicts[0].copy === `Notes/Idea (conflict ${DAY}).md`, rep)
  await run(A, r)
  check("conflict: the other device ends with both too", read(A.root, "Notes/Idea.md") === "B's version\n" && read(A.root, `Notes/Idea (conflict ${DAY}).md`) === "A's version\n" && same(A.root, B.root))
  write(A.root, "Notes/Plan.md", "again A\n")
  write(B.root, "Notes/Plan.md", "again B\n")
  await run(A, r)
  rep = await run(B, r)
  check("conflict: a second one the same day is numbered", has(B.root, `Notes/Plan (conflict ${DAY} 2).md`), rep.conflicts)
  await run(A, r)

  // Deletions follow only what was synced before
  fs.rmSync(path.join(A.root, "Notes/Only B.md"))
  rep = await run(A, r)
  check("deletion: a synced file deleted here is deleted there", rep.deletedRemote === 1 && !s3.objects.has("MyVault/Notes/Only B.md"), rep)
  rep = await run(B, r)
  check("deletion: and goes to the trash on the other device", rep.deletedLocal === 1 && !has(B.root, "Notes/Only B.md") && has(B.root, ".trash/Notes/Only B.md"), rep)
  write(A.root, "Notes/Café menu.md", "changed by A\n")
  fs.rmSync(path.join(B.root, "Notes/Café menu.md"))
  await run(B, r)
  rep = await run(A, r)
  check("deletion: a change wins over a deletion (it goes up again)", rep.up === 1 && s3.objects.has("MyVault/Notes/Café menu.md"), rep)
  await run(B, r)
  check("deletion: and comes back where it was deleted", read(B.root, "Notes/Café menu.md") === "changed by A\n" && same(A.root, B.root))

  // Many deletions at once wait
  for (let i = 0; i < 30; i++) write(A.root, `Bulk/n${i}.md`, `n${i}\n`)
  await run(A, r)
  await run(B, r)
  fs.rmSync(path.join(A.root, "Bulk"), { recursive: true })
  rep = await run(A, r)
  check("guard: a whole folder gone here (iCloud can do that) isn't deleted there", rep.held.length === 30 && rep.deletedRemote === 0 && s3.objects.has("MyVault/Bulk/n0.md"), rep)
  rep = await run(A, r, { dryRun: true, deletions: true })
  check("dry run: says what it would do, does nothing", rep.dryRun && rep.deletedRemote === 30 && s3.objects.has("MyVault/Bulk/n0.md"), rep)
  rep = await run(A, r, { deletions: true })
  check("guard: asked to, it deletes them", rep.deletedRemote === 30 && !s3.objects.has("MyVault/Bulk/n0.md"), rep)
  for (let i = 0; i < 25; i++) write(A.root, `More/m${i}.md`, `m${i}\n`)
  write(A.root, "More/keep.md", "k\n")
  await run(A, r)
  await run(B, r)
  for (let i = 0; i < 25; i++) fs.rmSync(path.join(A.root, `More/m${i}.md`))
  rep = await run(A, r)
  check("guard: more than max(20, a quarter) at once are held", rep.held.length === 25 && rep.deletedRemote === 0, rep)
  await run(A, r, { deletions: true })
  rep = await run(B, r)
  check("guard: many deletions coming down wait too", rep.held.length === 55 && rep.deletedLocal === 0 && has(B.root, "More/m0.md"), rep.held.length)
  rep = await run(B, r, { deletions: true })
  check("guard: asked to, they follow (to the trash)", rep.deletedLocal === 55 && has(B.root, ".trash/More/m0.md") && same(A.root, B.root), rep)

  // Skip globs
  const C = device("C", { "a.md": "a\n", "big.mp4": "video", "Archive/old.md": "x\n", "Notes/Archive/deep.md": "y\n", "Notes/b.md": "b\n" })
  const r2 = bucket("Skip/")
  rep = await run(C, r2, { skip: ["*.mp4", "Archive/"] })
  check("skip: patterns leave files and folders out, anywhere", [...s3.objects.keys()].filter((k) => k.startsWith("Skip/")).sort().join() === "Skip/Notes/b.md,Skip/a.md", [...s3.objects.keys()].filter((k) => k.startsWith("Skip/")))
  s3.objects.set("Skip/remote.mp4", { body: Buffer.from("v"), etag: "\"v\"" })
  rep = await run(C, r2, { skip: ["*.mp4", "Archive/"] })
  check("skip: a skipped file on the remote isn't pulled", !has(C.root, "remote.mp4") && rep.down === 0, rep)

  s3.objects.set("Skip/../escape.md", { body: Buffer.from("x"), etag: "\"x\"" })
  s3.objects.set("Skip/a/./b.md", { body: Buffer.from("x"), etag: "\"x\"" })
  rep = await run(C, r2, { skip: ["*.mp4", "Archive/"] })
  check("unsafe names on the remote never land outside the vault", !fs.existsSync(path.join(TMP, "escape.md")) && rep.skipped.filter((x) => x.why.includes("inside the vault")).length === 2, rep.skipped)

  // Push only and pull only
  const P = device("P", { "x.md": "x1\n", "y.md": "y1\n" })
  const r3 = bucket("Push/")
  await run(P, r3, { direction: "push" })
  s3.objects.set("Push/elsewhere.md", { body: Buffer.from("e\n"), etag: "\"e\"" })
  s3.objects.set("Push/y.md", { body: Buffer.from("y changed there\n"), etag: "\"y2\"" })
  write(P.root, "x.md", "x2\n")
  rep = await run(P, r3, { direction: "push" })
  check("push only: changes go up, nothing comes down", rep.up === 1 && rep.down === 0 && !has(P.root, "elsewhere.md") && read(P.root, "y.md") === "y1\n" &&
    s3.objects.get("Push/x.md")!.body.toString() === "x2\n", rep)
  write(P.root, "y.md", "y local\n")
  rep = await run(P, r3, { direction: "push" })
  check("push only: a file changed on both keeps the remote's beside ours, there", rep.conflicts.length === 1 && s3.objects.get("Push/y.md")!.body.toString() === "y local\n" &&
    s3.objects.get(`Push/y (conflict ${DAY}).md`)?.body.toString() === "y changed there\n" && !has(P.root, `y (conflict ${DAY}).md`), rep)
  s3.objects.delete("Push/x.md")
  rep = await run(P, r3, { direction: "push" })
  check("push only: the backup puts back what went missing there", rep.up === 1 && s3.objects.has("Push/x.md"), rep)

  const Q = device("Q", { "q.md": "mine\n" })
  const r4 = bucket("Pull/")
  s3.objects.set("Pull/q.md", { body: Buffer.from("theirs\n"), etag: "\"q1\"" })
  s3.objects.set("Pull/n.md", { body: Buffer.from("new\n"), etag: "\"n1\"" })
  rep = await run(Q, r4, { direction: "pull" })
  check("pull only: the remote's version keeps the name, this vault's is the copy", read(Q.root, "q.md") === "theirs\n" && read(Q.root, `q (conflict ${DAY}).md`) === "mine\n" &&
    read(Q.root, "n.md") === "new\n" && rep.up === 0 && !s3.objects.has(`Pull/q (conflict ${DAY}).md`), rep)
  write(Q.root, "local.md", "stays\n")
  s3.objects.delete("Pull/n.md")
  rep = await run(Q, r4, { direction: "pull" })
  check("pull only: local files never go up; a deletion there moves it to the trash here", !s3.objects.has("Pull/local.md") && !has(Q.root, "n.md") && has(Q.root, ".trash/n.md"), rep)

  // Encryption
  const E1 = device("E1", { "Secret/Plan.md": "the launch is on friday\n", "pic.png": Buffer.from([1, 2, 3, 4, 5]) })
  const info = newKeyInfo("correct horse battery staple")
  const enc = sealedCodec("correct horse battery staple", info)
  const r5 = bucket("Enc/")
  await r5.put(META, Buffer.from(JSON.stringify({ format: 1, encryption: info })))
  rep = await run(E1, r5, { codec: enc })
  const encKeys = [...s3.objects.keys()].filter((k) => k.startsWith("Enc/") && k !== `Enc/${META}`)
  check("encryption: names are hashed", rep.up === 2 && encKeys.length === 2 && encKeys.every((k) => sealedKey(k.slice(4))), encKeys)
  check("encryption: contents are sealed (no plain text there)", encKeys.every((k) => !s3.objects.get(k)!.body.toString("latin1").includes("friday")))
  const E2 = device("E2")
  rep = await run(E2, r5, { codec: sealedCodec("correct horse battery staple", info) })
  check("encryption: another device with the passphrase gets the files back", rep.down === 2 && same(E1.root, E2.root), rep)
  write(E2.root, "Secret/Plan.md", "moved to monday\n")
  await run(E2, r5, { codec: enc })
  rep = await run(E1, r5, { codec: enc })
  check("encryption: edits round-trip", read(E1.root, "Secret/Plan.md") === "moved to monday\n" && rep.down === 1, rep)
  let wrong = ""
  try { sealedCodec("wrong passphrase", info) } catch (e) { wrong = (e as Error).message }
  check("encryption: a wrong passphrase is refused", wrong.includes("isn't the one"), wrong)
  const k0 = encKeys[0]
  s3.objects.set(encKeys[1], { ...s3.objects.get(k0)! }) // (one object copied over another's name)
  const E3 = device("E3")
  rep = await run(E3, r5, { codec: enc })
  check("encryption: an object under another's name is refused", rep.skipped.some((s) => s.why.includes("don't match")), rep.skipped)

  // An interrupted sync resumes where it stopped
  const I = device("I", Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Log/${i}.md`, `entry ${i}\n`])))
  const r6 = bucket("Int/")
  s3.failAfter = 4
  rep = await run(I, r6)
  s3.failAfter = null
  check("interrupted: it stops when the remote stops answering, keeping what it did", !!rep.stopped && rep.up >= 1 && rep.up < 12 && Object.keys(I.state.files).length === rep.up, rep)
  rep = await run(I, r6)
  check("interrupted: the next sync does the rest, nothing twice, no conflicts", !rep.stopped && rep.conflicts.length === 0 &&
    [...s3.objects.keys()].filter((k) => k.startsWith("Int/")).length === 12 && Object.keys(I.state.files).length === 12, rep)

  // A write here that raced the sync: the local file changed after it was scanned
  const W = device("W", { "w.md": "one\n" })
  const loc = fsLocal(W.root)
  const scanned = (await loc.scan(skipper([]))).files.get("w.md")!
  write(W.root, "w.md", "two, typed meanwhile\n")
  check("race: a pull doesn't overwrite a file changed since the scan", (await loc.write("w.md", Buffer.from("remote\n"), scanned)) === null && read(W.root, "w.md") === "two, typed meanwhile\n")

  // Bad keys say so
  let bad = ""
  try { await bucket("MyVault/", { secretAccessKey: "nope" }).list() } catch (e) { bad = (e as Error).message }
  check("s3: a wrong secret is refused by the service, said plainly", bad.includes("refused the keys") && bad.includes("SignatureDoesNotMatch"), bad)

  // ---------- WebDAV
  const dav = await fakeWebdav("alice", "app-password")
  fakes.push(dav)
  const w = webdavRemote({ url: `${dav.url}/dav/`, username: "alice", password: "app-password" })
  const D1 = device("D1", { "Notes/One.md": "1\n", "Notes/Deep/Two.md": "2\n", "With space & more.md": "3\n" })
  const D2 = device("D2", { "Notes/One.md": "other\n" })
  rep = await run(D1, w)
  check("webdav: first sync makes folders and puts files", rep.up === 3 && dav.objects.has("Notes/Deep/Two.md") && dav.objects.has("With space & more.md"), rep)
  rep = await run(D2, w)
  check("webdav: another device gets them, a differing file kept twice", rep.down === 2 && rep.conflicts.length === 1 && has(D2.root, `Notes/One (conflict ${DAY}).md`), rep)
  await run(D1, w)
  fs.rmSync(path.join(D1.root, "Notes/Deep/Two.md"))
  write(D1.root, "With space & more.md", "edited\n")
  await run(D1, w)
  rep = await run(D2, w)
  check("webdav: edits and deletions follow", read(D2.root, "With space & more.md") === "edited\n" && !has(D2.root, "Notes/Deep/Two.md") && same(D1.root, D2.root), rep)
  let davBad = ""
  try { await webdavRemote({ url: `${dav.url}/dav/`, username: "alice", password: "wrong" }).list() } catch (e) { davBad = (e as Error).message }
  check("webdav: a wrong password is said plainly", davBad.includes("refused the keys"), davBad)
} catch (e) {
  check(`no exception: ${(e as Error).stack}`, false)
}

// ---------- the plugin on a throwaway server
const app = await serve(["remote-save"])
// (vau runs apart from this process, which answers as the fake services meanwhile)
const vau = async (...a: string[]) => (await promisify(execFile)(process.execPath, [path.join(APP, "bin", "vau"), "--url", app.base, ...a],
  { encoding: "utf8", env: { ...ENV, VAULTITE_URL: app.base } })).stdout
const LOCAL = path.join(path.dirname(app.vault), "local")
try {
  app.write("Notes/Hello.md", "# Hello\n\nFrom the sandbox.\n")
  const form = { name: "Test bucket", type: "s3", direction: "two-way", every: "1h", connection: { endpoint: s3.url, region: "auto", bucket: "vault", prefix: "Server/",
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: KEYS.AKIDEXAMPLE } }
  let [st, body] = await app.api("POST", "remote-save/test", { ...form, connection: { ...form.connection, secretAccessKey: "nope" } })
  check("test connection: wrong keys say so", st === 200 && body.ok === false && /refused the keys/.test(body.message), body)
  ;[st, body] = await app.api("POST", "remote-save/test", form)
  check("test connection: it lists, writes, reads and deletes", st === 200 && body.ok === true && /Writing works/.test(body.message) && ![...s3.objects.keys()].some((k) => k.includes("remote-save-test")), body)
  ;[st, body] = await app.api("POST", "remote-save/remotes", form)
  check("add a remote", st === 200 && body.id === "test-bucket" && body.here && body.connection?.secret === true && !("secretAccessKey" in body.connection), body)
  const settings = app.read(".vaultite/plugins/remote-save/data.json")
  check("the vault keeps how it syncs, never how to reach it", settings.includes("Test bucket") && !settings.includes(KEYS.AKIDEXAMPLE) && !settings.includes("AKIDEXAMPLE") && !settings.includes(s3.url), settings)
  const secrets = JSON.parse(fs.readFileSync(path.join(LOCAL, "config.json"), "utf8"))
  check("its keys are in this machine's data/config.json, readable by its user only", secrets["remote-save"]?.["test-bucket"]?.secretAccessKey === KEYS.AKIDEXAMPLE &&
    (fs.statSync(path.join(LOCAL, "config.json")).mode & 0o077) === 0, secrets)
  ;[st, body] = await app.api("POST", "ops/schedule.list", {})
  check("its schedule: a job on the server", st === 200 && body.some((j: { id: string; every: string }) => j.id === "remote-save/sync-test-bucket" && j.every === "1h"), body)

  let out = await vau("remote-save", "sync")
  check("vau remote-save sync: says what went up", /Test bucket\*\*: \d+ up/.test(out) && s3.objects.has("Server/Notes/Hello.md") && !s3.objects.has("Server/.vaultite/cache"), out)
  s3.objects.set("Server/Notes/From phone.md", { body: Buffer.from("# From phone\n"), etag: "\"p1\"" })
  out = await vau("remote-save", "sync")
  check("a file from elsewhere comes down into the vault", /1 down/.test(out) && app.read("Notes/From phone.md").includes("From phone"), out)
  const stateDir = fs.readdirSync(path.join(LOCAL, "remote-save")).map((d) => path.join(LOCAL, "remote-save", d)).find((d) => fs.existsSync(path.join(d, "test-bucket.state.json")))
  check("what was synced is kept on this machine, not in the vault", !!stateDir && !fs.readdirSync(app.vault, { recursive: true }).some((f) => String(f).includes("state.json")))

  app.write("Notes/Hello.md", "# Hello\n\nEdited in the vault.\n")
  s3.objects.set("Server/Notes/Hello.md", { body: Buffer.from("# Hello\n\nEdited on the phone.\n"), etag: "\"h2\"" })
  out = await vau("remote-save", "sync")
  const inbox = fs.readdirSync(path.join(app.vault, "Inbox")).filter((f) => f.includes("kept both"))
  check("a conflict keeps both and says so in the inbox", /kept both: Notes\/Hello\.md/.test(out) && app.read(`Notes/Hello (conflict ${localDay()}).md`).includes("phone") && inbox.length === 1, [out, inbox])
  out = await vau("remote-save", "status")
  check("vau remote-save status: how it syncs and how it went", /\*\*Test bucket\*\* \(S3, two-way, every hour\): synced/.test(out) && /conflict/.test(out), out)
  ;[st, body] = await app.api("GET", `render?path=${encodeURIComponent("Dashboards/Remote.md")}`)
  app.write("Dashboards/Remote.md", "# Remote\n\n```block-remote-save\n```\n")
  out = await vau("render", "Dashboards/Remote.md")
  check("the block as text", out.includes("Test bucket") && out.includes("synced"), out)
  ;[st, body] = await app.api("POST", "remote-save/remotes", { ...form, id: "test-bucket", every: "", connection: { ...form.connection, secretAccessKey: "" } })
  const kept = JSON.parse(fs.readFileSync(path.join(LOCAL, "config.json"), "utf8"))["remote-save"]["test-bucket"].secretAccessKey
  ;[, body] = await app.api("POST", "ops/schedule.list", {})
  check("saved again with the secret blank: it's kept, and no schedule is no job", st === 200 && kept === KEYS.AKIDEXAMPLE && !body.some((j: { id: string }) => j.id.startsWith("remote-save/")), body)
  ;[st, body] = await app.api("POST", "remote-save/remotes", { ...form, name: "Locked", encrypt: true, connection: { ...form.connection, prefix: "ServerEnc/" } })
  check("encryption needs a passphrase", st === 400 && /passphrase/.test(JSON.stringify(body)), body)
  ;[st, body] = await app.api("POST", "remote-save/remotes", { ...form, name: "Locked", encrypt: true, connection: { ...form.connection, prefix: "ServerEnc/", passphrase: "a long passphrase" } })
  out = await vau("remote-save", "sync", "Locked")
  check("an encrypted remote from the server", /Locked\*\*: \d+ up/.test(out) && s3.objects.has(`ServerEnc/${META}`) && ![...s3.objects.keys()].some((k) => k.startsWith("ServerEnc/Notes")), out)
  ;[st, body] = await app.api("DELETE", "remote-save/remotes/locked")
  check("remove a remote: its keys go from this machine", st === 200 && !JSON.parse(fs.readFileSync(path.join(LOCAL, "config.json"), "utf8"))["remote-save"].locked)
  const stranger = await fetch(`${app.base}api/remote-save/remotes`, { method: "POST", headers: { "content-type": "application/json", "tailscale-user-login": "stranger@example.com" }, body: JSON.stringify(form) })
  check("only this machine's owner may set a remote's keys", stranger.status === 403, stranger.status)
} catch (e) {
  check(`server: no exception: ${(e as Error).stack}`, false)
} finally {
  app.stop()
  for (const f of fakes) await f.close()
  fs.rmSync(TMP, { recursive: true, force: true })
}

function localDay() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
done()
