// Dock icon on a throwaway server: installed and on, it's listed as the desktop app's and builds. Setting the Dock's
// picture needs the desktop app: .test/qa/desktop.mjs.   node dock-icon/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

const s = await serve(["dock-icon"])
try {
  const [, list] = await s.api("GET", "plugins")
  const p = list.find((x: { id: string }) => x.id === "dock-icon")
  check("on, loaded and built, said to work only in the desktop app", p?.on && p.loaded && typeof p.bundle === "string" && p.desktopApp === true && !p.problems.length, p)
  const [bc, bundle] = await s.api("GET", `plugins/dock-icon/${p.bundle}/bundle.js`)
  check("its bundle has its menu item and commands", bc === 200 && bundle.includes("Use as Dock icon") && bundle.includes("Reset Dock icon"), bundle.slice(0, 200))
  check("its docs say where the picture is kept", s.vau("docs", "dock-icon").includes("Nothing is written to the vault"))
} finally {
  s.stop()
}
done()
