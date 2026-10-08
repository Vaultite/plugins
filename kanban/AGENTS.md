## Kanban boards
A board is a Markdown file with `kanban-plugin: board` (or `basic`) in its frontmatter, in the Kanban plugin's format,
so other apps open the same files. The app draws it as lanes of cards (reading view; editing shows its Markdown).
Prefer the ops (`kanban.read`, `kanban.add`, `kanban.move`, `kanban.done`, `kanban.archive`, `kanban.new`): they change
only the lines a change is about. New boards go where new notes go ("New board" in the palette and the file tree's New menu).

    ---

    kanban-plugin: board

    ---

    ## To do

    - [ ] Write the launch post for [[Lighthouse]] @{2026-10-12} #writing
    - [ ] Ask Alice Park about the beta list
    	A second line of the card, indented with a tab


    ## Doing (3)

    - [ ] Fix the onboarding copy


    ## Done

    **Complete**
    - [x] Ship the beta


    ***

    ## Archive

    - [x] An archived card

    %% kanban:settings
    ```
    {"kanban-plugin":"board","list-collapse":[false,false,false]}
    ```
    %%

- Each `## heading` is a lane, in order; `(3)` after its name is its limit. Its cards are the first list under it: `- [ ]`
  open, `- [x]` done; a card's further lines are indented under it. `**Complete**` under a heading marks the lane whose
  cards are done (moved there, they're ticked).
- A card is Markdown: `[[links]]`, `#tags`, a date as `@{2026-10-08}` (or `@[[2026-10-08]]`) and a time as `@@{14:30}`.
  A `^id` at the end of its first line is a link to it: keep it.
- The archive is `***` then `## Archive` after the lanes. The `%% kanban:settings %%` block at the end is the
  board's settings as JSON on one line (`list-collapse`: which lanes are collapsed; `new-card-insertion-method`:
  `prepend` puts new cards on top; `archive-with-date`): keep it last and valid.
- Writing by hand: change only the lines you mean to; sentence case, no emojis.
