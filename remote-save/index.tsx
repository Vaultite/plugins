// Remote save's app side: its settings sheet (the remotes, each in a sheet of its own to add or change), the block
// with each remote's last sync, a status bar item, and Sync now. The sync itself runs on the server (plugin.ts).
import { useEffect, useState, type ReactNode } from "react"
import { AlertCircle, CheckCircle2, Cloud, CloudOff, Plus, RefreshCw } from "lucide-react"
import {
  AmbientButton, backDetail, cn, confirmDialog, definePlugin, del, detailPath, Empty, fmtAgo, Group, List, Loading, notify, notifyError, op,
  openDetail, openPluginSettings, Panel, post, replaceDetail, Section, Segmented, SettingField, SettingRow, SheetHead, useLive, type SettingDecl,
} from "@vaultite"
import { DEFAULT_SKIP, SCHEDULES, type Direction, type Kind, type RemoteView, type Report, type Run } from "./types"

const TINT = "var(--remote-save)"
type Remotes = { remotes: RemoteView[] }

// What a sync or a save changed isn't a vault file, so useLive wouldn't hear of it: every view asks again (a new version).
let generation = 0
const views = new Set<() => void>()
function refresh() {
  generation++
  for (const f of views) f()
}
/** A remote just saved, until the list brings it (its sheet opens on it at once); and each one's name, for its sheet's title. */
const recent = new Map<string, RemoteView>()
const names = new Map<string, string>()

/** The remotes, asked again every 30 s, every 1.5 s while one syncs, and after anything here changes them. */
function useRemotes() {
  const [tick, setTick] = useState(0)
  const live = useLive<Remotes>("remote-save", `${generation}.${tick}`)
  const busy = !!live.data?.remotes.some((r) => r.running)
  for (const r of live.data?.remotes ?? []) names.set(r.id, r.name)
  useEffect(() => {
    const again = () => setTick((n) => n + 1)
    views.add(again)
    const t = setInterval(again, busy ? 1500 : 30000)
    return () => { clearInterval(t); views.delete(again) }
  }, [busy])
  return { ...live, reload: refresh }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/** A sync's result in a few words: "3 up, 1 down", "Up to date". */
function resultText(rep: Report | null) {
  if (!rep) return ""
  const parts = [rep.up && `${rep.up} up`, rep.down && `${rep.down} down`, rep.deletedRemote + rep.deletedLocal && `${rep.deletedRemote + rep.deletedLocal} deleted`,
    rep.conflicts.length && `${plural(rep.conflicts.length, "conflict")} kept both`, rep.held.length && `${plural(rep.held.length, "deletion")} held`,
    rep.skipped.length && `${rep.skipped.length} for next time`].filter(Boolean)
  return parts.length ? parts.join(", ") : "Up to date"
}

const KIND_TEXT: Record<Kind, string> = { s3: "S3", webdav: "WebDAV" }
const DIRECTION_TEXT: Record<Direction, string> = { "two-way": "Two-way", push: "Push only", pull: "Pull only" }

/** Where a remote is: syncing, its last sync, or why it doesn't sync here. */
function statusOf(r: RemoteView, syncing = false): { text: string; bad: boolean } {
  if (r.running || syncing) return { text: "Syncing…", bad: false }
  if (!r.here) return { text: `Its connection is on ${r.machine ?? "another machine"}`, bad: false }
  if (!r.last) return { text: "Never synced", bad: false }
  if (!r.last.ok) return { text: `Failed ${fmtAgo(r.last.at)}: ${r.last.error}`, bad: true }
  return { text: `Synced ${fmtAgo(r.last.at)} · ${resultText(r.last.report)}`, bad: false }
}

/** Sync one remote now: the toast says how it went. */
async function syncNow(r: RemoteView, deletions = false) {
  setTimeout(refresh, 300) // (shows it syncing)
  try {
    const [run] = await op<Run[]>("remote-save.sync", { remote: r.id, ...(deletions ? { deletions: true } : {}) })
    if (run.ok) notify(`${r.name}: ${resultText(run.report)}`)
    else notifyError(new Error(run.error ?? "it failed"), `${r.name} didn't sync`)
  } catch (e) { notifyError(e, "Couldn't sync") }
  refresh()
}

const iconButton = "grid size-8 shrink-0 cursor-pointer place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-50 max-md:size-11"

function SyncButton({ r, onDone }: { r: RemoteView; onDone?: () => void }) {
  const [busy, setBusy] = useState(false)
  if (!r.here) return null
  const spin = busy || r.running
  return (
    <button type="button" disabled={spin} aria-label={`Sync ${r.name} now`} data-tip="Sync now" data-remote-sync={r.id} className={iconButton}
      onClick={async (e) => { e.stopPropagation(); setBusy(true); try { await syncNow(r) } finally { setBusy(false); onDone?.() } }}>
      <RefreshCw className={cn("size-4", spin && "animate-spin")} strokeWidth={2} />
    </button>
  )
}

// ---------- the block

function RemotesBlock({ only }: { only?: string }) {
  const { data, error, reload } = useRemotes()
  if (!data) return <Panel title="Remote save" icon={Cloud} tint={TINT}><Loading error={error && "Couldn't ask the server how the syncs went."} /></Panel>
  const list = data.remotes.filter((r) => !only || r.id === only || r.name.toLowerCase() === only.toLowerCase())
  return (
    <Panel title="Remote save" icon={Cloud} tint={TINT}>
      {!list.length ? (
        <Empty>
          No remotes yet.{" "}
          <button type="button" className="cursor-pointer font-semibold text-primary" onClick={() => openPluginSettings("remote-save")}>Add one</button> to sync or back up
          this vault with a bucket or a WebDAV folder you own.
        </Empty>
      ) : (
        <div data-remote-save-block><List>
          {list.map((r) => {
            const st = statusOf(r)
            return (
              <div key={r.id} className="flex min-h-11 items-center gap-3 py-2" data-remote-row={r.id}>
                {st.bad ? <CloudOff className="size-4 shrink-0 text-[var(--red)]" strokeWidth={2} /> : <Cloud className="size-4 shrink-0" style={{ color: TINT }} strokeWidth={2} />}
                <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => openDetail(detailPath("remote-save", r.id))}>
                  <div className="truncate text-[15px] leading-[20px]">{r.name}</div>
                  <div className={cn("text-[13px] max-md:line-clamp-2 md:truncate", st.bad ? "text-[var(--red)]" : "text-muted-foreground")} data-remote-status>{st.text}</div>
                </button>
                <SyncButton r={r} onDone={reload} />
              </div>
            )
          })}
        </List></div>
      )}
    </Panel>
  )
}

// ---------- the settings sheet: the remotes

function SettingsPanel() {
  const { data } = useRemotes()
  return (
    <div className="space-y-1.5" data-remote-save-settings>
      <Section title="Remotes">
        <Group>
          {data?.remotes.map((r) => (
            <SettingRow key={r.id} label={r.name} sub={`${KIND_TEXT[r.type]} · ${DIRECTION_TEXT[r.direction]} · ${statusOf(r).text}`}
              onClick={() => openDetail(detailPath("remote-save", r.id))} data-remote-setting={r.id} />
          ))}
          <SettingRow label="Add a remote" sub="An S3-compatible bucket or a WebDAV folder" onClick={() => openDetail(detailPath("remote-save", "new"))} chevron={Plus} data-remote-add />
        </Group>
      </Section>
      <p className="px-1 text-[13px] leading-[18px] text-muted-foreground">
        A remote's address, keys and passphrase stay on the machine you add it on (in data/config.json there, never in the vault), and it
        syncs from that machine. What was synced is kept there too; the vault only says which remotes there are and how they sync.
      </p>
    </div>
  )
}

// ---------- a remote's own sheet

type Form = {
  name: string; type: Kind; direction: Direction; every: string; skip: string[]; encrypt: boolean
  endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean; accessKeyId: string; secret: string
  url: string; username: string; passphrase: string
}

const formOf = (r: RemoteView | null): Form => ({
  name: r?.name ?? "", type: r?.type ?? "s3", direction: r?.direction ?? "two-way", every: r?.every ?? "", skip: r?.skip ?? DEFAULT_SKIP,
  encrypt: r?.encrypt ?? false, endpoint: r?.connection?.endpoint ?? "", region: r?.connection?.region ?? "", bucket: r?.connection?.bucket ?? "",
  prefix: r?.connection?.prefix ?? "", pathStyle: r?.connection?.pathStyle ?? true, accessKeyId: r?.connection?.accessKeyId ?? "", secret: "",
  url: r?.connection?.url ?? "", username: r?.connection?.username ?? "", passphrase: "",
})

/** What the server's routes take: the form, its secrets only when typed (blank keeps the saved ones). */
const bodyOf = (id: string | null, f: Form) => ({
  ...(id ? { id } : {}), name: f.name, type: f.type, direction: f.direction, every: f.every, skip: f.skip, encrypt: f.encrypt,
  connection: f.type === "s3"
    ? { endpoint: f.endpoint, region: f.region, bucket: f.bucket, prefix: f.prefix, pathStyle: f.pathStyle, accessKeyId: f.accessKeyId, secretAccessKey: f.secret, passphrase: f.passphrase }
    : { url: f.url, username: f.username, password: f.secret, passphrase: f.passphrase },
})

const field = "h-8 min-w-0 rounded-[7px] border-[0.5px] border-border bg-background px-2 text-[16px] outline-none focus:border-primary md:h-7 md:text-[14px]"

function TextRow({ label, sub, value, set, placeholder, secret, k }: {
  label: string; sub?: ReactNode; value: string; set: (v: string) => void; placeholder?: string; secret?: boolean; k: string
}) {
  return (
    <SettingRow stack label={label} sub={sub} data-setting={k}>
      <input aria-label={label} value={value} placeholder={placeholder} spellCheck={false} autoComplete={secret ? "new-password" : "off"} autoCapitalize="off"
        type={secret ? "password" : "text"} onChange={(e) => set(e.target.value)} className={cn(field, "w-full sm:max-w-64")} />
    </SettingRow>
  )
}

const SCHEDULE: SettingDecl = { type: "enum", values: SCHEDULES, labels: { "": "By hand", "15m": "Every 15 minutes", "1h": "Every hour", "6h": "Every 6 hours", "1d": "Every day" },
  label: "Syncs", description: "how often it syncs on its own, from the machine its connection is on" }
const SKIP: SettingDecl = { type: "list", default: DEFAULT_SKIP, label: "Leave out", description: "files and folders it never syncs, like *.mp4, Archive/ or .vaultite/cache/" }
const ENCRYPT: SettingDecl = { type: "boolean", default: false, label: "Encrypt", description: "files and their names are encrypted here before they leave (AES-256-GCM), so only the passphrase opens them; set it before the first sync" }

const DIRECTION_SUB: Record<Direction, string> = {
  "two-way": "Changes on either side reach the other. A file changed on both is kept twice.",
  push: "A backup: this vault's changes go up, deletions too; nothing comes down.",
  pull: "This vault follows the remote; its own changes stay here and never go up.",
}

const primary = "h-9 shrink-0 cursor-pointer rounded-[8px] bg-primary px-4 text-[15px] font-medium text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-50 md:h-8 md:text-[14px]"
const secondary = "h-9 shrink-0 cursor-pointer rounded-[8px] border-[0.5px] border-border bg-card px-4 text-[15px] text-foreground hover:bg-foreground/[0.05] disabled:cursor-default disabled:opacity-50 md:h-8 md:text-[14px]"

function RemoteSheet({ id }: { id: string }) {
  const { data, reload } = useRemotes()
  const r = id === "new" ? null : data?.remotes.find((x) => x.id === id) ?? recent.get(id) ?? null
  const [form, setForm] = useState<Form | null>(id === "new" ? formOf(null) : null)
  const [test, setTest] = useState<{ ok: boolean; message: string } | "busy" | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (r && !form) setForm(formOf(r)) }, [r, form])
  if (id !== "new" && !data) return <Loading />
  if (id !== "new" && !r) return <Empty>There's no such remote any more.</Empty>
  if (!form) return <Loading />
  const set = (p: Partial<Form>) => { setForm({ ...form, ...p }); setTest(null) }
  const locked = !!r?.here && !r.connection // (its connection is here, but only this machine's owner may see it)
  const saved = { secret: !!r?.connection?.secret, passphrase: !!r?.connection?.passphrase }

  const runTest = async () => {
    setTest("busy")
    try { setTest(await post<{ ok: boolean; message: string }>("remote-save/test", bodyOf(r?.id ?? null, form))) } catch (e) { setTest({ ok: false, message: String((e as Error).message ?? e) }) }
  }
  const save = async () => {
    setSaving(true)
    try {
      const v = await post<RemoteView>("remote-save/remotes", bodyOf(r?.id ?? null, form))
      notify(r ? `Saved ${v.name}` : `Added ${v.name}`)
      setForm(formOf(v))
      recent.set(v.id, v)
      reload()
      if (!r) replaceDetail(detailPath("remote-save", v.id))
    } catch (e) { notifyError(e, "Couldn't save it") } finally { setSaving(false) }
  }
  const remove = async () => {
    if (!r || !(await confirmDialog({ title: `Remove ${r.name}?`, body: "Its connection and what was synced are forgotten on this machine. The files stay where they are, here and on the remote.", confirm: "Remove", danger: true }))) return
    try { await del(`remote-save/remotes/${encodeURIComponent(r.id)}`); recent.delete(r.id); refresh(); notify(`Removed ${r.name}`); backDetail() } catch (e) { notifyError(e, "Couldn't remove it") }
  }
  const held = r?.last?.report?.held.length ?? 0
  const deleteHeld = async () => {
    if (!r || !(await confirmDialog({ title: `Make ${plural(held, "deletion")}?`, body: "They were held because there were many at once, or a whole folder is gone from here (iCloud can do that). Files deleted here go to the trash.", confirm: "Delete", danger: true }))) return
    await syncNow(r, true)
    reload()
  }

  return (
    <div data-remote-sheet={id}>
      <SheetHead icon={Cloud} tint={TINT} kicker="Remote save" title={r ? r.name : "Add a remote"}
        sub={r ? statusOf(r).text : "Sync or back up this vault with storage you own."} />
      <div className="space-y-5">
        {r && !r.here && (
          <p className="text-[15px] leading-[20px] text-muted-foreground">
            It was set up on {r.machine ?? "another machine"}, which keeps its keys and syncs it. Fill in its connection to sync from this machine instead.
          </p>
        )}
        {locked ? (
          <p className="text-[15px] leading-[20px] text-muted-foreground">Only this machine's owner can see or change its connection.</p>
        ) : (
          <>
            <Section title="Connection">
              <Group>
                <TextRow k="name" label="Name" value={form.name} set={(name) => set({ name })} placeholder="Cloudflare R2" />
                <SettingRow stack label="Kind" data-setting="type">
                  <Segmented label="Kind" value={form.type} onChange={(type) => set({ type, secret: "" })} className="w-full sm:w-auto"
                    options={[{ value: "s3", label: "S3-compatible" }, { value: "webdav", label: "WebDAV" }]} />
                </SettingRow>
                {form.type === "s3" ? (
                  <>
                    <TextRow k="endpoint" label="Endpoint" value={form.endpoint} set={(endpoint) => set({ endpoint })} placeholder="https://s3.us-east-1.amazonaws.com"
                      sub="R2: https://<account>.r2.cloudflarestorage.com · B2: https://s3.<region>.backblazeb2.com" />
                    <TextRow k="region" label="Region" value={form.region} set={(region) => set({ region })} placeholder="us-east-1" sub="R2: auto" />
                    <TextRow k="bucket" label="Bucket" value={form.bucket} set={(bucket) => set({ bucket })} placeholder="my-vault" />
                    <TextRow k="prefix" label="Folder in the bucket" value={form.prefix} set={(prefix) => set({ prefix })} placeholder="Vault/" sub="Optional: several vaults can share a bucket" />
                    <TextRow k="accessKeyId" label="Access key ID" value={form.accessKeyId} set={(accessKeyId) => set({ accessKeyId })} />
                    <TextRow k="secret" secret label="Secret access key" value={form.secret} set={(secret) => set({ secret })} placeholder={saved.secret ? "Saved on this machine" : ""} />
                    <SettingField k="pathStyle" d={{ type: "boolean", default: true, label: "Bucket in the address's path", description: "what MinIO and most services take; off for a bucket.host address" }}
                      value={form.pathStyle} set={(v) => set({ pathStyle: v !== false })} />
                  </>
                ) : (
                  <>
                    <TextRow k="url" label="Folder's address" value={form.url} set={(url) => set({ url })} placeholder="https://cloud.example.com/remote.php/dav/files/alice/Vault/"
                      sub="Nextcloud: Files, Settings, WebDAV, then a folder of its own" />
                    <TextRow k="username" label="Username" value={form.username} set={(username) => set({ username })} />
                    <TextRow k="secret" secret label="Password" value={form.secret} set={(secret) => set({ secret })} placeholder={saved.secret ? "Saved on this machine" : "An app password is best"} />
                  </>
                )}
              </Group>
            </Section>
            <Section title="How it syncs">
              <Group>
                <SettingRow stack label="Direction" sub={DIRECTION_SUB[form.direction]} data-setting="direction">
                  <Segmented label="Direction" value={form.direction} onChange={(direction) => set({ direction })} className="w-full sm:w-auto [&>button]:whitespace-nowrap"
                    options={[{ value: "two-way", label: "Two-way" }, { value: "push", label: "Push only" }, { value: "pull", label: "Pull only" }]} />
                </SettingRow>
                <SettingField k="every" d={SCHEDULE} value={form.every} set={(v) => set({ every: typeof v === "string" ? v : "" })} />
                <SettingField k="skip" d={SKIP} value={form.skip} set={(v) => set({ skip: Array.isArray(v) ? v.map(String) : DEFAULT_SKIP })} />
                <SettingField k="encrypt" d={ENCRYPT} value={form.encrypt} set={(v) => set({ encrypt: v === true })} />
                {form.encrypt && (
                  <TextRow k="passphrase" secret label="Passphrase" value={form.passphrase} set={(passphrase) => set({ passphrase })}
                    placeholder={saved.passphrase ? "Saved on this machine" : ""} sub="Lose it and the remote's copies can't be opened: keep it somewhere safe" />
                )}
              </Group>
            </Section>
            {test && test !== "busy" && (
              <div className={cn("flex items-start gap-2 text-[15px] leading-[20px] md:text-[14px]", test.ok ? "text-[var(--green)]" : "text-[var(--red)]")} data-remote-test={test.ok ? "ok" : "failed"}>
                {test.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" strokeWidth={2} /> : <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={2} />}
                <span className="min-w-0 break-words">{test.message}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondary} disabled={test === "busy"} onClick={runTest} data-remote-test-button>{test === "busy" ? "Testing…" : "Test connection"}</button>
              <button type="button" className={primary} disabled={saving} onClick={save} data-remote-save-button>{saving ? "Saving…" : r ? "Save" : "Add remote"}</button>
            </div>
          </>
        )}
        {r && (
          <Section title="Syncs">
            <Group>
              {r.here && <SettingRow label="Sync now" sub={statusOf(r).text} onClick={() => void syncNow(r).then(reload)} chevron={RefreshCw} data-remote-sync-row />}
              {held > 0 && r.here && <SettingRow label={`Make ${plural(held, "held deletion")}`} sub={r.last!.report!.held.slice(0, 3).join(", ") + (held > 3 ? "…" : "")} onClick={deleteHeld} />}
              {r.last?.report?.conflicts.map((c) => (
                <SettingRow key={c.copy} label={`Kept both: ${c.path}`} sub={`The other version is ${c.copy}`} />
              ))}
              {!r.last && <SettingRow label="Not synced yet" sub={r.here ? "The first sync copies each side's files to the other; it never deletes." : "It syncs from the machine its connection is on."} />}
            </Group>
          </Section>
        )}
        {r && (
          <button type="button" onClick={remove} className="cursor-pointer text-[15px] text-[var(--red)] md:text-[14px]" data-remote-remove>Remove remote</button>
        )}
      </div>
    </div>
  )
}

// ---------- the status bar

function Ambient() {
  const { data } = useRemotes()
  const list = (data?.remotes ?? []).filter((r) => r.here)
  if (!list.length) return null
  const failed = list.find((r) => r.last && !r.last.ok)
  const syncing = list.some((r) => r.running)
  const latest = list.map((r) => r.last?.at ?? "").sort().pop()
  const text = syncing ? "Syncing" : failed ? "Sync failed" : latest ? fmtAgo(latest) : "Never synced"
  return <AmbientButton icon={failed ? CloudOff : Cloud} tint={failed ? "var(--red)" : undefined} text={text}
    tip={failed ? `${failed.name}: ${failed.last!.error}` : `Remote save: ${list.map((r) => `${r.name}, ${statusOf(r).text.toLowerCase()}`).join("; ")}`}
    onClick={() => openPluginSettings("remote-save")} />
}

function Preview() {
  return (
    <Panel title="Remote save" icon={Cloud} tint={TINT}>
      <p className="text-[15px] leading-[20px] text-muted-foreground">
        Keeps a copy of your vault in storage you own, or syncs it both ways: an S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2,
        MinIO) or a WebDAV folder (Nextcloud and friends). It runs on a schedule or when you ask, can encrypt everything before it leaves,
        never deletes on a first sync, and keeps both versions when a file changed on both sides.
      </p>
    </Panel>
  )
}

const MOCK: RemoteView[] = [{ id: "r2", name: "Cloudflare R2", type: "s3", direction: "two-way", every: "1h", skip: DEFAULT_SKIP, encrypt: true, machine: null,
  here: true, running: false, lastOk: "2026-10-06T08:00:00Z", connection: null,
  last: { at: "2026-10-06T08:00:00Z", ms: 2100, ok: true, error: null, by: "schedule", report: { up: 3, down: 1, deletedRemote: 0, deletedLocal: 0, adopted: 0, unchanged: 412,
    conflicts: [], held: [], skipped: [], errors: [], waiting: 0, stopped: null, dryRun: false } } }]

export default definePlugin({
  blocks: { "remote-save": ({ options }) => <RemotesBlock only={typeof options.remote === "string" ? options.remote : undefined} /> },
  details: {
    "remote-save": {
      render: (_s, [id]) => <RemoteSheet key={id} id={id} />,
      title: (_s, [id]) => (id === "new" ? "Add a remote" : names.get(id) ?? "Remote"),
    },
  },
  settingsPanel: () => <SettingsPanel />,
  ambient: { status: { title: "Remote save", sort: 60, render: () => <Ambient /> } },
  commands: [
    { id: "remote-save:sync", name: "Sync with remotes now", icon: "refresh-cw", label: "Sync", run: async () => {
      try {
        const runs = await op<(Run & { name: string })[]>("remote-save.sync", {})
        const bad = runs.find((x) => !x.ok)
        if (bad) notifyError(new Error(bad.error ?? "it failed"), `${bad.name} didn't sync`)
        else notify(runs.map((x) => `${x.name}: ${resultText(x.report)}`).join("; "))
      } catch (e) { notifyError(e, "Couldn't sync") }
      refresh()
    } },
    { id: "remote-save:add", name: "Add a remote…", run: () => openDetail(detailPath("remote-save", "new")) },
  ],
  mockLive: () => ({ "remote-save": { remotes: MOCK } }),
  preview: () => <Preview />,
})
