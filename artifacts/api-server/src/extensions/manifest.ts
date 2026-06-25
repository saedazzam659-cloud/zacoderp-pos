import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────
// Extension manifest — the SIGNED contract between a partner extension and
// the Zacode platform. It is intentionally declarative: it describes WHAT an
// extension exposes (screens, API routes, requested permissions) but never
// ships executable core code. The runtime verifies its Ed25519 signature
// before honouring any of it.
// ─────────────────────────────────────────────────────────────────────────

// A surface kind lets ONE rendering mechanism (the sandboxed iframe) back
// three host-level concepts: an ordinary screen, a report, or a dashboard.
// The host groups them in the UI; the runtime treats them identically.
export const ExtensionScreenKindSchema = z.enum(["screen", "report", "dashboard"]);
export type ExtensionScreenKind = z.infer<typeof ExtensionScreenKindSchema>;

export const ExtensionScreenSchema = z.object({
  // Stable per-extension key, e.g. "home".
  key: z.string().min(1).max(64),
  titleAr: z.string().min(1).max(120),
  titleEn: z.string().max(120).optional(),
  // Optional lucide icon name the host may use for the sidebar entry.
  icon: z.string().max(64).optional(),
  // How the host should surface this screen. Default "screen".
  kind: ExtensionScreenKindSchema.default("screen"),
});
export type ExtensionScreen = z.infer<typeof ExtensionScreenSchema>;

export const ExtensionApiRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  // Path RELATIVE to the extension's /api namespace, e.g. "/ping".
  path: z.string().min(1).max(256),
  description: z.string().max(256).optional(),
});
export type ExtensionApiRoute = z.infer<typeof ExtensionApiRouteSchema>;

// A custom "table" (collection) the extension owns. Its rows live in the
// generic, tenant-scoped ext_records store — never a core table, never DDL.
export const ExtensionTableSchema = z.object({
  // Stable collection key, lowercase slug, e.g. "notes".
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "table key must be a lowercase slug"),
  titleAr: z.string().min(1).max(120),
  titleEn: z.string().max(120).optional(),
});
export type ExtensionTable = z.infer<typeof ExtensionTableSchema>;

// A requested CORE-data permission, in `resource:action` form
// (e.g. "customers:read", "customers:write"). The runtime's Core Data API
// honours a call ONLY if the matching permission is present in the SIGNED
// manifest — so permissions cannot be widened after signing.
export const ExtensionPermissionSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z_]+:(read|write)$/, "permission must be '<resource>:read' or '<resource>:write'");

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
  // Custom "tables" (collections) the extension owns. Their rows live in the
  // tenant-scoped ext_records store; the runtime accepts data writes ONLY for
  // a collection declared here.
  tables: z.array(ExtensionTableSchema).max(50).default([]),
  // CORE-data permission keys the extension requests, in `resource:action`
  // form. ENFORCED by the runtime Core Data API: a call is honoured only if
  // the matching permission appears in this SIGNED list.
  permissions: z.array(ExtensionPermissionSchema).max(100).default([]),
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
