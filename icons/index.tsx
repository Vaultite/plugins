// Icons: a folder's or file's icon and colour from its menu (the tree's right-click, a tab's, the phone's …), drawn by the
// app wherever it draws a file's icon (`fileIcons`). A note's "Change icon" is the app's own; this adds its colour.
import { Eraser, Palette, Shapes, Smile } from "lucide-react"
import { CHIP_TINTS, choose, definePlugin, getStore, notifyError, op, pickIcon, type FileMenuItem } from "@vaultite"
import "./types"

const isNote = (p: string) => /\.md$/i.test(p)
const set = (path: string, change: { icon?: string; tint?: string }) =>
  void op("icons.set", { path, ...change }).catch((e) => notifyError(e, "Couldn't change its icon"))

/** Its icon and colour now: a note's own properties, else the settings'. */
function current(path: string) {
  const s = getStore(), f = isNote(path) ? s?.files.files.find((x) => x.path === path) : undefined
  return f ? { icon: f.icon ?? undefined, tint: f.tint ?? undefined } : s?.icons?.[path] ?? {}
}

function pickTint(path: string) {
  choose({
    title: "Change colour", placeholder: "Colour…", current: current(path).tint ?? "",
    items: [{ id: "", label: "None" }, ...CHIP_TINTS.map((t) => ({
      id: t, label: t[0].toUpperCase() + t.slice(1), icon: <span className="size-3 rounded-full" style={{ background: `var(--${t})` }} />,
    }))],
    onPick: (it) => set(path, { tint: it.id }),
  })
}

function items(path: string): FileMenuItem[] {
  if (path.startsWith(".")) return []
  const now = current(path)
  return [
    // (a note's is the app's own, in Rename ▸)
    ...(isNote(path) ? [] : [{ label: "Change icon", icon: Smile, section: "icons",
      run: () => pickIcon({ title: "Change icon", current: now.icon, onPick: (icon) => set(path, { icon }) }) }]),
    { label: "Change colour", icon: Palette, section: "icons", run: () => pickTint(path) },
    ...(now.icon || now.tint ? [{ label: "Remove icon", icon: Eraser, section: "icons", run: () => set(path, { icon: "", tint: "" }) }] : []),
  ]
}

export default definePlugin({
  icon: Shapes,
  // A colour alone keeps a folder's or file's own icon.
  fileIcons: (s) => Object.fromEntries(Object.entries(s.icons ?? {}).map(([p, i]) =>
    [p, { icon: i.icon || (/\.[^/]+$/.test(p) ? "file" : "folder"), tint: i.tint }])),
  fileMenu: items,
  folderMenu: items,
})
