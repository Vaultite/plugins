// What's on this Mac's screen, for Screen sharing's app mode (plugin.ts runs it: osascript -l JavaScript windows.js):
// the screens (points, as windows are placed), the windows in front-to-back order (CoreGraphics' list: bounds and owner
// need no permission; titles need Screen Recording, so they may be missing) and the apps in the Dock. No Apple Events,
// so it never asks for Automation or Accessibility.
ObjC.import("CoreGraphics")
ObjC.import("AppKit")

// eslint-disable-next-line no-unused-vars -- osascript calls it
function run() {
  const js = (v) => (v && !v.isNil() ? v.js : null)
  const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)
  const list = ObjC.castRefToObject(raw)
  const windows = []
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i)
    if (js(w.objectForKey("kCGWindowLayer")) !== 0) continue
    const b = w.objectForKey("kCGWindowBounds")
    const width = js(b.objectForKey("Width")), height = js(b.objectForKey("Height"))
    if (width < 40 || height < 40) continue
    windows.push({ id: js(w.objectForKey("kCGWindowNumber")), pid: js(w.objectForKey("kCGWindowOwnerPID")),
      app: js(w.objectForKey("kCGWindowOwnerName")) || "", title: js(w.objectForKey("kCGWindowName")) || "",
      x: js(b.objectForKey("X")), y: js(b.objectForKey("Y")), w: width, h: height })
  }
  const screens = []
  const all = $.NSScreen.screens
  for (let i = 0; i < all.count; i++) {
    const s = all.objectAtIndex(i), f = s.frame
    screens.push({ x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height, scale: s.backingScaleFactor })
  }
  const apps = []
  const running = $.NSWorkspace.sharedWorkspace.runningApplications
  for (let i = 0; i < running.count; i++) {
    const a = running.objectAtIndex(i)
    if (a.activationPolicy !== $.NSApplicationActivationPolicyRegular) continue
    apps.push({ name: js(a.localizedName) || "", bundle: js(a.bundleIdentifier) || "", pid: a.processIdentifier, active: a.active })
  }
  return JSON.stringify({ screens, windows, apps })
}
