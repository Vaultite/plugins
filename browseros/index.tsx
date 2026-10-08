// BrowserOS: a web page handed from the Web viewer to BrowserOS (a real browser: passkeys, its own logins), opened in its
// window, which App windows keeps behind a tab; that tab is shown, a new one if no tab holds the window yet.
import { Compass } from "lucide-react"
import { appWindows, definePlugin, isViewOpen, notify, notifyError, openView } from "@vaultite"

const NEO = "com.browseros.BrowserClaw"

/** BrowserOS as installed on this Mac (BrowserOS neo first), or null. */
async function browserOS() {
  const { installed } = await appWindows!.list()
  const ids = installed.map((a) => a.bundle).filter((b) => b.startsWith("com.browseros."))
  return ids.includes(NEO) ? NEO : ids[0] ?? null
}

async function openIn(url: string) {
  const api = appWindows
  if (!api?.open) return notify("Opening pages in BrowserOS needs a newer desktop app", { kind: "error" })
  try {
    const bundle = await browserOS()
    if (!bundle) return notify("BrowserOS isn't installed on this Mac", { kind: "error" })
    const r = await api.open(bundle, url)
    // (no window found, or no Accessibility permission yet: the app's tab takes one, or asks for it)
    const to = r.ok && r.wid ? `${bundle}:${r.wid}` : bundle
    openView(`app/${to}`, { newTab: !isViewOpen(`view:app/${to}`) })
  } catch (e) { notifyError(e, "Couldn't open the page in BrowserOS") }
}

export default definePlugin({
  webPageActions: ({ url }) => appWindows ? [{ label: "Open in BrowserOS", icon: Compass, run: () => void openIn(url) }] : [],
})
