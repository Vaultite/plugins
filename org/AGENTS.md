## Org Mode files (`*.org`)
Org Mode as Emacs writes it: the app parses `.org` files as Emacs's Org does and draws them as documents. `vau render
<file>` reads one as Markdown (a heading `* TODO [#A] Call Alice :work:` as `## TODO [#A] Call Alice :work:`, planning
and properties as code); to change one, edit its Org source (`vau edit`), never the Markdown. Write only Org syntax, no
Markdown (`**bold**`, `# heading`, backticks and `[text](url)` aren't Org). New files go where the vault's `.org` files are.

    #+TITLE: Lighthouse launch
    #+TODO: TODO NEXT WAITING | DONE CANCELLED

    A paragraph with *bold*, /italic/, _underline_, +strike+, =verbatim=, ~code~ and $E = mc^2$.

    * NEXT [#A] Write the launch post                                 :writing:web:
      DEADLINE: <2026-11-20 Fri> SCHEDULED: <2026-11-16 Mon 09:00 +1w>
      :PROPERTIES:
      :CUSTOM_ID: launch-post
      :END:
      - [X] Outline
      - [ ] Screenshots [1/3]
        1. Home
      - Alice Park :: reviews the draft
    ** DONE Pick the price
       CLOSED: [2026-11-10 Tue 17:02]
       | Plan | Price |
       |------+-------|
       | Solo |     5 |

- Headings: stars at the line's start and a space, then a keyword, a priority `[#A]`-`[#C]`, the title, tags `:a:b:` at the
  end. Keywords are TODO and DONE unless the file's `#+TODO:` lists others (after `|`: the done ones). `COMMENT` after
  them comments the subtree out.
- Under a heading, in this order and nothing between: one planning line (`SCHEDULED:`, `DEADLINE:`, `CLOSED:`), then the
  `:PROPERTIES:` drawer, one `:KEY: value` per line. `<2026-11-16 Mon>` is an active date (the agenda's), `[...]` an
  inactive one; `+1w` repeats it.
- Lists: `-`, `+` or `1.` and a space; checkboxes `[ ]`, `[X]`, `[-]`; `term :: text`. An item's other lines are indented
  past its bullet; two blank lines end a list. Tables: `|` rows, a `|---+---|` rule under the header.
- Blocks: `#+begin_src python` ... `#+end_src` (also `quote`, `example`, `verse`, `comment`); inside one, a line that
  starts with `*` or `#+` takes a comma first (`,* not a heading`). `: text` is a line of fixed-width text, `# text` a
  comment, `#+KEY: value` a setting.
- Links: `[[target][description]]`. Other files: `[[file:Research/notes.org]]`, relative to this file's folder (what the
  graph and the backlinks follow), `[[file:notes.org::*A heading]]` to a heading; in the file `[[*A heading]]`; the web
  `[[https://example.com][Example]]`. A file link with no description to an image shows the image.
- Footnotes: `[fn:1]` in the text, `[fn:1] The note.` at a line's start (under `* Footnotes`, by custom).
- In a note, `![[Plan.org]]` embeds a file and `![[Plan.org#A heading]]` one of its headings.
