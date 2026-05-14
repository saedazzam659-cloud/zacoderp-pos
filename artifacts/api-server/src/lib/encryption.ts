/**
 * Symmetric encryption for credentials at rest.
 *
 * Used by the gateway-clients module to encrypt ZATCA CSID private keys,
 * tokens, and secrets before they hit Postgres. The DEK is derived from
 * SESSION_SECRET via scrypt so rotating SESSION_SECRET re-keys all
 * existing ciphertexts (after a one-time migration script).
 *
 * Format on disk:  v1:<iv_base64>:<tag_base64>:<ciphertext_base64>
 * Algorithm:       AES-256-GCM
 * KDF:             scrypt(SESSION_SECRET, "zatca-gw-v1", 32 bytes)
 *
 * Never log decrypted values, never include them in HTTP responses, and
 * always strip them in `select` projections (see gatewayClients.ts).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT = Buffer.from("zatca-gw-v1");

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set and at least 16 chars to derive the encryption key");
  }
  cachedKey = scryptSync(secret, SALT, KEY_LEN);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") throw new Error("encryptSecret expects a string");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Encrypted blob has unsupported format");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const enc = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/** Returns "•••• ABC" — never the real value. Use for status displays. */
export function maskSecret(blob: string | null | undefined, visibleTail = 4): string {
  if (!blob) return "—";
  try {
    const plain = decryptSecret(blob);
    if (!plain) return "—";
    const tail = plain.slice(-visibleTail);
    return `•••• ${tail}`;
  } catch { return "•••• ?"; }
}
