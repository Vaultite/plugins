// What the runtime shares: where it runs (Obsidian's Platform) and what plugins have registered, drawn by index.tsx.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { isDesktop } from "@vaultite"
import { Events } from "./core.ts"
import type * as editor from "./editor.ts"
import type * as ui from "./ui.ts"

export type Manifest = { id: string; name: string; version: string; minAppVersion?: string; isDesktopOnly?: boolean; description?: string; author?: string; dir?: string }
export type ObsCommand = { id: string; name: string; icon?: string; hotkeys?: { modifiers: string[]; key: string }[]; callback?: () => any
  checkCallback?: (checking: boolean) => any; editorCallback?: (e: editor.Editor, ctx: any) => any; editorCheckCallback?: (checking: boolean, e: editor.Editor, ctx: any) => any; mobileOnly?: boolean }

/** Where the app is running, as Obsidian's Platform says it. */
const ua = navigator.userAgent
const electron = "vaultite" in window && /Electron/.test(ua)
const phone = !isDesktop()
export const Platform = {
  isDesktop: !phone, isMobile: phone, isDesktopApp: !phone, isMobileApp: phone && /iPhone|iPad|Android/.test(ua),
  isIosApp: /iPhone|iPad/.test(ua), isAndroidApp: /Android/.test(ua), isPhone: phone, isTablet: false,
  isMacOS: /Mac/.test(navigator.platform), isWin: /Win/.test(navigator.platform), isLinux: /Linux/.test(navigator.platform), isSafari: /Safari/.test(ua) && !/Chrome/.test(ua),
  resourcePathPrefix: "", isElectron: electron,
}

export const API_VERSION = "1.13.1"

// --- what plugins add, kept here; index.tsx draws it in the app

export type Registered = {
  commands: Map<string, { plugin: string; cmd: ObsCommand }>
  fences: Map<string, { plugin: string; fn: (source: string, el: HTMLElement, ctx: any) => any }>
  postProcessors: { plugin: string; fn: (el: HTMLElement, ctx: any) => any }[]
  settingTabs: Map<string, ui.PluginSettingTab>
  ribbon: { plugin: string; icon: string; title: string; run: (e: MouseEvent) => any; el: HTMLElement }[]
  statusBar: { plugin: string; el: HTMLElement }[]
  suggests: editor.EditorSuggest<any>[]
  /** View types, by the plugin that registered each. */
  views: Map<string, string>
  /** Extensions a plugin's view opens (registerExtensions): extension -> its plugin and view type. */
  extensions: Map<string, { plugin: string; type: string }>
  /** obsidian://<action> links a plugin answers (registerObsidianProtocolHandler). */
  protocols: Map<string, { plugin: string; fn: (params: Record<string, string>) => any }>
}
export const registered: Registered = { commands: new Map(), fences: new Map(), postProcessors: [], settingTabs: new Map(), ribbon: [], statusBar: [], suggests: [], views: new Map(), extensions: new Map(), protocols: new Map() }
export const changed = new Events()
export const tell = () => changed.trigger("changed")

