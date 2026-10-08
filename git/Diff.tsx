// Two texts compared line by line in the app's colours (File history's look): unchanged runs folded to a few lines
// of context, a click away. The diff view (view:git-diff/<path>) is a file against its last commit.
import { useEffect, useMemo, useState } from "react"
import { FileText, History, Minus, Plus, Undo2 } from "lucide-react"
import { cn, confirmDialog, get, opcodes, openFile, openView, stem, useVaultChange } from "@vaultite"
import { discard, stage, unstage, useGit } from "./client"
import { LETTER_TINT, LETTER_WORD, letter, type FileStatus } from "./types"

type Line = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number }
type Row = Line | { kind: "fold"; n: number; at: number }

/** `before` against `after`: kept, only in after (add), only in before (del), with their line numbers. */
export function diffLines(before: string, after: string): Line[] {
  const lines = (t: string) => (t ? t.replace(/\n$/, "").split("\n") : [])
  const a = lines(before), b = lines(after)
  if (a.length + b.length > 40000) return b.map((text, i) => ({ kind: "same", text, b: i + 1 })) // too big to compare here
  const out: Line[] = []
  for (const [tag, i1, i2, j1, j2] of opcodes(a, b)) {
    if (tag === "equal") { for (let j = j1; j < j2; j++) out.push({ kind: "same", text: b[j], a: i1 + j - j1 + 1, b: j + 1 }); continue }
    for (let i = i1; i < i2; i++) out.push({ kind: "del", text: a[i], a: i + 1 })
    for (let j = j1; j < j2; j++) out.push({ kind: "add", text: b[j], b: j + 1 })
  }
  return out
}

const CONTEXT = 3
/** Unchanged runs longer than the context around changes become one fold row, unless opened. */
function folded(lines: Line[], open: Set<number>): Row[] {
  const out: Row[] = []
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== "same") { out.push(lines[i++]); continue }
    let j = i
    while (j < lines.length && lines[j].kind === "same") j++
    const head = i === 0 ? 0 : CONTEXT, tail = j === lines.length ? 0 : CONTEXT
    if (j - i > head + tail + 2 && !open.has(i)) {
      out.push(...lines.slice(i, i + head), { kind: "fold", n: j - i - head - tail, at: i }, ...lines.slice(j - tail, j))
    } else out.push(...lines.slice(i, j))
    i = j
  }
  return out
}

export function DiffLines({ before, after, all = false }: { before: string; after: string; all?: boolean }) {
  const lines = useMemo(() => diffLines(before, after), [before, after])
  const [open, setOpen] = useState<Set<number>>(new Set())
  const rows = useMemo(() => (all ? lines : folded(lines, open)), [lines, open, all])
  if (!lines.length) return <p className="px-3 py-2 font-sans text-[13px] text-muted-foreground">Empty on both sides.</p>
  return (
    <div className="overflow-x-auto rounded-[10px] border-[0.5px] border-border bg-card py-1 font-mono text-[12.5px] leading-[19px] md:rounded-[8px]" data-git-diff>
      {rows.map((l, i) => l.kind === "fold" ? (
        <button key={`f${l.at}`} type="button" data-diff="fold" onClick={() => setOpen((s) => new Set(s).add(l.at))}
          className="flex w-full cursor-pointer items-center gap-2 bg-foreground/[0.03] px-3 py-0.5 text-left font-sans text-[12px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
          {l.n} unchanged line{l.n === 1 ? "" : "s"}
        </button>
      ) : (
        <div key={i} data-diff={l.kind}
          className={cn("flex min-w-max pr-3 whitespace-pre",
            l.kind === "add" && "bg-[color-mix(in_srgb,var(--green)_16%,transparent)]",
            l.kind === "del" && "bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-muted-foreground")}>
          <span aria-hidden className="w-9 shrink-0 pr-1.5 text-right text-tertiary tabular-nums select-none max-md:hidden">{l.kind === "del" ? l.a : l.b}</span>
          <span aria-hidden className={cn("w-5 shrink-0 text-center select-none", l.kind === "add" ? "text-[var(--green)]" : l.kind === "del" ? "text-[var(--red)]" : "text-tertiary")}>
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
          </span>
          <span>{l.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

export const changesOf = (before: string, after: string) => diffLines(before, after).filter((l) => l.kind !== "same").length

type Diff = { path: string; from: string | null; binary: boolean; head: string | null; now: string | null; file: FileStatus | null }

const BUTTON = "flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] bg-foreground/[0.06] px-3 text-[15px] font-medium hover:bg-foreground/[0.1] disabled:opacity-40 md:h-7 md:rounded-[6px] md:text-[13px]"

/** A file against its last commit (view:git-diff/<path>), with Stage, Unstage and Discard. */
export function DiffView({ path }: { path: string }) {
  const [d, setD] = useState<Diff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { snap } = useGit()
  const load = () => { get<Diff>(`git/diff?path=${encodeURIComponent(path)}`).then((r) => { setD(r); setError(null) }, (e) => setError(String((e as Error).message ?? e))) }
  useEffect(load, [path])
  useVaultChange(load, [path])
  const f = snap?.files?.find((x) => x.path === path) ?? null
  // (asked again when the panel's state changes: a stage or a commit doesn't change the file itself)
  useEffect(load, [f?.x, f?.y, snap?.lastCommit?.sha])
  const name = stem(path.split("/").pop()!)
  const l = f ? letter(f, f.unstaged ? "unstaged" : "staged") : null
  const lines = d && !d.binary ? changesOf(d.head ?? "", d.now ?? "") : 0
  return (
    <div className="@container mt-3 pb-10" data-git-diff-view>
      <h1 className="mb-1 truncate text-[22px] leading-[28px] font-bold max-md:hidden">{name}</h1>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="w-full min-w-0 text-[15px] text-muted-foreground @md:w-auto @md:flex-1 md:text-[13px]">
          {l && <span className="mr-1.5 font-medium" style={{ color: LETTER_TINT[l] }}>{LETTER_WORD[l]}</span>}
          {d?.from ? <>from {d.from}, </> : null}
          {!d ? "Loading…" : d.binary ? "a file that isn't text" : !f ? "the same as its last commit" : `${lines} line${lines === 1 ? "" : "s"} changed since its last commit`}
          {f && <span> · {f.staged && !f.unstaged ? "staged" : f.staged ? "partly staged" : "not staged"}</span>}
        </p>
        <button type="button" className={BUTTON} onClick={() => openFile(path)}><FileText className="size-3.5" strokeWidth={2.25} />Open</button>
        <button type="button" className={BUTTON} onClick={() => openView(`git-history/${path}`)}><History className="size-3.5" strokeWidth={2.25} />History</button>
        {f && f.unstaged && !f.conflict && <button type="button" className={BUTTON} onClick={() => void stage([path])}><Plus className="size-3.5" strokeWidth={2.25} />Stage</button>}
        {f && f.staged && <button type="button" className={BUTTON} onClick={() => void unstage([path])}><Minus className="size-3.5" strokeWidth={2.25} />Unstage</button>}
        {f && !f.untracked && !f.conflict && !f.from && f.x !== "A" && (
          <button type="button" className={BUTTON} onClick={async () => {
            if (await confirmDialog({ title: `Discard the changes to ${name}?`, body: "It goes back to its last commit. File history keeps what it has now.", confirm: "Discard", danger: true })) void discard([path])
          }}><Undo2 className="size-3.5" strokeWidth={2.25} />Discard</button>
        )}
      </div>
      {error ? <p className="text-[15px] text-[var(--red)] md:text-[13px]">{error}</p>
        : !d ? null
        : d.binary ? <p className="text-[15px] text-muted-foreground md:text-[13px]">Its changes can't be shown here.</p>
        : <DiffLines before={d.head ?? ""} after={d.now ?? ""} />}
      <p className="mt-2 text-[12px] text-muted-foreground">
        <span className="text-[var(--green)]">+</span> in the file now, <span className="text-[var(--red)]">−</span> in its last commit.
      </p>
    </div>
  )
}
