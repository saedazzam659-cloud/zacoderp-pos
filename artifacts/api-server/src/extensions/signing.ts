import crypto from "node:crypto";
import { canonicalJson, type ExtensionManifest } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────
// Ed25519 signing primitives for extension manifests.
//
// The platform holds a single keypair. Every published extension manifest is
// signed with the private key; the runtime verifies the signature against the
// public key before loading the extension. A tampered manifest (anything in
// the catalog row edited after signing) fails verification and is REFUSED.
// ─────────────────────────────────────────────────────────────────────────

export interface PlatformKeyPair {
  publicKey: string; // SPKI PEM
  privateKey: string; // PKCS8 PEM
  keyId: string; // short fingerprint of the public key
}

export function generateKeyPair(): PlatformKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey, keyId: publicKeyFingerprint(publicKey) };
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  return crypto
    .createHash("sha256")
    .update(publicKeyPem.replace(/\s+/g, ""))
    .digest("hex")
    .slice(0, 16);
}

// Sign the canonical bytes of a manifest. Returns a base64 signature.
export function signManifest(privateKeyPem: string, manifest: ExtensionManifest): string {
  const data = Buffer.from(canonicalJson(manifest), "utf8");
  const sig = crypto.sign(null, data, privateKeyPem);
  return sig.toString("base64");
}

// Verify a base64 signature over a manifest. Never throws — returns false on
// any error (malformed key, bad signature, etc.).
export function verifyManifest(
  publicKeyPem: string,
  manifest: unknown,
  signatureB64: string | null | undefined,
): boolean {
  if (!signatureB64) return false;
  try {
    const data = Buffer.from(canonicalJson(manifest), "utf8");
    return crypto.verify(null, data, publicKeyPem, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
