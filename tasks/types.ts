// What GET /api/tasks/query and tasks.list answer: a query's groups of tasks, each as the app draws it.
import type { Layout } from "./query.ts"
import type { DateKey, Priority, StatusType } from "./task.ts"

export type Shown = {
  path: string
  /** From 1. */
  line: number
  /** The line as it was read: what a write checks it's still there. */
  text: string
  heading: string
  symbol: string
  status: StatusType
  description: string
  priority: Priority
  dates: Partial<Record<DateKey, string>>
  recurrence: string
  recurrenceValid: boolean
  onCompletion: string
  id: string
  dependsOn: string[]
  tags: string[]
  urgency: number
  blocked: boolean
}

export type Answer = {
  groups: { names: string[]; tasks: Shown[] }[]
  total: number
  shown: number
  layout: Layout
  explain: string | null
  problems: string[]
  today: string
}
