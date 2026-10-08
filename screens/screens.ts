// The screens there are (GET /api/screens, others' through Machines) and how a tab names one: `view:screen/<screen>`,
// `view:screen/<screen>/<app>` for one app's window. A Mac's own is `local@<machine>`, the same on every device.
import { fetchMachines, get, onMachine, otherMachines, splitMachine, viewsChanged } from "@vaultite"

/** A screen as GET /api/screens answers (one machine's). */
export type ScreenInfo = { id: string; label: string; host: string; port: number; online: boolean }
/** A screen any machine here reaches: `id` is what a tab names (local@studio, or a settings' id). */
export type ScreenRow = { id: string; label: string; detail: string; online: boolean; mac: boolean }

/** Machine id -> its label, and a settings' screen id -> its label, for tab titles (filled as the lists come). */
const labels = new Map<string, string>()
const screenLabels = new Map<string, string>()

/** Every screen: each machine's own (a Mac's), then the ones in the settings (the same list on every machine: the
 *  vault's, reached from this one). */
export async function allScreens(): Promise<ScreenRow[]> {
  const machines = await fetchMachines()
  const self = machines.find((m) => m.self)
  const [mine, ...theirs] = await Promise.all([
    get<ScreenInfo[]>("screens").catch(() => [] as ScreenInfo[]),
    ...otherMachines(machines, "screens").map((m) => get<ScreenInfo[]>(`machines/${m.id}/screens`).catch(() => [] as ScreenInfo[])),
  ])
  let changed = false
  for (const m of machines) if (labels.get(m.id) !== m.label) { labels.set(m.id, m.label); changed = true }
  for (const s of mine) if (s.id !== "local" && screenLabels.get(s.id) !== s.label) { screenLabels.set(s.id, s.label); changed = true }
  if (changed) viewsChanged()
  const rows: ScreenRow[] = []
  const own = mine.find((s) => s.id === "local")
  if (own) rows.push({ id: onMachine("local", self?.id), label: self?.label ?? own.label, detail: "This Mac", online: own.online, mac: true })
  otherMachines(machines, "screens").forEach((m, i) => {
    const s = theirs[i]?.find((x) => x.id === "local")
    if (s) rows.push({ id: onMachine("local", m.id), label: m.label, detail: m.platform === "darwin" ? "Mac" : m.host ?? "", online: s.online, mac: true })
  })
  for (const s of mine) if (s.id !== "local") rows.push({ id: s.id, label: s.label, detail: `${s.host}:${s.port}`, online: s.online, mac: false })
  return rows
}

/** A tab's arg: "local@studio/Claude" -> {screen: "local@studio", app: "Claude"}. */
export function parseArg(arg: string): { screen: string; app: string } {
  const i = arg.indexOf("/")
  return i < 0 ? { screen: arg, app: "" } : { screen: arg.slice(0, i), app: arg.slice(i + 1) }
}
export const argOf = (screen: string, app = "") => (app ? `${screen}/${app}` : screen)

/** What a tab shows: "Claude · Studio", "Studio", "Box". */
export function titleOf(arg: string) {
  const { screen, app } = parseArg(arg)
  const [id, machine] = splitMachine(screen)
  const where = id === "local" ? labels.get(machine) ?? (machine || "This Mac") : screenLabels.get(id) ?? id
  return app ? `${app} · ${where}` : where
}
