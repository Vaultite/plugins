// A remote folder as the sync sees it: list, get, put and delete objects by key (a path under the folder), whatever
// the service. s3.ts and webdav.ts are the two kinds.

export type RemoteFile = { key: string; etag: string; size: number }

/** A write the remote refused because the object isn't what the sync last saw (someone else wrote it meanwhile). */
export class Changed extends Error {}

export interface Remote {
  /** Every object under the folder, keys relative to it ("Notes/Idea.md"). */
  list(): Promise<RemoteFile[]>
  get(key: string): Promise<Buffer>
  /** Write an object, only if it's still `ifMatch` (an etag) or, with `ifNoneMatch`, isn't there: its new etag, or
   *  null when the service doesn't say. Throws Changed when the condition fails. */
  put(key: string, body: Buffer, cond?: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<string | null>
  /** Delete an object (gone already is fine). */
  del(key: string, cond?: { ifMatch?: string }): Promise<void>
  /** Where it is, for messages: "bucket vault on r2.example.com". */
  readonly where: string
}

/** An error a service answered, with its status: what the user reads in the status and Test connection. */
export class RemoteError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The message for a failed request: what went wrong, in a line the user can act on. */
export function explain(status: number, code: string, message: string, where: string) {
  if (status === 401 || status === 403 || /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/i.test(code)) return `${where} refused the keys (${code || status}): check them and what they may do`
  if (status === 404 || /NoSuchBucket/i.test(code)) return `${where} has no such ${/bucket/i.test(code) ? "bucket" : "folder"} (${code || status})`
  return `${where} answered ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`
}

/** fetch with a timeout, and a network failure said plainly. */
export async function call(url: string, init: RequestInit, where: string, ms = 60_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms), redirect: "manual" })
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    const why = err.name === "TimeoutError" ? "didn't answer in time" : err.cause?.code === "ENOTFOUND" ? "isn't a host that resolves"
      : err.cause?.code === "ECONNREFUSED" ? "refused the connection" : `couldn't be reached (${err.cause?.code ?? err.message})`
    throw new RemoteError(0, `${where} ${why}`)
  }
}

/** XML's entities, for the few values read out of a service's answer. */
export const unxml = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[e.toLowerCase()])

/** The text of each `<tag>` (any namespace prefix) in `xml`. */
export function tags(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi")
  return [...xml.matchAll(re)].map((m) => m[1])
}
export const tag = (xml: string, name: string) => { const t = tags(xml, name)[0]; return t === undefined ? "" : unxml(t.trim()) }
