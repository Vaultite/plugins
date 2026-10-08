// Kanban: Obsidian Kanban's boards (a file with `kanban-plugin: board`, its type "kanban") drawn as lanes of cards while
// read (Board.tsx); editing shows the Markdown. "New board" makes one where new notes go, opened as a board (not as a
// new note's editing, which would show its Markdown).
import { lazy, Suspense } from "react"
import { SquareKanban } from "lucide-react"
import { definePlugin, freeName, getStore, newNoteFolder, openFile, PageHeader, post, reload, splitFm, type PageCtx, type Store } from "@vaultite"
import { newBoard } from "./format"

const Board = lazy(() => import("./Board"))

async function makeBoard(folder = newNoteFolder(getStore())) {
  const s = getStore()
  const name = s ? freeName(s.files, folder, "Board") : "Board"
  const f = await post<{ path: string }>("file", { path: `${folder ? `${folder}/` : ""}${name}.md`, text: newBoard(), unique: true })
  await reload()
  return f.path
}

const board = (ctx: PageCtx) => <Suspense fallback={<div className="min-h-40" aria-busy />}><Board {...ctx} /></Suspense>

// A made-up board for the Plugins sheet.
const SAMPLE = splitFm(`---
kanban-plugin: board
---
## To do

- [ ] Draft the launch post for [[Lighthouse]] @{2026-10-12}
- [ ] Ask Alice Park about the beta list #beta

## Doing

- [ ] Fix the onboarding copy

## Done

**Complete**
- [x] Ship the beta to Bob Lee
`).body

export default definePlugin({
  icon: SquareKanban,
  files: {
    types: ["kanban"], icon: SquareKanban, tint: "var(--kanban)",
    page: {
      // In a tab the board's name is its title; in a sheet the file's title is there already.
      header: (ctx) => (ctx.place === "page" ? <PageHeader title={ctx.title} className="mb-4" /> : null),
      render: (ctx) => board(ctx),
    },
  },
  newFiles: [{ label: "New board", icon: SquareKanban, make: makeBoard }],
  commands: [{ id: "kanban:new", name: "New board", icon: SquareKanban, run: () => void makeBoard().then((p) => openFile(p)) }],
  preview: (mock: Store) => <div className="pointer-events-none">{board({ store: mock, path: "Lighthouse board.md", fm: {}, body: SAMPLE, title: "Lighthouse board", place: "sheet", disabled: [] })}</div>,
})
