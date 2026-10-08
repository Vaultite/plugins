// Work on a throwaway server: its area comes with it, work.focus writes the focus card, and its page reads as text.
//   node work/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

const s = await serve(["work"])
try {
  const [, st] = await s.api("GET", "state")
  check("work: on, it brings its log area", st.areas.some((a: { slug: string }) => a.slug === "work"), st.areas.map((a: { slug: string }) => a.slug))
  const [code, r] = await s.api("POST", "ops/work.focus", { focus: "Ship the op catalog", questions: ["Who reviews it?"] })
  const file = (await s.api("GET", "work"))[1]
  check("work.focus: the focus card", code === 200 && file?.focus === "Ship the op catalog" && file.questions?.[0] === "Who reviews it?", [code, r, file])
  const [, txt] = await s.api("GET", "render?path=Dashboards/Work.md")
  check("work: its page, copied in once it's on, as text", String(txt).includes("Ship the op catalog"), txt)
  s.vau("plugin", "off", "work")
  const [, after] = await s.api("GET", "state")
  check("work: off, its area goes", !after.areas.some((a: { slug: string }) => a.slug === "work"))
} finally {
  s.stop()
}
done()
