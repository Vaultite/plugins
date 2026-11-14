// Org Mode: .org files read as notes (headings that fold, TODO keywords and dates as chips, tables, code, math), edited
// in a live preview (the syntax drawn off the cursor's line, boxes and keywords clickable) and as highlighted source.
import { lazy, Suspense } from "react"
import { ListTree } from "lucide-react"
import { besideActive, currentEditor, definePlugin, freeName, getStore, Loading, openNew, post, reload, type FileFormat } from "@vaultite"
import { SAMPLE } from "./sample.ts"

const OrgDocument = lazy(() => import("./view/Document.tsx").then((m) => ({ default: m.OrgDocument })))
const LiveEditor = lazy(() => import("./view/Live.tsx").then((m) => ({ default: m.LiveEditor })))
const source = () => import("./editor/source.ts")

const isOrg = (path?: string) => !!path && /\.org$/i.test(path)

async function newOrgFile(folder = besideActive("")) {
  const s = getStore()
  const name = s ? freeName(s.files, folder, "Untitled", ".org") : "Untitled"
  const f = await post<{ path: string }>("file", { path: `${folder ? `${folder}/` : ""}${name}.org`, text: "", unique: true })
  await reload()
  return f.path
}

const format: FileFormat = {
  exts: ["org"], icon: ListTree, tint: "var(--green)", code: "text", page: true, layout: "full", prose: true,
  render: ({ store, path, text, editable, onChange, place }) => (
    <Suspense fallback={<Loading />}>
      {editable ? <LiveEditor key={path} store={store} path={path} text={text} onChange={onChange} />
        : <OrgDocument store={store} path={path} text={text} place={place} />}
    </Suspense>
  ),
  embed: ({ store, path, text, subpath }) => (
    <Suspense fallback={<Loading />}>
      <OrgDocument store={store} path={path} text={text} place="embed" subpath={subpath} />
    </Suspense>
  ),
}

/** The .org file's source editor that has the keyboard, if one does. */
const orgEditor = () => { const e = currentEditor(); return e && isOrg(e.path) ? e.view : null }

export default definePlugin({
  formats: { org: format },
  // (source mode only: live preview is the format's own editor, with its own drawing)
  editor: async (ctx) => (ctx.source && isOrg(ctx.path) ? (await source()).orgSource : []),
  newFiles: [{ label: "Org file", icon: ListTree, make: newOrgFile }],
  commands: [
    { id: "org:new", name: "New Org file", icon: ListTree, run: () => void newOrgFile().then((p) => openNew(p)) },
    { id: "org:cycle-todo", name: "Cycle the headline's TODO keyword", when: () => !!orgEditor(),
      run: () => { const v = orgEditor(); if (v) void source().then((m) => m.cycleKeyword(v)) } },
    { id: "org:toggle-checkbox", name: "Tick the checkbox on this line", when: () => !!orgEditor(),
      run: () => { const v = orgEditor(); if (v) void source().then((m) => m.toggleBox(v)) } },
  ],
  preview: () => (
    <Suspense fallback={<Loading />}>
      <OrgDocument path="Lighthouse.org" text={SAMPLE} place="preview" />
    </Suspense>
  ),
})
