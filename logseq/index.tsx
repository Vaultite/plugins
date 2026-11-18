// "Import a Logseq graph…": its folder (sent file by file) or a zip of it, then the import's job followed in a toast;
// "Export a folder as a Logseq graph…": a zip of it, downloaded.
import { FileInput, FileOutput, FolderOpen, FileArchive } from "lucide-react"
import { choose, chooseFolder, definePlugin, Group, notify, notifyError, SettingRow } from "@vaultite"
import type { Job } from "./job"

const TOAST = "logseq-import"
const HEADERS = { "X-Vaultite-Client": "app" }
/** What Logseq keeps for itself in a graph's folder: never sent. */
const NOISE = /(^|\/)(\.[^/]*|node_modules|logseq\/bak|logseq\/\.recycle|logseq\/version-files|version-files)(\/|$)/i

function summary(j: Job) {
  if (j.state === "failed") return `Couldn't import ${j.name}: ${j.error ?? "it failed"}`
  const parts = [`${j.created} new`]
  if (j.unchanged) parts.push(`${j.unchanged} imported before`)
  if (j.files) parts.push(`${j.files} asset${j.files === 1 ? "" : "s"}`)
  return `Logseq: ${j.pages} page${j.pages === 1 ? "" : "s"} and ${j.journals} journal${j.journals === 1 ? "" : "s"} (${parts.join(", ")}).`
}

async function follow(started: Response, name: string) {
  let job: Job = await started.json().catch(() => ({}))
  if (!started.ok) throw new Error(job.error ?? `${started.status}`)
  while (job.state === "queued" || job.state === "running") {
    notify(job.state === "queued" ? "Waiting for the import before it…" : `Importing ${name}… ${job.notes} of ${job.total || "?"} pages`, { id: TOAST, duration: Infinity })
    await new Promise((r) => setTimeout(r, 700))
    job = await fetch(`api/logseq/jobs/${job.id}`, { headers: HEADERS }).then((r) => r.json())
  }
  notify(summary(job), job.state === "failed" ? { id: TOAST, kind: "error" } : { id: TOAST, duration: 12000 })
}

async function sendFolder(files: File[]) {
  const top = files[0]?.webkitRelativePath.split("/")[0] || "graph"
  const wanted = files.filter((f) => !NOISE.test(f.webkitRelativePath.split("/").slice(1).join("/")))
  if (!wanted.length) return
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  try {
    let sent = 0, next = 0
    const one = async () => {
      while (next < wanted.length) {
        const f = wanted[next++]
        const rel = f.webkitRelativePath.split("/").slice(1).join("/")
        const r = await fetch(`api/logseq/upload/${token}?path=${encodeURIComponent(rel)}`, { method: "POST", body: f, headers: { ...HEADERS, "Content-Type": "application/octet-stream" } })
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`)
        if (++sent % 25 === 0) notify(`Sending ${top}… ${sent} of ${wanted.length} files`, { id: TOAST, duration: Infinity })
      }
    }
    notify(`Sending ${top}…`, { id: TOAST, duration: Infinity })
    await Promise.all(Array.from({ length: 4 }, one))
    await follow(await fetch("api/logseq/import", { method: "POST", body: JSON.stringify({ upload: token, name: top }), headers: { ...HEADERS, "Content-Type": "application/json" } }), top)
  } catch (e) {
    notifyError(e, `Couldn't import ${top}`, { id: TOAST })
  }
}

async function sendZip(file: File) {
  try {
    notify(`Sending ${file.name}…`, { id: TOAST, duration: Infinity })
    await follow(await fetch(`api/logseq/import?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file, headers: { ...HEADERS, "Content-Type": "application/octet-stream" } }), file.name)
  } catch (e) {
    notifyError(e, `Couldn't import ${file.name}`, { id: TOAST })
  }
}

function pick(folder: boolean) {
  const input = document.createElement("input")
  input.type = "file"
  if (folder) input.webkitdirectory = true
  else input.accept = ".zip,application/zip"
  input.style.display = "none"
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])]
    input.remove()
    if (folder) void sendFolder(files)
    else if (files[0]) void sendZip(files[0])
  })
  document.body.append(input)
  input.click()
}

function importGraph() {
  choose({
    title: "Import a Logseq graph", heading: "Import a Logseq graph", placeholder: "From…",
    items: [
      { id: "folder", label: "The graph's folder…", detail: "the folder with pages/ and journals/", icon: FolderOpen },
      { id: "zip", label: "A zip of it…", detail: "the folder zipped, or the Logseq DB version's Markdown export", icon: FileArchive },
    ],
    onPick: (item) => pick(item.id === "folder"),
  })
}

function exportGraph() {
  chooseFolder("Export as a Logseq graph", (folder) => {
    const a = document.createElement("a")
    a.href = `api/logseq/export?folder=${encodeURIComponent(folder || "/")}`
    a.download = ""
    document.body.append(a)
    a.click()
    a.remove()
    notify(`Exporting ${folder || "the vault"} as a Logseq graph: the zip downloads when it's ready.`)
  })
}

function SettingsPanel() {
  return (
    <div>
      <Group>
        <SettingRow label="Import a Logseq graph…" sub="Its folder (with pages/ and journals/) or a zip of it: pages become notes, journals daily notes" onClick={importGraph} chevron={FileInput} />
        <SettingRow label="Export a folder as a Logseq graph…" sub="A zip Logseq opens: notes as pages, daily notes as journals, tasks as TODO and DONE" onClick={exportGraph} chevron={FileOutput} />
      </Group>
      <p className="mt-1.5 px-1 text-[13px] leading-[18px] text-muted-foreground">Importing again adds only pages and journals that weren't imported before; the notes already here stay as they are. Whiteboards aren't imported.</p>
    </div>
  )
}

export default definePlugin({
  commands: [
    { id: "logseq:import", name: "Import a Logseq graph…", run: importGraph, icon: FileInput },
    { id: "logseq:export", name: "Export a folder as a Logseq graph…", run: exportGraph, icon: FileOutput },
  ],
  settingsPanel: () => <SettingsPanel />,
  settingsPanelFirst: true,
})
