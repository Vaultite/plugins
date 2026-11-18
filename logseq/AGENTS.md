## Logseq (a graph in: `Logseq/`, journals in the daily notes' folder; back out: a graph folder or .zip)
`logseq.import <folder or zip>` (an absolute path on this machine, or one in the vault; `--folder` where the pages go,
default the setting's `Logseq`; `--wait`) imports a Logseq graph: a folder with `pages/`, `journals/`, `assets/` and
`logseq/config.edn`, a zip of one, or the Logseq DB version's Markdown export. It answers a job (`logseq.job [id]
--wait`: `notes` of `total`, `created`, `unchanged`, `files`, `pages`, `journals`, `blocks`, `queries` made Tasks or
Dataview queries and `queriesKept`, `macrosKept`, `brokenRefs`, `whiteboards`). In the app: "Import a Logseq graph…".
Each note has `ext_id: logseq-<hash>` (of the folder, the kind and the title): importing again adds only what's new and
leaves the notes imported before as they are (they're the user's notes from then on).
`logseq.export <vault folder> <out>` writes them back as a graph (`out` a folder or a `.zip`; `--journals false` leaves
the daily notes out); in the app, "Export a folder as a Logseq graph…" downloads a zip.

### What becomes what
- Pages: a note named by its title (`title::`, else its file name read per `:file/name-format`: `___` and `%2F` the
  triple-lowbar way, `.` the legacy way). A namespace `a/b/c` is `Logseq/a/b/c.md`, its title an alias, so `[[a/b/c]]`
  finds it. A title a file can't have (`What: now?`) is the file `What - now.md` with the title as an alias.
- Journals: daily notes, named and placed as Daily notes says (its date format, its folder; `type: day` when no folder
  is set), the file names read with `:journal/file-name-format`. Links to a journal (`[[Nov 2nd, 2026]]`, read with
  `:journal/page-title-format`) link the daily note (`[[2026-11-02|Nov 2nd, 2026]]`). A day with a daily note already:
  the journal's blocks go after its text and it gets the `ext_id`.
- Blocks: nested list items (4 spaces a level); a block's other lines are the item's lines. A heading Logseq wrote
  without a bullet is a heading of the note, its blocks under it; text before the first bullet a paragraph.
  `logseq.order-list-type:: number` is a numbered item. `collapsed::` is dropped (folds are kept per device).
- Page properties (the first lines, or a first block of only properties, or YAML frontmatter) are frontmatter:
  `alias::` is `aliases`, `tags::` `tags` (as tags: spaces become `-`), others keep their key; numbers, booleans and
  dates typed, `[[links]]` kept as links (one, or a list). Block properties stay `key:: value` lines: Dataview's fields.
- `id:: <uuid>` is the block id `^<uuid>` (at the end of the item's first line, or on its own line after code or a
  table). `((uuid))` is `[[Page#^uuid|the block's text]]`, `[label](((uuid)))` keeps its label;
  `{{embed ((uuid))}}` is `![[Page#^uuid]]`, `{{embed [[page]]}}` is `![[page]]`.
- Links and tags: `[[page]]` stays when it finds the note by name (or namespace path), else `[[path|page]]`;
  `[label]([[page]])` is `[[page|label]]`; `#tag` and `#[[two words]]` are tags (`#two-words`); a tag of digits only
  (`#123`) is a link, as Vaultite reads no tag without a letter.
- Tasks (the Tasks plugin's format): TODO and LATER `[ ]`, DOING and NOW `[/]`, DONE `[x]`, CANCELED `[-]`, WAITING
  `[ ] WAITING …`. `[#A]` `[#B]` `[#C]` are ⏫ 🔼 🔽; `SCHEDULED:` ⏳ and `DEADLINE:` 📅 (or `[scheduled:: ]`, `[due:: ]`
  when the Tasks plugin's format is Dataview's); a repeater `+1w` is `🔁 every week`, `.+1w` `… when done`. A time or a
  repeater Tasks can't say (`++`, hours) also keeps Logseq's line as a comment, `%%SCHEDULED: <…>%%`. The logbook
  (`:LOGBOOK:` clocks) is kept in a `%%` comment.
- Queries: `{{query …}}` of task states, priorities, a page or a tag/link becomes a ```` ```tasks ```` query; of
  page properties, page tags, a namespace or links/tags alone a ```` ```dataview ```` LIST (pages, where Logseq lists
  blocks). The query is kept above it as `%%logseq: {{query …}}%%`. Others (between dates, full text, sorting) stay as
  written; `#+BEGIN_QUERY` is a ```` ```clojure ```` block under "Advanced Logseq query (not converted):".
- Formatting: `^^highlight^^` `==highlight==`; `#+BEGIN_NOTE/TIP/IMPORTANT/CAUTION/WARNING/PINNED/EXAMPLE/QUOTE` a
  callout (`> [!note]`…); `#+BEGIN_SRC` a fenced code block, `#+BEGIN_EXAMPLE` ```` ```example ````, `#+BEGIN_COMMENT` a
  `%%` comment; math, code, tables and quotes as they are. `{{cloze x}}` `==x==`; `{{video url}}` / `{{youtube id}}` /
  `{{tweet url}}` links named Video / YouTube / Tweet; `{{pdf …}}` an embed; `{{namespace x}}` a link; the graph's own
  `:macros` that are text are filled in; `{{renderer …}}` and other macros stay as written.
- Flashcards: a `#card` block stays in its page; its page's cards are also a `type: cards` note in `Logseq/Cards/`
  (the Lessons plugin's: the block a prompt, its children the answer, a cloze a highlight).
- Assets: every file of `assets/` goes in the vault's attachments folder (its subfolders kept), embedded where it was
  (`![[Attachments/x.png|240]]` keeps a `:width`). `hls__` pages (PDF highlights) are notes like any, their `hl-*`
  fields kept and an area highlight's picture embedded. `draws/*.excalidraw` go in `Logseq/draws/`, embedded.
- Org pages (`.org`) are converted the same way when the importer reads all of them (headlines, drawers, Org's
  markup); one it can't (footnotes, other drawers) is kept as `.org` (the Org Mode plugin opens it).
- Not imported: whiteboards (`whiteboards/*.edn`: listed in the job), `logseq/bak`, `logseq/.recycle`,
  `version-files`, hidden folders and `:hidden` ones. `logseq/config.edn` and `custom.css` are kept in
  `<folder>/.logseq/` for the way back.

### Back to Logseq
The same table the other way: frontmatter is the page's properties (`aliases` `alias::`), list items blocks, a heading
and what's under it a block and its children, paragraphs blocks, `^ids` `id::` (an id that isn't a uuid gets one made
from it), wikilinks `[[page]]` and `((uuid))`, embeds `{{embed …}}`, attachments `../assets/…`, callouts `#+BEGIN_…`,
tasks TODO/DOING (LATER/NOW when the graph's `:preferred-workflow` is `:now`), DONE, CANCELED, WAITING with SCHEDULED
and DEADLINE, the kept queries their `{{query …}}`. A folder imported from Logseq goes back with its own config.edn and
its file name format; another gets a new config.edn. What doesn't go back as it was: `collapsed::`, `heading:: true`
(a `##` heading), a filled-in macro, `#[[two words]]` (`#two-words`), LATER/NOW in a `:todo` graph (TODO/DOING).
