/** A BrowserOS neo agent session running now, with the tab it worked in last (`GET /api/browseros/sessions`). */
export type Session = { id: string; agent: string; name: string; site: string; startedAt: number; active: boolean
  tab: { id: number; url: string; title: string } | null
  /** It asked for a person (a sign-in, a code, a captcha). */
  help: { reason: string; at: number } | null }
export type Live = { running: boolean; sessions: Session[] }
