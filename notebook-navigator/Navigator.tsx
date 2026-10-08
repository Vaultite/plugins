// The navigator: places (shortcuts, recent, folders, tags) beside or above the notes of the one picked, like Apple
// Notes or Bear. Rows, menus, drag, selection and the keyboard are the app's; only the two panes are laid out here.
import { memo, useEffect, useId, useMemo, useReducer, useState } from "react"
import { parse as parseYaml } from "yaml"
import { ArrowUpDown, ChevronRight, FileText, Folder, FolderInput, History, Library, Hash, SquarePen, Star, StarOff, Trash2, Copy, type LucideIcon } from "lucide-react"
import {
  cn, copyText, createFile, dateText, deleteFile, edgeScroller, FilterField, fileMenu, filesMenu, freeName, get, inArchive, isDesktop, isHidden, menuBelow, menuFor,
  moveManyInto, askMove, newNoteFolder, notify, notifyError, openFile, openingSoon, openInSplit, openItem, openNew, openView, PanelFold, post, rawUrl,
  readFile, rowMenu, selectClick, selectedAttr, selectionFor, setProperty, SidebarHeading, SidebarRow, snippet, splitFm, startDrag, stem,
  useDrag, useDropHit, useDropTarget, useOpenedFiles, usePluginSettings, useScopedState, useSelectable, useSelected, useWorkspaceVersion, workspacePins,
  type DragItem, type MenuItem, type Store,
} from "@vaultite"
import { folderOf, folderTree, groupNotes, nameOf, notesIn, SORTS, sortNotes, tagTree, timeOf, type Node, type Note, type Place, type Sort } from "./model.ts"

export const ID = "notebook-navigator"
type Settings = { subfolders?: boolean; sort?: Sort; shortcuts?: Place[] | null; sorts?: Record<Place, Sort> | null }
const SORT_LABEL: Record<Sort, string> = { modified: "Date modified", created: "Date created", title: "Title" }

export const placeName = (p: Place) => (p === "recent" ? "Recent" : p.startsWith("tag:") ? `#${p.slice(4)}` : nameOf(p.slice(7)) || "All notes")
const placeIcon = (p: Place): LucideIcon => (p === "recent" ? History : p.startsWith("tag:") ? Hash : p === "folder:" ? Library : Folder)
const folderPlace = (p: Place) => (p.startsWith("folder:") ? p.slice(7) : null)

/** The notes the navigator lists: Markdown files that aren't hidden or archived (the store keeps each list's object
 *  while it's unchanged, so this runs again only when the files do). */
const notesOf = (files: Store["files"]["files"]): Note[] => files.filter((f) => !f.archived && !isHidden(f.path))
/** The pinned pages (the Pinned plugin's, the current workspace's with Workspaces on): pinned notes come first. */
function usePinned(store: Store) {
  useWorkspaceVersion()
  const list = workspacePins() ?? (store as { pinned?: string[] }).pinned ?? []
  return useMemo(() => new Set(list), [list.join("\n")]) // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------- previews: asked of the server for the notes listed, once per change of each ----------
const previews = new Map<string, { m: number; text: string; image: string }>()
/** Its number goes up as previews come in. */
function usePreviews(notes: Note[]) {
  const [n, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const want = notes.filter((n) => previews.get(n.path)?.m !== n.mtime)
    if (!want.length) return
    let live = true
    post<Record<string, [string, string]>>(`${ID}/previews`, { paths: want.map((n) => n.path) }).then((r) => {
      for (const n of want) { const x = r[n.path]; if (x) previews.set(n.path, { m: n.mtime, text: snippet(x[0]), image: x[1] }) }
      if (live) redraw()
    }, () => {})
    return () => { live = false }
  }, [notes])
  return n
}

/** Notes whose text has the words (the app's search), in a folder or anywhere; null while there's no query. */
function useFound(q: string, folder: string | null) {
  const [found, setFound] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!q.trim()) return setFound(null)
    const t = setTimeout(() => get<{ path: string }[]>(`search?q=${encodeURIComponent(q)}&limit=500${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`)
      .then((r) => setFound(new Set(r.map((x) => x.path))), () => setFound(new Set())), 150)
    return () => clearTimeout(t)
  }, [q, folder])
  return found
}

/** Add a tag to notes' frontmatter `tags` (those without it), with Undo. */
async function tagNotes(paths: string[], tag: string) {
  const was: [string, unknown][] = []
  for (const p of paths) {
    try {
      const fm = (parseYaml(splitFm((await readFile(p)).text).fm.replace(/^---\n|---\s*$/g, "")) ?? {}) as Record<string, unknown>
      const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/).filter(Boolean) : []
      if (tags.some((t) => t.replace(/^#/, "").toLowerCase() === tag.toLowerCase())) continue
      await setProperty(p, "tags", [...tags, tag])
      was.push([p, fm.tags])
    } catch (e) { notifyError(e, `Couldn't tag ${stem(p)}`) }
  }
  if (was.length) notify(`Tagged ${was.length === 1 ? stem(was[0][0]) : `${was.length} notes`} #${tag}`, { action: { label: "Undo", run: async () => {
    for (const [p, t] of was) await setProperty(p, "tags", t)
  } } })
}

/** What a drag carries that a place can take: its paths (several selected, or the one held). */
const pathsOf = (item: DragItem) => item.paths ?? (item.path ? [item.path] : [])

// ---------- the places ----------
type PlacesProps = { store: Store; notes: Note[]; s: Settings; save: (c: Settings) => Promise<void>; place: Place; pick: (p: Place, keys: boolean) => void }

function Places({ store, notes, s, save, place, pick }: PlacesProps) {
  const pinned = usePinned(store)
  const [open, setOpen] = useScopedState<string[]>(`${ID}:open`, [], "workspace")
  const deep = s.subfolders !== false
  const folders = useMemo(() => folderTree(store.files.folders.filter((f) => !isHidden(f) && !inArchive(`${f}/x`)), notes, deep), [store.files.folders, notes, deep])
  const tags = useMemo(() => tagTree(notes), [notes])
  const shortcuts = s.shortcuts ?? []
  const target = `${ID}:${useId()}`
  const hit = useDropHit<Place>(target)
  const [edge] = useState(edgeScroller)
  // A note (or several) dropped on a folder moves there; on a tag, gets it. (`data-drops`: a pane holding this leaves
  // files dropped here to it.)
  useDropTarget<Place>(target, (item, _x, y, el) => {
    const at = el?.closest<HTMLElement>("[data-nn-drop]")?.dataset.nnDrop, ps = pathsOf(item), box = el?.closest<HTMLElement>(`[data-nn-places="${target}"]`)
    if (!box || !ps.length) return (edge.stop(), null)
    // Near the edge of what scrolls the places, it scrolls (a folder further down).
    let sc: HTMLElement | null = box
    while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement
    if (sc) edge.near(sc, y)
    if (!at) return null
    if (at.startsWith("tag:")) return ps.some((p) => /\.md$/i.test(p) && !notes.find((n) => n.path === p)?.tags?.some((t) => t.toLowerCase() === at.slice(4).toLowerCase())) ? at : null
    const f = at.slice(7)
    return ps.some((p) => folderOf(p) !== f && p !== f && !f.startsWith(`${p}/`)) ? at : null
  }, (item, at) => {
    const ps = pathsOf(item)
    if (at.startsWith("tag:")) void tagNotes(ps.filter((p) => /\.md$/i.test(p)), at.slice(4))
    else void moveManyInto(ps, at.slice(7), { reveal: false })
  }, { hint: (at) => (at.startsWith("tag:") ? `Tag ${placeName(at)}` : `Move to ${placeName(at)}`), end: edge.stop })

  const toggleShortcut = (p: Place) => {
    const next = shortcuts.includes(p) ? shortcuts.filter((x) => x !== p) : [...shortcuts, p]
    return save({ shortcuts: next.length ? next : null })
  }
  const menu = (p: Place): MenuItem[] => {
    const f = folderPlace(p)
    const star: MenuItem = shortcuts.includes(p) ? { label: "Remove from shortcuts", icon: StarOff, run: () => void toggleShortcut(p) } : { label: "Add to shortcuts", icon: Star, run: () => void toggleShortcut(p) }
    if (p === "recent") return []
    if (f === null) return [{ label: "New note", icon: SquarePen, run: () => void newNote(store, p) }, star]
    return [
      { label: "New note", icon: SquarePen, run: () => void newNote(store, p) },
      ...(f ? [star, { label: "Move folder to…", icon: FolderInput, sep: true, run: () => askMove(f) }, { label: "Copy path", icon: Copy, run: () => void copyText(f) },
        { label: "Delete", icon: Trash2, danger: true, sep: true, run: () => void deleteFile(f).catch((e) => notifyError(e)) }] : []),
    ]
  }
  // `depth` null: a row of its own (not in a tree), without a chevron's room.
  const row = (p: Place, count: number | null, depth: number | null = null, kids: Node[] = []) => {
    const shown = open.includes(p)
    return (
      <div key={p}>
        <div data-nn-drop={p === "recent" ? undefined : p} className={cn("flex items-center rounded-[5px]", hit === p && "bg-primary/10 ring-1 ring-primary/50")}
          style={{ paddingLeft: (depth ?? 0) * 14 }} onContextMenu={menuFor(() => menu(p))}>
          {kids.length ? (
            <button type="button" aria-expanded={shown} aria-label={shown ? `Fold ${placeName(p)}` : `Show what's in ${placeName(p)}`}
              onClick={() => setOpen(shown ? open.filter((k) => k !== p) : [...open, p])} className="grid size-4 shrink-0 cursor-pointer place-items-center text-muted-foreground">
              <ChevronRight className={cn("size-3.5 transition-transform", shown && "rotate-90")} strokeWidth={2.5} />
            </button>
          ) : depth !== null && <span className="size-4 shrink-0" />}
          <SidebarRow data-nn-place={p} icon={placeIcon(p)} label={placeName(p).replace(/^#/, "")} open active={place === p} className="min-w-0 flex-1"
            onClick={(e) => pick(p, e.detail === 0)}>
            {count !== null && <span className="text-[12px] text-tertiary tabular-nums">{count}</span>}
          </SidebarRow>
        </div>
        {shown && kids.map((k) => row(p.startsWith("tag:") ? `tag:${k.key}` : `folder:${k.key}`, k.count, (depth ?? 0) + 1, k.kids))}
      </div>
    )
  }
  const pinnedNotes = notes.filter((n) => pinned.has(n.path))
  const countOf = (p: Place) => notesIn(notes, p, deep, []).length
  return (
    <PanelFold.Provider value={null}>
      <div data-nn-places={target} data-drops className="flex flex-col pb-2">
        {row("folder:", notes.length)}
        {row("recent", null)}
        {(shortcuts.length > 0 || pinnedNotes.length > 0) && <SidebarHeading title="Shortcuts" open sticky={false} />}
        {shortcuts.map((p) => row(p, countOf(p)))}
        {pinnedNotes.map((n) => (
          <div key={n.path} className="flex items-center" onContextMenu={menuFor(() => fileMenu(n.path, { phone: !isDesktop() }))}>
            <SidebarRow icon={FileText} label={stem(n.path)} open className="min-w-0 flex-1" onClick={(e) => openFile(n.path, { newTab: e.metaKey || e.ctrlKey || e.button === 1 })} />
          </div>
        ))}
        {folders.length > 0 && <SidebarHeading title="Folders" open sticky={false} />}
        {folders.map((f) => row(`folder:${f.key}`, f.count, 0, f.kids))}
        {tags.length > 0 && <SidebarHeading title="Tags" open sticky={false} />}
        {tags.map((t) => row(`tag:${t.key}`, t.count, 0, t.kids))}
      </div>
    </PanelFold.Provider>
  )
}

/** A new note in a folder (a tag's: where new notes go, with the tag), opened with its name ready to type. */
async function newNote(store: Store, place: Place) {
  const tag = place.startsWith("tag:") ? place.slice(4) : null
  const folder = folderPlace(place) ?? newNoteFolder(store)
  try {
    const f = await createFile(folder, freeName(store.files, folder, "Untitled"), tag ? `---\ntags:\n  - ${tag}\n---\n` : "")
    openNew(f.path)
  } catch (e) { notifyError(e, "Couldn't make the note") }
}

// ---------- the list ----------
const TIME = { hour: "numeric", minute: "2-digit" } as const
const DAY = { month: "short", day: "numeric" } as const
const DAY_YEAR = { month: "short", day: "numeric", year: "numeric" } as const
const MONTH = { month: "long" } as const
const MONTH_YEAR = { month: "long", year: "numeric" } as const
const month = (d: Date, year: boolean) => dateText(d, year ? MONTH_YEAR : MONTH)
function when(t: number) {
  const d = new Date(t), now = new Date()
  if (d.toDateString() === now.toDateString()) return dateText(d, TIME)
  return dateText(d, d.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR)
}

const NoteRow = memo(function NoteRow({ note, sort, active, folder, preview, dragged }: {
  note: Note; sort: Sort; active: boolean; folder: string | null; preview?: { text: string; image: string }; dragged: boolean }) {
  const p = note.path
  const picked = useSelected(ID, p)
  const there = folderOf(p)
  return (
    <a href={`#file/${encodeURIComponent(p)}`} data-keyrow data-nn-note={p} data-select-key={p} {...selectedAttr(picked)}
      onClick={(e) => { e.preventDefault(); if (!selectClick(e, ID, p, active ? p : null)) openFile(p, { newTab: e.metaKey || e.ctrlKey }) }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openFile(p, { newTab: true }) } }}
      onPointerDown={(e) => {
        openingSoon(p, true)
        const keys = selectionFor(ID, p, false)
        startDrag(e, keys && keys.length > 1 ? { from: "row", to: `file:${p}`, path: p, paths: keys, label: `${keys.length} notes` } : { from: "row", to: `file:${p}`, path: p, label: stem(p) }, { touch: true })
      }}
      onPointerEnter={() => openingSoon(p)} onPointerLeave={() => openingSoon(null)}
      onContextMenu={menuFor(rowMenu(ID, p, () => [
        openItem(() => openFile(p, { newTab: true }), isDesktop() ? () => openInSplit(`file:${p}`, "right") : undefined),
        ...fileMenu(p, { phone: !isDesktop() }).map((it, i) => (i ? it : { ...it, sep: true })),
      ]))}
      className={cn("flex gap-2 rounded-[6px] px-1.5 py-1.5 [contain-intrinsic-size:auto_58px] [content-visibility:auto]",
        active ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.04]", dragged && "opacity-50")}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5 font-medium">{stem(p)}</span>
        <span className="line-clamp-2 text-[12px] leading-4 text-muted-foreground">
          <span className="mr-1.5 text-foreground/75 tabular-nums">{when(timeOf(note, sort))}</span>
          {preview?.text}
        </span>
        {folder !== null && there !== folder && (
          <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] leading-4 text-tertiary"><Folder className="size-3 shrink-0" strokeWidth={2} />{nameOf(there) || "Vault"}</span>
        )}
      </span>
      {preview?.image && <img src={rawUrl(preview.image)} alt="" loading="lazy" draggable={false} className="size-10 shrink-0 self-center rounded-[5px] bg-foreground/[0.04] object-cover" />}
    </a>
  )
})

function List({ store, notes, s, save, place, active }: { store: Store; notes: Note[]; s: Settings; save: (c: Settings) => Promise<void>; place: Place; active: string }) {
  const pinned = usePinned(store)
  const recent = useOpenedFiles(store, 50)
  const [q, setQ] = useState("")
  const deep = s.subfolders !== false
  const sort = s.sorts?.[place] ?? s.sort ?? "modified"
  const folder = folderPlace(place)
  const all = useMemo(() => notesIn(notes, place, deep, place === "recent" ? recent : []), [notes, place, deep, place === "recent" && recent.join("\n")]) // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => (place === "recent" ? all : sortNotes(all, sort)), [all, sort, place])
  const seen = usePreviews(sorted)
  const found = useFound(q, folder || null)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = useMemo(() => (words.length ? sorted.filter((n) => words.every((w) => stem(n.path).toLowerCase().includes(w)) || found?.has(n.path)) : sorted),
    [sorted, found, q]) // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupNotes(shown, place === "recent" ? null : sort, pinned, new Date(), month), [shown, sort, pinned, place])
  useSelectable(ID, { menu: (keys) => filesMenu(keys), noun: ["note", "notes"] })
  // What's dragged, asked once here and passed on as text: a drag moves many times a second, the rows stay as they are.
  const d = useDrag(), dragged = d?.item.from === "row" ? pathsOf(d.item).join("\n") : ""
  const sortMenu = (e: React.MouseEvent) => menuBelow(e, SORTS.map((o) => ({ label: SORT_LABEL[o], checked: o === sort,
    run: () => {
      const rest = Object.fromEntries(Object.entries(s.sorts ?? {}).filter(([k]) => k !== place))
      void save({ sorts: o !== (s.sort ?? "modified") ? { ...rest, [place]: o } : Object.keys(rest).length ? rest : null })
    } })))
  const button = (label: string, Icon: LucideIcon, run: (e: React.MouseEvent) => void) => (
    <button type="button" aria-label={label} data-tip={label} onClick={run}
      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-[4px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
      <Icon className="size-[15px]" strokeWidth={2} />
    </button>
  )
  return (
    <div className="flex min-w-0 flex-col gap-1" data-nn-list={place}>
      <div className="flex h-7 items-center gap-1.5 pl-1.5">
        <span className="min-w-0 truncate text-[13px] font-semibold">{placeName(place)}</span>
        <span className="text-[12px] text-tertiary tabular-nums">{shown.length}</span>
        <span className="flex-1" />
        {place !== "recent" && button(`Sort: ${SORT_LABEL[sort].toLowerCase()}`, ArrowUpDown, sortMenu)}
        {place !== "recent" && button("New note", SquarePen, () => void newNote(store, place))}
      </div>
      <FilterField value={q} onChange={setQ} placeholder="Search notes" />
      <Rows groups={groups} sort={sort} active={active} folder={place.startsWith("folder:") ? folder : null} dragged={dragged} seen={seen} />
      {!shown.length && <p className="px-1.5 py-1 text-[13px] text-tertiary">{q ? "No notes match." : "No notes here yet."}</p>}
    </div>
  )
}

/** The list's rows under their headings (`seen`: previews that came in since, drawn again). */
const Rows = memo(function Rows({ groups, sort, active, folder, dragged }: {
  groups: ReturnType<typeof groupNotes>; sort: Sort; active: string; folder: string | null; dragged: string; seen: number }) {
  const out = new Set(dragged.split("\n"))
  return (
    <div data-select-list={ID} className="flex flex-col">
      {groups.map((g) => (
        <section key={g.label || "notes"} aria-label={g.label || "Notes"}>
          {g.label && <h3 className="px-1.5 pt-2 pb-0.5 text-[11px] font-semibold text-muted-foreground">{g.label}</h3>}
          {g.notes.map((n) => (
            <NoteRow key={n.path} note={n} sort={sort} active={n.path === active} folder={folder} preview={previews.get(n.path)} dragged={out.has(n.path)} />
          ))}
        </section>
      ))}
    </div>
  )
})

// ---------- the two panes ----------
/** `panel`: in the sidebar (side by side once it's wide, else stacked); `tab`: a tab of its own, each pane scrolling;
 *  `phone`: one pane at a time, the places until one is picked (`place`), as Notes does. */
export function Navigator({ store, active, mode, place: given }: { store: Store; active: string; mode: "panel" | "tab" | "phone"; place?: Place }) {
  const [data, save] = usePluginSettings(ID)
  const s = (data ?? {}) as Settings
  const [kept, setKept] = useScopedState<Place>(`${ID}:place`, "folder:", "workspace")
  const place = given ?? kept
  const notes = useMemo(() => notesOf(store.files.files), [store.files.files])
  const pick = (p: Place, keys: boolean) => {
    if (mode === "phone") return openView(`${ID}/${p}`)
    setKept(p)
    // From the keyboard, on into the list.
    if (keys) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-nn-list="${CSS.escape(p)}"] [data-keyrow]`)?.focus())
  }
  const places = <Places store={store} notes={notes} s={s} save={save} place={place} pick={pick} />
  const list = <List store={store} notes={notes} s={s} save={save} place={place} active={active} />
  if (mode === "phone") return <div className="h-full overflow-y-auto px-3 pt-2 pb-10"><div data-size-up data-keylist>{given ? list : places}</div></div>
  const tab = mode === "tab"
  return (
    <div data-keylist className={cn("@container", tab && "h-full")}>
      <div className={cn("flex flex-col gap-2 @md:flex-row @md:items-start", tab && "h-full overflow-y-auto p-2 @md:overflow-visible @md:p-0")}>
        <div className={cn("shrink-0 @md:w-[38%] @md:max-w-64", tab ? "border-border @md:h-full @md:overflow-y-auto @md:border-r @md:p-2" : "max-h-[40vh] overflow-y-auto @md:sticky @md:top-7 @md:max-h-[calc(100dvh-7rem)]")}>
          {tab ? <div data-size-up>{places}</div> : places}
        </div>
        <div className={cn("min-w-0 flex-1", tab && "@md:h-full @md:overflow-y-auto @md:p-2")}>{tab ? <div data-size-up>{list}</div> : list}</div>
      </div>
    </div>
  )
}
