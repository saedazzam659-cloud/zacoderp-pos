import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// Extension manifest — the SIGNED contract between a partner extension and
// the Zacode platform. It is intentionally declarative: it describes WHAT an
// extension exposes (screens, API routes, requested permissions) but never
// ships executable core code. The runtime verifies its Ed25519 signature
// before honouring any of it.
// ─────────────────────────────────────────────────────────────────────────

export const ExtensionScreenSchema = z.object({
  // Stable per-extension key, e.g. "home".
  key: z.string().min(1).max(64),
  titleAr: z.string().min(1).max(120),
  titleEn: z.string().max(120).optional(),
  // Optional lucide icon name the host may use for the sidebar entry.
  icon: z.string().max(64).optional(),
});
export type ExtensionScreen = z.infer<typeof ExtensionScreenSchema>;

export const ExtensionApiRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  // Path RELATIVE to the extension's /api namespace, e.g. "/ping".
  path: z.string().min(1).max(256),
  description: z.string().max(256).optional(),
});
export type ExtensionApiRoute = z.infer<typeof ExtensionApiRouteSchema>;

export const ExtensionManifestSchema = z.object({
  // Manifest format version (NOT the extension version).
  manifestVersion: z.literal(1),
  extensionId: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "extensionId must be a lowercase slug"),
  name: z.object({
    ar: z.string().min(1).max(120),
    en: z.string().max(120).optional(),
  }),
  version: z.string().min(1).max(32),
  vendor: z.string().max(120).optional(),
  description: z.string().max(1024).optional(),
  screens: z.array(ExtensionScreenSchema).max(50).default([]),
  apiRoutes: z.array(ExtensionApiRouteSchema).max(200).default([]),
  // Core permission keys the extension requests. Declarative for now (Phase 0);
  // the runtime/SDK in later phases will enforce these on core-data access.
  permissions: z.array(z.string().min(1).max(64)).max(100).default([]),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

// Deterministic JSON serialisation (sorted keys) so the SAME manifest always
// produces the SAME bytes to sign/verify regardless of property order.
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) throw new Error("cannot canonicalize circular structure");
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = norm(v[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}
