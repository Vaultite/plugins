// Org Mode's server side: .org files as Markdown (/api/render, embeds, AIs reading them), their file: links for the
// graph, and listed like notes (titled by #+TITLE). A file the parser fails on reads as its Org source.
import fs from "node:fs"
import { Plugin } from "@vaultite/core/plugins.ts"
import type { Vault } from "@vaultite/core/vault.ts"
import { orgLinks } from "./export/links.ts"
import { fence, orgMarkdown } from "./export/markdown.ts"

export const plugin = new Plugin(import.meta.url)

plugin.provide("text:org", (text: string, rel?: string, at?: { sub?: string }) => {
  try {
    return orgMarkdown(text, { path: rel, sub: at?.sub })
  } catch {
    return fence(text, "org")
  }
})

plugin.provide("links:org", (text: string) => {
  try {
    return orgLinks(text)
  } catch {
    return []
  }
})


/** #+TITLE: lines before the first heading, joined as Org joins them; "" for none. Read from the file's start only. */
export function orgTitle(head: string): string {
  const first = head.search(/^\*+[ \t]/m), top = first < 0 ? head : head.slice(0, first)
  return [...top.matchAll(/^[ \t]*#\+title:[ \t]*(.*?)[ \t]*$/gim)].map((m) => m[1]).filter(Boolean).join(" ")
}

const looked = new Map<string, { mtime: number; title: string }>()
const HEAD = 16384

// (listed like a note: its #+TITLE, else its name without .org)
plugin.provide("looks:org", (vault: Vault, rel: string, mtime: number) => {
  let hit = looked.get(rel)
  if (hit?.mtime !== mtime) {
    let head = ""
    try {
      const fd = fs.openSync(vault.abs(rel), "r"), buf = Buffer.alloc(HEAD)
      try { head = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD, 0)).toString("utf8") } finally { fs.closeSync(fd) }
    } catch { /* (gone, or still in iCloud: its name for now) */ }
    looked.set(rel, hit = { mtime, title: orgTitle(head) })
  }
  return hit.title ? { title: hit.title } : {}
})
