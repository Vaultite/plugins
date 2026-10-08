// A drawing drawn by Excalidraw (its own chunk). The file's text is the only state: changes are written back (codec.ts)
// and text changed under it (an AI, another device) goes into the scene. `Preview` is a still SVG for embeds.
import { useEffect, useMemo, useRef, useState } from "react"
import { Excalidraw, exportToSvg, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw"
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types"
import "@excalidraw/excalidraw/index.css"
import { runShortcut, type FormatCtx, type Store } from "@vaultite"
import type { Codec } from "./codec"

type Elements = Parameters<typeof serializeAsJSON>[0]
type Scene = { elements: Elements; appState: Partial<AppState>; files: BinaryFiles; embedded: Record<string, string> }
const parse = (codec: Codec, text: string) => codec.read(text) as unknown as Scene

/** Obsidian's images (file id -> [[name]]), read from the vault as data URLs; ones it can't find are left out. */
async function embeddedFiles(store: Store, embedded: Record<string, string>): Promise<BinaryFiles> {
  const all = [...store.files.others, ...store.files.files].map((f) => f.path)
  const out: BinaryFiles = {}
  await Promise.all(Object.entries(embedded).map(async ([id, name]) => {
    const low = name.toLowerCase()
    const path = all.find((p) => p.toLowerCase() === low) ?? all.find((p) => p.split("/").pop()!.toLowerCase() === low.split("/").pop())
    if (!path) return
    try {
      const blob = await (await fetch(`api/raw?path=${encodeURIComponent(path)}`)).blob()
      const dataURL = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(blob) })
      out[id] = { id, dataURL, mimeType: blob.type || "image/png", created: Date.now() } as BinaryFiles[string]
    } catch { /* gone meanwhile */ }
  }))
  return out
}

/** The app's colour mode (the `dark` class on <html>), followed as it changes. */
function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => o.disconnect()
  }, [])
  return dark
}

export default function Drawing({ store, text, editable, onChange, codec }: FormatCtx & { codec: Codec }) {
  const dark = useDark()
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  // The text last seen or written: onChange fires for every pointer move and scroll, but only a different drawing is
  // written; a `text` that differs from it came from elsewhere.
  const last = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [initial] = useState<ExcalidrawInitialDataState>(() => ({ ...parse(codec, text), scrollToContent: true }))
  const [ready, setReady] = useState<ExcalidrawImperativeAPI | null>(null)

  // Obsidian's images, once Excalidraw is there (and again when the file names others).
  const embedded = useMemo(() => { try { return JSON.stringify(parse(codec, text).embedded ?? {}) } catch { return "{}" } }, [codec, text])
  useEffect(() => {
    const want = JSON.parse(embedded) as Record<string, string>
    if (!ready || !Object.keys(want).length) return
    let on = true
    embeddedFiles(store, want).then((f) => { if (on && Object.keys(f).length) ready.addFiles(Object.values(f)) })
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, embedded])

  useEffect(() => {
    if (text === last.current || !api.current) return
    last.current = text
    let scene: Scene
    try { scene = parse(codec, text) } catch { return } // half-written by hand: wait for the next change
    const files = Object.values(scene.files)
    if (files.length) api.current.addFiles(files)
    const bg = scene.appState.viewBackgroundColor
    api.current.updateScene({ elements: restoreElements(scene.elements, null), ...(bg ? { appState: { viewBackgroundColor: bg } } : {}) })
  }, [text])

  // Excalidraw keeps keys it knows (⌘E, ⌘K, ⌘P) from the app: the app's shortcuts go to the app first. Its tools'
  // letters and Space (pan) stay its own (`data-keeps-keys`: Vim's keys and its leader don't take them).
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (wrap.current?.contains(e.target as Node) && runShortcut(e)) e.stopPropagation() }
    addEventListener("keydown", on, true)
    return () => removeEventListener("keydown", on, true)
  }, [])

  // Leaving with a change still waiting: write it now.
  const flush = useRef<() => void>(() => {})
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); flush.current() } }, [])

  return (
    <div ref={wrap} className="absolute inset-0" data-excalidraw data-keeps-keys>
      <Excalidraw
        initialData={initial}
        excalidrawAPI={(a) => { api.current = a; setReady(a) }}
        viewModeEnabled={!editable}
        theme={dark ? "dark" : "light"}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
        onChange={(elements, appState, files) => {
          if (!editable) return
          flush.current = () => {
            timer.current = null
            const next = codec.write(last.current, serializeAsJSON(elements, appState, files, "local"))
            if (next === last.current) return
            last.current = next
            onChange(next)
          }
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => flush.current(), 300)
        }}
      />
    </div>
  )
}

/** A still picture of the drawing, fit to its box. */
export function Preview({ store, text, codec }: { store?: Store; text: string; codec: Codec }) {
  const dark = useDark()
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    let scene: Scene
    try { scene = parse(codec, text) } catch (e) { setError(String((e as Error).message ?? e)); return }
    setError(null)
    if (!scene.elements.some((e) => !(e as { isDeleted?: boolean }).isDeleted)) { if (ref.current) ref.current.replaceChildren(); return }
    const images = store && Object.keys(scene.embedded ?? {}).length ? embeddedFiles(store, scene.embedded) : Promise.resolve({} as BinaryFiles)
    images.then((more) => exportToSvg({
      elements: restoreElements(scene.elements, null),
      appState: { ...scene.appState, exportBackground: false, exportWithDarkMode: dark },
      files: { ...scene.files, ...more },
      exportPadding: 16,
    })).then((svg: SVGSVGElement) => {
      if (!on || !ref.current) return
      svg.removeAttribute("width")
      svg.removeAttribute("height")
      svg.style.width = "100%"
      svg.style.height = "100%"
      ref.current.replaceChildren(svg)
    }).catch((e: unknown) => on && setError(String((e as Error)?.message ?? e)))
    return () => { on = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, dark])
  if (error) return <p className="p-4 text-[15px] text-muted-foreground">This drawing couldn't be drawn: {error}</p>
  return <div ref={ref} className="absolute inset-0 p-2" data-excalidraw-preview />
}
