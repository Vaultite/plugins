// A drawing drawn by Excalidraw (its own chunk). The file's text is the only state: changes are written back (codec.ts)
// and text changed under it (an AI, another device) goes into the scene. `Preview` is a still SVG for embeds.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CaptureUpdateAction, Excalidraw, exportToSvg, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw"
import type { AppState, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, SocketId } from "@excalidraw/excalidraw/types"
import "@excalidraw/excalidraw/index.css"
import "./scheme.css"
import { registerCanvas, runShortcut, type CanvasPeer, type FormatCtx, type Store } from "@vaultite"
import type { Codec } from "./codec"
import { applyActions, describe, type El, itemsOf, layout, type Point } from "./scene"

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

export default function Drawing({ store, path, text, editable, onChange, place, codec }: FormatCtx & { codec: Codec }) {
  const dark = useDark()
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  // The text last seen or written: onChange fires for every pointer move and scroll, but only a different drawing is
  // written; a `text` that differs from it came from elsewhere.
  const last = useRef(text)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [initial] = useState<ExcalidrawInitialDataState>(() => ({ ...parse(codec, text), scrollToContent: true }))
  const [ready, setReady] = useState<ExcalidrawImperativeAPI | null>(null)
  // (its scene loads after the API is there: others read it from then on)
  const [loaded, setLoaded] = useState(false)

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

  const pointer = useRef<Point | null>(null)
  const subs = useRef(new Set<(outside?: string[]) => void>())
  const fire = (outside?: string[]) => { for (const fn of [...subs.current]) fn(outside) }

  useEffect(() => {
    if (text === last.current || !api.current) return
    let scene: Scene, base: Scene
    try { scene = parse(codec, text) } catch { return } // half-written by hand: wait for the next change
    try { base = parse(codec, last.current) } catch { base = { elements: [], appState: {}, files: {}, embedded: {} } }
    last.current = text
    const files = Object.values(scene.files)
    if (files.length) api.current.addFiles(files)
    const bg = scene.appState.viewBackgroundColor
    const local = api.current.getSceneElementsIncludingDeleted()
    const m = merged(base.elements, local, scene.elements)
    // (not into the undo history: it's not the user's own step)
    api.current.updateScene({ elements: restoreElements(m.elements as unknown as Elements, local), captureUpdate: CaptureUpdateAction.NEVER,
      ...(bg ? { appState: { viewBackgroundColor: bg } } : {}) })
    if (m.theirs.length) fire(m.theirs)
  }, [text])

  // On the canvases others reach (registerCanvas): its items, the user's pointer, others drawn as its collaborators.
  // (registered as a layout effect: it goes before Excalidraw does, while its scene can still be read)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!ready || !loaded || !el || place === "embed") return
    const ps = new Peers(ready)
    const offs = [ready.onChange(() => fire()), ready.onScrollChange(() => { fire(); ps.follow() }), ready.onUserFollow((f) => ps.following(f.action === "FOLLOW" ? f.userToFollow.socketId : null))]
    const off = registerCanvas({
      path, el,
      items: () => itemsOf(ready.getSceneElements()),
      describe: (at) => describe(ready.getSceneElements(), at),
      view: () => { const s = ready.getAppState(), z = s.zoom.value; return { x: -s.scrollX, y: -s.scrollY, w: s.width / z, h: s.height / z } },
      editing: () => ready.getAppState().editingTextElement?.id ?? null,
      pointer: () => pointer.current,
      selected: () => Object.entries(ready.getAppState().selectedElementIds).filter(([, on]) => on).map(([id]) => id),
      toScreen: (p) => toScreen(ready, el, p),
      setPeers: (next) => ps.set(next),
      ...(editable ? { apply: (actions: unknown[], by?: string) => draw(ready, actions, by ? (p) => ps.move(by, p) : undefined) } : {}),
      subscribe: (fn) => { subs.current.add(fn); return () => { subs.current.delete(fn) } },
    })
    return () => { off(); for (const o of offs) o(); ps.stop() }
  }, [ready, loaded, path, place, editable])

  // Excalidraw keeps keys it knows (⌘E, ⌘K, ⌘P) from the app: the app's shortcuts go to the app first. Its tools'
  // letters and Space (pan) stay its own (`data-keeps-keys`: Vim's keys and its leader don't take them).
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
        onPointerUpdate={(p) => { pointer.current = { x: p.pointer.x, y: p.pointer.y }; fire() }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
        onChange={(elements, appState, files) => {
          if (!loaded) setLoaded(true)
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

/** The scene with a change from elsewhere (`remote`) folded in: what the user changed since the text it was drawn from
 *  (`base`) stays theirs, the rest is as the file has it now (gone from it: gone). `theirs`: the items that came so (a
 *  label's, its shape). */
function merged(base: readonly El[], local: readonly El[], remote: readonly El[]) {
  const was = new Map(base.map((e) => [e.id, e.version])), there = new Map(remote.map((e) => [e.id, e]))
  const mine = (e: El) => !was.has(e.id) || was.get(e.id) !== e.version
  const out = local.flatMap((e) => (mine(e) ? [e] : there.has(e.id) ? [there.get(e.id)!] : []))
  const have = new Set(out.map((e) => e.id)), added = remote.filter((e) => !have.has(e.id))
  const changed = [...local.filter((e) => !mine(e) && (there.get(e.id)?.version !== e.version || there.get(e.id)?.isDeleted !== e.isDeleted)), ...added]
  const theirs = new Set(changed.flatMap((e) => [e.id, ...(e.containerId ? [e.containerId] : [])]))
  return { elements: [...out, ...added], theirs: [...theirs] }
}

/** A point of the scene on screen. */
function toScreen(api: ExcalidrawImperativeAPI, el: HTMLElement, p: Point): Point {
  const s = api.getAppState(), box = (el.querySelector(".excalidraw") ?? el).getBoundingClientRect()
  return { x: (p.x + s.scrollX) * s.zoom.value + box.left, y: (p.y + s.scrollY) * s.zoom.value + box.top }
}

/** Typed actions (scene.ts) made as one step undo takes back, all checked first (none is made when one doesn't fit),
 *  then `by`'s pointer goes over what they touched. Those ids, in order. */
async function draw(api: ExcalidrawImperativeAPI, actions: unknown[], by?: (p: Point) => void): Promise<string[]> {
  const now = api.getSceneElementsIncludingDeleted()
  const made = applyActions(now, actions)
  const els = restoreElements(made.elements as unknown as Elements, now, { refreshDimensions: true, repairBindings: true }) as El[]
  layout(els, new Set(made.touched))
  // (at once: a step at a time, Excalidraw's own updates between them, as fonts loading, would leave some out of undo)
  api.updateScene({ elements: els as never, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  for (const id of by ? made.touched.slice(0, 8) : []) {
    const e = els.find((x) => x.id === id)
    if (!e) continue
    by!({ x: e.x + e.width / 2, y: e.y + e.height })
    await new Promise((ok) => setTimeout(ok, 160))
  }
  return made.touched
}

/** A colour's hue (rgb() or #hex), or null. */
function hueOf(color: string) {
  const m = /rgba?\((\d+)\D+(\d+)\D+(\d+)/.exec(color), h = /^#([0-9a-f]{6})$/i.exec(color)
  const [r, g, b] = m ? m.slice(1).map(Number) : h ? [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16)) : []
  if (r === undefined) return null
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  if (!d) return null
  const x = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return x * 60
}
/** Excalidraw colours a collaborator by a hash of its id (a hue, in tens of degrees): the id for `id` whose hue is
 *  nearest `color`'s, so its cursor, name and selection show in the agent's colour. */
const ids = new Map<string, string>()
function idFor(id: string, color: string) {
  const k = `${id}\n${color}`, want = hueOf(color)
  if (want === null) return id
  if (ids.has(k)) return ids.get(k)!
  // (its hash as Excalidraw's own)
  const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i); return (Math.abs(h) % 37) * 10 }
  let best = id, far = 360
  for (let n = 0; n < 300 && far > 5; n++) {
    const c = n ? `${id}~${n}` : id, d = Math.abs(hue(c) - want), off = Math.min(d, 360 - d)
    if (off < far) { far = off; best = c }
  }
  ids.set(k, best)
  return best
}

/** Others on the drawing as Excalidraw's own collaborators: each one's pointer glides to where it goes, and the view
 *  keeps the one the user follows (a click on them, top right) in sight. */
class Peers {
  list: CanvasPeer[] = []
  at = new Map<string, Point>()
  to = new Map<string, Point>()
  frame = 0
  followed: string | null = null
  key = ""
  readonly api: ExcalidrawImperativeAPI
  constructor(api: ExcalidrawImperativeAPI) { this.api = api }
  // (a peer drawing goes where its strokes are, whatever else says for a moment)
  driven = new Map<string, number>()
  set(next: CanvasPeer[]) {
    const key = JSON.stringify(next)
    if (key === this.key) return
    this.key = key
    this.list = next
    for (const p of next) {
      if (Date.now() - (this.driven.get(p.id) ?? 0) > 1500) this.to.set(p.id, { x: p.x, y: p.y })
      if (!this.at.has(p.id)) this.at.set(p.id, { x: p.x, y: p.y })
    }
    this.glide()
  }
  move(id: string, p: Point) { if (this.list.some((x) => x.id === id)) { this.driven.set(id, Date.now()); this.to.set(id, p); this.glide() } }
  following(id: string | null) { this.followed = id; this.follow() }
  follow() {
    const p = this.followed ? this.to.get(this.followed) : null
    if (!p) return
    const s = this.api.getAppState(), z = s.zoom.value
    const x = (p.x + s.scrollX) * z, y = (p.y + s.scrollY) * z
    if (x > s.width * 0.1 && x < s.width * 0.9 && y > s.height * 0.1 && y < s.height * 0.9) return
    this.api.updateScene({ appState: { scrollX: s.width / 2 / z - p.x, scrollY: s.height / 2 / z - p.y } })
  }
  glide() {
    if (this.frame) return
    const step = () => {
      this.frame = 0
      let moving = false
      for (const p of this.list) {
        const a = this.at.get(p.id)!, b = this.to.get(p.id)!
        const nx = a.x + (b.x - a.x) * 0.22, ny = a.y + (b.y - a.y) * 0.22, done = Math.hypot(b.x - nx, b.y - ny) < 0.5
        this.at.set(p.id, done ? b : { x: nx, y: ny })
        moving ||= !done
      }
      this.draw()
      if (moving) this.frame = requestAnimationFrame(step)
      else this.follow()
    }
    this.frame = requestAnimationFrame(step)
  }
  draw() {
    const map = new Map<SocketId, Collaborator>(this.list.map((p) => [p.id as SocketId, {
      id: idFor(p.id, p.color), socketId: p.id as SocketId, username: p.busy ? `${p.name} …` : p.name, color: { background: p.color, stroke: p.color },
      pointer: { ...this.at.get(p.id)!, tool: "pointer" }, button: "up", selectedElementIds: Object.fromEntries((p.selected ?? []).map((id) => [id, true])),
    }]))
    // (not NEVER: that takes in what an unfinished drawing did, so its undo would miss it)
    this.api.updateScene({ collaborators: map })
  }
  stop() { cancelAnimationFrame(this.frame); this.list = []; try { this.api.updateScene({ collaborators: new Map() }) } catch { /* gone */ } }
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
