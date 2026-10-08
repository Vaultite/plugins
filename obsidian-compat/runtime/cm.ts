// The editor's CodeMirror and Lezer, as plugins `require` them: the app's own copies (an extension from another copy
// doesn't work in its editor).
import * as state from "@codemirror/state"
import * as view from "@codemirror/view"
import { languageForPlugins } from "./tree.ts"
import * as commands from "@codemirror/commands"
import * as search from "@codemirror/search"
import * as autocomplete from "@codemirror/autocomplete"
import * as common from "@lezer/common"
import * as highlight from "@lezer/highlight"
import * as lint from "@codemirror/lint"
import * as lr from "@lezer/lr"


export const CM: Record<string, unknown> = {
  "@codemirror/state": state, "@codemirror/view": view, "@codemirror/language": languageForPlugins, "@codemirror/commands": commands,
  "@codemirror/search": search, "@codemirror/autocomplete": autocomplete, "@lezer/common": common, "@lezer/highlight": highlight,
  "@codemirror/lint": lint, "@lezer/lr": lr,
}
