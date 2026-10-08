## Tasks (the Tasks plugin's format)
A task is a checkbox line in any note, its fields after the description (read from the end of the line; written in
this order):
```
- [ ] Call Alice Park #home 🆔 call ⛔ budget ⏫ 🔁 every week ➕ 2026-10-01 🛫 2026-10-05 ⏳ 2026-10-06 📅 2026-10-08 ❌ 2026-10-09 ✅ 2026-10-09 ^call
```
- Status: `[ ]` todo, `[x]` done, `[/]` in progress, `[-]` cancelled (others count as todo).
- 📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, ❌ cancelled (`YYYY-MM-DD`); priority 🔺 highest, ⏫ high, 🔼 medium,
  🔽 low, ⏬ lowest (none: normal); 🔁 recurrence; 🏁 delete (a done one is removed); 🆔 id and ⛔ ids it waits for.
- Dataview's fields work too, kept apart by two spaces: `- [ ] Call Alice  [priority:: high]  [repeat:: every week]
  [due:: 2026-10-08]` (`created`, `start`, `scheduled`, `due`, `completion`, `cancelled`, `onCompletion`, `id`,
  `dependsOn`). The Tasks plugin's `format` setting says which a new field is written in; a task with fields keeps its own.
- Recurrence: `every day`, `every 3 days`, `every week`, `every 2 weeks on Monday, Friday`, `every Tuesday and
  Thursday`, `every weekday`, `every month`, `every month on the 1st` / `the 15th` / `the last` / `the last Friday` /
  `the 2nd Wednesday`, `every 3 months on the 1st`, `every year`, `every January on the 15th`; `... when done` counts
  from the day it's done. Ticked, its next one is written above it with every date moved on together (from the due
  date, else scheduled, else start).
- Tick through `tasks_complete` (or `tasks.update` with a status), not by writing `[x]`: it writes the ✅ date and the
  next recurrence as Tasks does. Add with `tasks_add`; change fields with `tasks.update`.

### Queries (```` ```tasks ````)
A fence of instructions, one a line (`#` a comment, `\` at a line's end continues it); every filter must match:
- `not done`, `done`; `due` / `scheduled` / `starts` / `created` / `done` / `cancelled` / `happens` (any of start,
  scheduled, due) + `before` / `after` / `on` / `in` / `on or before` / `on or after` + a date: `2026-10-08`, `today`,
  `tomorrow`, `yesterday`, `in 3 days`, `2 weeks ago`, `next monday`, `this week` / `next month` / `last year`, `2026-W41`,
  `2026-10`, `2026-Q4`, or two dates. A task without a start date matches every `starts` filter.
- `has due date`, `no due date` (and the others), `due date is invalid`, `is recurring`, `is not recurring`, `is blocked`,
  `is blocking`, `has id`, `exclude sub-items`.
- `description` / `path` / `filename` / `folder` / `root` / `heading` / `tags` / `recurrence` / `status.name` +
  `includes` / `does not include` / `regex matches /.../i` / `is`; `tags include #work` (nested tags too);
  `priority is high`, `priority is above medium`, `status.type is IN_PROGRESS`.
- Combined: `(due today) OR (priority is high)`, `NOT (done)`, `(a) AND NOT (b)`, `XOR`; operands in `()`, `[]`, `{}`
  or `""`.
- `sort by` due, scheduled, start, created, done, happens, priority, urgency, status, description, path, filename,
  heading, tag (`reverse` after it); then by status, urgency, due, priority, path.
- `group by` filename, path, folder, root, heading, backlink, status, status.type, priority, due (and the other dates),
  happens, tags, recurring, recurrence, urgency (`reverse` too); several nest.
- `limit 20`, `limit groups 5`; `hide` / `show` edit button, backlink, task count, priority, recurrence rule, due date
  (and the others), tags, urgency; `short mode`; `explain`; `ignore global query`. `{{query.file.path}}`,
  `{{query.file.folder}}`, `{{query.file.filename}}` are the note the block is in.

`vau render <note>` shows a block's tasks as their lines, each with `· [[note#heading]]`; `tasks_list` runs any query and
gives each task's note and line, which `tasks_complete` and `tasks.update` take (or `task`: words of it).
