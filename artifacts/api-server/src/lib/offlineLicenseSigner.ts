// Ed25519 signing for Standalone POS license files — Task #199.
//
// A signed license file is a small JSON document:
//   { payload: { ...JSON metadata }, payloadB64, signature, publicKey, alg: "ed25519", version: 1 }
//
// payloadB64 = base64(JSON.stringify(payload))  ← the signed bytes
// signature  = base64(ed25519_sign(privateKey, payloadB64))
// publicKey  = base64(raw 32-byte ed25519 public key)  ← embedded for self-describing files
//                (the desktop app rejects unless it matches its bundled pinned key)
//
// Keypair source (priority):
//   1. env OFFLINE_LICENSE_PRIVATE_KEY_PEM  (production)
//   2. cached file artifacts/api-server/.offline-license-keypair.local.json  (dev convenience)
//   3. generate-and-persist on first call    (one-time dev bootstrap)

import {
  generateKeyPairSync, sign as cryptoSign, createPublicKey, createPrivateKey,
  type KeyObject, createHash,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "./logger.js";

const DEV_CACHE_PATH = resolve(process.cwd(), "artifacts/api-server/.offline-license-keypair.local.json");

let _keypair: { privateKey: KeyObject; publicKey: KeyObject; publicKeyB64: string; publicKeyFingerprint: string } | null = null;

function loadKeypair(): NonNullable<typeof _keypair> {
  if (_keypair) return _keypair;

  // 1. Production: env-provided PEM
  const envPem = process.env.OFFLINE_LICENSE_PRIVATE_KEY_PEM;
  if (envPem && envPem.includes("BEGIN")) {
    try {
      const privateKey = createPrivateKey({ key: envPem, format: "pem" });
      const publicKey = createPublicKey(privateKey);
      return _keypair = finalize(privateKey, publicKey);
    } catch (e) {
      logger.error({ err: e }, "OFFLINE_LICENSE_PRIVATE_KEY_PEM is set but unparseable — falling back to dev cache");
    }
  }

  // 2. Dev cache on disk
  if (existsSync(DEV_CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(DEV_CACHE_PATH, "utf8"));
      if (cached?.privateKeyPem) {
        const privateKey = createPrivateKey({ key: cached.privateKeyPem, format: "pem" });
        const publicKey = createPublicKey(privateKey);
        return _keypair = finalize(privateKey, publicKey);
      }
    } catch (e) {
      logger.warn({ err: e }, "offline-license dev keypair cache unreadable — regenerating");
    }
  }

  // 3. Generate and persist
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  try {
    mkdirSync(dirname(DEV_CACHE_PATH), { recursive: true });
    writeFileSync(DEV_CACHE_PATH, JSON.stringify({
      _warning: "DEV-ONLY auto-generated Ed25519 keypair for Standalone POS license signing. " +
                "Production must set OFFLINE_LICENSE_PRIVATE_KEY_PEM env secret instead. " +
                "Do NOT commit this file. The matching public key must be bundled in pos-desktop builds.",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      generatedAt: new Date().toISOString(),
    }, null, 2));
    logger.warn({ path: DEV_CACHE_PATH }, "🔑 generated dev offline-license keypair — embed the public key in pos-desktop and set the matching env secret for production");
  } catch (e) {
    logger.error({ err: e }, "could not persist dev offline-license keypair");
  }
  return _keypair = finalize(privateKey, publicKey);
}

function finalize(privateKey: KeyObject, publicKey: KeyObject) {
  // 32-byte raw ed25519 public key extracted from SPKI DER (last 32 bytes).
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spkiDer.subarray(spkiDer.length - 32);
  const publicKeyB64 = raw.toString("base64");
  const publicKeyFingerprint = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return { privateKey, publicKey, publicKeyB64, publicKeyFingerprint };
}

export type OfflineLicensePayload = {
  v: 1;
  licenseKey: string;
  customerName: string;
  vertical: string;       // retail|pharmacy|restaurant|grocery
  plan: string;           // standalone_pos
  maxUsers: number;
  fingerprintHash: string | null;
  issuedAt: string;       // ISO
  expiresAt: string | null;
  serverPubKey: string;   // base64 raw 32-byte
  notes?: string;
  // ─── Online self-registration + remote control (Task #236) ──────────
  // Optional so older admin-issued files remain byte-compatible. When the
  // device self-registers online these carry the company profile; graceDays
  // tells the desktop how many days it may run offline before it must
  // re-validate against the cloud.
  country?: string;
  companyTaxNumber?: string;
  companyCrNumber?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  source?: "admin" | "self_register";
  graceDays?: number;
};

export type SignedLicenseFile = {
  v: 1;
  alg: "ed25519";
  payloadB64: string;
  signature: string;     // base64
  publicKey: string;     // base64 raw 32-byte (must match bundled pinned key)
  publicKeyFingerprint: string;
  payload: OfflineLicensePayload; // duplicated unsigned-friendly view for the UI
};

export function signOfflineLicense(payloadInput: Omit<OfflineLicensePayload, "v" | "serverPubKey">): SignedLicenseFile {
  const kp = loadKeypair();
  const payload: OfflineLicensePayload = { v: 1, serverPubKey: kp.publicKeyB64, ...payloadInput };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64");
  // Ed25519: sign() uses null algorithm; signs the raw payloadB64 bytes (NOT the inner JSON)
  // so the desktop verifier doesn't need to re-canonicalize JSON.
  const sigBuf = cryptoSign(null, Buffer.from(payloadB64, "utf8"), kp.privateKey);
  return {
    v: 1, alg: "ed25519",
    payloadB64,
    signature: sigBuf.toString("base64"),
    publicKey: kp.publicKeyB64,
    publicKeyFingerprint: kp.publicKeyFingerprint,
    payload,
  };
}

export function getPublicKeyInfo() {
  const kp = loadKeypair();
  return {
    publicKeyB64: kp.publicKeyB64,
    publicKeyFingerprint: kp.publicKeyFingerprint,
    source: process.env.OFFLINE_LICENSE_PRIVATE_KEY_PEM ? "env" : "dev-cache",
  };
}

// ─── Clock-rollback unlock codes (Task #237) ─────────────────────────
// The desktop hard-locks itself when it detects the Windows clock rolled
// backward (anti clock-rollback guard). A SuperAdmin can mint an OFFLINE
// unlock code that the device verifies with the SAME pinned Ed25519 key it
// uses for offline license files — so it works with zero internet.
//
// The locked device shows a self-contained "device code" = base64url(JSON{
//   fp,            ← this machine's hardware fingerprint
//   n,             ← the random lock nonce (rotates on every new lock)
//   v: 1
// }). The SuperAdmin pastes it here; we sign a matching unlock payload bound
// to BOTH the fingerprint and the nonce so a code minted for one device /
// one lock cannot unlock another device or a later lock.

function b64ToB64url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToB64(s: string): string {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return t + "=".repeat((4 - (t.length % 4)) % 4);
}

export type ClockUnlockPayload = {
  fp: string;
  nonce: string;
  purpose: "clock_unlock";
  iat: string; // ISO
};

/**
 * Decodes a device code, signs a fingerprint+nonce-bound unlock payload, and
 * returns a compact base64url unlock code the cashier pastes back into the
 * locked desktop. The unlock code = base64url(JSON{ p: payloadB64, s: sigB64 }),
 * mirroring the offline-license file's "sign the payloadB64 bytes" convention
 * so the desktop reuses its existing Ed25519 verify path with the pinned key.
 */
export function signClockUnlockFromDeviceCode(deviceCode: string): {
  unlockCode: string;
  fp: string;
  nonce: string;
} {
  let decoded: { fp?: string; n?: string; v?: number };
  try {
    decoded = JSON.parse(Buffer.from(b64urlToB64(deviceCode.trim()), "base64").toString("utf8"));
  } catch {
    throw new Error("invalid device code (not decodable)");
  }
  if (!decoded?.fp || !decoded?.n) throw new Error("invalid device code (missing fp/nonce)");

  const kp = loadKeypair();
  const payload: ClockUnlockPayload = {
    fp: decoded.fp,
    nonce: decoded.n,
    purpose: "clock_unlock",
    iat: new Date().toISOString(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const sig = cryptoSign(null, Buffer.from(payloadB64, "utf8"), kp.privateKey).toString("base64");
  const unlockCode = b64ToB64url(
    Buffer.from(JSON.stringify({ p: payloadB64, s: sig }), "utf8").toString("base64"),
  );
  return { unlockCode, fp: decoded.fp, nonce: decoded.n };
}
