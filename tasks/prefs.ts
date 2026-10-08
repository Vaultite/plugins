// The settings as the app last read them (the background component keeps them), for code outside React: the
// editor's done dates and the form's format.
import { DEFAULT_PREFS, type Prefs } from "./task.ts"

export let prefs: Prefs = DEFAULT_PREFS
export function setPrefs(data: Record<string, unknown> | null) {
  const d = data ?? {}
  const b = (k: keyof Prefs, x: boolean) => (typeof d[k] === "boolean" ? d[k] as boolean : x)
  prefs = {
    format: d.format === "dataview" ? "dataview" : "emoji",
    doneDate: b("doneDate", DEFAULT_PREFS.doneDate), cancelledDate: b("cancelledDate", DEFAULT_PREFS.cancelledDate),
    createdDate: b("createdDate", DEFAULT_PREFS.createdDate), recurrenceBelow: b("recurrenceBelow", DEFAULT_PREFS.recurrenceBelow),
  }
}
