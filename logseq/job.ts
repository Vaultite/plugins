export type Job = {
  id: string; state: "queued" | "running" | "done" | "failed"; name: string; graph: string | null; folder: string | null
  /** Pages and journals read so far, of `total`. */
  notes: number; total: number; created: number; unchanged: number; files: number
  pages: number; journals: number; blocks: number; cards: number
  /** Simple queries made Tasks or Dataview queries, and those kept as Logseq wrote them. */
  queries: number; queriesKept: number
  macrosKept: Record<string, number>; brokenRefs: number; orgKept: number
  whiteboards: string[]; skipped: string[]; problems: string[]
  started: number; finished?: number; error?: string
}

export const newJob = (id: string, name: string): Job => ({
  id, state: "queued", name, graph: null, folder: null, notes: 0, total: 0, created: 0, unchanged: 0, files: 0,
  pages: 0, journals: 0, blocks: 0, cards: 0, queries: 0, queriesKept: 0, macrosKept: {}, brokenRefs: 0, orgKept: 0,
  whiteboards: [], skipped: [], problems: [], started: Date.now(),
})
