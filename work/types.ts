// What Work keeps in the store (/api/state's `work`: Work.md, the focus card).
export type Work = { id: string; modified: string; focus: string; questions: string[]; colleagues: { name: string; role: string }[]; notes: string }

declare module "@vaultite" {
  interface PluginState {
    work: Work | null
  }
}
