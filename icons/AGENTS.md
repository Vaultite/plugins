## Icons (a folder's or file's icon and colour)
A note's icon is its own `icon:` property (a Lucide icon's name, `rocket`, or an emoji) and its colour `tint:` (red,
orange, yellow, green, teal, blue, indigo, purple, pink, gray). A folder's or another file's (a PDF, an image) are in
`.vaultite/plugins/icons/data.json`, `{"icons": {"Projects": {"icon": "rocket", "tint": "blue"}}}`, by vault path.
Set either with `vau icons set <path> --icon <name> --tint <colour>` (empty takes it away): it writes the right place.
Obsidian's Iconize settings (`.obsidian/plugins/obsidian-icon-folder/data.json`) are read too: its Lucide icons and
emojis, colours as the nearest of these; the settings here win.
