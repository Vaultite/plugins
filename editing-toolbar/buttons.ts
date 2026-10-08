// The buttons it can show. Most run the app's editing commands by id (the Editing commands plugin's, Obsidian's ids),
// so a button does what the key and the palette do; undo, redo and indenting are the editor's own ⌘Z, ⇧⌘Z and Tab.
import type { EditorView } from "@codemirror/view"
import { indentLess, indentMore, redo, undo } from "@codemirror/commands"
import {
  Bold, Code, Footprints, Heading, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Highlighter, ImagePlus, IndentDecrease,
  IndentIncrease, Italic, Link, Link2, List, ListOrdered, ListTodo, MessageSquareQuote, Minus, Percent, Pilcrow, Redo2, RemoveFormatting,
  Sigma, SquareCode, SquareSigma, Strikethrough, Table, TextQuote, Undo2, type LucideIcon,
} from "lucide-react"

export type Button = {
  id: string; label: string; icon: LucideIcon
  /** The app command it runs. */
  command?: string
  /** Or what it does itself, and the keys that do the same. */
  run?: (view: EditorView) => void
  keys?: string
  /** Or a menu of commands (headings). */
  menu?: { command: string; label: string; icon: LucideIcon }[]
}

/** A thin line between groups; it may be in the list any number of times. */
export const SEPARATOR = "|"

const HEADINGS = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6]

export const BUTTONS: Button[] = [
  { id: "undo", label: "Undo", icon: Undo2, run: (v) => undo(v), keys: "Mod+Z" },
  { id: "redo", label: "Redo", icon: Redo2, run: (v) => redo(v), keys: "Mod+Shift+Z" },
  {
    id: "heading", label: "Heading", icon: Heading,
    menu: [...HEADINGS.map((icon, i) => ({ command: `editor:set-heading-${i + 1}`, label: `Heading ${i + 1}`, icon })),
      { command: "editor:set-heading-0", label: "Body", icon: Pilcrow }],
  },
  { id: "bold", label: "Bold", icon: Bold, command: "editor:toggle-bold" },
  { id: "italic", label: "Italic", icon: Italic, command: "editor:toggle-italics" },
  { id: "strikethrough", label: "Strikethrough", icon: Strikethrough, command: "editor:toggle-strikethrough" },
  { id: "highlight", label: "Highlight", icon: Highlighter, command: "editor:toggle-highlight" },
  { id: "code", label: "Code", icon: Code, command: "editor:toggle-code" },
  { id: "math", label: "Math", icon: Sigma, command: "editor:toggle-inline-math" },
  { id: "comment", label: "Comment", icon: Percent, command: "editor:toggle-comment" },
  { id: "clear-formatting", label: "Clear formatting", icon: RemoveFormatting, command: "editor:clear-formatting" },
  { id: "internal-link", label: "Add link", icon: Link, command: "editor:insert-wikilink" },
  { id: "external-link", label: "Add external link", icon: Link2, command: "editor:insert-link" },
  { id: "bullet-list", label: "Bullet list", icon: List, command: "editor:toggle-bullet-list" },
  { id: "numbered-list", label: "Numbered list", icon: ListOrdered, command: "editor:toggle-numbered-list" },
  { id: "task-list", label: "Task list", icon: ListTodo, command: "editor:toggle-task-list" },
  { id: "indent", label: "Indent", icon: IndentIncrease, run: (v) => indentMore(v), keys: "Tab" },
  { id: "outdent", label: "Outdent", icon: IndentDecrease, run: (v) => indentLess(v), keys: "Shift+Tab" },
  { id: "quote", label: "Quote", icon: TextQuote, command: "editor:toggle-blockquote" },
  { id: "callout", label: "Callout", icon: MessageSquareQuote, command: "editor:insert-callout" },
  { id: "code-block", label: "Code block", icon: SquareCode, command: "editor:insert-codeblock" },
  { id: "math-block", label: "Math block", icon: SquareSigma, command: "editor:insert-mathblock" },
  { id: "table", label: "Table", icon: Table, command: "editor:insert-table" },
  { id: "horizontal-rule", label: "Horizontal rule", icon: Minus, command: "editor:insert-horizontal-rule" },
  { id: "footnote", label: "Footnote", icon: Footprints, command: "editor:insert-footnote" },
  { id: "photo", label: "Photo", icon: ImagePlus, command: "editor:add-photo" },
]
export const BUTTON = new Map(BUTTONS.map((b) => [b.id, b]))

export const DEFAULT_BUTTONS = [
  "undo", "redo", SEPARATOR, "heading", "bold", "italic", "strikethrough", "highlight", "code", SEPARATOR,
  "internal-link", "external-link", SEPARATOR, "bullet-list", "numbered-list", "task-list", "indent", "outdent", SEPARATOR,
  "quote", "callout", "code-block", "table", SEPARATOR, "clear-formatting",
]
