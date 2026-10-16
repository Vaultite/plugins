// Today on a throwaway server: routines ticked in a day's daily note (routine.check), routine.list, its block as text,
// vau today, and a tick in a daily note Obsidian's settings name.   node today/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

const s = await serve(["today"])
try {
  const run = (id: string, params: unknown) => s.api("POST", `ops/${id}`, params)
  const exists = (p: string) => { try { s.read(p); return true } catch { return false } }
  // (a Wednesday long before the sandbox's days, so no daily note is there)
  let [c, t] = await run("routine.check", { routine: "stretch", date: "2025-03-12" })
  check("routine.check: ticked in the day's note, made for it, by its name in any case", c === 200 && t.routine === "Stretch" &&
    s.read("Daily/2025-03-12.md").includes("done: [Stretch]") && s.read("Daily/2025-03-12.md").includes("type: day"), [c, t])
  const [, st] = await s.api("GET", "state")
  check("the tick shows in the state's checks", st.checks.some((x: { routine: string; date: string }) => x.routine.endsWith("/Stretch") && x.date === "2025-03-12"), st.checks?.slice(0, 3))
  ;[c] = await run("routine.check", { routine: "Stretch", date: "2025-03-12", done: false })
  check("routine.check: done false unticks it, and the note left empty goes", c === 200 && !exists("Daily/2025-03-12.md"))
  ;[c, t] = await run("routine.check", { routine: "Juggle" })
  check("routine.check: a routine that isn't there is said, with the routines", c >= 400 && String(t.error).includes("Stretch"), [c, t])
  await run("routine.check", { routine: "Stretch", date: "2025-03-12" })
  ;[c, t] = await run("routine.list", { date: "2025-03-12" })
  check("routine.list: the routines, which are done that day and that week", c === 200 && t.week_start === "2025-03-10" && t.page === "Dashboards/Today.md" &&
    t.routines.some((x: { name: string; done: boolean; ticked: boolean; week: boolean[]; target: number }) => x.name === "Stretch" && x.done && x.ticked && x.week[2] && !x.week[3] && x.target === 7), t)
  await run("routine.check", { routine: "Stretch", date: "2025-03-12", done: false })

  s.write("Mine.md", "```block-routines\n```\n")
  const [, mine] = await s.api("GET", "render?path=Mine.md")
  check("routines block as text: today's, ticked or not, and the week so far", /## Routines · /.test(mine) && /\[[ x]\] Stretch \(\d of 7 this week\)/.test(mine), mine)
  const today = s.vau("today")
  check("vau today: the Today page as text, its blocks filled in", today.includes("# Today") && today.includes("Routines · ") && !today.includes("```block-routines"), today.slice(0, 300))

  // A daily note found by its name in Obsidian's folder and format, without a type: the tick goes there.
  s.write(".obsidian/daily-notes.json", JSON.stringify({ folder: "Journal/", format: "YYYY/MM/DD-MM-YYYY" }))
  s.write("Journal/2025/03/13-03-2025.md", "Rain.\n")
  ;[c] = await run("routine.check", { routine: "Stretch", date: "2025-03-13" })
  const note = s.read("Journal/2025/03/13-03-2025.md")
  check("a tick goes into the note found by its name, no other made", c === 200 && note.includes("done: [Stretch]") && note.includes("Rain.") && !note.includes("type:") &&
    !exists("Daily/2025-03-13.md"), note)

  s.vau("plugin", "off", "today")
  ;[c] = await run("routine.list", {})
  check("off, its operations aren't there", c === 404, c)
} finally {
  s.stop()
}
done()
