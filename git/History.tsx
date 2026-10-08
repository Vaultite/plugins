// A file's history in git (view:git-history/<path>): its commits, newest first, following renames. A version reads
// as what that commit changed, against the file now, or its text (read-only); Restore writes it back as an ordinary
// edit, with Undo (File history keeps what it replaces).
import { useCallback, useEffect, useMemo, useState } from "react"
import { Copy, GitCommitHorizontal, RotateCcw } from "lucide-react"
import { cn, copyText, dateText, get, Markdown, notify, notifyError, op, openFile, put, readFile, Segmented, stem, useVaultChange } from "@vaultite"
import { changesOf, DiffLines } from "./Diff"
import type { Version } from "./types"

export const ago = (t: number) => {
  const d = (Date.now() - t) / 1000
  if (d < 60) return "Just now"
  if (d < 3600) return `${Math.round(d / 60)} min ago`
  if (d < 86400) return `${Math.round(d / 3600)} h ago`
  const days = Math.round(d / 86400)
  return days === 1 ? "Yesterday" : days < 45 ? `${days} days ago` : dateText(new Date(t), { month: "short", day: "numeric", year: "numeric" })
}
export const stamp = (t: number) => dateText(new Date(t), { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

const textAt = async (v: Version) => {
  const r = await fetch(`api/git/show?path=${encodeURIComponent(v.path)}&rev=${v.sha}`)
  return r.ok ? r.text() : null
}

type Mode = "commit" | "now" | "text"
const BUTTON = "flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] px-3 text-[15px] font-medium disabled:opacity-40 md:h-7 md:rounded-[6px] md:text-[13px]"

export function HistoryView({ path }: { path: string }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>("commit")
  const [texts, setTexts] = useState<{ sha: string; text: string | null; before: string | null } | null>(null)
  const [now, setNow] = useState<string | null | undefined>(undefined)

  const load = useCallback(() => {
    get<{ versions: Version[] }>(`git/log?limit=200&path=${encodeURIComponent(path)}`).then((r) => {
      setVersions(r.versions); setError(null)
      setSel((s) => (s && r.versions.some((v) => v.sha === s) ? s : r.versions[0]?.sha ?? null))
    }, (e) => { setVersions([]); setError(String((e as Error).message ?? e)) })
    readFile(path).then((f) => setNow(f.text), () => setNow(null))
  }, [path])
  useEffect(load, [load])
  useVaultChange(load, [path])

  const i = versions?.findIndex((v) => v.sha === sel) ?? -1
  const v = i >= 0 ? versions![i] : null
  const prev = i >= 0 ? versions![i + 1] ?? null : null
  useEffect(() => {
    if (!v) { setTexts(null); return }
    let live = true
    Promise.all([v.change === "D" ? Promise.resolve(null) : textAt(v), prev ? textAt(prev) : Promise.resolve(null)])
      .then(([text, before]) => { if (live) setTexts({ sha: v.sha, text, before }) }, () => { if (live) setTexts({ sha: v.sha, text: null, before: null }) })
    return () => { live = false }
  }, [v?.sha, prev?.sha])
  const shown = texts && texts.sha === v?.sha ? texts : null
  const same = useMemo(() => (shown?.text != null && now != null ? changesOf(shown.text, now) === 0 : false), [shown, now])

  const restore = async () => {
    if (!v || shown?.text == null) return
    const before = now ?? null
    try {
      await op("git.restore", { path, commit: v.sha, ...(v.path !== path ? { from: v.path } : {}) })
      const text = shown.text
      notify(`Restored the version of ${stamp(v.t)}`, {
        action: before === null ? undefined : { label: "Undo", run: () => { put("file", { path, text: before, base: text }).then(load, (e) => notifyError(e)) } },
      })
      load()
    } catch (e) { notifyError(e, "Couldn't restore it") }
  }

  const name = stem(path.split("/").pop()!)
  if (versions === null) return <p className="mt-6 text-[15px] text-muted-foreground">Loading…</p>
  return (
    <div className="@container mt-3 pb-10" data-git-history>
      <h1 className="mb-1 truncate text-[22px] leading-[28px] font-bold max-md:hidden">{name}</h1>
      <p className="mb-4 text-[15px] leading-[20px] text-muted-foreground md:text-[13px] md:leading-[18px]">
        Each commit of <button type="button" className="cursor-pointer font-medium text-foreground hover:underline" onClick={() => openFile(path)}>{name}</button> in
        the vault's git repository, newest first. File history keeps the versions in between, every few minutes.
      </p>
      {error ? <p className="text-[15px] text-[var(--red)] md:text-[13px]">{error}</p> : !versions.length ? (
        <div className="flex items-center gap-2.5 rounded-[10px] bg-foreground/[0.04] px-4 py-3 text-[15px] text-muted-foreground md:text-[13px]">
          <GitCommitHorizontal className="size-4 shrink-0" strokeWidth={2} />No commits of this file yet.
        </div>
      ) : (
        <div className="flex flex-col gap-4 @2xl:flex-row">
          <ul role="listbox" aria-label="Commits" className="flex max-h-[34vh] shrink-0 flex-col gap-px overflow-y-auto overscroll-contain @2xl:max-h-[calc(100dvh-12rem)] @2xl:w-[240px]">
            {versions.map((x) => (
              <li key={x.sha}>
                <button type="button" role="option" aria-selected={x.sha === sel} onClick={() => setSel(x.sha)} data-sha={x.sha.slice(0, 7)}
                  className={cn("flex w-full cursor-pointer flex-col rounded-[8px] px-3 py-2 text-left md:rounded-[6px] md:py-1.5",
                    x.sha === sel ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.04]")}>
                  <span className="line-clamp-2 text-[15px] font-medium md:text-[13px]">{x.subject || "(no message)"}</span>
                  <span className="truncate text-[13px] text-muted-foreground md:text-[12px]">
                    {ago(x.t)} · {x.author} · <span className="font-mono">{x.sha.slice(0, 7)}</span>{x.change === "D" ? " · deleted" : x.path !== path ? " · renamed" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {v && (
            <section className="min-w-0 flex-1" aria-label="Version">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Segmented<Mode> label="Show" value={mode} onChange={setMode} className="w-full @md:w-auto"
                  options={[{ value: "commit", label: "This commit" }, { value: "now", label: "Against now" }, { value: "text", label: "Text" }]} />
                <span className="hidden flex-1 @md:block" />
                <button type="button" disabled={shown?.text == null} onClick={() => shown?.text != null && copyText(shown.text).then(() => notify("Copied the version", { id: "copied" }), (e) => notifyError(e))}
                  className={cn(BUTTON, "bg-foreground/[0.06] hover:bg-foreground/[0.1]")}>
                  <Copy className="size-3.5" strokeWidth={2.25} />Copy
                </button>
                <button type="button" disabled={shown?.text == null || same} onClick={restore}
                  className={cn(BUTTON, "bg-primary text-primary-foreground hover:bg-primary/90")}>
                  <RotateCcw className="size-3.5" strokeWidth={2.25} />Restore
                </button>
              </div>
              <p className="mb-2 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">{stamp(v.t)}</span> · {v.author}{v.path !== path ? ` · then ${v.path}` : ""}
                {mode !== "text" && shown?.text != null && (mode === "now" ? (same ? " · the same as the file now" : ` · ${changesOf(shown.text, now ?? "")} lines differ from the file now`) : "")}
              </p>
              {!shown ? <p className="text-[13px] text-muted-foreground">Loading…</p>
                : shown.text === null ? <p className="text-[15px] text-muted-foreground md:text-[13px]">This commit deleted the file.</p>
                : mode === "commit" ? <DiffLines before={shown.before ?? ""} after={shown.text} />
                : mode === "now" ? <DiffLines before={now ?? ""} after={shown.text} />
                : (
                  <div className="rounded-[10px] border-[0.5px] border-border bg-card px-4 py-3 md:rounded-[8px]" data-git-version-text>
                    {/\.(md|markdown)$/i.test(v.path) ? <Markdown text={shown.text.replace(/^---\n[\s\S]*?\n---\n/, "")} /> : <pre className="font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap">{shown.text}</pre>}
                  </div>
                )}
              {mode !== "text" && (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  {mode === "commit"
                    ? <><span className="text-[var(--green)]">+</span> added in this commit, <span className="text-[var(--red)]">−</span> taken out.</>
                    : <><span className="text-[var(--green)]">+</span> in this version, <span className="text-[var(--red)]">−</span> in the file now. Restore makes the file this version (it can be undone).</>}
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  )
}
