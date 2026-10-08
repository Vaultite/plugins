// Editing toolbar: a formatting bar for notes, like Obsidian's Editing Toolbar. The editor makes room for it (cm.ts),
// Host draws it there, and its buttons run the app's editing commands (buttons.ts).
import { PanelTop } from "lucide-react"
import { definePlugin } from "@vaultite"
import { toolbar } from "./cm"
import { Host } from "./Host"
import { ready } from "./settings"
import { ButtonsSettings } from "./ButtonsSettings"

export default definePlugin({
  icon: PanelTop,
  // A note's own view only (an editor with a path), not text kept elsewhere (a canvas card); its settings first, so
  // a note opens with the bar where it belongs.
  editor: (ctx) => (ctx.kind === "markdown" && ctx.path ? ready().then(toolbar) : []),
  background: () => <Host />,
  settingsPanel: () => <ButtonsSettings />,
  settingsSearch: [{ label: "Buttons", description: "which buttons the toolbar shows, and their order" }],
})
