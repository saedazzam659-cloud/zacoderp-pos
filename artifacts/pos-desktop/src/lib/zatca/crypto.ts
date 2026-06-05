// Browser-safe ZATCA crypto primitives (Task #233).
//
// The web's ZATCA code (artifacts/api-server) relies on Node's `crypto` module
// and the `openssl` binary. Neither exists inside the Tauri webview, so this
// module re-implements the exact primitives ZATCA needs using pure-JS libraries
// that run identically in the browser and in Node:
//   • SHA-256        → @noble/hashes
//   • secp256k1 ECDSA→ @noble/curves   (ZATCA's mandated EGS curve)
//   • base64 / hex   → small isomorphic helpers (btoa/atob exist in both the
//                      webview and Node ≥16)
//
// ECDSA note: ZATCA's XAdES signature uses fixed-length IEEE-P1363 (r||s, 64
// bytes for secp256k1) — see `signEcdsaP1363`. The CSR / X.509 path needs the
// DER form instead — see `signEcdsaDer`. @noble produces low-S canonical
// signatures by default, which every standards-compliant verifier accepts.

import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// ─── Encoding helpers ────────────────────────────────────────────────
export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("hex string must have an even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex string");
    out[i] = byte;
  }
  return out;
}
export function bytesToB64(b: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // avoid arg-count overflow in String.fromCharCode
  for (let i = 0; i < b.length; i += CHUNK) {
    bin += String.fromCharCode(...b.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? utf8ToBytes(input) : input;
}

// ─── SHA-256 ─────────────────────────────────────────────────────────
export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  return sha256(toBytes(input));
}
export function sha256B64(input: string | Uint8Array): string {
  return bytesToB64(sha256Bytes(input));
}
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256Bytes(input));
}

// ─── secp256k1 keys ──────────────────────────────────────────────────
export interface EcKeyPair {
  /** 32-byte secret scalar. Treat as highly sensitive — store in the OS keyring. */
  privateKey: Uint8Array;
  /** 33-byte compressed SEC1 point (0x02/0x03 prefix). */
  publicKeyCompressed: Uint8Array;
  /** 65-byte uncompressed SEC1 point (0x04 prefix). */
  publicKeyUncompressed: Uint8Array;
}

export function generateEcKeyPair(): EcKeyPair {
  const privateKey = secp256k1.utils.randomSecretKey();
  return {
    privateKey,
    publicKeyCompressed: secp256k1.getPublicKey(privateKey, true),
    publicKeyUncompressed: secp256k1.getPublicKey(privateKey, false),
  };
}

export function publicKeyFromPrivate(priv: Uint8Array, compressed = true): Uint8Array {
  return secp256k1.getPublicKey(priv, compressed);
}

// ─── ECDSA-SHA256 signing ────────────────────────────────────────────
/**
 * Sign `message` with ECDSA-SHA256, returning the fixed 64-byte r||s
 * (IEEE-P1363) form required by XAdES `<ds:SignatureValue>`.
 */
export function signEcdsaP1363(message: Uint8Array, priv: Uint8Array): Uint8Array {
  const digest = sha256(message);
  return secp256k1.sign(digest, priv, { prehash: false, format: "compact" });
}

/**
 * Sign `message` with ECDSA-SHA256, returning the ASN.1 DER form required by
 * the CSR (PKCS#10) signature and X.509 structures.
 */
export function signEcdsaDer(message: Uint8Array, priv: Uint8Array): Uint8Array {
  const digest = sha256(message);
  return secp256k1.sign(digest, priv, { prehash: false, format: "der" });
}

export function verifyEcdsaP1363(sig: Uint8Array, message: Uint8Array, pub: Uint8Array): boolean {
  const digest = sha256(message);
  return secp256k1.verify(sig, digest, pub, { prehash: false, format: "compact" });
}
