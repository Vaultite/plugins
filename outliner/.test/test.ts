// The list tree: which item a line is in, its block, siblings and parent; moving, indenting and outdenting an item
// with its children, and the whole list.   node outliner/.test/test.ts
import { check, done } from "../../testkit.ts"
import * as L from "../tree.ts"

const doc = (s: string) => s.split("\n")
const run = (e: L.Edit | null, lines: string[]) => (e ? [...lines.slice(0, e.from), ...e.lines, ...lines.slice(e.to)].join("\n") : null)
const same = (name: string, got: unknown, want: unknown) => check(name, got === want, got)

const A = doc(`Intro
- Alice
  - one
    text under one
  - two
- Bob
  - three

- Carol
After`)
same("itemAt: its own line", L.itemAt(A, 2), 2)
same("itemAt: a line of its text", L.itemAt(A, 3), 2)
same("itemAt: not in a list", L.itemAt(A, 0), -1)
same("itemAt: after the list", L.itemAt(A, 9), -1)
same("end: with children", L.end(A, 1), 5)
same("end: trailing blank left out", L.end(A, 5), 7)
same("previous / next across a blank line", `${L.previous(A, 8)},${L.next(A, 5)}`, "5,8")
same("previous: none for a first child", L.previous(A, 2), -1)
same("parent", `${L.parent(A, 4)},${L.parent(A, 1)}`, "1,-1")

same("move up with children", run(L.move(A, 5, -1), A), `Intro
- Bob
  - three
- Alice
  - one
    text under one
  - two

- Carol
After`)
same("move down from a line of its text", run(L.move(A, 3, 1), A), `Intro
- Alice
  - two
  - one
    text under one
- Bob
  - three

- Carol
After`)
const down = L.move(A, 1, 1)!
same("move down: where it lands", down.d, 2)
same("move: nothing past the first", L.move(A, 1, -1), null)
same("move: numbers stay in order", run(L.move(doc("1. a\n2. b\n   - c"), 1, -1), doc("1. a\n2. b\n   - c")), "1. b\n   - c\n2. a")

same("indent with children: under the sibling's children", run(L.indent(A, 4), A), `Intro
- Alice
  - one
    text under one
    - two
- Bob
  - three

- Carol
After`)
same("indent: under the text of a numbered item", run(L.indent(doc("1. a\n2. b\n   - c"), 1), doc("1. a\n2. b\n   - c")), "1. a\n   2. b\n      - c")
same("indent: tabs stay tabs", run(L.indent(doc("- a\n- b\n\t- c"), 1), doc("- a\n- b\n\t- c")), "- a\n\t- b\n\t\t- c")
same("indent: shift", L.indent(A, 5)!.shift, 2)
same("indent: not a first item", L.indent(A, 1), null)

same("outdent: after its parent's other children", run(L.outdent(A, 2), A), `Intro
- Alice
  - two
- one
  text under one
- Bob
  - three

- Carol
After`)
same("outdent: where it lands", L.outdent(A, 3)!.d, 1)
same("outdent: the last child in place", run(L.outdent(A, 6), A), `Intro
- Alice
  - one
    text under one
  - two
- Bob
- three

- Carol
After`)
same("outdent: not a top-level item", L.outdent(A, 1), null)
same("task's text start", L.textStart("  - [ ] buy milk"), 8)
same("list: the whole list", L.list(A, 3)?.join(), "1,9")
same("list: none outside", L.list(A, 0), null)
done()
