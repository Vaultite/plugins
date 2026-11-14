// What every part of the drawing reads: the file, its indexes, its folds, and how to jump within it.
import { createContext, useContext } from "react"
import type { Store } from "@vaultite"
import type { OrgNode, Settings } from "../parser/index.ts"
import type { Doc } from "./tree.ts"
import type { Folds } from "./folds.ts"

export type View = {
  store?: Store
  path: string
  text: string
  root: OrgNode
  doc: Doc
  settings: Settings
  folds: Folds
  /** Each headline's key in `folds`. */
  keys: Map<OrgNode, string>
  /** Show what's at `pos` (unfolding what hides it) and scroll to it. */
  jump: (pos: number) => void
  compact: boolean
}

export const ViewCtx = createContext<View | null>(null)
export const useView = () => useContext(ViewCtx)!
