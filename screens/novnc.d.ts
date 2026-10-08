// noVNC ships no types: what Screen.tsx uses of it (docs/API.md in the package), plus the private parts app mode
// reaches into (pinned to the version in package.json: check them when it changes).
declare module "@novnc/novnc" {
  export type Credentials = { username?: string; password?: string; target?: string }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: Credentials; wsProtocols?: string[] })
    viewOnly: boolean
    focusOnClick: boolean
    clipViewport: boolean
    scaleViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    readonly capabilities: { power: boolean }
    disconnect(): void
    sendCredentials(credentials: Credentials): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    focus(options?: FocusOptions): void
    blur(): void
    clipboardPasteFrom(text: string): void
  }
}
