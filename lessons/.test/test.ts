// Lessons on a throwaway server: cards due and reviewed (kept beside its settings, not a new version to allow), the
// day's reminder in the inbox, the lessons block as text.   node lessons/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

type Event = { source: string; title: string }
// (its cards' format alone: a cloze's other blank shows its text, not its highlight's colour)
const cards = await import("../format.ts")
const [first] = cards.parseCards("## ==🟢Paris== is the capital of ==France==\n")
check("a cloze card's other blank shows its text, not its colour", cards.clozeText({ ...first, cloze: 1 }, false) === "Paris is the capital of **[...]**" &&
  cards.clozeText(first, true) === "==🟢Paris== is the capital of France", [cards.clozeText({ ...first, cloze: 1 }, false), cards.clozeText(first, true)])
const s = await serve(["lessons"])
try {
  const run = (id: string, params: unknown) => s.api("POST", `ops/${id}`, params)
  const mine = async () => ((await s.api("GET", "inbox/events"))[1].events as Event[]).filter((e) => e.source === "lessons")
  s.write(".vaultite/plugins/lessons/data.json", JSON.stringify({ remind_at: "00:00" }))
  s.write("Cards/Capitals.md", "---\ntype: cards\n---\n## What's two and two?\nFour.\n\n## What's the capital of France?\nParis.\n\n## What's the capital of Italy?\nRome.\n")
  let [c] = await run("schedule.run", { id: "lessons/reminder" })
  check("no reminder for someone who never reviewed a card", c === 200 && !(await mine()).length, await mine())
  s.write(".vaultite/plugins/lessons/reminded.json", "{}")
  const [dc, first] = await run("cards.due", { limit: 1 })
  check("cards.due: new cards, with their prompt and answer", dc === 200 && first.due === 3 && first.cards[0].prompt === "What's two and two?" && first.cards[0].answer.includes("Four"), first)
  const [rc, rev] = await run("cards.review", { source: first.cards[0].source, card: first.cards[0].card, rating: "again" })
  check("cards.review: when it comes back", rc === 200 && typeof rev.due === "string", rev)
  ;[c] = await run("schedule.run", { id: "lessons/reminder" })
  const events = await mine()
  check("the day's reminder says how many cards are due", c === 200 && events.length === 1 && /^\d+ cards to review$/.test(events[0].title), events)
  const [, due] = await run("cards.due", { limit: 100 })
  for (const x of due.cards) await run("cards.review", { source: x.source, card: x.card, rating: "good" })
  check("the last due card reviewed takes the reminder away", !(await mine()).length, await mine())
  ;[c] = await run("schedule.run", { id: "lessons/reminder" })
  check("once a day only", !(await mine()).length, await mine())
  const lessons = ((await s.api("GET", "plugins"))[1] as { id: string; loaded: boolean; approval: unknown }[]).find((p) => p.id === "lessons")
  check("its reviews are kept beside its settings: not a new version to allow", s.read(".vaultite/plugins/lessons/reviews.json").includes("Capitals") && !!lessons?.loaded && !lessons.approval, lessons)
  s.write("Mine.md", "```block-lessons\n```\n")
  const [, text] = await s.api("GET", "render?path=Mine.md")
  check("lessons block as text: what's due and the cards files", text.includes("## Lessons") && text.includes("[[Capitals]]: 3 cards"), text)
  s.vau("plugin", "off", "lessons")
  ;[c] = await run("cards.due", {})
  check("off, its operations aren't there", c === 404, c)
} finally {
  s.stop()
}
done()
