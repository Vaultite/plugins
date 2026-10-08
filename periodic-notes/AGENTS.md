## Periodic notes (daily, weekly, monthly, quarterly, yearly)
A periodic note is a plain note named by its date in the period's moment.js format, in the period's folder: daily
`Daily/2026-10-06.md` (`type: day`, the Today plugin's daily note, when named YYYY-MM-DD), weekly `Weekly/2026-W41.md`
(`gggg-[W]ww`), monthly `YYYY-MM`, quarterly `YYYY-[Q]Q`, yearly `YYYY`, as the settings say (else the vault's existing
Periodic Notes, Daily notes and Calendar settings). Don't work out a note's path or write a new one by hand: `vau calendar
note <today|day|week|month|quarter|year> [--offset -1] [--date YYYY-MM-DD]` answers its path, made from its template
when it isn't there (`--create false` doesn't make it); then edit it with the file ops. In its template, `{{date}}`
(`{{date:dddd D MMMM}}`), `{{title}}`, `{{time}}`, `{{yesterday}}`, `{{tomorrow}}` and `{{monday}}`…`{{sunday}}` are filled for
the note's date.
