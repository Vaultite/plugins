// How a vault file is kept on the remote: as it is, at its own path (what Obsidian's Remotely Save does without a
// password, so both can share a folder), or sealed with AES-256-GCM under a name that's a keyed hash of its path.
import crypto from "node:crypto"

/** The remote folder's own file: whether it's encrypted, and how to check a passphrase. */
export const META = ".vaultite-remote-save.json"
const MAGIC = Buffer.from("VRS1")
const CHECK = "vaultite remote save"

export type KeyInfo = { kdf: "scrypt"; N: number; r: number; p: number; salt: string; check: string }
export type Meta = { format: 1; encryption: KeyInfo | null }

export interface Codec {
  readonly encrypted: boolean
  /** The remote key of a vault path. */
  keyOf(rel: string): string
  /** The vault path of a remote key, when the key says it (plain), else null. */
  pathOf(key: string): string | null
  seal(rel: string, bytes: Buffer): Buffer
  /** The file in a remote object, and the path it says it is (checked against its key). */
  open(key: string, blob: Buffer): { rel: string; bytes: Buffer }
}

export const plainCodec: Codec = {
  encrypted: false,
  keyOf: (rel) => rel,
  pathOf: (key) => key,
  seal: (_rel, bytes) => bytes,
  open: (key, blob) => ({ rel: key, bytes: blob }),
}

type Keys = { enc: Buffer; name: Buffer }

function derive(passphrase: string, info: KeyInfo): Keys {
  const k = crypto.scryptSync(passphrase.normalize("NFC"), Buffer.from(info.salt, "base64"), 64, { N: info.N, r: info.r, p: info.p, maxmem: 256 * info.N * info.r })
  return { enc: k.subarray(0, 32), name: k.subarray(32) }
}

function encrypt(key: Buffer, plain: Buffer) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()])
}

function decrypt(key: Buffer, blob: Buffer) {
  if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error("not a file this plugin encrypted")
  const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(4, 16))
  d.setAuthTag(blob.subarray(blob.length - 16))
  try { return Buffer.concat([d.update(blob.subarray(16, blob.length - 16)), d.final()]) } catch { throw new Error("it doesn't decrypt with this passphrase (or it was changed)") }
}

/** A new remote's encryption: a fresh salt, and the check a passphrase must open. */
export function newKeyInfo(passphrase: string): KeyInfo {
  const info: KeyInfo = { kdf: "scrypt", N: 1 << 15, r: 8, p: 1, salt: crypto.randomBytes(16).toString("base64"), check: "" }
  info.check = encrypt(derive(passphrase, info).enc, Buffer.from(CHECK)).toString("base64")
  return info
}

/** The codec for an encrypted remote, or an Error saying why the passphrase doesn't fit. */
export function sealedCodec(passphrase: string, info: KeyInfo): Codec {
  if (info.kdf !== "scrypt" || !(info.N > 1 && info.N <= 1 << 20) || !(info.r > 0 && info.r <= 32) || !(info.p > 0 && info.p <= 16)) throw new Error("the remote's encryption settings aren't ones this plugin reads")
  const keys = derive(passphrase, info)
  let ok = false
  try { ok = decrypt(keys.enc, Buffer.from(info.check, "base64")).toString() === CHECK } catch { /* (wrong) */ }
  if (!ok) throw new Error("the passphrase isn't the one this remote was encrypted with")
  const keyOf = (rel: string) => {
    const h = crypto.createHmac("sha256", keys.name).update(rel.normalize("NFC")).digest("hex")
    return `${h.slice(0, 2)}/${h}`
  }
  return {
    encrypted: true,
    keyOf,
    pathOf: () => null,
    seal: (rel, bytes) => {
      const name = Buffer.from(rel.normalize("NFC"))
      const head = Buffer.alloc(4)
      head.writeUInt32BE(name.length)
      return encrypt(keys.enc, Buffer.concat([head, name, bytes]))
    },
    open: (key, blob) => {
      const plain = decrypt(keys.enc, blob)
      const n = plain.readUInt32BE(0)
      const rel = plain.subarray(4, 4 + n).toString()
      // (an object copied under another's name would otherwise land at that other path)
      if (keyOf(rel) !== key) throw new Error("its name and its content don't match")
      return { rel, bytes: plain.subarray(4 + n) }
    },
  }
}

/** Whether a remote key is one an encrypted remote makes. */
export const sealedKey = (key: string) => /^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)
