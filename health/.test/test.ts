// Health on a throwaway server: the areas it brings Logs, a workout log's block, its blocks as text, its page.
//   node health/.test/test.ts
import fs from "node:fs"
import path from "node:path"
import { check, done, serve } from "../../testkit.ts"

type Area = { slug: string; parent: string | null; tint: string | null; icon: string; blocks: string[] }
const s = await serve(["health"])
try {
  // (the areas it brings, not the sandbox's areas setting)
  fs.rmSync(path.join(s.vault, ".vaultite/plugins/logs/data.json"), { force: true })
  const areas = async (): Promise<Area[]> => (await s.api("GET", "state"))[1].areas
  const all = await areas(), gym = all.find((a) => a.slug === "workouts")
  check("it brings Logs its areas: workouts, sleep and nutrition under health", gym?.parent === "health" && gym.tint === "pink" && gym.icon === "dumbbell" &&
    all.filter((a) => a.parent === "health").map((a) => a.slug).sort().join() === "nutrition,sleep,workouts", all)
  await s.api("POST", "logs", [{ area: "workouts", date: "2025-03-12", source: "claude", ext_id: "health-gym", title: "Push",
    data: { kind: "Strength", exercises: [{ name: "Bench Press", sets: [{ type: "normal", weight_kg: 50, reps: 8 }] }] } }])
  const log = (await s.api("GET", "state"))[1].logs.find((x: { ext_id: string }) => x.ext_id === "health-gym")
  check("a new workout log has the workout block's fence under its log's", s.read(`${log.id}.md`).includes("```block-log\n```\n\n```block-workout\n```"), s.read(`${log.id}.md`))
  const [, one] = await s.api("GET", `render?path=${encodeURIComponent(`${log.id}.md`)}`)
  check("a workout renders as text: each lift's sets", one.includes("Bench Press: 50 kg x 8"), one)
  await s.api("POST", "logs", [{ area: "nutrition", date: "2025-03-12", source: "claude", ext_id: "health-meal", title: "Rice bowl", data: { meal: "Lunch", kcal: 650 } }])
  const [, logs] = await s.api("GET", "logs?area=health")
  check("an area's logs include its sub-areas'", logs.some((l: { ext_id: string }) => l.ext_id === "health-meal") && logs.some((l: { ext_id: string }) => l.ext_id === "health-gym"), logs.length)
  const [pc, page] = await s.api("GET", "render?path=Dashboards/Health.md")
  check("its page, written when turned on: its blocks as text", pc === 200 && page.includes("# Health") && !page.includes("```block-") && /## (Sleep|Workouts|Nutrition)/.test(page), page.slice(0, 400))
  s.vau("plugin", "off", "health")
  check("off, it brings no areas", !(await areas()).some((a) => a.slug === "workouts"), (await areas()).map((a) => a.slug))
} finally {
  s.stop()
}
done()
