// Tasks (Obsidian Tasks' format): ```tasks queries drawn as checklists, the done date and recurrences written when a
// task is ticked in a note, [/] and [-] drawn as boxes, and Create or edit task for the line the cursor is on.
import { useEffect } from "react"
import { ListChecks } from "lucide-react"
import { currentEditor, definePlugin, Panel, usePluginSettings } from "@vaultite"
import { taskEditor, toggleAt } from "./editor.ts"
import { TaskForm } from "./Form"
import { setPrefs } from "./prefs.ts"
import { countText, QueryFence, TaskList } from "./QueryView"
import { editTask } from "./target.ts"
import { LINE } from "./task.ts"
import type { Answer } from "./types.ts"

function Background() {
  const [data] = usePluginSettings("tasks")
  useEffect(() => setPrefs(data), [data])
  return null
}

/** The note's line under the cursor, in the editor the user means. */
function here() {
  const ed = currentEditor()
  if (!ed || ed.kind !== "markdown" || ed.view.state.readOnly) return null
  return { ed, line: ed.view.state.doc.lineAt(ed.view.state.selection.main.head) }
}

const MOCK: Answer = {
  today: "2026-10-06", total: 4, shown: 4, explain: null, problems: [], layout: { short: false, hide: ["urgency", "backlink"] },
  groups: [{ names: [], tasks: [
    ["/", "Draft the Lighthouse newsletter", { due: "2026-10-06" }, "high", ""],
    [" ", "Call Alice Park", { scheduled: "2026-10-06" }, "none", "every week"],
    [" ", "Order a new lamp #shopping", { due: "2026-10-09" }, "medium", ""],
    ["x", "Check the beam", { due: "2026-10-01", done: "2026-10-02" }, "none", ""],
  ].map(([symbol, description, dates, priority, recurrence], i) => ({
    path: "Projects/Lighthouse.md", line: i + 1, text: "", heading: "", symbol, description, dates, priority, recurrence, recurrenceValid: true,
    status: symbol === "x" ? "DONE" : symbol === "/" ? "IN_PROGRESS" : "TODO", onCompletion: "", id: "", dependsOn: [], tags: [], urgency: 0, blocked: false,
  })) as Answer["groups"][number]["tasks"] }],
}

export default definePlugin({
  fences: { tasks: (ctx) => <QueryFence {...ctx} /> },
  editor: (ctx) => (ctx.kind === "markdown" ? taskEditor(!!ctx.source) : []),
  background: () => <Background />,
  details: {
    // task/<n>: the form, for the line it was opened on (target.ts)
    task: { render: (_s, [id]) => <TaskForm id={id} />, title: () => "Task" },
  },
  commands: [
    {
      id: "tasks:edit", name: "Create or edit task", when: () => !!here(),
      run: () => { const h = here(); if (h) editTask({ path: h.ed.path, line: h.line.number, text: h.line.text, view: h.ed.view }) },
      icon: ListChecks, label: "Task",
    },
    {
      id: "tasks:toggle", name: "Toggle task done", when: () => { const h = here(); return !!h && LINE.test(h.line.text) },
      run: () => { const h = here(); if (h) toggleAt(h.ed.view, h.line.from) },
    },
  ],
  slash: () => [{
    id: "tasks-query", title: "Tasks query", section: "Blocks", keywords: "todo checklist due query", line: true,
    text: "```tasks\nnot done\ndue before tomorrow\n$|\n```",
  }],
  preview: () => (
    <Panel title="Tasks" icon={ListChecks} tint="var(--notes)" action={<span className="text-[13px] text-muted-foreground">{countText(MOCK)}</span>}>
      <TaskList a={MOCK} />
    </Panel>
  ),
})
