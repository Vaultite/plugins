## Tailscale
Labels for what's served: `.vaultite/plugins/tailscale/data.json`, `{"services": [{"port": 8447, "label": "Vaultite",
"note": "This app"}, {"port": 8443, "host": "studio", "label": "Blog"}]}` (by port; `host`, a device's name, for one
machine only). When you add or remove a `tailscale serve` mapping, update that file too.
