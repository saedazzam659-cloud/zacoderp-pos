import { db, extDataTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { generateKeyPair, publicKeyFingerprint, type PlatformKeyPair } from "./signing.js";

// ─────────────────────────────────────────────────────────────────────────
// Platform signing keypair management.
//
// Priority:
//   1. Environment secrets EXTENSION_SIGNING_PUBLIC_KEY / _PRIVATE_KEY (PEM)
//      — the recommended production path (rotate via secrets).
//   2. A keypair persisted in ext_data (company_id NULL, a platform-global
//      row) — auto-generated on first use so the dev/preview environment has
//      a stable key without any manual setup.
//
// The private key NEVER leaves the server. Only the public key + fingerprint
// are exposed (for the catalog UI / verification transparency).
// ─────────────────────────────────────────────────────────────────────────

const PLATFORM_NS = "__platform__";
const KEYPAIR_KEY = "signing_keypair";

let cached: PlatformKeyPair | null = null;

export async function loadOrCreatePlatformKeys(): Promise<PlatformKeyPair> {
  if (cached) return cached;

  const envPub = process.env.EXTENSION_SIGNING_PUBLIC_KEY;
  const envPriv = process.env.EXTENSION_SIGNING_PRIVATE_KEY;
  if (envPub && envPriv) {
    cached = {
      publicKey: envPub,
      privateKey: envPriv,
      keyId: publicKeyFingerprint(envPub),
    };
    return cached;
  }

  const existing = await db
    .select({ value: extDataTable.value })
    .from(extDataTable)
    .where(
      and(
        isNull(extDataTable.companyId),
        eq(extDataTable.extensionId, PLATFORM_NS),
        eq(extDataTable.key, KEYPAIR_KEY),
      ),
    )
    .limit(1);

  const row = existing[0]?.value as PlatformKeyPair | undefined;
  if (row?.publicKey && row?.privateKey) {
    cached = {
      publicKey: row.publicKey,
      privateKey: row.privateKey,
      keyId: row.keyId ?? publicKeyFingerprint(row.publicKey),
    };
    return cached;
  }

  const fresh = generateKeyPair();
  await db.insert(extDataTable).values({
    companyId: null,
    extensionId: PLATFORM_NS,
    key: KEYPAIR_KEY,
    value: fresh,
  });
  cached = fresh;
  return cached;
}

// For tests / explicit re-read.
export function resetPlatformKeyCache(): void {
  cached = null;
}
