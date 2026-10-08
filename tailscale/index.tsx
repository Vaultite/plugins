import { Network } from "lucide-react"
import { addDays, definePlugin, today } from "@vaultite"
import { Served, Tailnet } from "./Served"

export default definePlugin({
  icon: Network,
  // ```block-tailscale: what this machine serves on the tailnet (on Projects; `machine:` another one's). ```block-tailnet:
  // every device, the machines with what they serve.
  blocks: { tailscale: (ctx) => <Served {...ctx} />, tailnet: () => <Tailnet /> },
  preview: "projects",
  mockLive: () => ({
    "tailscale/services": [
      { url: "https://my-mac.example.ts.net/", port: 443, backend: "http://127.0.0.1:3000", up: true, title: "Blog", label: "Blog", note: "Preview" },
      { url: "https://my-mac.example.ts.net:8443/", port: 8443, backend: "http://127.0.0.1:5173", up: false, title: "", label: "Dashboard", note: "Dev server" },
    ],
    "tailscale/devices": [
      { name: "my-mac", dns: "my-mac.example.ts.net", os: "macOS", online: true, self: true, lastSeen: null, ips: [], tags: [], exitNode: false, owner: "" },
      { name: "phone", dns: "phone.example.ts.net", os: "iOS", online: false, self: false, lastSeen: `${addDays(today(), -1)}T09:00:00Z`, ips: [], tags: [], exitNode: false, owner: "" },
    ],
  }),
})
