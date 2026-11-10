/**
 * Secrets handling.
 *
 * Vault (test-account passwords): envelope encryption. Each secret gets its own
 * random data key; the secret is encrypted with the data key (AES-256-GCM) and
 * the data key is encrypted with the master key from VAULT_MASTER_KEY. The
 * record's org and id are bound in as additional authenticated data, so a
 * ciphertext copied into another record or another org fails to decrypt.
 * Rotating the master key only means re-encrypting data keys.
 *
 * Tokens (API keys, refresh tokens, invites): only a SHA-256 hash is stored;
 * the plaintext is shown once.
 */
import crypto from "node:crypto";

interface Sealed { iv: string; tag: string; ct: string }

function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]);
}

export class Vault {
  private master: Buffer;
  constructor(masterKeyBase64: string) {
    this.master = Buffer.from(masterKeyBase64, "base64");
    if (this.master.length !== 32) throw new Error("VAULT_MASTER_KEY must be 32 bytes");
  }

  /** aad: "<orgId>:<credentialId>" */
  encrypt(secret: string, aad: string): string {
    const dataKey = crypto.randomBytes(32);
    const blob = { v: 1, k: seal(this.master, dataKey, `dk:${aad}`), d: seal(dataKey, Buffer.from(secret, "utf8"), aad) };
    dataKey.fill(0);
    return Buffer.from(JSON.stringify(blob)).toString("base64");
  }

  decrypt(blobBase64: string, aad: string): string {
    const blob = JSON.parse(Buffer.from(blobBase64, "base64").toString("utf8"));
    if (blob.v !== 1) throw new Error(`Unsupported vault blob version ${blob.v}`);
    const dataKey = open(this.master, blob.k, `dk:${aad}`);
    try {
      return open(dataKey, blob.d, aad).toString("utf8");
    } finally {
      dataKey.fill(0);
    }
  }
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** "qak_" + 32 random bytes. Shown once; the database keeps the hash and the first 12 chars. */
export function newApiKey() {
  const key = `qak_${randomToken(32)}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

/** Constant-time comparison of two hex digests */
export const safeEqualHex = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
