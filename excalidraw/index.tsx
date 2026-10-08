// Excalidraw: .excalidraw files (and Obsidian's .excalidraw.md, codec.ts) open as a whiteboard, saved like any file;
// `![[Diagram.excalidraw]]` shows a picture of it. Its fonts come from this server (plugin.ts), not the network.
import { lazy, Suspense, type ReactNode } from "react"
import { PenTool } from "lucide-react"
import { besideActive, definePlugin, freeName, getStore, openNew, post, reload, type FileFormat } from "@vaultite"
import { obsidian, plain, type Codec } from "./codec"

const Drawing = lazy(() => import("./Drawing"))
const Preview = lazy(() => import("./Drawing").then((m) => ({ default: m.Preview })))

// Excalidraw loads its fonts from here (the path is resolved against it: fonts/<family>/<file>.woff2).
;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL("api/excalidraw/", location.href.split("#")[0]).href

const EMPTY = JSON.stringify({ type: "excalidraw", version: 2, source: "vaultite", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} }, null, 2)

/** Where a new drawing goes: next to the note being written (not a page: a dashboard), else Drawings/. */
const whereNew = () => besideActive("Drawings")

async function newDrawing(folder = whereNew()) {
  const s = getStore()
  const name = s ? freeName(s.files, folder, "Drawing", ".excalidraw") : "Drawing"
  const f = await post<{ path: string }>("file", { path: `${folder ? `${folder}/` : ""}${name}.excalidraw`, text: EMPTY, unique: true })
  await reload()
  return f.path
}

const box = (node: ReactNode) => <Suspense fallback={<div className="absolute inset-0" aria-busy />}>{node}</Suspense>

const format = (exts: string[], codec: Codec, json: boolean): FileFormat => ({
  exts, icon: PenTool, tint: "var(--purple)", json, layout: "pane",
  render: (ctx) => box(<Drawing {...ctx} codec={codec} />),
  embed: ({ store, text }) => box(<Preview store={store} text={text} codec={codec} />),
})

// A made-up drawing for the Plugins sheet.
const SAMPLE = JSON.stringify({
  type: "excalidraw", version: 2, source: "vaultite", appState: { viewBackgroundColor: "#ffffff" }, files: {},
  elements: [
    { id: "a", type: "rectangle", x: 0, y: 0, width: 180, height: 80, strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "hachure", roughness: 1, strokeWidth: 2, roundness: { type: 3 }, seed: 1, boundElements: [{ id: "at", type: "text" }] },
    { id: "at", type: "text", x: 45, y: 27, width: 90, height: 25, text: "Idea", originalText: "Idea", fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: "a", strokeColor: "#1e1e1e", seed: 2 },
    { id: "b", type: "ellipse", x: 320, y: -10, width: 160, height: 100, strokeColor: "#1e1e1e", backgroundColor: "#b2f2bb", fillStyle: "hachure", roughness: 1, strokeWidth: 2, seed: 3, boundElements: [{ id: "bt", type: "text" }] },
    { id: "bt", type: "text", x: 360, y: 27, width: 80, height: 25, text: "Sketch", originalText: "Sketch", fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: "b", strokeColor: "#1e1e1e", seed: 4 },
    { id: "c", type: "arrow", x: 190, y: 40, width: 120, height: 0, points: [[0, 0], [120, 0]], strokeColor: "#1e1e1e", roughness: 1, strokeWidth: 2, endArrowhead: "arrow", seed: 5 },
  ],
})

export default definePlugin({
  formats: { drawing: format(["excalidraw"], plain, true), obsidian: format(["excalidraw.md"], obsidian, false) },
  newFiles: [{ label: "New drawing", icon: PenTool, make: newDrawing }],
  commands: [
    { id: "excalidraw:new", name: "New drawing", run: () => void newDrawing().then((p) => openNew(p)) },
  ],
  slash: () => [{
    id: "excalidraw:new", title: "Drawing", section: "Excalidraw", keywords: "excalidraw sketch diagram whiteboard draw", detail: "New drawing",
    line: true,
    run: async (put) => { const p = await newDrawing(); put(`![[${p}]]\n`) },
  }],
  preview: () => <div className="relative h-[220px]">{box(<Preview text={SAMPLE} codec={plain} />)}</div>,
})
