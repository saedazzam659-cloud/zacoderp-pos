import { db, platformExtensionsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { signManifest, type PlatformKeyPair } from "./signing.js";
import { listBuiltins } from "./registry.js";

// Idempotently register every builtin extension in platform_extensions with a
// FRESH signature over its current manifest. Re-running keeps the catalog row
// in lockstep with the in-code manifest (version bumps, new screens, …). It
// NEVER touches company_extensions — extensions stay OFF for all tenants until
// explicitly enabled.
export async function seedBuiltinExtensions(keys: PlatformKeyPair): Promise<void> {
  for (const ext of listBuiltins()) {
    const signature = signManifest(keys.privateKey, ext.manifest);
    try {
      await db
        .insert(platformExtensionsTable)
        .values({
          extensionId: ext.manifest.extensionId,
          nameAr: ext.manifest.name.ar,
          nameEn: ext.manifest.name.en ?? null,
          version: ext.manifest.version,
          vendor: ext.manifest.vendor ?? null,
          manifest: ext.manifest,
          signature,
          publicKeyId: keys.keyId,
          status: "active",
        })
        .onConflictDoUpdate({
          target: platformExtensionsTable.extensionId,
          set: {
            nameAr: ext.manifest.name.ar,
            nameEn: ext.manifest.name.en ?? null,
            version: ext.manifest.version,
            vendor: ext.manifest.vendor ?? null,
            manifest: ext.manifest,
            signature,
            publicKeyId: keys.keyId,
            updatedAt: sql`NOW()`,
          },
        });
    } catch (err) {
      logger.error({ err, extensionId: ext.manifest.extensionId }, "extensions: seed failed");
    }
  }
}
