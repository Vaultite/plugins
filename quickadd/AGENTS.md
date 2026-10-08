## Quick add (choices)
The user's Quick add choices are in `.vaultite/plugins/quickadd/data.json`, `{"choices": [...]}` (else Obsidian's
QuickAdd's, `.obsidian/plugins/quickadd/data.json`, are used as they are). Each has `id`, `name`, `type` and `command`
(a palette command of its own):
- `capture`: adds `format` (default `{{VALUE}}`) to `file` (a path, `.md` optional; empty: the open note), at its end, or
  its top with `prepend`; with `heading`, of that heading's section (made at the end when missing).
- `template`: a new note from `template` (in the templates folder), named `nameFormat` (default `{{VALUE}}`), in `folder`;
  `open` (default true) opens it.
- `multi`: a group offering `choices`, other choices' names.
Formats take `{{VALUE}}` (or `{{NAME}}`), named `{{VALUE:Topic}}`, `{{VALUE:a,b,c}}` (one of these), `{{DATE}}`,
`{{DATE:YYYY-MM-DD}}`, `{{TIME}}`, `{{TITLE}}`, `{{LINKCURRENT}}` and `{{FILENAMECURRENT}}`. Run one with
`vau quickadd <choice> [value] [--values '{"Topic": "..."}'] [--file <the open note>]`, never by editing the note
yourself; `vau quickadd list` lists them with what each asks.
