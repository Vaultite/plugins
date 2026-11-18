// What only Obsidian plugins use, about half the runtime's code: CodeMirror's Vim, Markdown's language for their own
// editors, Lint and Lezer's parser for require(). Loaded as the runtime wakes (before any plugin runs), not with the app.
import { CM } from "./cm.ts"

export let vim: typeof import("@replit/codemirror-vim") | null = null
export let md: typeof import("@codemirror/lang-markdown") | null = null

let loading: Promise<void> | null = null
export const loadHeavy = () => loading ??= Promise.all([import("@replit/codemirror-vim"), import("@codemirror/lang-markdown"), import("@codemirror/lint"), import("@lezer/lr")])
  .then(([v, m, lint, lr]) => {
    vim = v; md = m
    CM["@codemirror/lint"] = lint; CM["@lezer/lr"] = lr
  })
