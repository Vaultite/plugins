// Projects on a throwaway server: a new project's file, its blocks as text, the Projects page, archived ones left out.
//   node projects/.test/test.ts
import { check, done, serve } from "../../testkit.ts"

const s = await serve(["projects"])
try {
  const [c, p] = await s.api("POST", "projects", { name: "Beacon", status: "building", tagline: "A lamp for the harbour", repo: "alicepark/beacon",
    links: [{ label: "beacon.example.com", url: "https://beacon.example.com" }] })
  const FILE = `${p.id}.md`
  check("a new project is a file where projects are, its block on top", c === 201 && p.id.endsWith("Projects/Beacon") && s.read(FILE).includes("```block-project") &&
    s.read(FILE).includes("tagline: A lamp for the harbour"), [c, p])
  const [, one] = await s.api("GET", `render?path=${encodeURIComponent(FILE)}`)
  check("project block: its status, tagline and links, GitHub last", one.includes("building · A lamp for the harbour") && one.includes("[beacon.example.com](https://beacon.example.com)") &&
    one.includes("[GitHub](https://github.com/alicepark/beacon)"), one)
  await s.api("POST", "projects", { name: "Shelved", status: "paused", tagline: "Not now" })
  await s.api("PUT", "projects/Shelved", { archived: true })
  const [pc, page] = await s.api("GET", "render?path=Dashboards/Projects.md")
  check("its page: a line per project, archived ones left out", pc === 200 && page.includes("[[Beacon]]: building · A lamp for the harbour") && !page.includes("Shelved"), page)
  const [, st] = await s.api("GET", "state")
  check("the state's projects, sorted, with their links", st.projects.some((x: { name: string; links: unknown[] }) => x.name === "Beacon" && x.links.length === 1), st.projects?.length)
  s.vau("plugin", "off", "projects")
  check("off, its kind isn't the state's", !("projects" in (await s.api("GET", "state"))[1]))
} finally {
  s.stop()
}
done()
