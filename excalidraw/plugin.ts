// Excalidraw's server side: its fonts from the app's own copy of the package, so drawings draw offline
// (GET /api/excalidraw/fonts/<family>/<file>.woff2). Drawings are vault files, read and written through /api/file.
import fs from "node:fs"
import path from "node:path"
import { HTTPError, Plugin, ROOT, Text } from "@vaultite/core/plugins.ts"

export const plugin = new Plugin(import.meta.url)

const FONTS = path.join(ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts")
const SAFE = /^[\w.-]+$/

plugin.route("GET", "excalidraw/fonts/*/*", (req) => {
  const [family, file] = [req.arg(0), req.arg(1)]
  if (!SAFE.test(family) || !SAFE.test(file) || family.startsWith(".") || file.startsWith(".")) throw new HTTPError(400, "bad font path")
  let data: Buffer
  try {
    data = fs.readFileSync(path.join(FONTS, family, file))
  } catch {
    throw new HTTPError(404, `no font ${family}/${file}`)
  }
  const type = file.endsWith(".woff2") ? "font/woff2" : file.endsWith(".woff") ? "font/woff" : "application/octet-stream"
  return new Text(data, type, { "Cache-Control": "public, max-age=31536000, immutable" })
})
