// The sync itself, between a folder and a remote, against what both were when they last agreed (the state, kept on
// this machine). Each side is new, the same, changed or deleted since; the direction says what follows from that.
// Never loses a version: a file changed on both sides is kept twice, deletions only follow files synced before.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type Codec, META, sealedKey } from "./codec.ts"
import { Changed, type Remote, RemoteError, type RemoteFile } from "./remote.ts"
import type { Direction, Report } from "./types.ts"

/** A file as both sides last agreed: its content's hash, its size and mtime here, its key and etag there. */
export type FileState = { h: string; s: number; m: number; k: string; e: string }
export type State = { fingerprint: string; files: Record<string, FileState> }
export type Stat = { size: number; mtime: number; real: string }

/** The vault's folder as the sync sees it. Writes check the file is still what was scanned, or don't happen. */
export interface Local {
  scan(skip: (rel: string) => boolean): Promise<{ files: Map<string, Stat>; waiting: Set<string>; tops: Set<string> }>
  read(rel: string, real: string): Promise<{ bytes: Buffer; stat: Stat }>
  /** Write a file if it's still `expect` (null: not there): its stat after, or null when it changed meanwhile. */
  write(rel: string, bytes: Buffer, expect: Stat | null): Promise<Stat | null>
  /** Move a file to the trash if it's still `expect`: false when it changed meanwhile. */
  trash(rel: string, expect: Stat): Promise<boolean>
}

const hashOf = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex")
const sameStat = (a: Stat | null | undefined, b: { s: number; m: number } | Stat | null | undefined) =>
  !!a && !!b && a.size === ("s" in b ? b.s : b.size) && a.mtime === ("m" in b ? b.m : b.mtime)

const stemExt = (rel: string): [string, string] => {
  const slash = rel.lastIndexOf("/"), dot = rel.slice(slash + 1).lastIndexOf(".")
  return dot > 0 ? [rel.slice(0, slash + 1 + dot), rel.slice(slash + 1 + dot)] : [rel, ""]
}

/** `name (conflict 2026-10-06).md`, numbered when that's taken. */
export function conflictName(rel: string, day: string, taken: (rel: string) => boolean) {
  const [stem, ext] = stemExt(rel)
  for (let n = 1; ; n++) {
    const copy = `${stem} (conflict ${day}${n > 1 ? ` ${n}` : ""})${ext}`
    if (!taken(copy)) return copy
  }
}

/** A remote's name for a file that stays inside the vault: no "..", no absolute path, no empty or odd parts. */
const safe = (p: string) => !!p && !p.startsWith("/") && !/[\\\0]/.test(p) && p.split("/").every((x) => x && x !== "." && x !== "..")

type LocalSide = "same" | "changed" | "new" | "deleted" | "absent"
type RemoteSide = "same" | "changed" | "new" | "deleted" | "absent"
type Task = { path: string; action: "push" | "pull" | "reconcile" | "delete-remote" | "delete-local" | "forget"
  l: Stat | null; r: (RemoteFile & { path: string }) | null; s: FileState | undefined }

/** What a direction does with a file, from how each side changed since they last agreed. */
function decide(dir: Direction, L: LocalSide, R: RemoteSide): Task["action"] | null {
  const lc = L === "changed" || L === "new", rc = R === "changed" || R === "new"
  const lgone = L === "deleted" || L === "absent", rgone = R === "deleted" || R === "absent"
  if (lgone && rgone) return "forget"
  if (lc && rc) return "reconcile"
  if (dir === "two-way") {
    if (lc) return "push" // (over a remote that's the same, gone, or deleted: a change wins over a deletion)
    if (rc) return "pull"
    if (L === "same" && R === "deleted") return "delete-local"
    if (L === "deleted" && R === "same") return "delete-remote"
    return null
  }
  if (dir === "push") {
    if (lc || (L === "same" && R === "deleted")) return "push" // (the backup puts back what went missing)
    if (L === "deleted" && R === "same") return "delete-remote"
    if (L === "deleted" && R === "changed") return "forget" // (someone else's newer version stays there)
    return null
  }
  if (rc) return "pull"
  if (L === "same" && R === "deleted") return "delete-local"
  if (L === "changed" && R === "deleted") return "forget"
  return null
}

export type SyncOptions = {
  remote: Remote; codec: Codec; local: Local; state: State; save: (s: State) => void
  direction: Direction; skip: (rel: string) => boolean
  /** Make deletions however many there are (else more than max(20, a quarter of the files) wait). */
  deletions?: boolean
  /** Say what it would do, doing nothing. */
  dryRun?: boolean
  /** Today, for conflict copies' names (YYYY-MM-DD, this machine's day). */
  day: string
  concurrency?: number
  signal?: AbortSignal
}

export async function sync(o: SyncOptions): Promise<Report> {
  const rep: Report = { up: 0, down: 0, deletedRemote: 0, deletedLocal: 0, adopted: 0, unchanged: 0, conflicts: [], held: [], skipped: [], errors: [],
    waiting: 0, stopped: null, dryRun: !!o.dryRun }
  const files = o.state.files
  const nfc = (p: string) => p.normalize("NFC")

  // The remote's files by vault path. An encrypted remote's names say nothing: known ones from the state, the rest opened.
  const byKey = new Map(Object.entries(files).map(([p, s]) => [s.k, p]))
  const remote = new Map<string, RemoteFile & { path: string }>()
  const opened = new Map<string, Buffer>() // (opened to learn their names: kept for the pull, up to 64 MB in all)
  let kept = 0
  for (const f of await o.remote.list()) {
    if (f.key === META || (o.codec.encrypted && !sealedKey(f.key))) continue
    let p = o.codec.pathOf(f.key) ?? byKey.get(f.key) ?? null
    if (p === null) {
      try {
        const got = o.codec.open(f.key, await o.remote.get(f.key))
        p = got.rel
        if ((kept += got.bytes.length) < 64 << 20) opened.set(nfc(p), got.bytes)
      } catch (e) {
        if (e instanceof RemoteError && e.status === 0) throw e
        rep.skipped.push({ path: f.key, why: `can't be read: ${(e as Error).message}` })
        continue
      }
    }
    p = nfc(p)
    if (!safe(p)) { rep.skipped.push({ path: p, why: "isn't a path inside the vault" }); continue }
    if (!o.skip(p)) remote.set(p, { ...f, path: p })
  }

  const { files: here, waiting, tops } = await o.local.scan(o.skip)
  if (!here.size && Object.keys(files).length) throw new Error("the vault's folder is empty here: not syncing (is it there?)")

  const tasks: Task[] = []
  const paths = new Set([...here.keys(), ...remote.keys(), ...Object.keys(files).filter((p) => !o.skip(p))])
  for (const p of [...paths].sort()) {
    if (waiting.has(p)) { rep.waiting++; continue }
    const s = files[p], l = here.get(p) ?? null, r = remote.get(p) ?? null
    let L: LocalSide = !l ? (s ? "deleted" : "absent") : !s ? "new" : sameStat(l, s) ? "same" : "changed"
    if (L === "changed") {
      // Touched but the same (a copy back, a save without changes): only its stat is new.
      const { bytes, stat } = await o.local.read(p, l!.real)
      if (hashOf(bytes) === s!.h) { L = "same"; if (!o.dryRun) { s!.s = stat.size; s!.m = stat.mtime } }
    }
    const R: RemoteSide = !r ? (s ? "deleted" : "absent") : !s ? "new" : r.key === s.k && !!r.etag && r.etag === s.e ? "same" : "changed"
    const action = decide(o.direction, L, R)
    if (action) tasks.push({ path: p, action, l, r, s })
    else rep.unchanged++
  }

  // Deletions wait when there are many, or when a whole top folder is gone from here (iCloud can take one away).
  const deletes = tasks.filter((t) => t.action === "delete-remote" || t.action === "delete-local")
  const gone = (t: Task) => t.action === "delete-remote" && t.path.includes("/") && !tops.has(t.path.slice(0, t.path.indexOf("/")))
  const many = deletes.length > Math.max(20, Object.keys(files).length / 4)
  const held = new Set(o.deletions ? [] : deletes.filter((t) => many || gone(t)))
  rep.held = [...held].map((t) => t.path)

  const taken = (p: string) => here.has(p) || remote.has(p)
  let done = 0, lastSave = Date.now()
  const saveSoon = () => {
    if (++done % 25 === 0 || Date.now() - lastSave > 5000) { o.save(o.state); lastSave = Date.now() }
  }
  const record = (p: string, h: string, st: Stat, key: string, etag: string | null) => { files[p] = { h, s: st.size, m: st.mtime, k: key, e: etag ?? "" } }
  const theirsOf = async (t: Task) => opened.get(t.path) ?? o.codec.open(t.r!.key, await o.remote.get(t.r!.key)).bytes

  async function push(t: Task) {
    const { bytes, stat } = await o.local.read(t.path, t.l!.real)
    const key = o.codec.keyOf(t.path)
    const cond = t.r && t.r.key === key ? { ifMatch: t.r.etag || undefined } : { ifNoneMatch: true }
    const etag = await o.remote.put(key, o.codec.seal(t.path, bytes), cond)
    record(t.path, hashOf(bytes), stat, key, etag)
    rep.up++
  }

  async function pull(t: Task, bytes?: Buffer) {
    bytes ??= await theirsOf(t)
    const h = hashOf(bytes)
    if (t.s && h === t.s.h && t.l && sameStat(t.l, t.s)) { t.s.e = t.r!.etag; t.s.k = t.r!.key; rep.adopted++; return } // (the same content, a new etag)
    const st = await o.local.write(t.path, bytes, t.l)
    if (!st) return void rep.skipped.push({ path: t.path, why: "changed here while syncing" })
    record(t.path, h, st, t.r!.key, t.r!.etag)
    rep.down++
  }

  async function reconcile(t: Task) {
    const theirs = await theirsOf(t)
    const { bytes: ours, stat } = await o.local.read(t.path, t.l!.real)
    if (hashOf(theirs) === hashOf(ours)) { record(t.path, hashOf(ours), stat, t.r!.key, t.r!.etag); rep.adopted++; return }
    const other = o.direction === "pull" ? ours : theirs
    // A copy already made of this very version (a sync stopped halfway) is used again, not made twice.
    const again = await madeBefore(t.path, other)
    if (again && o.direction !== "push") {
      if (o.direction === "pull") await pull(t, theirs)
      else await push(t)
      return
    }
    const copy = conflictName(t.path, o.day, taken)
    if (o.direction === "push") {
      // The backup keeps the remote's version beside ours, there.
      const ck = o.codec.keyOf(copy)
      remote.set(copy, { key: ck, etag: "", size: theirs.length, path: copy })
      await o.remote.put(ck, o.codec.seal(copy, theirs), { ifNoneMatch: true })
      await push(t)
      rep.conflicts.push({ path: t.path, copy, kept: "here" })
      return
    }
    // Here: the copy is the other version (the remote's when ours keeps the name; ours when following the remote).
    here.set(copy, { size: 0, mtime: 0, real: copy })
    const st = await o.local.write(copy, o.direction === "pull" ? ours : theirs, null)
    if (!st) return void rep.skipped.push({ path: t.path, why: `${copy} appeared while syncing` })
    if (o.direction === "pull") {
      const wrote = await o.local.write(t.path, theirs, stat)
      if (!wrote) return void rep.skipped.push({ path: t.path, why: "changed here while syncing" })
      record(t.path, hashOf(theirs), wrote, t.r!.key, t.r!.etag)
      rep.down++
    } else {
      const ck = o.codec.keyOf(copy)
      const etag = await o.remote.put(ck, o.codec.seal(copy, theirs), { ifNoneMatch: true })
      record(copy, hashOf(theirs), st, ck, etag)
      await push(t)
    }
    rep.conflicts.push({ path: t.path, copy, kept: o.direction === "pull" ? "remote" : "here" })
  }

  async function madeBefore(p: string, bytes: Buffer) {
    const h = hashOf(bytes), [stem] = stemExt(p)
    for (const [c, st] of here) {
      if (!c.startsWith(`${stem} (conflict `) || st.mtime === 0) continue
      try { if (hashOf((await o.local.read(c, st.real)).bytes) === h) return c } catch { /* (gone) */ }
    }
    return null
  }

  async function run(t: Task) {
    if (held.has(t)) return
    if (t.action === "forget") { delete files[t.path]; return }
    if (t.action === "push") await push(t)
    else if (t.action === "pull") await pull(t)
    else if (t.action === "reconcile") await reconcile(t)
    else if (t.action === "delete-remote") {
      await o.remote.del(t.r!.key, { ifMatch: t.r!.etag || undefined })
      delete files[t.path]
      rep.deletedRemote++
    } else if (t.action === "delete-local") {
      if (!(await o.local.trash(t.path, t.l!))) return void rep.skipped.push({ path: t.path, why: "changed here while syncing" })
      delete files[t.path]
      rep.deletedLocal++
    }
  }

  if (o.dryRun) {
    for (const t of tasks) {
      if (held.has(t)) continue
      if (t.action === "push") rep.up++
      else if (t.action === "pull") rep.down++
      else if (t.action === "delete-remote") rep.deletedRemote++
      else if (t.action === "delete-local") rep.deletedLocal++
      else if (t.action === "reconcile") rep.conflicts.push({ path: t.path, copy: "", kept: o.direction === "pull" ? "remote" : "here" })
    }
    return rep
  }

  const queue = [...tasks]
  const worker = async () => {
    for (let t = queue.shift(); t && !rep.stopped; t = queue.shift()) {
      if (o.signal?.aborted) { rep.stopped = "stopped before the end"; break }
      try {
        await run(t)
      } catch (e) {
        if (e instanceof Changed) rep.skipped.push({ path: t.path, why: e.message })
        else if (e instanceof RemoteError && e.status === 0) rep.stopped = e.message // (the remote is gone: the rest would fail too)
        else rep.errors.push({ path: t.path, error: (e as Error).message ?? String(e) })
      }
      saveSoon()
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker))
  o.save(o.state)
  return rep
}

// ---------- the vault's folder on this machine

/** `root` as a Local: `lock` runs each write with the vault to itself, `trash` moves a file to the vault's trash. */
export function fsLocal(root: string, o: { lock?: <T>(fn: () => Promise<T>) => Promise<T>; trash?: (rel: string) => void } = {}): Local {
  const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn())
  const abs = (rel: string) => path.join(root, rel)
  const statOf = (rel: string): Stat | null => {
    try {
      const st = fs.statSync(abs(rel))
      return st.isFile() ? { size: st.size, mtime: st.mtimeMs, real: rel } : null
    } catch { return null }
  }
  let n = 0
  return {
    async scan(skip) {
      const files = new Map<string, Stat>(), waiting = new Set<string>(), tops = new Set<string>()
      const walk = async (dir: string) => {
        let list: fs.Dirent[]
        try { list = await fs.promises.readdir(abs(dir), { withFileTypes: true }) } catch { return }
        for (const d of list) {
          const rel = dir ? `${dir}/${d.name}` : d.name
          const ph = /^\.(.+)\.icloud$/.exec(d.name)
          if (ph && d.isFile()) { waiting.add(`${dir ? `${dir}/` : ""}${ph[1]}`.normalize("NFC")); continue }
          if (d.isDirectory()) {
            if (!dir) tops.add(d.name.normalize("NFC"))
            if (!skip(`${rel}/`)) await walk(rel)
          } else if (d.isFile() && !skip(rel.normalize("NFC"))) {
            const st = await fs.promises.stat(abs(rel)).catch(() => null)
            if (st?.isFile()) files.set(rel.normalize("NFC"), { size: st.size, mtime: st.mtimeMs, real: rel })
          }
        }
      }
      await walk("")
      return { files, waiting, tops }
    },
    async read(_rel, real) {
      for (let i = 0; i < 3; i++) {
        const before = statOf(real)
        if (!before) throw new Changed("gone from here while syncing")
        const bytes = await fs.promises.readFile(abs(real))
        const after = statOf(real)
        if (sameStat(before, after) && bytes.length === before.size) return { bytes, stat: before }
      }
      throw new Changed("changed here while syncing")
    },
    write(rel, bytes, expect) {
      return lock(async () => {
        const real = expect?.real ?? rel
        const now = statOf(real)
        if (expect ? !sameStat(now, expect) : now !== null || fs.existsSync(abs(real))) return null
        const target = abs(real), tmp = `${target}.tmp-${process.pid}-${++n}`
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        // (a folder here that links elsewhere isn't followed out of the vault)
        const top = await fs.promises.realpath(root), dir = await fs.promises.realpath(path.dirname(target))
        if (dir !== top && !dir.startsWith(top + path.sep)) throw new Error("its folder here links outside the vault")
        try {
          await fs.promises.writeFile(tmp, bytes)
          await fs.promises.rename(tmp, target)
        } catch (e) {
          await fs.promises.rm(tmp, { force: true })
          throw e
        }
        return statOf(real)
      })
    },
    trash(rel, expect) {
      return lock(async () => {
        if (!sameStat(statOf(expect.real), expect)) return false
        if (o.trash) o.trash(expect.real)
        else {
          const to = abs(`.trash/${expect.real}`)
          await fs.promises.mkdir(path.dirname(to), { recursive: true })
          await fs.promises.rename(abs(expect.real), to)
        }
        void rel
        return true
      })
    },
  }
}
