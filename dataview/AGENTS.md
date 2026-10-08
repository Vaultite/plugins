## Dataview
Dataview's queries, run by this app: a ```` ```dataview ```` fence in a note shows its results (a table, a
list, tasks or a calendar), and inline code starting with `=` shows one value. `vau render <note>` gives them as text;
`vau dataview '<query>' [--path <note>]` runs one. Write them as Dataview does, so other apps read the note too:
````
```dataview
TABLE author AS "Author", rating, finished - started AS "Took"
FROM #book AND -"Archive"
WHERE rating >= 8
SORT rating DESC, file.name
LIMIT 10
```
````
- Types: `LIST [expr]`, `TABLE [WITHOUT ID] expr [AS name], ...`, `TASK`, `CALENDAR <date>`. Then `FROM` once
  (`#tag` with its subtags, `"folder"` or `"folder/note"`, `[[note]]`: notes linking to it, `outgoing([[note]])`,
  `[[]]`: this note; `and`, `or`, `-` to leave out, brackets), then `WHERE`, `SORT x [ASC|DESC]`, `GROUP BY x [AS
  name]` (rows become `key` and `rows`: `rows.file.link`), `FLATTEN x [AS name]`, `LIMIT n`, in any order and number.
- Fields: frontmatter keys; inline fields, a line `Key:: value` or `[key:: value]` / `(key:: value)` in text (a key
  with spaces or capitals also as `key-name` in lower case); `file.name`, `file.link`, `file.path`, `file.folder`,
  `file.ext`, `file.size`, `file.ctime`, `file.cday`, `file.mtime`, `file.mday`, `file.day` (a date in the name, or
  `date`), `file.tags` (with parents), `file.etags`, `file.inlinks`, `file.outlinks`, `file.aliases`, `file.tasks`,
  `file.lists`, `file.frontmatter`; `this` is the note the query is in.
- Values: `"text"`, numbers, `true`, `[[link]]` (and `[[link]].field`), `[1, 2]`, `{a: 1}`, `date(today)` (`now`,
  `tomorrow`, `yesterday`, `sow`, `eow`, `som`, `eom`, `soy`, `eoy`, `2026-10-06`), `dur(1 day)`, `(x) => x * 2`.
  Text that is an ISO date, a duration or a lone `[[link]]` in a field reads as one. `date - date` is a duration.
- Tasks (`- [ ] text`, nested ones under their parent): `TASK` lists them under their note; `text`, `status`,
  `completed`, `checked`, `fullyCompleted`, `due` (`[due:: 2026-10-10]` or 📅 2026-10-10), `completion` (✅),
  `created` (➕), `start` (🛫), `scheduled` (⏳), `tags`, `outlinks`, `section`, `line` (in the note's text after its
  frontmatter), `parent`, `children`, and the note's own fields. Ticking a box in the app writes `[x]` on that line.
- Functions: `date`, `dur`, `number`, `string`, `link`, `embed`, `elink`, `typeof`, `object`, `list`, `round`,
  `trunc`, `floor`, `ceil`, `min`, `max`, `sum`, `product`, `average`, `reduce`, `minby`, `maxby`, `contains`,
  `icontains`, `econtains`, `containsword`, `extract`, `sort`, `reverse`, `length`, `nonnull`, `firstvalue`, `all`,
  `any`, `none`, `join`, `filter`, `map`, `flat`, `slice`, `unique`, `regextest`, `regexmatch`, `regexreplace`,
  `replace`, `lower`, `upper`, `split`, `startswith`, `endswith`, `padleft`, `padright`, `substring`, `truncate`,
  `default`, `choice`, `display`, `striptime`, `dateformat` (Luxon's tokens: `"yyyy-MM-dd"`), `durationformat`,
  `currencyformat`, `meta`. Most work on each value of a list too (`lower(file.tags)`).
- Not here: ```` ```dataviewjs ```` and `$= ...` (JavaScript isn't run: the app shows a note, the code stays),
  `file.starred` (always false), Dataview's settings (a column is named "File" or "Group").
