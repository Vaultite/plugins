// The table model: parsing rows and the separator's alignments, formatting (wide characters too), the cell under a
// column, and each change the commands make.   node advanced-tables/.test/test.ts
import { check, done } from "../../testkit.ts"
import * as T from "../table.ts"

const fmt = (s: string) => T.format(T.parse(s.split("\n"))).join("\n")
const same = (name: string, got: string, want: string) => check(name, got === want, got)

check("cells: outer pipes optional", JSON.stringify(T.cells("| a | b |")) === '["a","b"]' && JSON.stringify(T.cells("a | b")) === '["a","b"]')
check("cells: an empty last cell stays", JSON.stringify(T.cells("| a |  |")) === '["a",""]', T.cells("| a |  |"))
check("cells: an escaped pipe is text", JSON.stringify(T.cells("| a \\| b | c |")) === '["a \\\\| b","c"]', T.cells("| a \\| b | c |"))
check("separator", T.isSeparator("|:--|:-:|--:|") && T.isSeparator("--- | ---") && !T.isSeparator("| a | - |"))

same("format: padded, separator widened", fmt("|Name|Age|\n|-|-|\n|Alice Park|7|"),
  "| Name       | Age |\n| ---------- | --- |\n| Alice Park | 7   |")
same("format: alignments kept and drawn", fmt("| a | b | c |\n|:--|:-:|--:|\n| left | mid | 12 |"),
  "| a    |  b  |   c |\n| :--- | :-: | --: |\n| left | mid |  12 |")
same("format: short rows filled, long ones widen the table", fmt("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |"),
  "| a   | b   |     |\n| --- | --- | --- |\n| 1   |     |     |\n| 1   | 2   | 3   |")
same("format: a header alone gets a separator", fmt("| x | y |"), "| x   | y   |\n| --- | --- |")
same("format: CJK and emoji are two columns wide", fmt("| 名前 | ok |\n|-|-|\n| 🙂 | a |"),
  "| 名前 | ok  |\n| ---- | --- |\n| 🙂   | a   |")
check("width: combining marks take none", T.width("é") === 1 && T.width("日本") === 4 && T.width("👍🏽") === 2, [T.width("é"), T.width("👍🏽")])
same("format: already formatted is unchanged", fmt("| a   | b   |\n| --- | --- |\n| 1   | 2   |"), "| a   | b   |\n| --- | --- |\n| 1   | 2   |")

const line = "| one | two   |   |"
check("cellAt: by pipes", [2, 7, 10, 16].map((ch) => T.cellAt(line, ch)).join() === "0,1,1,2", [2, 7, 10, 16].map((ch) => T.cellAt(line, ch)))
check("cellAt: without a leading pipe", T.cellAt("a | b", 4) === 1)
check("cellSpan: text, trimmed", JSON.stringify(T.cellSpan(line, 1)) === '{"from":8,"to":11}', T.cellSpan(line, 1))
check("cellSpan: an empty cell is after its space", JSON.stringify(T.cellSpan(line, 2)) === '{"from":16,"to":16}', T.cellSpan(line, 2))
check("cellSpan: right-aligned text", T.cellSpan("|   12 |", 0).from === 4)

const t = T.parse(["| k | n |", "|---|--:|", "| b | 10 |", "| a | 9 |", "|  | 1 |", "| c | 2,5 |"])
const col = (x: T.Table | null, c: number) => x!.rows.slice(1).map((r) => r[c]).join(",")
check("sort: text", col(T.sort(t, 0), 0) === "a,b,c,", col(T.sort(t, 0), 0))
check("sort: descending, empty still last", col(T.sort(t, 0, true), 0) === "c,b,a,", col(T.sort(t, 0, true), 0))
check("sort: numbers as numbers", col(T.sort(t, 1), 1) === "1,9,10,2,5", col(T.sort(t, 1), 1))
check("insert row", T.insertRow(t, 1).rows[1].join("|") === "|" && T.insertRow(t, 1).rows.length === 6)
check("delete row", col(T.deleteRow(t, 2), 0) === "b,,c")
check("move row: within the body", col(T.moveRow(t, 1, 1), 0) === "a,b,,c" && T.moveRow(t, 1, -1) === null && T.moveRow(t, 4, 1) === null)
const ic = T.insertColumn(t, 1)
check("insert column", ic.rows[0].join() === "k,,n" && ic.aligns.join() === ",,right")
check("delete column", T.deleteColumn(t, 0).rows[0].join() === "n" && T.deleteColumn(t, 0).aligns.join() === "right")
const mc = T.moveColumn(t, 0, 1)
check("move column: cells and alignment", mc!.rows[0].join() === "n,k" && mc!.aligns.join() === "right," && T.moveColumn(t, 1, 1) === null)
check("align", T.align(t, 0, "center").aligns.join() === "center,right")
done()
