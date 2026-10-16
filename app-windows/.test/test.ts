// App windows on a throwaway server: installed and on, it's listed as the desktop app's, builds, and its docs and
// settings are there. Its windows need the desktop app: .test/qa/desktop.mjs.   node app-windows/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

const s = await serve(["app-windows"])
try {
  const [, list] = await s.api("GET", "plugins")
  const p = list.find((x: { id: string }) => x.id === "app-windows")
  check("on, loaded and built, said to work only in the desktop app", p?.on && p.loaded && typeof p.bundle === "string" && p.desktopApp === true && !p.problems.length, p)
  const [bc, bundle] = await s.api("GET", `plugins/app-windows/${p.bundle}/bundle.js`)
  check("its bundle has its command, asking for the desktop app's windows", bc === 200 && bundle.includes("`app-windows:open`") && bundle.includes(".appWindows"), bundle.slice(0, 200))
  const docs = s.vau("docs", "app-windows")
  check("its docs say how to open an app in a tab", docs.includes("view:app/<bundle id>") && docs.includes("`newWindows` (true or false, default true)"), docs.slice(0, 300))
  s.vau("plugin", "off", "app-windows")
  const [, after] = await s.api("GET", "plugins")
  check("off: not loaded", !after.find((x: { id: string }) => x.id === "app-windows").loaded)
} finally {
  s.stop()
}
done()
