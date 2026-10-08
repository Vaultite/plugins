// A WebDAV folder (Nextcloud, ownCloud, Synology, rclone, dufs...): PROPFIND one folder at a time (many servers refuse
// Depth: infinity), PUT and DELETE with the etags it gives, MKCOL for folders.
import { call, Changed, explain, type Remote, RemoteError, type RemoteFile, tag, tags } from "./remote.ts"

export type WebdavConfig = { url: string; username: string; password: string }

const PROPS = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>`

export function webdavRemote(c: WebdavConfig): Remote {
  let base: URL
  try { base = new URL(c.url.replace(/\/*$/, "/")) } catch { throw new RemoteError(0, "the address isn't a URL (https://cloud.example.com/remote.php/dav/files/alice/Vault/)") }
  if (!/^https?:$/.test(base.protocol)) throw new RemoteError(0, "the address is an http or https address")
  const where = base.host
  const auth: Record<string, string> = c.username || c.password ? { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` } : {}
  const urlOf = (key: string) => new URL(key.split("/").map(encodeURIComponent).join("/"), base).toString()
  const made = new Set<string>([""]) // folders known to be there

  async function fail(r: Response): Promise<never> {
    const text = await r.text().catch(() => "")
    throw new RemoteError(r.status, explain(r.status, "", tag(text, "message") || r.statusText, where))
  }

  /** One folder's entries: files and subfolders, keys relative to the remote folder. */
  async function folder(dir: string): Promise<{ files: RemoteFile[]; dirs: string[] }> {
    const r = await call(urlOf(dir).replace(/\/?$/, "/"), { method: "PROPFIND", headers: { ...auth, depth: "1", "content-type": "application/xml" }, body: PROPS }, where)
    if (r.status !== 207) await fail(r)
    const xml = await r.text()
    const files: RemoteFile[] = [], dirs: string[] = []
    for (const resp of tags(xml, "response")) {
      let href = tag(resp, "href")
      try { href = new URL(href, base).pathname } catch { continue }
      if (!href.startsWith(base.pathname)) continue
      const key = href.slice(base.pathname.length).split("/").filter(Boolean).map((s) => decodeURIComponent(s)).join("/")
      if (key === dir || !key) continue
      // (a status other than 200 for the props: some servers list what they can't read)
      const ok = tags(resp, "propstat").find((p) => / 200 /.test(tag(p, "status"))) ?? resp
      if (/<(?:[\w-]+:)?collection\b/i.test(tags(ok, "resourcetype")[0] ?? "")) { dirs.push(key); made.add(key) }
      else files.push({ key, etag: tag(ok, "getetag"), size: Number(tag(ok, "getcontentlength")) || 0 })
    }
    return { files, dirs }
  }

  async function mkdirs(key: string) {
    const parts = key.split("/").slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/")
      if (made.has(dir)) continue
      const r = await call(urlOf(dir) + "/", { method: "MKCOL", headers: auth }, where)
      await r.text().catch(() => "")
      // 405: it's there already
      if (!r.ok && r.status !== 405) throw new RemoteError(r.status, explain(r.status, "", `couldn't make the folder ${dir}`, where))
      made.add(dir)
    }
  }

  return {
    where,
    async list() {
      const out: RemoteFile[] = []
      const queue = [""]
      while (queue.length) {
        const batch = queue.splice(0, 4)
        for (const { files, dirs } of await Promise.all(batch.map(folder))) { out.push(...files); queue.push(...dirs) }
      }
      return out
    },
    async get(key) {
      const r = await call(urlOf(key), { headers: auth }, where)
      if (!r.ok) await fail(r)
      return Buffer.from(await r.arrayBuffer())
    },
    async put(key, body, cond = {}) {
      await mkdirs(key)
      const headers: Record<string, string> = { ...auth, "content-type": "application/octet-stream" }
      if (cond.ifMatch) headers["if-match"] = cond.ifMatch
      if (cond.ifNoneMatch) headers["if-none-match"] = "*"
      const r = await call(urlOf(key), { method: "PUT", headers, body: new Uint8Array(body) }, where)
      await r.text().catch(() => "")
      if (r.status === 412) throw new Changed("changed on the remote while syncing")
      if (!r.ok) throw new RemoteError(r.status, explain(r.status, "", r.statusText, where))
      return r.headers.get("etag")
    },
    async del(key, cond = {}) {
      const r = await call(urlOf(key), { method: "DELETE", headers: cond.ifMatch ? { ...auth, "if-match": cond.ifMatch } : auth }, where)
      await r.text().catch(() => "")
      if (r.status === 412) throw new Changed("changed on the remote while syncing")
      if (!r.ok && r.status !== 404) throw new RemoteError(r.status, explain(r.status, "", r.statusText, where))
    },
  }
}
