// Tiny services for the tests, in this process: an S3 bucket that checks Signature Version 4 itself (written apart from
// s3.ts's signer, so a mistake there fails here), and a WebDAV folder. Both keep objects in memory, take conditional
// writes, and can be made to drop every connection after some writes (an interrupted sync).
import crypto from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

type Obj = { body: Buffer; etag: string }
export type Fake = { url: string; objects: Map<string, Obj>; requests: string[]; failAfter: number | null; close: () => Promise<void> }

const md5 = (b: Buffer) => `"${crypto.createHash("md5").update(b).digest("hex")}"`
const body = (req: http.IncomingMessage) => new Promise<Buffer>((ok) => { const parts: Buffer[] = []; req.on("data", (c) => parts.push(c)); req.on("end", () => ok(Buffer.concat(parts))) })
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, fake: Fake) => Promise<unknown>): Promise<Fake> {
  const sockets = new Set<import("node:net").Socket>()
  let writes = 0
  const fake: Fake = { url: "", objects: new Map(), requests: [], failAfter: null, close: async () => {} }
  const server = http.createServer(async (req, res) => {
    fake.requests.push(`${req.method} ${req.url}`)
    if (req.method !== "GET" && req.method !== "PROPFIND" && fake.failAfter !== null && ++writes > fake.failAfter) { req.socket.destroy(); return }
    try { await handler(req, res, fake) } catch (e) { res.writeHead(500); res.end(String(e)) }
  })
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)) })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () => new Promise((ok) => { for (const s of sockets) s.destroy(); server.close(() => ok()) })
  return fake
}

// ---------- S3

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const sha = (b: string | Buffer) => crypto.createHash("sha256").update(b).digest("hex")
const mac = (k: string | Buffer, s: string) => crypto.createHmac("sha256", k).update(s).digest()

/** Why a request's signature is wrong, or "". */
function badSignature(req: http.IncomingMessage, payload: Buffer, keys: Record<string, string>) {
  const auth = String(req.headers.authorization ?? "")
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth)
  if (!m) return "no SigV4 authorization"
  const [, ak, day, region, signed, sig] = m
  if (!(ak in keys)) return "InvalidAccessKeyId"
  const hash = String(req.headers["x-amz-content-sha256"] ?? "")
  if (hash !== sha(payload)) return "XAmzContentSHA256Mismatch"
  const [rawPath, rawQuery = ""] = (req.url ?? "/").split("?")
  const query = rawQuery ? rawQuery.split("&").map((kv) => kv.split("=").map((x) => rfc3986(decodeURIComponent(x ?? ""))))
    .map(([k, v = ""]) => `${k}=${v}`).sort().join("&") : ""
  const names = signed.split(";")
  if (!names.includes("host") || !names.includes("x-amz-date")) return "host and x-amz-date must be signed"
  const canonical = [req.method, rawPath, query, names.map((n) => `${n}:${String(req.headers[n] ?? "").trim()}\n`).join(""), signed, hash].join("\n")
  const date = String(req.headers["x-amz-date"])
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${day}/${region}/s3/aws4_request\n${sha(canonical)}`
  const key = mac(mac(mac(mac(`AWS4${keys[ak]}`, day), region), "s3"), "aws4_request")
  return crypto.createHmac("sha256", key).update(toSign).digest("hex") === sig ? "" : "SignatureDoesNotMatch"
}

/** A bucket named `bucket` (path-style), reached with `keys` (access key id -> secret). Lists 3 keys a page. */
export function fakeS3(bucket: string, keys: Record<string, string>) {
  const err = (res: http.ServerResponse, status: number, code: string) => {
    res.writeHead(status, { "content-type": "application/xml" })
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`)
  }
  return listen(async (req, res, fake) => {
    const payload = await body(req)
    const why = badSignature(req, payload, keys)
    if (why) return err(res, 403, why)
    const url = new URL(req.url ?? "/", "http://x")
    const parts = url.pathname.split("/").slice(1)
    if (parts[0] !== bucket) return err(res, 404, "NoSuchBucket")
    const key = parts.slice(1).map(decodeURIComponent).join("/")
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? ""
      const all = [...fake.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = Number(url.searchParams.get("continuation-token") ?? 0)
      const page = all.slice(start, start + 3), more = start + 3 < all.length
      res.writeHead(200, { "content-type": "application/xml" })
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>${more}</IsTruncated>${
        more ? `<NextContinuationToken>${start + 3}</NextContinuationToken>` : ""}${page.map((k) => `<Contents><Key>${esc(k)}</Key><ETag>${esc(fake.objects.get(k)!.etag)}</ETag><Size>${fake.objects.get(k)!.body.length}</Size><LastModified>2026-10-06T10:00:00.000Z</LastModified></Contents>`).join("")}</ListBucketResult>`)
    }
    const cur = fake.objects.get(key)
    if (req.method === "GET") {
      if (!cur) return err(res, 404, "NoSuchKey")
      res.writeHead(200, { etag: cur.etag })
      return res.end(cur.body)
    }
    if (req.method === "PUT") {
      const ifMatch = req.headers["if-match"], ifNone = req.headers["if-none-match"]
      if ((ifMatch && cur?.etag !== ifMatch) || (ifNone === "*" && cur)) return err(res, 412, "PreconditionFailed")
      const etag = md5(payload)
      fake.objects.set(key, { body: payload, etag })
      res.writeHead(200, { etag })
      return res.end()
    }
    if (req.method === "DELETE") {
      fake.objects.delete(key)
      res.writeHead(204)
      return res.end()
    }
    err(res, 405, "MethodNotAllowed")
  })
}

// ---------- WebDAV

/** A WebDAV server whose folder /dav/ holds the objects (keys are paths under it), behind Basic auth. */
export function fakeWebdav(user: string, password: string) {
  const dirs = new Set<string>([""])
  let n = 0
  return listen(async (req, res, fake) => {
    const payload = await body(req)
    if (req.headers.authorization !== `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`) { res.writeHead(401, { "www-authenticate": "Basic" }); return res.end() }
    const url = new URL(req.url ?? "/", "http://x")
    if (!url.pathname.startsWith("/dav/")) { res.writeHead(404); return res.end() }
    const key = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent).join("/")
    const parent = key.split("/").slice(0, -1).join("/")
    const cur = fake.objects.get(key)
    const href = (k: string, dir: boolean) => `/dav/${k.split("/").filter(Boolean).map(encodeURIComponent).join("/")}${dir && k ? "/" : ""}`
    if (req.method === "PROPFIND") {
      if (req.headers.depth !== "1" && req.headers.depth !== "0") { res.writeHead(403); return res.end() }
      if (!dirs.has(key)) { res.writeHead(404); return res.end() }
      const kids: [string, boolean][] = req.headers.depth === "0" ? [] : [...[...dirs].filter((d) => d && d.split("/").slice(0, -1).join("/") === key).map((d): [string, boolean] => [d, true]),
        ...[...fake.objects.keys()].filter((f) => f.split("/").slice(0, -1).join("/") === key).map((f): [string, boolean] => [f, false])]
      const row = (k: string, dir: boolean) => `<D:response><D:href>${esc(href(k, dir))}</D:href><D:propstat><D:prop>${dir ? "<D:resourcetype><D:collection/></D:resourcetype>"
        : `<D:resourcetype/><D:getetag>${esc(fake.objects.get(k)!.etag)}</D:getetag><D:getcontentlength>${fake.objects.get(k)!.body.length}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
      res.writeHead(207, { "content-type": "application/xml; charset=utf-8" })
      return res.end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${row(key, true)}${kids.map(([k, d]) => row(k, d)).join("")}</D:multistatus>`)
    }
    if (req.method === "MKCOL") {
      if (dirs.has(key)) { res.writeHead(405); return res.end() }
      if (!dirs.has(parent)) { res.writeHead(409); return res.end() }
      dirs.add(key)
      res.writeHead(201)
      return res.end()
    }
    if (req.method === "GET") {
      if (!cur) { res.writeHead(404); return res.end() }
      res.writeHead(200, { etag: cur.etag })
      return res.end(cur.body)
    }
    if (req.method === "PUT") {
      if (!dirs.has(parent)) { res.writeHead(409); return res.end() }
      const ifMatch = req.headers["if-match"], ifNone = req.headers["if-none-match"]
      if ((ifMatch && cur?.etag !== ifMatch) || (ifNone === "*" && cur)) { res.writeHead(412); return res.end() }
      const etag = `"w${++n}"`
      fake.objects.set(key, { body: payload, etag })
      res.writeHead(cur ? 204 : 201, { etag })
      return res.end()
    }
    if (req.method === "DELETE") {
      if (req.headers["if-match"] && cur?.etag !== req.headers["if-match"]) { res.writeHead(412); return res.end() }
      if (!cur) { res.writeHead(404); return res.end() }
      fake.objects.delete(key)
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(405)
    res.end()
  })
}
