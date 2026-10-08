import { NotebookTabs } from "lucide-react"
import { definePlugin, isViewOpen, openView, useDesktop, useFocusedFile, type Store } from "@vaultite"
import { ID, Navigator, placeName } from "./Navigator"

// Notebook navigator: a sidebar panel (two panes, stacked or side by side by its width), a tab (view:notebook-navigator)
// and, on phones, a screen of places that opens a place's notes (view:notebook-navigator/<place>), then a note.
function View({ store, arg }: { store: Store; arg: string }) {
  const desktop = useDesktop()
  const { path } = useFocusedFile()
  return desktop ? <Navigator store={store} active={path} mode="tab" /> : <Navigator store={store} active="" mode="phone" place={arg || undefined} />
}

export default definePlugin({
  icon: NotebookTabs,
  sidebar: {
    navigator: { title: "Notebook navigator", names: ["notebook", "notes list", "navigator"], sort: 36, tall: true, view: ID, flyout: { icon: NotebookTabs, width: 560 },
      render: ({ store, open, file }) => (open ? <Navigator store={store} active={file} mode="panel" /> : null) },
  },
  views: { [ID]: { icon: NotebookTabs, title: (arg) => (arg ? placeName(arg) : "Notebook"), full: true, render: ({ store, arg }) => <View store={store} arg={arg} /> } },
  commands: [{ id: `${ID}:open`, name: "Open notebook navigator", run: () => openView(ID, { newTab: !isViewOpen(ID) }) }],
})
