import { definePlugin } from "@vaultite"

// An importer: no screen of its own. Claude runs import.ts, which turns an Apple Health export into sleep and workout logs.
export default definePlugin({ preview: "health" })
