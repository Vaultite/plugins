## Drawings (`*.excalidraw`, `*.excalidraw.md`, Excalidraw)
Hand-drawn diagrams and sketches. `.excalidraw.md` files are Obsidian's Excalidraw plugin's (the drawing compressed in
a ```compressed-json block): the app opens and saves them so Obsidian still reads them; to write one, prefer a plain
`.excalidraw`. A drawing is a `.excalidraw` file anywhere in the vault (new ones go next to the note
being written, else `Drawings/`, or in the folder right-clicked in the file tree: New drawing): the JSON excalidraw.com saves, so files from there open as they are. The app draws it
as a whiteboard; `![[Drawings/Plan.excalidraw]]` on a line of its own in a note or a dashboard shows a picture of it
(`|400`: its height).

To write one, the shape is:

    {"type": "excalidraw", "version": 2, "source": "vaultite",
     "elements": [
       {"id": "box1", "type": "rectangle", "x": 0, "y": 0, "width": 200, "height": 80,
        "strokeColor": "#1e1e1e", "backgroundColor": "#a5d8ff", "fillStyle": "solid", "roughness": 1,
        "boundElements": [{"id": "box1-text", "type": "text"}]},
       {"id": "box1-text", "type": "text", "x": 50, "y": 28, "width": 100, "height": 25, "text": "Idea",
        "originalText": "Idea", "fontSize": 20, "fontFamily": 5, "textAlign": "center", "verticalAlign": "middle",
        "containerId": "box1"},
       {"id": "a1", "type": "arrow", "x": 200, "y": 40, "width": 120, "height": 0, "points": [[0, 0], [120, 0]],
        "endArrowhead": "arrow"}
     ],
     "appState": {"viewBackgroundColor": "#ffffff"},
     "files": {}}

Element types: rectangle, ellipse, diamond, arrow, line (`points` relative to x/y), freedraw, text (standalone or
inside a shape with `containerId`, the shape listing it in `boundElements`), image (`fileId` into `files`). Missing
fields (version, seed, angle...) are filled in when it's opened; ids must be unique. Keep the JSON valid: the app saves
it only while it parses. Sentence case in labels, no emojis.
