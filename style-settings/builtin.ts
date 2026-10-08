// The app's own knobs that Settings doesn't have (fonts and text sizes it has), said as a Style Settings section: the
// accent and the notes' line width are the app's CSS variables (--primary, --ring; --line-width).
import { readSettings, type Section } from "./parse.ts"

export const APP = "vaultite"

const CSS = `/* @settings
name: Vaultite
id: ${APP}
settings:
  - id: primary
    title: Accent colour
    description: Buttons, links, switches and the cursor. Unset, the colour scheme's
    type: variable-color
    format: hex
    alt-format:
      - id: ring
        format: hex
  - id: line-width
    title: Line width
    description: A note's widest line, in pixels
    type: variable-number-slider
    default: 700
    min: 500
    max: 1400
    step: 20
    format: px
*/`

/** Its section: its defaults are the app's look, so they're never written (outputOf's `quiet`). */
export const appSection = (): Section => readSettings(CSS, "Vaultite").sections[0]
