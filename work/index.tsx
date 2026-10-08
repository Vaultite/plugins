import { Briefcase } from "lucide-react"
import { definePlugin, detailPath, today } from "@vaultite"
import { ColleagueDetail, WorkColleagues, WorkFocus, WorkIdeas, WorkLog } from "./Work"
import "./types"

export default definePlugin({
  icon: Briefcase,
  mock: () => ({
    work: { id: "Work", modified: `${today()} 12:00:00`, focus: "Shipping the new onboarding", questions: ["What should the first week look like?"],
      colleagues: [{ name: "Bob", role: "Engineering lead" }], notes: "" },
  }),
  // The Work dashboard (pages/Work.md) is these four.
  blocks: {
    "work-focus": (ctx) => <WorkFocus {...ctx} />,
    "work-log": (ctx) => <WorkLog {...ctx} />,
    "work-ideas": (ctx) => <WorkIdeas {...ctx} />,
    "work-colleagues": (ctx) => <WorkColleagues {...ctx} />,
  },
  details: {
    colleague: { render: (s, [name]) => <ColleagueDetail store={s} name={name} />, title: (_, [name]) => name ?? "" },
  },
  // [[Alex]] and a log's "with: Alex" open the colleague (a People profile wins if there is one).
  links: (s) => (s.work?.colleagues ?? []).map((c) => ({
    kind: "colleague", id: c.name, title: c.name, detail: detailPath("colleague", c.name), names: [c.name],
  })),
})
