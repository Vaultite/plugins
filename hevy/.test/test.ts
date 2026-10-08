// Hevy's import on a throwaway server: a made-up export becomes workout logs, and a rerun updates them in place.
//   node hevy/.test/test.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, done, serve } from "../../testkit.ts"

const head = "title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_lbs,reps,distance_miles,duration_seconds,rpe"
const csv = [head,
  "Push,\"Mar 2, 2026, 6:00 PM\",\"Mar 2, 2026, 7:00 PM\",,Bench Press (Barbell),,,0,warmup,95,10,,,",
  "Push,\"Mar 2, 2026, 6:00 PM\",\"Mar 2, 2026, 7:00 PM\",,Bench Press (Barbell),,,1,normal,135,8,,,8",
  "Legs,\"Mar 4, 2026, 7:30 AM\",\"Mar 4, 2026, 8:15 AM\",Felt good,Squat (Barbell),,,0,normal,185,5,,,"].join("\n") + "\n"
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hevy-test-")), "workouts.csv")
fs.writeFileSync(file, csv)
const s = await serve(["hevy"])
try {
  const [code, r] = await s.api("POST", "ops/hevy.import", { file })
  check("hevy.import: two workouts", code === 200 && r.workouts === 2 && r.upserted === 2, [code, r])
  const logs = (await s.api("GET", "state"))[1].logs.filter((l: { source?: string }) => l.source === "hevy")
  const push = logs.find((l: { title: string }) => l.title === "Push")
  check("hevy.import: sets in kg, warm-ups not counted", logs.length === 2 && push?.date === "2026-03-02" && push.duration_min === 60 &&
    push.data.sets === 1 && push.data.exercises[0].sets[1].weight_kg === 61.23, push)
  const [, again] = await s.api("POST", "ops/hevy.import", { file })
  const now = (await s.api("GET", "state"))[1].logs.filter((l: { source?: string }) => l.source === "hevy")
  check("hevy.import: a rerun updates in place", again.workouts === 2 && now.length === 2, now.length)
  check("hevy.import: a missing file says so", (await s.api("POST", "ops/hevy.import", { file: file + ".gone" }))[0] >= 400)
} finally {
  s.stop()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
}
done()
