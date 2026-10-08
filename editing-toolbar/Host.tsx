// Mounted once while the plugin is on (`background`): follows its settings file, draws the bars into the room the
// editors made for them, and on phones the bar above the keyboard for the note being typed in.
import { useEffect, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import type { EditorView } from "@codemirror/view"
import { settingsFile, useVaultChange } from "@vaultite"
import { editors, useMounts } from "./mounts"
import { current, ID, modeOf, ready, reload, subscribe } from "./settings"
import { Toolbar, useDesktop } from "./Toolbar"

export function Host() {
  useEffect(() => { void ready() }, [])
  useVaultChange(() => void reload(), [settingsFile(ID)])
  const mounts = useMounts()
  return (
    <>
      {mounts.map((m) => createPortal(<Toolbar view={m.view} place={m.place} />, m.dom, String(m.key)))}
      <KeyboardBar />
    </>
  )
}

/** The note being typed in, if it has the toolbar and can be changed. */
function useTyping(): EditorView | null {
  const [view, setView] = useState<EditorView | null>(null)
  useEffect(() => {
    const look = () => {
      const at = document.activeElement
      const v = [...editors].find((e) => e.contentDOM.contains(at)) ?? null
      // (a menu of the bar's holds the keyboard while it's open, and gives it back)
      if (!v && document.querySelector("[role=menu]")) return
      setView(v && v.contentDOM.contentEditable === "true" ? v : null)
    }
    // (focus leaves for a moment as a menu opens or a button is tapped: look again once it has landed)
    const later = () => setTimeout(look, 0)
    document.addEventListener("focusin", look)
    document.addEventListener("focusout", later)
    return () => { document.removeEventListener("focusin", look); document.removeEventListener("focusout", later) }
  }, [])
  return view
}

/** Where the keyboard leaves room: the bar's top, or null while there's no keyboard (it sits on the phone's bar). */
function useKeyboardTop(height: number) {
  const [top, setTop] = useState<number | null>(null)
  useEffect(() => {
    const vv = visualViewport
    if (!vv) return
    const f = () => setTop(innerHeight - vv.height > 80 ? vv.offsetTop + vv.height - height : null)
    f()
    vv.addEventListener("resize", f); vv.addEventListener("scroll", f)
    return () => { vv.removeEventListener("resize", f); vv.removeEventListener("scroll", f) }
  }, [height])
  return top
}

function KeyboardBar() {
  const settings = useSyncExternalStore(subscribe, current)
  const desktop = useDesktop()
  const view = useTyping()
  const top = useKeyboardTop(44)
  if (modeOf(settings, desktop) !== "keyboard" || !view) return null
  return createPortal(
    <div className="fixed inset-x-0 z-30 border-t-[0.5px] border-border bg-background"
      style={top === null ? { bottom: "var(--phone-bar)" } : { top }}>
      <Toolbar view={view} place="keyboard" />
    </div>,
    document.body,
  )
}
