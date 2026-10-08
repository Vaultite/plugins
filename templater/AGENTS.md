## Templater
Templates (in the Templates plugin's folder) may hold Obsidian's Templater commands, run when a note is made from one
or one is inserted: `<% tp.date.now("YYYY-MM-DD") %>` writes a value; `<%* %>` runs code; `-%>` / `<%-` drop the
newline after / before, `_%>` / `<%_` all whitespace. Make a note from one with `templater_new`; don't write the
commands' output by hand. What runs (the rest stays as written, and the user is told):
- `tp.date.now(format, offset, reference, reference_format)` (offset: days or "P1W"), `tomorrow`, `yesterday`,
  `weekday(format, n)` (0 is Monday); formats are moment.js's (`YYYY-MM-DD`, `dddd D MMMM`, `[W]WW`, `HH:mm`).
- `tp.file.title`, `folder(absolute)`, `path(relative)`, `creation_date(format)`, `last_modified_date(format)`, `tags`,
  `content`, `exists(path)`, `include("[[Note#Heading]]")`, `rename(name)`, `move("Folder/Name")`, `cursor()`;
  `tp.frontmatter.<key>`, `tp.config`; `tp.system.prompt(question, default)` and `tp.system.suggester(labels, items,
  false, placeholder)` (answered with `answers`, by question or placeholder).
- In `<%* %>`: `let`/`const`, `=`, `+=`, `if`/`else`, `tR += "..."`, strings and their methods, `? :`, `&&`, `??`.
  Not loops, functions, `app`, `moment`, `tp.user`, `tp.web` or `tp.obsidian`.
- Settings: `folderTemplates` (folder: template) fills empty new notes there; `onCreate` runs commands in new notes.
