// What the server and the app share: a sync's report and a remote as the app sees it (no Node here: the app imports it).

export type Direction = "two-way" | "push" | "pull"
export type Kind = "s3" | "webdav"

export type Conflict = { path: string; copy: string; kept: "here" | "remote" }
export type Report = {
  up: number; down: number; deletedRemote: number; deletedLocal: number; adopted: number; unchanged: number
  conflicts: Conflict[]
  /** Deletions not made: too many at once, or under a folder gone from here (iCloud), until asked with deletions. */
  held: string[]
  /** Files left for the next sync (changed while syncing), with why. */
  skipped: { path: string; why: string }[]
  errors: { path: string; error: string }[]
  /** Files iCloud hasn't downloaded here yet: left alone. */
  waiting: number
  /** Why it stopped before the end (the remote stopped answering), or null. */
  stopped: string | null
  dryRun: boolean
}

/** A sync as it ended. */
export type Run = { at: string; ms: number; ok: boolean; error: string | null; by: string; report: Report | null }

/** A remote as the vault's settings keep it (.vaultite/plugins/remote-save/data.json: `remotes`). */
export type RemoteSettings = { id: string; name: string; type: Kind; direction: Direction; every: string; skip: string[]; encrypt: boolean; machine: string | null }

/** A remote as GET /api/remote-save shows it: its connection only to this machine's owner, never its secrets. */
export type RemoteView = RemoteSettings & {
  /** Its connection is on this machine (so it syncs here). */
  here: boolean
  running: boolean
  last: Run | null
  lastOk: string | null
  connection: { endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean; accessKeyId: string; url: string; username: string
    /** Whether its secret key or password, and its passphrase, are saved (never what they are). */
    secret: boolean; passphrase: boolean } | null
}

export const SCHEDULES = ["", "15m", "1h", "6h", "1d"]
export const DEFAULT_SKIP = [".vaultite/cache/", ".trash/"]
