// Made-up Logseq graphs written to a folder for the tests: `lighthouse` (most of Logseq's syntax), `legacy` (the old
// file names, other journal formats, LATER/NOW, spaces for indentation), `dbexport` (the DB version's Markdown export,
// zipped) and `big` (generated: any number of pages, deep outlines, unicode, many assets).
import fs from "node:fs"
import path from "node:path"
import { zipFiles } from "@vaultite/core/plugins.ts"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
const PDF = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
const DRAWING = JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 80, height: 40 }], appState: {}, files: {} })

export const IDS = {
  beam: "6571a3c2-1b2c-4d3e-8f90-0a1b2c3d4e5f", lamp: "6571a3c2-1b2c-4d3e-8f90-0a1b2c3d4e60", note: "6571a3c2-1b2c-4d3e-8f90-0a1b2c3d4e61",
  card: "6571a3c2-1b2c-4d3e-8f90-0a1b2c3d4e62", hl: "6571a3c2-1b2c-4d3e-8f90-0a1b2c3d4e63", area: "6571a3c2-1b2c-4d3e-8f90-0a1b2c3d4e64",
}

const LIGHTHOUSE: Record<string, string | Buffer> = {
  "logseq/config.edn": `{:meta/version 1
 :preferred-workflow :todo
 :file/name-format :triple-lowbar
 :journal/page-title-format "MMM do, yyyy"
 :journal/file-name-format "yyyy_MM_dd"
 :hidden ["private"]
 ;; a comment, and forms the importer doesn't read
 :query/result-transforms {:sort (fn [r] (sort-by :block/content r))}
 :macros {"ticket" "[Ticket $1](https://example.com/tickets/$1)"
          "mark" "[:mark \\"$1\\"]"}}
`,
  "logseq/custom.css": ".ls-block { line-height: 1.6; }\n",
  "logseq/bak/pages/Lighthouse/2026-11-01T10_00_00.000Z.Desktop.md": "- an old copy\n",
  "logseq/.recycle/pages_Old.md": "- deleted\n",
  "private/secret.md": "- hidden by :hidden\n",
  "pages/Lighthouse.md": `alias:: The Lighthouse, Beacon
tags:: project, [[coastal work]]
type:: [[Project]]
rating:: 8
started:: [[Mar 2nd, 2025]]
owner:: [[Alice Park]]

- Overview #[[coastal work]]
	- The lamp is lit at dusk by [[Alice Park]]. See [[Projects/Lighthouse/Lamp]] and [the keeper]([[Alice]]).
	  Its second line, with ^^a highlight^^ and **bold**.
	- The beam turns every 10 seconds.
	  id:: ${IDS.beam}
	  speed:: 6 rpm
	  checked-by:: [[Alice Park]]
- ## Tasks
  collapsed:: true
	- TODO [#A] Order a new lens #shopping
	  SCHEDULED: <2026-11-05 Thu>
	  DEADLINE: <2026-11-09 Mon>
	- DOING Paint the railing
	  :LOGBOOK:
	  CLOCK: [2026-11-02 Mon 09:00:00]--[2026-11-02 Mon 10:30:00] =>  01:30:00
	  :END:
	- DONE Check the beam ((${IDS.beam}))
	- WAITING Delivery of oil
	- CANCELED Old plan
	- LATER Wind the clock
	  SCHEDULED: <2026-11-04 Wed 08:00 .+1w>
	- NOW Log the weather
	- TODO Inspect every month
	  DEADLINE: <2026-11-30 Mon +1m>
- Notes
	- #+BEGIN_NOTE
	  Keep the logbook dry.
	  #+END_NOTE
	- #+BEGIN_WARNING
	  The stairs are steep.
	  #+END_WARNING
	- #+BEGIN_QUOTE
	  The sea is calm tonight.
	  #+END_QUOTE
	  After the quote.
	- \`\`\`js
	  const beam = "on" // - not a block
	  \`\`\`
	- | Shift | Keeper |
	  | --- | --- |
	  | Night | [[Alice Park]] |
	- Math: $E = mc^2$ and $$\\int_0^1 x\\,dx$$
	- ![beam.png](../assets/beam_1730000000000_0.png){:height 120, :width 240}
	- ![plan](../assets/sub/plan.png)
	- The manual: ![keeper-manual.pdf](../assets/keeper-manual_1730000000000_0.pdf)
	- [[draws/2026-11-01-10-00-00.excalidraw]]
	- {{video https://www.youtube.com/watch?v=abcdefghijk}}
	- {{youtube abcdefghijk}}
	- {{ticket 42}} and {{mark hi}} and {{renderer :wordcount}}
	- Embedded: {{embed ((${IDS.beam}))}}
	- {{embed [[Alice Park]]}}
	- A link to [the beam](((${IDS.beam}))) with a label.
	- numbered one
	  logseq.order-list-type:: number
	- numbered two
	  logseq.order-list-type:: number
	- Steps in a block:
	  1. not a block
	  2. still not
- Queries
	- {{query (task TODO DOING)}}
	- {{query (and (task todo) (priority a))}}
	- {{query [[Alice Park]]}}
	- {{query (page-property type [[Project]])}}
	- {{query (between -7d today)}}
	- #+BEGIN_QUERY
	  {:title "All tasks"
	   :query [:find (pull ?b [*]) :where [?b :block/marker _]]}
	  #+END_QUERY
- Cards
	- What lights the lamp? #card
	  id:: ${IDS.card}
		- Oil, then a wick.
	- The beam turns every {{cloze 10 seconds}}. #card
`,
  "pages/Projects___Lighthouse___Lamp.md": `- A namespaced page: [[Projects/Lighthouse]] is its parent.
- Back to [[lighthouse]] (another case).
	- deep
		- deeper
			- deepest
				- bottom
					- below the bottom
`,
  "pages/Alice Park.md": `alias:: Alice
type:: [[Person]]

- Keeps the Lighthouse. Phone 555-0100.
- Notes about her
  id:: ${IDS.note}
`,
  "pages/What%3A now%3F.md": `title:: What: now?

- A page whose title has a colon and a question mark.
- Links back to [[Lighthouse]] and to ((${IDS.note})).
`,
  "pages/Café ☕ notes.md": "- Ünïcödé text, emoji 🌊, and [[灯塔]].\n- #café-tag and #[[deux mots]]\n",
  "pages/灯塔.md": "- 中文页面，链接到 [[Lighthouse]]。\n",
  "pages/hls__keeper-manual_1730000000000_0.md": `file:: [keeper-manual.pdf](../assets/keeper-manual_1730000000000_0.pdf)
file-path:: ../assets/keeper-manual_1730000000000_0.pdf

- Always trim the wick.
  ls-type:: annotation
  hl-page:: 1
  hl-color:: yellow
  id:: ${IDS.hl}
- [:span]
  ls-type:: annotation
  hl-page:: 1
  hl-color:: green
  id:: ${IDS.area}
  hl-type:: area
  hl-stamp:: 1730000001000
`,
  "pages/Changelog.org": `#+TITLE: Changelog
#+ALIAS: History

* Version 2 [[Mar 2nd, 2025]]
:PROPERTIES:
:id: 6571a3c2-1b2c-4d3e-8f90-0a1b2c3d4e70
:END:
** TODO Write the *release* notes for /the/ lamp
SCHEDULED: <2026-11-06 Fri>
** A link to [[https://example.com][the site]] and =code=
* Version 1
`,
  "pages/Footnotes.org": "* A page with a footnote[fn:1]\n\n[fn:1] Org only.\n",
  "journals/2025_03_02.md": `- Met [[Alice Park]] at the [[Lighthouse]] #meeting
	- TODO Call the harbour about the oil
	  DEADLINE: <2026-11-03 Tue>
- Embedded page {{embed [[Projects/Lighthouse/Lamp]]}}
`,
  "journals/2025_03_03.md": "- Followed up on [[Mar 2nd, 2025]] and [[Mar 1st, 2025]].\n- DONE Called the harbour\n",
  "assets/beam_1730000000000_0.png": PNG,
  "assets/sub/plan.png": PNG,
  "assets/keeper-manual_1730000000000_0.pdf": PDF,
  "assets/keeper-manual_1730000000000_0.edn": "{:highlights []}\n",
  [`assets/keeper-manual_1730000000000_0/1_${IDS.area}_1730000001000.png`]: PNG,
  "draws/2026-11-01-10-00-00.excalidraw": DRAWING,
  "whiteboards/Plan.edn": "{:blocks []}\n",
}

const LEGACY: Record<string, string | Buffer> = {
  "logseq/config.edn": `{:meta/version 1
 :preferred-workflow :now
 :journal/page-title-format "yyyy-MM-dd EEEE"
 :journal/file-name-format "yyyy-MM-dd"}
`,
  "pages/projects.lamp.md": "- A namespace written the old way: projects/lamp.\n  - A child, indented with spaces.\n    - Its child.\n",
  "pages/v1%2E2 notes.md": "title:: v1.2 notes\n\n- A title with a dot, written %2E.\n",
  "pages/contents.md": "- [[projects/lamp]]\n- [[v1.2 notes]]\n",
  "journals/2025-03-02.md": "- LATER Sweep the stairs\n- NOW Polish the lens\n- Read [[2025-03-01 Saturday]]\n",
  "journals/2025-03-01.md": "- A quiet day.\n",
}

const DBEXPORT: Record<string, string | Buffer> = {
  "Lighthouse.md": "- The lamp is lit at dusk by [[Alice Park]].\n\t- TODO Order a new lens\n\t- Met on [[Mar 2nd, 2025]]\n",
  "Alice Park.md": "- Keeps the [[Lighthouse]].\n",
  "Projects/Lamp.md": "- A namespaced page from the DB version.\n",
  "Mar 2nd, 2025.md": "- Met [[Alice Park]] #meeting\n",
}

function write(dir: string, files: Record<string, string | Buffer>) {
  for (const [rel, data] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split("/"))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, data)
  }
  return dir
}

/** A graph of `pages` pages and a journal for each of `days` days: outlines up to `depth` deep, links, block refs,
 *  tasks, unicode titles, namespaces, and `assets` pictures. */
export function bigGraph(dir: string, { pages = 10000, days = 1500, depth = 12, assets = 300 } = {}) {
  const files: Record<string, string | Buffer> = { "logseq/config.edn": "{:file/name-format :triple-lowbar :preferred-workflow :todo}\n" }
  const words = ["lamp", "beam", "keeper", "harbour", "tide", "oil", "wick", "lens", "fog", "gull", "café", "Ωmega", "灯塔", "маяк"]
  const title = (i: number) => (i % 50 === 0 ? `Area ${i % 7}/Topic ${i}` : `${words[i % words.length]} note ${i}`)
  const id = (i: number) => `6571a3c2-0000-4000-8000-${String(i).padStart(12, "0")}`
  for (let i = 0; i < pages; i++) {
    const lines = [`tags:: ${words[i % 5]}, [[${words[(i + 3) % 14]}]]`, "", `- Page ${i} links [[${title((i * 7 + 1) % pages)}]] and #${words[i % 9]}`, `  id:: ${id(i)}`]
    let pad = ""
    for (let d = 1; d < (i % depth) + 2; d++) { pad += "\t"; lines.push(`${pad}- depth ${d}: ${d % 3 === 0 ? `TODO task ${i}.${d}` : `ref ((${id((i + d) % pages)}))`}`) }
    if (i < assets) { files[`assets/pic_${i}.png`] = PNG; lines.push(`- ![pic](../assets/pic_${i}.png)`) }
    files[`pages/${title(i).replace(/\//g, "___")}.md`] = `${lines.join("\n")}\n`
  }
  const day = new Date(Date.UTC(2022, 0, 1))
  for (let i = 0; i < days; i++) {
    const iso = new Date(day.getTime() + i * 86400_000).toISOString().slice(0, 10)
    files[`journals/${iso.replace(/-/g, "_")}.md`] = `- Worked on [[${title(i % pages)}]]\n\t- DONE step ${i}\n- TODO next ${i}\n  SCHEDULED: <${iso} Mon>\n`
  }
  return write(dir, files)
}

/** The fixture graphs, written under `dir`: their paths by name (dbexport as a zip). */
export function fixtures(dir: string) {
  const db = path.join(dir, "dbexport.zip")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(db, zipFiles(Object.fromEntries(Object.entries(DBEXPORT).map(([k, v]) => [`lighthouse_markdown_1730000000/${k}`, v]))))
  return { lighthouse: write(path.join(dir, "lighthouse"), LIGHTHOUSE), legacy: write(path.join(dir, "legacy"), LEGACY), dbexport: db }
}
