// Periodic notes: moment-style names both ways, weeks numbered as the settings and locales do, notes' paths, an
// Obsidian vault's settings read; then the op, the month and templates on a throwaway server.   node periodic-notes/.test/test.ts
import { check, done, serve } from "../../testkit.ts"
import { shift, startOf } from "../dates.ts"
const { formatDate, parseDate } = await import("@vaultite/core/plugins.ts") // (after testkit: it finds @vaultite/core)
const { config, fillTemplate, pathOf, weeksOf } = await import("../plugin.ts")

// ---------- formats (Tuesday 6 October 2026)
const d = new Date(2026, 9, 6)
const SUN = weeksOf("sunday"), MON = weeksOf("monday")
check("YYYY-MM-DD", formatDate(d, "YYYY-MM-DD") === "2026-10-06")
check("dddd, MMMM Do YYYY", formatDate(d, "dddd, MMMM Do YYYY") === "Tuesday, October 6th 2026", formatDate(d, "dddd, MMMM Do YYYY"))
check("folders in a format", formatDate(d, "YYYY/MM-MMMM/YYYY-MM-DD-ddd") === "2026/10-October/2026-10-06-Tue")
check("quarter and day of year", formatDate(d, "YYYY-[Q]Q DDDD") === "2026-Q4 279")
check("ISO week", formatDate(d, "GGGG-[W]WW") === "2026-W41")
check("ISO week at the year's edge", formatDate(new Date(2027, 0, 1), "GGGG-[W]WW") === "2026-W53" && formatDate(new Date(2024, 11, 30), "GGGG-[W]WW") === "2025-W01")

// ---------- weeks by locale settings
check("weeks from Monday are ISO's", MON.start === 1 && MON.jan === 4 && formatDate(d, "gggg-[W]ww", MON) === "2026-W41")
check("weeks from Sunday: week 1 holds January 1st (en-US)", SUN.start === 0 && SUN.jan === 1 && formatDate(d, "gggg-[W]ww", SUN) === "2026-W41"
  && formatDate(new Date(2026, 0, 3), "gggg-[W]ww", SUN) === "2026-W01" && formatDate(new Date(2025, 11, 28), "gggg-[W]ww", SUN) === "2026-W01",
  [formatDate(new Date(2026, 0, 3), "gggg-[W]ww", SUN), formatDate(new Date(2025, 11, 28), "gggg-[W]ww", SUN)])
check("the same day, two numberings", formatDate(new Date(2027, 0, 2), "gggg-ww", SUN) === "2027-01" && formatDate(new Date(2027, 0, 2), "gggg-ww", MON) === "2026-53",
  [formatDate(new Date(2027, 0, 2), "gggg-ww", SUN), formatDate(new Date(2027, 0, 2), "gggg-ww", MON)])
check("weeks from Saturday", weeksOf("saturday").start === 6 && startOf("week", d, weeksOf("saturday")).getDay() === 6)
check("e: the day in the locale's week", formatDate(d, "e", SUN) === "2" && formatDate(d, "e", MON) === "1")
check("the locale's own week start", [0, 1, 6].includes(weeksOf("locale").start))

// ---------- names read back
const same = (a: Date | null, b: string) => !!a && formatDate(a, "YYYY-MM-DD") === b
check("read a day", same(parseDate("2026-10-06", "YYYY-MM-DD"), "2026-10-06"))
check("read a locale week: its first day", same(parseDate("2026-W41", "gggg-[W]ww", SUN), "2026-10-04") && same(parseDate("2026-W41", "gggg-[W]ww", MON), "2026-10-05"))
check("read an ISO week across years", same(parseDate("2026-W53", "GGGG-[W]WW"), "2026-12-28"))
check("read a quarter, a month, a year", same(parseDate("2026-Q4", "YYYY-[Q]Q"), "2026-10-01") && same(parseDate("2026-10", "YYYY-MM"), "2026-10-01") && same(parseDate("2026", "YYYY"), "2026-01-01"))
check("read names and weekdays", same(parseDate("Tuesday, October 6th 2026", "dddd, MMMM Do YYYY"), "2026-10-06"))
check("not a date the format writes", parseDate("2026-13-06", "YYYY-MM-DD") === null && parseDate("2026-10-6", "YYYY-MM-DD") === null && parseDate("Notes", "YYYY") === null)

// ---------- periods, paths, templates
check("start of a week, month, quarter", same(startOf("week", d, SUN), "2026-10-04") && same(startOf("month", d, MON), "2026-10-01") && same(startOf("quarter", d, MON), "2026-10-01"))
check("periods away", same(shift("week", startOf("week", d, MON), -1), "2026-09-28") && same(shift("month", new Date(2026, 0, 1), 13), "2027-02-01") && same(shift("quarter", new Date(2026, 9, 1), 1), "2027-01-01"))
check("a path", pathOf({ on: true, folder: "Journal/Weeks", format: "gggg/[W]ww", template: "" }, startOf("week", d, MON), MON) === "Journal/Weeks/2026/W41.md")
check("at the vault's top", pathOf({ on: true, folder: "", format: "YYYY", template: "" }, d, MON) === "2026.md")
const t = fillTemplate("# {{title}}\n{{date:dddd D MMMM}} ({{date}}), after {{yesterday}}, before {{tomorrow:ddd}}; week from {{monday}} to {{sunday:D MMM}} at {{time:HH}}",
  d, "YYYY-MM-DD", "2026-10-06", MON, new Date(2026, 9, 9, 7))
check("a template filled for the note's date", t === "# 2026-10-06\nTuesday 6 October (2026-10-06), after 2026-10-05, before Wed; week from 2026-10-05 to 11 Oct at 07", t)

// ---------- settings: its own, else Obsidian's
const files = (o: Record<string, object>) => (p: string) => (o[p] ?? {}) as Record<string, unknown>
let c = config({}, files({}), "Journal/Daily")
check("defaults: daily notes where the vault's are, the others off", c.periods.day.on && c.periods.day.folder === "Journal/Daily" && c.periods.day.format === "YYYY-MM-DD"
  && !c.periods.week.on && c.periods.week.format === "gggg-[W]ww" && c.weeks.start === 1 && c.confirm && !c.weekNumbers && c.wordsPerDot === 250, c)
c = config({}, files({ ".obsidian/daily-notes.json": { folder: "Journal", format: "DD-MM-YYYY", template: "Templates/Day" } }), "Daily")
check("Obsidian's Daily notes", c.periods.day.folder === "Journal" && c.periods.day.format === "DD-MM-YYYY" && c.periods.day.template === "Templates/Day", c.periods.day)
c = config({}, files({
  ".obsidian/daily-notes.json": { folder: "Journal" },
  ".obsidian/plugins/periodic-notes/data.json": { daily: { enabled: true, folder: "", format: "" }, weekly: { enabled: true, folder: "Weeks", format: "GGGG-[W]WW", template: "Templates/Week" }, monthly: { enabled: false, folder: "Months" } },
}), "Daily")
check("Periodic Notes 0.x over Daily notes", c.periods.day.folder === "" && c.periods.day.format === "YYYY-MM-DD" && c.periods.week.on && c.periods.week.folder === "Weeks"
  && c.periods.week.format === "GGGG-[W]WW" && c.periods.week.template === "Templates/Week" && !c.periods.month.on, c.periods)
c = config({}, files({ ".obsidian/plugins/periodic-notes/data.json": { activeCalendarSet: "Work", calendarSets: [
  { id: "Default", day: { enabled: true, folder: "Home" } }, { id: "Work", day: { enabled: true, folder: "Work/Days", format: "YYYYMMDD", templatePath: "Templates/Work day" }, quarter: { enabled: true } }] } }), "Daily")
check("Periodic Notes 1.x: the active calendar set", c.periods.day.folder === "Work/Days" && c.periods.day.format === "YYYYMMDD" && c.periods.day.template === "Templates/Work day"
  && c.periods.quarter.on && c.periods.quarter.folder === "Quarterly", c.periods)
c = config({ dailyFolder: "Days", weekly: false, weekStart: "saturday", confirmCreate: false, wordsPerDot: 100, weekNumbers: true }, files({
  ".obsidian/daily-notes.json": { folder: "Journal" }, ".obsidian/plugins/periodic-notes/data.json": { weekly: { enabled: true } } }), "Daily")
check("its own settings win", c.periods.day.folder === "Days" && !c.periods.week.on && c.weeks.start === 6 && !c.confirm && c.wordsPerDot === 100 && c.weekNumbers, c)

// ---------- on a server
const srv = await serve(["periodic-notes", "templater"])
try {
  const op = (params: object) => srv.api("POST", "ops/periodic-notes.note", params)
  let [st, r] = await op({ period: "day", date: "2026-10-08", create: false })
  check("where a note is, without making it", st === 200 && r.path === "Daily/2026-10-08.md" && !r.exists && !r.created, r)
  ;[st, r] = await op({ period: "day", date: "2026-10-08" })
  check("a daily note made: the app's own (type: day)", st === 200 && r.created && srv.read("Daily/2026-10-08.md").startsWith("---\ntype: day\n---"), [r, srv.read("Daily/2026-10-08.md")])
  ;[st, r] = await op({ period: "day", date: "2026-10-08" })
  check("asked again, it's there", r.exists && !r.created, r)

  srv.write("Templates/Daily.md", "---\ntags: [journal]\nid: template-day\n---\n# {{date:dddd D MMMM}}\n\n- [ ] Plan the day\n")
  srv.write("Templates/Week.md", "## Week {{title}}\nFrom {{monday:D MMM}} to {{sunday:D MMM}}\n")
  await srv.api("PATCH", "config/plugin/periodic-notes", { dailyTemplate: "Daily", weekly: true, weeklyTemplate: "Templates/Week", weekNumbers: true })
  ;[st, r] = await op({ period: "day", date: "2026-10-09" })
  const text = srv.read("Daily/2026-10-09.md")
  check("from its template: dates for the note's day, frontmatter merged, the app's keys left out",
    /^---\ntype: day\ntags: \[journal\]\n---\n/.test(text) && text.includes("# Friday 9 October\n\n- [ ] Plan the day") && !text.includes("template-day"), text)
  ;[st, r] = await op({ period: "week", date: "2026-10-09", offset: -1 })
  // (Provenance may add its `origin` to a new note)
  check("last week's note, from its template", r.path === "Weekly/2026-W40.md" && srv.read(r.path).endsWith("\n## Week 2026-W40\nFrom 28 Sep to 4 Oct\n"), [r, srv.read(r.path)])
  ;[st, r] = await op({ period: "month" })
  check("a period that's off says so", st >= 400 && /Monthly notes are off/.test(JSON.stringify(r)), [st, r])
  const cli = srv.vau("calendar", "note", "week", "--offset", "-1", "--date", "2026-10-09").trim()
  check("vau calendar note week --offset -1", cli === "Weekly/2026-W40.md", cli)

  ;[st, r] = await srv.api("GET", "periodic-notes/month?month=2026-10")
  const day9 = r.weeks.flatMap((w: { days: object[] }) => w.days).find((x: { date: string }) => x.date === "2026-10-09")
  check("the month: weeks from Monday, its weekly notes", r.weeks.length === 5 && r.weeks[0].date === "2026-09-28" && r.weeks[0].n === 40 && r.weeks[0].note.exists && r.weekNumbers, r.weeks[0])
  check("a day's dots and open tasks", day9.note.exists && day9.dots === 1 && day9.open === 1 && day9.words > 0, day9)
  srv.write("Daily/2026-10-10.md", "---\ntype: day\n---\n" + "word ".repeat(800) + "\n- [x] done\n")
  await new Promise((res) => setTimeout(res, 600))
  ;[st, r] = await srv.api("GET", "periodic-notes/month?month=2026-10")
  const day10 = r.weeks.flatMap((w: { days: object[] }) => w.days).find((x: { date: string }) => x.date === "2026-10-10")
  check("dots by length (250 words each), done tasks aren't open", day10.dots === 3 && day10.open === 0, day10)

  // Templater's commands run too (the Templates plugin's template:expand).
  srv.write("Templates/Year.md", "# <% tp.file.title %>, made <% tp.date.now(\"YYYY\") %>\n")
  await srv.api("PATCH", "config/plugin/periodic-notes", { yearly: true, yearlyTemplate: "Year" })
  ;[st, r] = await op({ period: "year", date: "2027-03-01" })
  check("a template's Templater commands run", srv.read("Yearly/2027.md").endsWith(`# 2027, made ${new Date().getFullYear()}\n`), srv.read("Yearly/2027.md"))

  srv.write(".obsidian/plugins/periodic-notes/data.json", JSON.stringify({ monthly: { enabled: true, folder: "Journal/Months", format: "YYYY-MM MMMM" } }))
  ;[st, r] = await op({ period: "month", date: "2026-02-14" })
  check("an Obsidian vault's Periodic Notes settings", r.path === "Journal/Months/2026-02 February.md" && r.created, r)
} finally { srv.stop() }
done()
