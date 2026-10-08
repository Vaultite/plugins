// An S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO...): Signature Version 4 with Node's crypto, no SDK.
import crypto from "node:crypto"
import { call, Changed, explain, type Remote, RemoteError, type RemoteFile, tag, tags } from "./remote.ts"

export type S3Config = { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string
  /** The bucket in the address's path (endpoint/bucket/key, what MinIO and most services take) rather than its host. */
  pathStyle: boolean }

const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => crypto.createHmac("sha256", key).update(data).digest()
/** RFC 3986, as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ escaped. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The headers that sign a request (exported for the tests' fake service, which checks them the same way). */
export function sign(o: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; region: string
  accessKeyId: string; secretAccessKey: string; now?: Date }) {
  const amzDate = (o.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "")
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = { ...o.headers, host: o.url.host, "x-amz-date": amzDate, "x-amz-content-sha256": o.payloadHash }
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]))
  const query = [...o.url.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("&")
  const canonical = [o.method, o.url.pathname, query, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), o.payloadHash].join("\n")
  const scope = `${day}/${o.region}/s3/aws4_request`
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n")
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), "s3"), "aws4_request")
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex")
  const { host: _host, ...rest } = headers
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` }
}

export function s3Remote(c: S3Config): Remote {
  const base = new URL(c.endpoint.replace(/\/+$/, "") + "/")
  if (!/^https?:$/.test(base.protocol)) throw new RemoteError(0, "the endpoint is an http or https address")
  const prefix = c.prefix.replace(/^\/+/, "").replace(/\/*$/, c.prefix.replace(/^\/+|\/+$/g, "") ? "/" : "")
  const where = `bucket ${c.bucket} at ${base.host}`
  const urlOf = (key: string, query: Record<string, string> = {}) => {
    const path = [...(c.pathStyle ? [c.bucket] : []), ...key.split("/")].map(enc).join("/")
    const u = new URL(base)
    if (!c.pathStyle) u.host = `${c.bucket}.${base.host}`
    u.pathname = `${base.pathname.replace(/\/+$/, "")}/${path}`
    // (written with %20, never +, so what's sent is what's signed)
    u.search = Object.entries(query).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&")
    return u
  }

  async function request(method: string, key: string, o: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {}) {
    const url = urlOf(key, o.query)
    const body = o.body ?? Buffer.alloc(0)
    const headers = sign({ method, url, headers: o.headers ?? {}, payloadHash: sha256(body), region: c.region || "us-east-1",
      accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey })
    return call(url.toString(), { method, headers, body: method === "PUT" ? new Uint8Array(body) : undefined }, where)
  }

  async function fail(r: Response): Promise<never> {
    const text = await r.text().catch(() => "")
    throw new RemoteError(r.status, explain(r.status, tag(text, "Code"), tag(text, "Message"), where))
  }

  return {
    where,
    async list() {
      const out: RemoteFile[] = []
      let token = ""
      for (let page = 0; page < 10_000; page++) {
        const r = await request("GET", "", { query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) } })
        if (!r.ok) await fail(r)
        const xml = await r.text()
        for (const item of tags(xml, "Contents")) {
          const key = tag(item, "Key")
          if (!key.startsWith(prefix) || key.endsWith("/")) continue // (a "folder" some tools make)
          out.push({ key: key.slice(prefix.length), etag: tag(item, "ETag"), size: Number(tag(item, "Size")) || 0 })
        }
        token = tag(xml, "NextContinuationToken")
        if (tag(xml, "IsTruncated") !== "true" || !token) break
      }
      return out
    },
    async get(key) {
      const r = await request("GET", prefix + key)
      if (!r.ok) await fail(r)
      return Buffer.from(await r.arrayBuffer())
    },
    async put(key, body, cond = {}) {
      const headers: Record<string, string> = { "content-type": "application/octet-stream" }
      if (cond.ifMatch) headers["if-match"] = cond.ifMatch
      if (cond.ifNoneMatch) headers["if-none-match"] = "*"
      let r = await request("PUT", prefix + key, { body, headers })
      // Services without conditional writes say so (501, or 400 NotImplemented): written plainly then.
      if ((r.status === 501 || r.status === 400) && (cond.ifMatch || cond.ifNoneMatch)) {
        const text = await r.text().catch(() => "")
        if (r.status === 501 || /NotImplemented|InvalidArgument|conditional/i.test(text)) r = await request("PUT", prefix + key, { body, headers: { "content-type": "application/octet-stream" } })
        else throw new RemoteError(r.status, explain(r.status, tag(text, "Code"), tag(text, "Message"), where))
      }
      if (r.status === 412 || r.status === 409) { await r.text().catch(() => ""); throw new Changed("changed on the remote while syncing") }
      if (!r.ok) await fail(r)
      await r.text().catch(() => "")
      return r.headers.get("etag")
    },
    async del(key) {
      const r = await request("DELETE", prefix + key)
      if (!r.ok && r.status !== 404) await fail(r)
      await r.text().catch(() => "")
    },
  }
}
