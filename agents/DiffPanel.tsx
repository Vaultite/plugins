// The diff panel beside the chat (⌘D), as T3 Code's: what a turn, the whole thread or the uncommitted files changed,
// file by file, stacked or side by side; git's diff between the turn's checkpoints, else the edits' own.
import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Columns2, ExternalLink, ListTree, RefreshCw, Rows3, WrapText, X } from "lucide-react"
import { cn, get, menuBelow, openFile, useScopedState, type MenuItem } from "@vaultite"
import { setPanel, usePanel, type Scope } from "./panel"
import type { Entry, FileDiff } from "./types"
import { button, Counts, hunkLines, timeOf, type Line } from "./ui"

type Got = { source: "git" | "edits"; files: FileDiff[] }

/** Side by side: each removed line against the added one in its place. */
function pairs(lines: Line[]) {
  const rows: { l?: Line; r?: Line }[] = []
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === "same") { rows.push({ l: lines[i], r: lines[i] }); i++; continue }
    const dels: Line[] = [], adds: Line[] = []
    while (lines[i]?.kind === "del") dels.push(lines[i++])
    while (lines[i]?.kind === "add") adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k], r: adds[k] })
  }
  return rows
}

const tint = (k?: Line["kind"]) => k === "add" ? "bg-[color-mix(in_srgb,var(--green)_15%,transparent)]" : k === "del" ? "bg-[color-mix(in_srgb,var(--red)_13%,transparent)]" : ""
const num = "w-9 shrink-0 pe-1.5 text-right text-tertiary select-none tabular-nums"

function FileBody({ f, split, wrap }: { f: FileDiff; split: boolean; wrap: boolean }) {
  const hunks = f.hunks
  if (f.binary) return <div className="px-3 py-2 text-[12px] text-tertiary">A binary file.</div>
  if (!hunks.length) return <div className="px-3 py-2 text-[12px] text-tertiary">{f.status === "added" ? "An empty file." : "No changes to show."}</div>
  const ws = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[18px]" data-diff-file-body>
      {hunks.map((h, n) => {
        const lines = hunkLines([h])
        return (
          <div key={n} className={cn(!wrap && "min-w-max")}>
            <div className="bg-foreground/[0.04] px-3 py-0.5 text-[11px] text-tertiary select-none">@@ −{h.oldStart} +{h.newStart} @@</div>
            {split ? pairs(lines).map((p, k) => (
              <div key={k} className="grid grid-cols-2">
                {[p.l, p.r].map((l, side) => (
                  <div key={side} className={cn("flex min-w-0", side === 1 && "border-s-[0.5px] border-border", tint(l?.kind === "same" ? undefined : l?.kind), !l && "bg-foreground/[0.025]")} data-diff={l?.kind}>
                    <span className={num}>{l ? (side ? l.new : l.old) : ""}</span>
                    <span className={cn("min-w-0 flex-1 pe-3", ws)}>{l?.text || " "}</span>
                  </div>
                ))}
              </div>
            )) : lines.map((l, k) => (
              <div key={k} className={cn("flex", tint(l.kind), l.kind === "del" && "text-muted-foreground")} data-diff={l.kind}>
                <span className={num}>{l.old ?? ""}</span>
                <span className={num}>{l.new ?? ""}</span>
                <span aria-hidden className={cn("w-4 shrink-0 text-center select-none", l.kind === "add" ? "text-[var(--green)]" : l.kind === "del" ? "text-[var(--red)]" : "")}>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                <span className={cn("min-w-0 flex-1 pe-3", ws)}>{l.text || " "}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** The choices of what to show: the whole thread, the latest turn, each turn, and (in a checkout) what isn't committed. */
function scopes(entries: Entry[], git: boolean) {
  const turns = entries.map((e, i) => ({ e, i })).filter((x) => x.e.kind === "user") as { e: Extract<Entry, { kind: "user" }>; i: number }[]
  const label = (s: Scope) => s === "all" ? "All turns" : s === "uncommitted" ? "Uncommitted" : `Turn ${turns.findIndex((t) => t.i === s) + 1}`
  return { turns, label, git }
}

export function DiffPanel({ id, entries, running, git, onClose }: { id: string; entries: Entry[]; running: boolean; git: boolean; onClose: () => void }) {
  const p = usePanel(id)
  const [split, setSplit] = useScopedState<boolean>("agents:diff-split", false, "workspace")
  const [wrap, setWrap] = useScopedState<boolean>("agents:diff-wrap", false, "workspace")
  const [tree, setTree] = useScopedState<boolean>("agents:diff-tree", true, "workspace")
  const [got, setGot] = useState<Got | null>(null)
  const [error, setError] = useState("")
  const [shut, setShut] = useState<Set<string>>(new Set())
  const [refresh, setRefresh] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  const s = scopes(entries, git)
  const narrow = matchMedia("(max-width: 767px)").matches
  // (refetched when a turn ends: its checkpoint and changes arrive with it)
  const key = `${p.scope}|${running}|${entries.filter((e) => e.kind === "user").map((e) => (e as { after?: string }).after ?? "").join(",")}|${refresh}`
  useEffect(() => {
    let gone = false
    setError("")
    const q = p.scope === "all" ? "" : p.scope === "uncommitted" ? "?scope=uncommitted" : `?turn=${p.scope}`
    get<Got>(`agents/threads/${id}/diff${q}`).then((r) => { if (!gone) setGot(r) }).catch((e) => { if (!gone) { setGot(null); setError(String((e as Error).message ?? e)) } })
    return () => { gone = true }
  }, [id, key]) // eslint-disable-line react-hooks/exhaustive-deps
  // A file asked for (a click in a turn's card): scrolled to, opened.
  useEffect(() => {
    if (!p.file || !got) return
    setShut((x) => { const n = new Set(x); n.delete(p.file); return n })
    requestAnimationFrame(() => body.current?.querySelector(`[data-diff-path="${CSS.escape(p.file)}"]`)?.scrollIntoView({ block: "start" }))
  }, [p.nonce, got]) // eslint-disable-line react-hooks/exhaustive-deps
  const files = useMemo(() => got?.files ?? [], [got])
  const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0)
  const scopeMenu = (): MenuItem[] => [
    { label: "All turns", checked: p.scope === "all", run: () => setPanel(id, { scope: "all" }) },
    ...(s.turns.length ? [{ label: "Latest turn", hint: timeOf(s.turns.at(-1)!.e.at), checked: p.scope === s.turns.at(-1)!.i, run: () => setPanel(id, { scope: s.turns.at(-1)!.i }) }] : []),
    ...(git ? [{ label: "Uncommitted", hint: "against the last commit", checked: p.scope === "uncommitted", run: () => setPanel(id, { scope: "uncommitted" as Scope }) }] : []),
    ...(s.turns.length > 1 ? [{ label: "Turn", run: () => {}, items: [...s.turns].reverse().map((t, n) => ({ label: `Turn ${s.turns.length - n}`, hint: timeOf(t.e.at), checked: p.scope === t.i, run: () => setPanel(id, { scope: t.i }) })) }] : []),
  ] as MenuItem[]
  const go = (path: string) => body.current?.querySelector(`[data-diff-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" })
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background max-md:pt-[env(safe-area-inset-top)]" data-diff-panel data-diff-scope={String(p.scope)} data-diff-split={split || undefined}>
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b-[0.5px] border-border ps-2 pe-1.5 max-md:h-12">
        <button type="button" onClick={(e) => menuBelow(e, scopeMenu())} data-diff-scope-button
          className="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-[6px] px-1.5 text-[13px] font-semibold hover:bg-foreground/[0.06] max-md:h-10 max-md:text-[16px]">
          <span className="truncate">{s.label(p.scope)}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
        {files.length > 0 && <span className="ms-1 shrink-0 text-[12px] text-muted-foreground">{files.length === 1 ? "1 file" : `${files.length} files`}</span>}
        {files.length > 0 && <Counts added={added} removed={removed} className="ms-1" />}
        <span className="flex-1" />
        <button type="button" className={cn(button, tree && "text-foreground")} aria-pressed={tree} aria-label="Show the file list" data-tip="File list" onClick={() => setTree(!tree)}><ListTree className="size-3.5" /></button>
        <button type="button" className={cn(button, "max-md:hidden")} aria-label={split ? "Stacked" : "Side by side"} data-tip={split ? "Stacked" : "Side by side"} data-diff-split-toggle onClick={() => setSplit(!split)}>
          {split ? <Rows3 className="size-3.5" /> : <Columns2 className="size-3.5" />}
        </button>
        <button type="button" className={cn(button, wrap && "text-foreground", "max-md:hidden")} aria-pressed={wrap} aria-label="Wrap lines" data-tip="Wrap lines" onClick={() => setWrap(!wrap)}><WrapText className="size-3.5" /></button>
        <button type="button" className={button} aria-label="Refresh" data-tip="Refresh" onClick={() => setRefresh(refresh + 1)}><RefreshCw className="size-3.5" /></button>
        <button type="button" className={button} aria-label="Close the diff" data-tip="Close (⌘D)" onClick={onClose} data-diff-close><X className="size-4" /></button>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto" data-diff-body>
        {error && <p className="p-3 text-[13px] text-[var(--red)]">{error}</p>}
        {!error && !got && <p className="p-3 text-[13px] text-tertiary">Loading the diff…</p>}
        {got && !files.length && <p className="p-3 text-[13px] text-tertiary" data-diff-empty>No net changes in this selection.</p>}
        {tree && files.length > 1 && (
          <div className="border-b-[0.5px] border-border py-1" data-diff-files>
            {files.map((f) => (
              <button key={f.path} type="button" onClick={() => go(f.path)} className="flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 text-left text-[12px] hover:bg-foreground/[0.04] max-md:h-9 max-md:text-[14px]">
                <span className={cn("w-3 shrink-0 text-[10px] font-semibold", f.status === "added" ? "text-[var(--green)]" : f.status === "deleted" ? "text-[var(--red)]" : "text-[var(--orange)]")}>{f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <Counts added={f.added} removed={f.removed} />
              </button>
            ))}
          </div>
        )}
        {files.map((f) => {
          const closed = shut.has(f.path)
          return (
            <section key={f.path} data-diff-path={f.path} className="border-b-[0.5px] border-border">
              <div className="sticky top-0 z-[1] flex h-8 min-w-0 items-center gap-1.5 border-b-[0.5px] border-border bg-background/95 ps-1.5 pe-2 text-[12px] backdrop-blur max-md:h-10">
                <button type="button" aria-label={closed ? "Show" : "Hide"} onClick={() => setShut((x) => { const n = new Set(x); if (closed) n.delete(f.path); else n.add(f.path); return n })}
                  className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-tertiary hover:bg-foreground/[0.08]">
                  <ChevronRight className={cn("size-3.5 transition", !closed && "rotate-90")} strokeWidth={2.25} />
                </button>
                <span className={cn("min-w-0 flex-1 truncate font-mono", f.status === "deleted" && "line-through")} data-tip={f.path}>{f.path}</span>
                {f.status === "added" && <span className="text-[10px] font-semibold text-[var(--green)]">NEW</span>}
                <Counts added={f.added} removed={f.removed} />
                {f.file && <button type="button" className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] text-tertiary hover:bg-foreground/[0.08] hover:text-foreground" aria-label="Open the note" data-tip="Open the note" onClick={() => openFile(f.file!, { newTab: true })}><ExternalLink className="size-3" /></button>}
              </div>
              {!closed && <FileBody f={f} split={split && !narrow} wrap={wrap || narrow} />}
            </section>
          )
        })}
        {got?.source === "edits" && files.length > 0 && <p className="px-3 py-2 text-[11px] text-tertiary">From the agent's edits: this folder isn't a git checkout, so changes made by commands aren't shown.</p>}
      </div>
    </div>
  )
}

/** The panel's width, dragged by its left edge (its share of the tab is kept per workspace). */
export function useDiffWidth() {
  const [width, setWidth] = useScopedState<number>("agents:diff-width", 0.48, "workspace")
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent) => setWidth(Math.min(0.75, Math.max(0.25, (box.right - m.clientX) / box.width)))
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  return { width: Math.min(0.75, Math.max(0.25, width || 0.48)), start, reset: () => setWidth(0.48) }
}
