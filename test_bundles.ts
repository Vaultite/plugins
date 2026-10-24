// The bundles here (bundles/<id>/), against the app at $VAULTITE_APP: each names only plugins there are, states every
// setting the app's own bundles set, and applies on a throwaway server (over Zen and Browser too).   node test_bundles.ts [id...]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { APP, check, done, serve } from "./testkit.ts"

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
const HERE = import.meta.dirname
const DIR = path.join(HERE, "bundles")
const ids = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, "bundle.json"))).sort()
const json = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null)
const appPlugins = new Map(fs.readdirSync(path.join(APP, "plugins", "core")).map((id) => [id, json(path.join(APP, "plugins", "core", id, "manifest.json")) ?? {}]))

// What the app's own bundles set: a bundle that leaves one out keeps the last bundle's (Zen's tab bar) when applied.
const builtIns = fs.readdirSync(path.join(APP, "bundles")).filter((d) => fs.existsSync(path.join(APP, "bundles", d, "bundle.json")))
/** The keys the app's bundles say in one of their files (appearance.json, editor.json, newtab.json). */
const keysIn = (rel: string) => new Set(builtIns.flatMap((b) => Object.keys(json(path.join(APP, "bundles", b, rel)) ?? {})))
const looks = keysIn("appearance.json"), FILES = ["editor", "newtab"].map((n) => [n, keysIn(`${n}.json`)] as const)
const lookKeys: string[] = (await import(pathToFileURL(path.join(APP, "core", "look.ts")).href)).LOOK_KEYS
/** What a restyle may hold besides its card. */
const RESTYLE = new Set(["bundle.json", "appearance.json", "preview.png", "preview-dark.png", "themes", "snippets"])
const settings = new Set(builtIns.flatMap((b) => {
  const pd = path.join(APP, "bundles", b, "plugins")
  return fs.existsSync(pd) ? fs.readdirSync(pd).flatMap((p) => Object.keys(json(path.join(pd, p, "data.json")) ?? {}).map((k) => `${p}.${k}`)) : []
}))

for (const id of ids) {
  const at = path.join(DIR, id), rel = `bundles/${id}`
  console.log(`\n== ${rel}`)
  const pj = json(path.join(at, "plugins.json")) ?? {}, install: Record<string, Any> = pj.install ?? {}
  const unknown = [...pj.enabled ?? [], ...pj.disabled ?? []].filter((p: string) => !appPlugins.has(p) && !install[p])
  check(`${rel}: names only the app's plugins and those it installs`, !unknown.length, unknown)
  const always = [...pj.enabled ?? [], ...pj.disabled ?? []].filter((p: string) => appPlugins.get(p)?.alwaysOn)
  check(`${rel}: leaves out plugins that are always on`, !always.length, always)
  const sources = Object.entries(install).filter(([p, x]) => x.source !== `Vaultite/plugins/${p}` || !fs.existsSync(path.join(HERE, p, "manifest.json")))
  check(`${rel}: installs only plugins of this repository`, !sources.length, sources)
  const look = json(path.join(at, "appearance.json")) ?? {}
  const pd = path.join(at, "plugins")
  const own = new Set(fs.existsSync(pd) ? fs.readdirSync(pd).flatMap((p) => Object.keys(json(path.join(pd, p, "data.json")) ?? {}).map((k) => `${p}.${k}`)) : [])
  // A restyle (only appearance.json, with its themes and snippets) sets the look's keys it names, over any setup.
  const restyle = fs.readdirSync(at).every((f) => RESTYLE.has(f))
  if (restyle) {
    const strange = Object.keys(look).filter((k) => !lookKeys.includes(k))
    check(`${rel}: a restyle names only keys of the look`, Object.keys(look).length > 0 && !strange.length, strange)
  } else {
    const missing = [...[...looks].filter((k) => !Object.hasOwn(look, k)).map((k) => `appearance ${k}`), ...[...settings].filter((k) => !own.has(k)),
      ...FILES.flatMap(([n, keys]) => { const o = json(path.join(at, `${n}.json`)) ?? {}; return [...keys].filter((k) => !Object.hasOwn(o, k)).map((k) => `${n} ${k}`) })]
    check(`${rel}: states every appearance key, editor and new tab key and plugin setting the app's bundles set`, !missing.length, missing)
  }

  // Applied for real: Vaultite's plugins it installs come from this checkout (a made-up GitHub), at their tags.
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), "vaultite-bundles-gh-"))
  fs.mkdirSync(path.join(gh, "Vaultite"))
  fs.symlinkSync(HERE, path.join(gh, "Vaultite", "plugins"))
  const s = await serve([], { env: { VAULTITE_GITHUB: pathToFileURL(gh).href } })
  try {
    const conf = (n: string) => json(path.join(s.vault, ".vaultite", `${n}.json`)) ?? {}
    s.vau("bundle", "import", at)
    const [, shown] = await s.api("GET", `bundles/${id}`)
    check(`${rel}: imported, its plan finds every plugin`, shown.plan && !shown.plan.plugins.missing.length && !shown.plan.skipped.length, shown.plan)
    let [code, r] = await s.api("POST", `bundles/${id}/apply`, { allowCode: true })
    check(`${rel}: applies, installing its plugins`, code === 200, r)
    const enabled: string[] = conf("plugins").enabled ?? []
    check(`${rel}: its plugins are on`, (pj.enabled ?? []).every((p: string) => enabled.includes(p)), enabled)
    const lock = conf("plugins-lock")
    check(`${rel}: installed from Vaultite/plugins at their tags`, Object.keys(install).every((p) => lock[p]?.tag?.startsWith(`${p}/v`)), lock)
    // (the setup it makes: the same over Zen as over the sample's; a restyle's, Zen's with its keys)
    const setup = (but: string[] = []) => JSON.stringify({ look: Object.fromEntries(Object.entries(conf("appearance")).filter(([k]) => !but.includes(k))),
      sidebars: conf("sidebars"), pinned: conf("pages").pinned, editor: conf("editor"), newtab: conf("newtab"),
      settings: [...settings].map((k) => { const [p, key] = k.split("."); return [k, conf(`plugins/${p}/data`)[key] ?? null] }) })
    if (restyle) {
      ;[code, r] = await s.api("POST", "bundles/zen/apply", {})
      const zen = setup(Object.keys(look))
      ;[code, r] = await s.api("POST", `bundles/${id}/apply`, {})
      const now = conf("appearance")
      check(`${rel}: over Zen, it sets its keys`, code === 200 && Object.entries(look).every(([k, v]) => JSON.stringify(now[k]) === JSON.stringify(v)), { look, now })
      const after = JSON.parse(setup(Object.keys(look))), was = JSON.parse(zen)
      const moved = Object.keys(was).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(after[k])).map((k) => ({ [k]: [was[k], after[k]] }))
      check(`${rel}: over Zen, the rest of Zen's setup stays`, !moved.length, moved)
      continue
    }
    const alone = setup()
    // (over each of the app's own but Standard, the defaults: Zen, Browser)
    for (const other of builtIns.filter((b) => b !== "standard")) {
      ;[code, r] = await s.api("POST", `bundles/${other}/apply`, {})
      check(`${rel}: (${other} applied)`, code === 200 && setup() !== alone, r)
      ;[code, r] = await s.api("POST", `bundles/${id}/apply`, { allowCode: true })
      check(`${rel}: over ${other}, it makes the same setup (none of its look or settings left)`, code === 200 && setup() === alone, { alone, now: setup() })
    }
    const pins: string[] = json(path.join(at, "pages.json"))?.pinned ?? []
    check(`${rel}: its pinned pages are there`, pins.every((p) => fs.existsSync(path.join(s.vault, p))), pins.filter((p) => !fs.existsSync(path.join(s.vault, p))))
    for (const p of pins) {
      const text = s.vau("render", p)
      // (render's notes: a block no plugin draws, one whose plugin is off, options it doesn't take)
      const notes = text.match(/_\((no plugin draws block-[\w-]+|[^)]* is off|[\w-]+ block: [^)]*)\)_/g) ?? []
      check(`${rel}: ${p} has only blocks that are drawn, with options they take`, !notes.length, notes)
    }
  } finally {
    s.stop()
    fs.rmSync(gh, { recursive: true, force: true })
  }
}

done()
