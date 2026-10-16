// Learning on a throwaway server: the areas it brings Logs (study, reading) and its page.   node learning/.test/test.ts
import fs from "node:fs"
import path from "node:path"
import { check, done, serve } from "../../testkit.ts"

type Area = { slug: string; parent: string | null; fields: { key: string }[] }
const s = await serve(["learning"])
try {
  // (the areas it brings, not the sandbox's areas setting)
  fs.rmSync(path.join(s.vault, ".vaultite/plugins/logs/data.json"), { force: true })
  const areas = async (): Promise<Area[]> => (await s.api("GET", "state"))[1].areas
  const all = await areas(), study = all.find((a) => a.slug === "study")
  check("it brings Logs study and reading, under learning, with their fields", study?.parent === "learning" && study.fields.some((f) => f.key === "subject") &&
    all.find((a) => a.slug === "reading")?.fields.some((f) => f.key === "book_id"), all)
  const [pc, page] = await s.api("GET", "render?path=Dashboards/Learning.md")
  check("its page, written when turned on: the study area and this week's goals as text", pc === 200 && page.includes("# Learning") && page.includes("## Study") &&
    !page.includes("```block-area"), page.slice(0, 400))
  s.vau("plugin", "off", "learning")
  check("off, it brings no areas", !(await areas()).some((a) => a.slug === "study"), (await areas()).map((a) => a.slug))
} finally {
  s.stop()
}
done()
