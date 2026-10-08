// Apple Health's import on a throwaway server: a made-up export's nights and workouts become logs, `skip` leaves a kind
// out, and a rerun updates them in place.   node apple-health/.test/test.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, done, serve } from "../../testkit.ts"

const sleep = (a: string, b: string, v: string) => `<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="${a}" endDate="${b}" value="HKCategoryValueSleepAnalysis${v}"/>`
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 ${sleep("2026-03-01 23:00:00 +0000", "2026-03-02 07:00:00 +0000", "InBed")}
 ${sleep("2026-03-01 23:15:00 +0000", "2026-03-02 06:45:00 +0000", "AsleepCore")}
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" startDate="2026-03-02 18:00:00 +0000" endDate="2026-03-02 18:30:00 +0000">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="320" unit="kcal"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" startDate="2026-03-03 18:00:00 +0000" endDate="2026-03-03 18:45:00 +0000"/>
</HealthData>
`
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apple-health-test-")), "export.xml")
fs.writeFileSync(file, xml)
const s = await serve(["apple-health"])
try {
  const [code, r] = await s.api("POST", "ops/apple-health.import", { file, skip: ["strength"] })
  check("apple-health.import: a night and a workout, strength skipped", code === 200 && r.sleep === 1 && r.workouts === 1 &&
    r.skipped.strength === 1, [code, r])
  const logs = (await s.api("GET", "state"))[1].logs.filter((l: { source?: string }) => l.source === "apple-health")
  const night = logs.find((l: { area: string }) => l.area === "sleep"), run = logs.find((l: { area: string }) => l.area !== "sleep")
  check("apple-health.import: asleep and in bed, on the wake date", night?.date === "2026-03-02" && night.duration_min === 450 && night.data.in_bed_min === 480, night)
  check("apple-health.import: the run, outdoor, with its energy", run?.title === "Running" && run.duration_min === 30 && run.data.kcal === 320 && run.data.style === "outdoor", run)
  await s.api("POST", "ops/apple-health.import", { file, skip: ["strength"] })
  check("apple-health.import: a rerun updates in place", (await s.api("GET", "state"))[1].logs.filter((l: { source?: string }) => l.source === "apple-health").length === 2)
} finally {
  s.stop()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
}
done()
