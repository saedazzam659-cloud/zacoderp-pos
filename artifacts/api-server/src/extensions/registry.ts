import type { Request, Response } from "express";
import { db, platformExtensionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import type { ExtensionManifest } from "./manifest.js";
import { verifyManifest } from "./signing.js";
import { loadOrCreatePlatformKeys } from "./platformKey.js";
import { seedBuiltinExtensions } from "./seed.js";
import { helloWorldExtension } from "./helloWorld.js";
import { partnerToolkitExtension } from "./partnerToolkit.js";
import { aiSuiteExtension } from "./aiSuite.js";

// Context handed to every builtin extension handler. Deliberately minimal — an
// extension sees ONLY its tenant scope, never the core db/handles.
export interface ExtensionContext {
  companyId: number | null;
  userId: number | null;
  role: string;
  token: string | null;
}

export interface BuiltinExtension {
  extensionId: string;
  manifest: ExtensionManifest;
  renderScreen: (screenKey: string, ctx: ExtensionContext) => string;
  handleApi: (sub: string, req: Request, res: Response, ctx: ExtensionContext) => void | Promise<void>;
}

// The code handlers live in-process keyed by extensionId. The DB row only
// carries the signed manifest + enable state; code is never loaded from the DB
// (no arbitrary code execution).
const BUILTINS: Record<string, BuiltinExtension> = {
  [helloWorldExtension.extensionId]: helloWorldExtension,
  [partnerToolkitExtension.extensionId]: partnerToolkitExtension,
  [aiSuiteExtension.extensionId]: aiSuiteExtension,
};

export function listBuiltins(): BuiltinExtension[] {
  return Object.values(BUILTINS);
}

export interface VerifiedExtension {
  extensionId: string;
  nameAr: string;
  nameEn: string | null;
  version: string;
  vendor: string | null;
  manifest: ExtensionManifest;
  publicKeyId: string | null;
  hasHandler: boolean;
  verified: boolean;
}

let initOnce: Promise<void> | null = null;

// Idempotent one-time platform init: ensure a signing keypair exists and the
// builtin extensions are seeded. Runs lazily on first endpoint hit so we never
// have to touch the server boot sequence.
export function ensureExtensionPlatform(): Promise<void> {
  if (!initOnce) {
    initOnce = (async () => {
      const keys = await loadOrCreatePlatformKeys();
      await seedBuiltinExtensions(keys);
    })().catch((err) => {
      // Reset so a transient failure can retry on the next request.
      initOnce = null;
      logger.error({ err }, "extensions: platform init failed");
      throw err;
    });
  }
  return initOnce;
}

// Returns ALL active + signature-verified platform extensions (catalog view).
export async function getActiveExtensions(): Promise<VerifiedExtension[]> {
  await ensureExtensionPlatform();
  const keys = await loadOrCreatePlatformKeys();
  const rows = await db
    .select()
    .from(platformExtensionsTable)
    .where(eq(platformExtensionsTable.status, "active"));

  const out: VerifiedExtension[] = [];
  for (const r of rows) {
    const verified = verifyManifest(keys.publicKey, r.manifest, r.signature);
    if (!verified) {
      logger.warn(
        { extensionId: r.extensionId },
        "extensions: signature verification FAILED — refusing to load",
      );
      continue;
    }
    out.push({
      extensionId: r.extensionId,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      version: r.version,
      vendor: r.vendor,
      manifest: r.manifest as ExtensionManifest,
      publicKeyId: r.publicKeyId,
      hasHandler: Boolean(BUILTINS[r.extensionId]),
      verified: true,
    });
  }
  return out;
}

// Resolve a single active + verified extension by id, or null.
export async function getExtension(extensionId: string): Promise<VerifiedExtension | null> {
  const all = await getActiveExtensions();
  return all.find((e) => e.extensionId === extensionId) ?? null;
}

export function getBuiltin(extensionId: string): BuiltinExtension | null {
  return BUILTINS[extensionId] ?? null;
}
