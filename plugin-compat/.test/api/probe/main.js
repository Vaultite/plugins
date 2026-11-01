const obsidian = require("obsidian")
// (a view with a frame, registered as plugins do in onload: the lab checks that its frame keeps its page)
class FrameView extends obsidian.ItemView {
  getViewType() { return "probe-frame" }
  getDisplayText() { return "Frame" }
  async onOpen() { this.contentEl.createEl("iframe", { attr: { srcdoc: "<p>framed</p>" } }) }
}
module.exports = class Probe extends obsidian.Plugin {
  onload() { window.__probe = { obsidian, app: this.app, plugin: this }; this.registerView("probe-frame", (leaf) => new FrameView(leaf)) }
}
