import { definePlugin } from "@vaultite"

// An importer: no screen of its own. Claude runs import.ts, which turns a Hevy export into workout logs.
export default definePlugin({ preview: "health" })
