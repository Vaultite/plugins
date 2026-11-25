import { Sparkles } from "lucide-react"
import { AgentLimits, definePlugin, type AgentSource, type BlockCtx } from "@vaultite"

// Gemini draws the limits block (`agent: gemini`) with the app's agent components on GET /api/gemini/limits: the Gemini
// app's plan, whose chats aren't read here.
const SRC: AgentSource = {
  path: "gemini", label: "Gemini", icon: Sparkles, tint: "var(--blue)", agent: "gemini", view: "gemini-session",
  noLimits: "No limits yet. They come from the Gemini app's Usage limits page, read in the agents' browser signed in to Google with the plan.",
  consent: { setting: "account", ask: "Read your Gemini usage limits from your Google account?",
    detail: "Vaultite opens the Gemini app's Usage limits page in the background in the agents' browser, with its Google sign-in, at most every 10 minutes while a page shows them, and closes it. Nothing is kept." },
}

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()

export default definePlugin({
  blocks: { "agent-limits": (ctx: BlockCtx) => <AgentLimits src={SRC} {...ctx} /> },
  mockLive: () => ({
    "gemini/limits": { plan: { name: "Google AI Pro", monthly: null }, limits: { source: "Gemini app", observed: ago(4), windows: [
      { id: "session", label: "Current session", minutes: 300, used: 18, resets_at: ago(-140) },
      { id: "week", label: "This week", minutes: 10080, used: 41, resets_at: ago(-60 * 24 * 3) }] } },
  }),
})
