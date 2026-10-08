const obsidian = require("obsidian")
module.exports = class Probe extends obsidian.Plugin { onload() { window.__probe = { obsidian, app: this.app, plugin: this } } }
