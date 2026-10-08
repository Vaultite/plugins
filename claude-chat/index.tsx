// Claude chat in the app: a sidebar panel (its conversation kept per workspace) and a tab, view:claude-chat/<id>, both
// the same chat (Chat.tsx); the server runs Claude Code (plugin.ts).
import { MessageSquarePlus } from "lucide-react"
import { definePlugin, openView, Panel, useScopedState, type SidebarCtx } from "@vaultite"
import { Chat, ChatIcon, TINT } from "./Chat"
import { titleOf } from "./live"

function SidebarChat({ open, bounded }: SidebarCtx) {
  const [id, setId] = useScopedState("claude-chat:current", "", "workspace")
  if (!open) return null
  return (
    <div className={bounded ? "flex h-full min-h-0 flex-col" : "flex flex-col"} data-chat-panel>
      <Chat id={id} setId={(x) => setId(x || undefined)} fill={!!bounded} />
    </div>
  )
}

function Preview() {
  return (
    <Panel title="Claude chat" icon={ChatIcon} tint={TINT}>
      <p className="text-[15px] leading-[20px] text-muted-foreground">
        Claude Code as a chat beside your notes: ask about them or have it change them, and watch what it reads and edits,
        each file a link and each edit a diff. It asks before it changes anything (or accepts edits, or only plans: your
        choice), and you answer with Allow or Deny. The open note goes with your message; type @ to point it at another.
        It runs your own Claude Code on the server's machine, signed in to your account; a conversation can go on in a
        terminal whenever you want the full thing.
      </p>
    </Panel>
  )
}

export default definePlugin({
  icons: { "claude-chat": ChatIcon },
  sidebar: {
    chat: { title: "Claude chat", names: ["claude", "chat", "claudian", "assistant"], heading: false, tall: true, sort: 60, view: "claude-chat",
      flyout: { icon: ChatIcon, width: 380 }, render: (ctx) => <SidebarChat {...ctx} /> },
  },
  views: {
    "claude-chat": {
      icon: ChatIcon,
      iconTint: () => TINT,
      title: (arg) => titleOf(arg) || "Claude chat",
      argState: true,
      full: true,
      keepsTab: true,
      render: ({ arg, setArg }) => <div className="flex h-full min-h-0 flex-col" data-chat-tab><Chat id={arg} setId={setArg} tab /></div>,
    },
  },
  commands: [
    { id: "claude-chat:new", name: "New Claude chat", icon: MessageSquarePlus, run: () => openView("claude-chat/", { newTab: true }) },
    { id: "claude-chat:split", desktop: true, name: "Open Claude chat in right split", icon: ChatIcon, run: () => openView("claude-chat/", { split: true }) },
  ],
  preview: () => <Preview />,
})
