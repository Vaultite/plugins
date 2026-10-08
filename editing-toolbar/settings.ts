// Its settings (.vaultite/plugins/editing-toolbar/data.json), kept here for the editor's extension and the bars: read
// once before the first editor, again whenever the file changes (Host).
import { get, isDesktop, notifyError, patch } from "@vaultite"
import { DEFAULT_BUTTONS } from "./buttons"

export const ID = "editing-toolbar"
export type Position = "top" | "floating"
export type Settings = { position: Position; phone: "keyboard" | "same" | "off"; buttons: string[] }
/** Where the bar is in this window: a computer's place, above the keyboard, or nowhere. */
export type Mode = Position | "keyboard" | "off"

let settings: Settings = { position: "top", phone: "keyboard", buttons: DEFAULT_BUTTONS }
let loaded: Promise<void> | null = null
const subs = new Set<() => void>()

function take(raw: unknown) {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>
  settings = {
    position: s.position === "floating" ? "floating" : "top",
    phone: s.phone === "same" || s.phone === "off" ? s.phone : "keyboard",
    buttons: Array.isArray(s.buttons) ? s.buttons.filter((b) => typeof b === "string") : DEFAULT_BUTTONS,
  }
  subs.forEach((f) => f())
}

export const reload = () => (loaded = get(`config/plugin/${ID}`).then(take, () => take({})))
export const ready = () => loaded ?? reload()
export const current = () => settings
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export const modeOf = (s: Settings, desktop = isDesktop()): Mode => (desktop || s.phone === "same" ? s.position : s.phone)

/** Change the buttons (null: back to the default set), at once here and then in the file. */
export function saveButtons(next: string[] | null) {
  take({ ...settings, buttons: next ?? undefined })
  patch(`config/plugin/${ID}`, { buttons: next }).catch((e) => { void reload(); notifyError(e, "Couldn't save it") })
}
