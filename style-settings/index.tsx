// Style settings: the settings CSS snippets declare in `/* @settings */` (Obsidian's Style Settings convention) as a
// form in this plugin's sheet, applied live as CSS variables and classes on <body>, kept in its data.json.
import { useEffect, useLayoutEffect } from "react"
import { Paintbrush } from "lucide-react"
import { definePlugin, useVaultChange } from "@vaultite"
import { StylePanel } from "./Panel"
import { applyCached, DATA, loadSources, loadValues, takeDown } from "./state.ts"

const SOURCES = [".vaultite/snippets", ".vaultite/themes", ".vaultite/appearance.json"]

function Background() {
  useLayoutEffect(() => { applyCached(); return takeDown }, [])
  useEffect(() => { void loadSources().then(loadValues) }, [])
  useVaultChange(() => { void loadValues() }, [DATA])
  useVaultChange(() => { void loadSources() }, SOURCES)
  return null
}

export default definePlugin({
  icon: Paintbrush,
  background: () => <Background />,
  settingsPanel: () => <StylePanel />,
  settingsSearch: [
    { label: "Accent colour", description: "buttons, links, switches and the cursor", key: "vaultite@@primary" },
    { label: "Line width", description: "a note's widest line", key: "vaultite@@line-width" },
  ],
})
