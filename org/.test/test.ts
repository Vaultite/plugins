// Org Mode: the parser against Emacs (conform.ts), edits, Markdown and links, then render, embeds, files, graph, search.
//   node org/.test/test.ts
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { check, done, serve } from "../../testkit.ts"

const HERE = import.meta.dirname
const { orgMarkdown } = await import("../export/markdown.ts")
const { follow, orgLinks, relinked, vaultPath } = await import("../export/links.ts")

// ---------- the parser node for node against Emacs (its trees cached in expected/), and what a click writes
{
  const r = spawnSync(process.execPath, [path.join(HERE, "conform.ts"), "--quiet"], { encoding: "utf8" })
  const out = `${r.stdout}${r.stderr}`.trim().split("\n")
  check(`parser: ${out[out.length - 1]}`, r.status === 0, out.slice(0, 12).join("\n"))
  const e = spawnSync(process.execPath, [path.join(HERE, "edits.ts")], { encoding: "utf8" })
  check("edits: what a click writes (edits.ts)", e.status === 0, `${e.stdout}${e.stderr}`.trim().split("\n").filter((l) => !/^ok\b/.test(l)).slice(0, 12).join("\n"))
}

// ---------- Markdown
const md = (org: string, p?: string) => { try { return orgMarkdown(org, { path: p }) } catch (e) { return `threw ${(e as Error).message}` } }
const cases: [string, string, string, string?][] = [
  ["a heading keeps its keyword, priority and tags; level 1 is ##", "* TODO [#A] Call Alice :work:phone:\n", "## TODO [#A] Call Alice :work:phone:"],
  ["deeper headings go one level deeper", "* One\n** Two\n*** Three\n", "## One\n\n### Two\n\n#### Three"],
  ["a COMMENT heading says so", "* COMMENT Draft\n", "## COMMENT Draft"],
  ["planning and properties stay as Org writes them, on consecutive lines", "* Task\nSCHEDULED: <2026-11-16 Mon>\n:PROPERTIES:\n:ID: abc\n:END:\nText.\n",
    "## Task\n\n`SCHEDULED: <2026-11-16 Mon>`\n`:ID: abc`\n\nText."],
  ["checkboxes are task list items", "- [ ] open\n- [X] done\n- [-] partly\n", "- [ ] open\n- [x] done\n- [-] partly"],
  ["ordered lists keep their numbers, a counter restarts them", "1. one\n2. two\n3. [@7] seven\n4. eight\n", "1. one\n2. two\n7. seven\n8. eight"],
  ["nested lists indent under their item", "- a\n  - b\n    - c\n", "- a\n  - b\n    - c"],
  ["a description list's term is bold", "- Alice :: designer\n", "- **Alice**: designer"],
  ["a table's first row is its header", "| a | b |\n|---+---|\n| 1 | 2 |\n", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ["a table with no rule still has a header", "| a | b |\n| 1 | 2 |\n", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ["a src block is fenced code with its language", "#+begin_src js :exports both\n  let x = 1\n#+end_src\n", "```js :exports both\nlet x = 1\n```"],
  ["an example block and fixed width are code", "#+begin_example\nraw *text*\n#+end_example\n: fixed\n", "```\nraw *text*\n```\n\n```\nfixed\n```"],
  ["a quote is a blockquote", "#+begin_quote\nWise *words*.\n#+end_quote\n", "> Wise **words**."],
  ["emphasis", "*b* /i/ _u_ +s+ =v= ~c~\n", "**b** *i* <u>u</u> ~~s~~ `v` `c`"],
  ["LaTeX stays LaTeX", "\\(x^2\\) and $y$ and \\[z\\]\n", "$x^2$ and $y$ and $$z$$"],
  ["web links are Markdown links", "[[https://example.com][Example]] and https://example.org\n", "[Example](https://example.com) and <https://example.org>"],
  ["file links are vault links, from the file's folder", "[[file:sub/b.org][B]] [[./c.md]] [[file:../d.org::*Intro]]\n", "[[A/sub/b.org|B]] [[A/c.md]] [[d.org#Intro]]", "A/x.org"],
  ["an image link is an embed", "[[file:pics/cat.png]]\n", "![[pics/cat.png]]"],
  ["a file outside the vault stays a file: link", "[[file:/etc/hosts][hosts]]\n", "[hosts](file:/etc/hosts)"],
  ["a link to a heading in the file", "[[*Intro][the intro]]\n", "[[#Intro|the intro]]"],
  ["footnotes", "Text[fn:1].\n\n[fn:1] The note.\n", "Text[^1].\n\n[^1]: The note."],
  ["an inline footnote is defined at the end", "Text[fn::inline].\n", "Text[^inline-1].\n\n[^inline-1]: inline"],
  ["comments are dropped", "# hidden\nShown.\n#+begin_comment\nhidden\n#+end_comment\n", "Shown."],
  ["#+TITLE is the title; other settings are kept as code", "#+TITLE: Plan\n#+STARTUP: overview\n", "# Plan\n\n`#+STARTUP: overview`"],
  ["a #+TITLE that is the file's name isn't repeated", "#+TITLE: Launch plan\nText.\n", "Text.", "Projects/launch-plan.org"],
  ["plain text that would be Markdown is escaped", "2*3*4 costs $5 and a_b stays\n", "2\\*3\\*4 costs \\$5 and a_b stays"],
  ["entities are their characters", "\\alpha to \\beta\n", "α to β"],
]
for (const [name, org, want, p] of cases) { const got = md(org, p); check(`markdown: ${name}`, got === want, got) }

{
  const sample = fs.readFileSync(path.join(HERE, "sample.org"), "utf8")
  const sub = orgMarkdown(sample, { path: "Projects/Lighthouse.org", sub: "launch-post" })
  check("markdown: an embed's #heading (or #custom-id) is that subtree only", sub.startsWith("## NEXT [#A] Write the launch post :writing:web:") && !sub.includes("Pick the price"), sub)
  check("markdown: a heading that isn't there says so", orgMarkdown(sample, { path: "P.org", sub: "Nope" }) === "_(no heading Nope in P.org)_")
}

// ---------- links, as the graph resolves them (relative to the file)
check("links: file: links, relative, search options off; absolute and web ones left out",
  JSON.stringify(orgLinks("[[file:a.org::*X]] [[./b/c.md][c]] [[../d.org]] file:e.org [[file:/abs.org]] [[https://x.org]] [[id:123]]\n#+INCLUDE: \"inc.org\" src\n")) ===
  JSON.stringify(["./a.org", "./b/c.md", "../d.org", "./e.org", "./inc.org"]), orgLinks("[[file:a.org::*X]] [[./b/c.md][c]] [[../d.org]] file:e.org"))
check("links: a path out of the vault isn't one of its files", vaultPath("", "../x.org") === null && vaultPath("A/B", "../c.org") === "A/c.org" && vaultPath("", "~/x") === null)
{
  // (for a move: what the core would ask of a format's links, were it to relink other files than notes)
  const org = "See [[file:R/n.org][n]], [[file:../Ideas.md][ideas]] and [[file:R/pic.png]].\n"
  const r = (from: string, to: string, was: string, now: string) => { try { return relinked(org, was, now, follow(from, to)) } catch (e) { return `threw ${(e as Error).message}` } }
  check("relink: a link follows the file it points to; only its path changes", r("P/R/n.org", "X/n.org", "P/A.org", "P/A.org") === org.replace("file:R/n.org", "file:../X/n.org"), r("P/R/n.org", "X/n.org", "P/A.org", "P/A.org"))
  check("relink: a moved folder's file keeps its links within, and those out of it follow", r("P", "W/P", "P/A.org", "W/P/A.org") === org.replace("../Ideas.md", "../../Ideas.md"), r("P", "W/P", "P/A.org", "W/P/A.org"))
  check("relink: nothing moved that it links to: no change", r("Q/x.org", "Q/y.org", "P/A.org", "P/A.org") === null)
}

// ---------- its title, for the file list (looks:org)
{
  const { orgTitle } = await import("../plugin.ts")
  check("title: #+TITLE lines before the first heading, joined; none: empty", orgTitle("#+title: Launch\n#+TITLE: plan\n* H\n#+TITLE: no\n") === "Launch plan" &&
    orgTitle("* H\n#+TITLE: in a section\n") === "" && orgTitle("Text.\n") === "")
}

// ---------- on a server
const s = await serve(["org"])
try {
  s.vau("plugin", "on", "graph")
  const put = async (p: string, text: string) => (await s.api("POST", "file", { path: p, text }))[0]
  const sample = fs.readFileSync(path.join(HERE, "sample.org"), "utf8")
  const made = [await put("Projects/Lighthouse.org", sample), await put("Projects/Research/notes.org", "* Findings\nPeople like the price.\n"),
    await put("Ideas.md", "# Ideas\n"), await put("Projects/People/Ben Ortiz.org", "* Contact\nben@example.com\n"),
    await put("Notes/Embed.md", "# Embed\n\n![[Lighthouse.org#Write the launch post]]\n")]
  check("server: the files are written", made.every((x) => x < 300), made)

  const [st, shown] = await s.api("GET", `render?path=${encodeURIComponent("Projects/Lighthouse.org")}`)
  const text = String(shown)
  check("render: an Org file reads as Markdown", st === 200 && text.includes("## NEXT [#A] Write the launch post :writing:web:") &&
    text.includes("| Plan | Price | Seats |") && text.includes("[[Projects/Research/notes.org|the research notes]]") && text.includes("```python :results output") &&
    !text.includes("A comment nobody reads"), shown)

  const [, embed] = await s.api("GET", `render?path=${encodeURIComponent("Notes/Embed.md")}`)
  check("render: ![[x.org#Heading]] embeds that heading's subtree", String(embed).includes("## NEXT [#A] Write the launch post") && !String(embed).includes("Pick the price"), embed)

  const [, graph] = await s.api("GET", "graph")
  const edge = (a: string, b: string) => (graph?.edges ?? []).some((e: { from: string; to: string }) => e.from === a && e.to === b)
  check("graph: an Org file's file: links are its edges", edge("Projects/Lighthouse.org", "Projects/Research/notes.org") && edge("Projects/Lighthouse.org", "Ideas.md") &&
    edge("Projects/Lighthouse.org", "Projects/People/Ben Ortiz.org"), (graph?.edges ?? []).filter((e: { from: string }) => e.from.endsWith(".org")))

  const [, tree] = await s.api("GET", "files")
  const row = (tree?.files ?? []).find((f: { path: string }) => f.path === "Projects/Lighthouse.org"), plain = (tree?.files ?? []).find((f: { path: string }) => f.path === "Projects/People/Ben Ortiz.org")
  check("files: an Org file is listed like a note, titled by its #+TITLE, else its name", row?.title === "Lighthouse launch" && plain?.title === "Ben Ortiz" &&
    !(tree?.others ?? []).some((f: { path: string }) => f.path.endsWith(".org")), [row, plain])

  const [, found] = await s.api("GET", `search?q=${encodeURIComponent("ship often")}`)
  check("search: finds an Org file's text", JSON.stringify(found).includes("Projects/Lighthouse.org"), found)

} finally {
  s.stop()
}
done()
