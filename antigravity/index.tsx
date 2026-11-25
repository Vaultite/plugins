import { Orbit } from "lucide-react"
import { AgentLimits, definePlugin, type AgentSource, type BlockCtx } from "@vaultite"

// Antigravity draws the limits block (`agent: antigravity`, `machine:` where agy runs) with the app's agent components
// on GET /api/antigravity/limits.
const SRC: AgentSource = {
  path: "antigravity", label: "Antigravity", icon: Orbit, tint: "var(--blue)", agent: "agy", view: "antigravity-session",
  noLimits: "No limits yet. They come from Antigravity's CLI (agy), signed in on the machine this block reads.",
}

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()
const win = (id: string, label: string, minutes: number, used: number, renewsIn: number) => ({ id, label, minutes, used, resets_at: ago(-renewsIn) })

export default definePlugin({
  blocks: { "agent-limits": (ctx: BlockCtx) => <AgentLimits src={SRC} {...ctx} /> },
  mockLive: () => ({
    "antigravity/limits": { plan: null, limits: { source: "Antigravity CLI", observed: ago(2), windows: [
      win("gemini-5h", "Current session, Gemini", 300, 14, 200), win("gemini-weekly", "This week, Gemini", 10080, 6, 60 * 24 * 6),
      win("3p-5h", "Current session, Claude and GPT", 300, 32, 90), win("3p-weekly", "This week, Claude and GPT", 10080, 18, 60 * 24 * 4)] } },
  }),
})
