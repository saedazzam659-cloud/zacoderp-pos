// Task #199 — SuperAdmin management of Standalone (offline-only) POS licenses.
// These licenses are NOT tied to a cloud company; they ship as a signed JSON file
// the customer drops into the desktop app. No /api/sync coupling, no impersonation.

import { Router } from "express";
import { db } from "@workspace/db";
import { offlineLicensesTable } from "@workspace/db";
import { eq, desc, sql, and } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth } from "../middleware/auth.js";
import { generateLicenseKey, hashFingerprint } from "../lib/posDesktopGuards.js";
import { signOfflineLicense, getPublicKeyInfo } from "../lib/offlineLicenseSigner.js";

const router = Router();
const OFFLINE_MODULE_KEYS = [
  "pos", "customers", "inventory", "purchasing",
  "sales_docs", "cash_banks", "accounting", "control", "zatca",
] as const;
const offlineModuleSchema = z.array(z.enum(OFFLINE_MODULE_KEYS))
  .min(1)
  .max(OFFLINE_MODULE_KEYS.length)
  .refine((modules) => new Set(modules).size === modules.length, "duplicate modules");
// ZATCA is opt-in; preserve the original defaults for new and approved licenses.
const defaultOfflineModules = OFFLINE_MODULE_KEYS.filter((key) => key !== "zatca");

function hasInvalidZatcaCountry(modules: readonly string[] | undefined, country: string | null | undefined) {
  return !!modules?.includes("zatca") && country?.trim().toUpperCase() !== "SA";
}
const offlineVerticalSchema = z.enum([
  "general", "grocery", "pharmacy", "retail", "restaurant",
  "plumbing", "paints", "auto_parts", "auto_workshop", "mobiles",
]);

function readSignedModules(signedFileJson: string | null): string[] | undefined {
  if (!signedFileJson) return undefined;
  try {
    const modules = JSON.parse(signedFileJson)?.payload?.modules;
    if (!Array.isArray(modules) || modules.length === 0) return undefined;
    if (
      !modules.every((module) => OFFLINE_MODULE_KEYS.includes(module)) ||
      new Set(modules).size !== modules.length
    ) return undefined;
    return [...modules];
  } catch {
    return undefined;
  }
}

function readSignedSetup(signedFileJson: string | null): Record<string, unknown> {
  if (!signedFileJson) return {};
  try {
    const payload = JSON.parse(signedFileJson)?.payload;
    if (!payload || typeof payload !== "object") return {};
    return {
      ...(payload.appProfile === "pos" || payload.appProfile === "erp" ? { appProfile: payload.appProfile } : {}),
      ...(payload.netRole === "single" || payload.netRole === "host" || payload.netRole === "client" ? { netRole: payload.netRole } : {}),
      ...(typeof payload.lanHostUrl === "string" ? { lanHostUrl: payload.lanHostUrl } : {}),
      ...(typeof payload.lanToken === "string" ? { lanToken: payload.lanToken } : {}),
      ...(Number.isInteger(payload.lanPort) ? { lanPort: payload.lanPort } : {}),
    };
  } catch {
    return {};
  }
}

router.use(extractAuth);
router.use((req, res, next) => {
  if ((req as any).authUser?.role !== "superadmin") {
    res.status(403).json({ error: "superadmin only" }); return;
  }
  next();
});

// ─── GET /api/admin/offline-licenses ─────────────────────────────────
router.get("/", async (_req, res) => {
  const rows = await db.select().from(offlineLicensesTable).orderBy(desc(offlineLicensesTable.id)).limit(500);
  res.json(rows.map((row) => ({
    ...row,
    modules: readSignedModules(row.signedFileJson) ?? null,
    ...readSignedSetup(row.signedFileJson),
  })));
});

// ─── GET /api/admin/offline-licenses/public-key ──────────────────────
// Returns the current Ed25519 public key. Bundle this into every
// pos-desktop build (Vite env: VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64).
router.get("/public-key", (_req, res) => {
  res.json(getPublicKeyInfo());
});

const createSchema = z.object({
  customerName: z.string().min(1).max(200),
  vertical: offlineVerticalSchema.default("retail"),
  plan: z.string().min(1).max(50).default("standalone_pos"),
  maxUsers: z.number().int().min(1).max(100).default(5),
  fingerprint: z.string().min(8).optional(),   // optional pre-bind
  expiresAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().max(1000).optional(),
  // Company profile (Task #236) — optional on admin-created licenses.
  country: z.string().max(2).optional(),
  companyTaxNumber: z.string().max(50).optional(),
  companyCrNumber: z.string().max(50).optional(),
  companyAddress: z.string().max(300).optional(),
  companyPhone: z.string().max(50).optional(),
  companyEmail: z.string().max(120).optional(),
  graceDays: z.number().int().min(1).max(365).optional(),
  appProfile: z.enum(["pos", "erp"]).default("pos"),
  netRole: z.enum(["single", "host", "client"]).default("single"),
  lanHostUrl: z.string().url().max(300).optional(),
  lanToken: z.string().min(8).max(128).optional(),
  lanPort: z.number().int().min(1).max(65535).default(7711),
  modules: offlineModuleSchema.default(defaultOfflineModules),
}).superRefine((value, ctx) => {
  if (value.modules.includes("zatca")) {
    ctx.addIssue({ code: "custom", path: ["modules"], message: "ZATCA can only be enabled by editing an existing license" });
  }
  if (hasInvalidZatcaCountry(value.modules, value.country)) {
    ctx.addIssue({ code: "custom", path: ["modules"], message: "ZATCA entitlement requires Saudi Arabia" });
  }
  if (value.netRole === "host" && !value.lanToken) {
    ctx.addIssue({ code: "custom", path: ["lanToken"], message: "host pairing token required" });
  }
  if (value.netRole === "client" && (!value.lanHostUrl || !value.lanToken)) {
    ctx.addIssue({ code: "custom", path: ["lanHostUrl"], message: "client host address and pairing token required" });
  }
});

// ─── POST /api/admin/offline-licenses ────────────────────────────────
// Create + sign in one step. Returns the SignedLicenseFile JSON the
// SuperAdmin downloads and hands to the customer.
router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const userId = (req as any).authUser?.id ?? null;
  const fpHash = parsed.data.fingerprint ? hashFingerprint(parsed.data.fingerprint) : null;
  const licenseKey = generateLicenseKey();

  const graceDays = parsed.data.graceDays ?? 7;
  const signed = signOfflineLicense({
    licenseKey,
    customerName: parsed.data.customerName,
    vertical: parsed.data.vertical,
    plan: parsed.data.plan,
    maxUsers: parsed.data.maxUsers,
    fingerprintHash: fpHash,
    issuedAt: new Date().toISOString(),
    expiresAt: parsed.data.expiresAt ?? null,
    notes: parsed.data.notes,
    country: parsed.data.country,
    companyTaxNumber: parsed.data.companyTaxNumber,
    companyCrNumber: parsed.data.companyCrNumber,
    companyAddress: parsed.data.companyAddress,
    companyPhone: parsed.data.companyPhone,
    companyEmail: parsed.data.companyEmail,
    source: "admin",
    graceDays,
    appProfile: parsed.data.appProfile,
    netRole: parsed.data.netRole,
    ...(parsed.data.netRole === "host" ? { lanToken: parsed.data.lanToken, lanPort: parsed.data.lanPort } : {}),
    ...(parsed.data.netRole === "client" ? { lanHostUrl: parsed.data.lanHostUrl, lanToken: parsed.data.lanToken } : {}),
    modules: parsed.data.modules,
  });

  const [created] = await db.insert(offlineLicensesTable).values({
    licenseKey,
    customerName: parsed.data.customerName,
    vertical: parsed.data.vertical,
    plan: parsed.data.plan,
    maxUsers: parsed.data.maxUsers,
    fingerprintHash: fpHash,
    expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    notes: parsed.data.notes,
    country: parsed.data.country ?? null,
    companyTaxNumber: parsed.data.companyTaxNumber ?? null,
    companyCrNumber: parsed.data.companyCrNumber ?? null,
    companyAddress: parsed.data.companyAddress ?? null,
    companyPhone: parsed.data.companyPhone ?? null,
    companyEmail: parsed.data.companyEmail ?? null,
    source: "admin",
    graceDays,
    signedFileJson: JSON.stringify(signed),
    publicKeyFingerprint: signed.publicKeyFingerprint,
    createdByUserId: userId,
  }).returning();

  res.json({ ok: true, license: created, signedFile: signed });
});

// ─── POST /api/admin/offline-licenses/:id/approve ───────────────────
// Approve a PENDING self-registered license. Grants a trial term (default
// 7 days, editable) or a permanent license, then signs + activates it so the
// device's next /revalidate pulls the freshly-signed file. Only `pending`
// rows can be approved (admin-created licenses are active on creation).
const approveSchema = z.object({
  trialDays: z.number().int().min(1).max(3650).optional(),
  permanent: z.boolean().optional(),
  vertical: offlineVerticalSchema.optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  appProfile: z.enum(["pos", "erp"]).optional(),
  netRole: z.enum(["single", "host", "client"]).optional(),
  lanHostUrl: z.string().url().max(300).optional(),
  lanToken: z.string().min(8).max(128).optional(),
  lanPort: z.number().int().min(1).max(65535).optional(),
  modules: offlineModuleSchema.default(defaultOfflineModules),
}).superRefine((value, ctx) => {
  if (value.modules.includes("zatca")) {
    ctx.addIssue({ code: "custom", path: ["modules"], message: "ZATCA can only be enabled by editing an existing license" });
  }
  if (value.netRole === "host" && !value.lanToken) {
    ctx.addIssue({ code: "custom", path: ["lanToken"], message: "host pairing token required" });
  }
  if (value.netRole === "client" && (!value.lanHostUrl || !value.lanToken)) {
    ctx.addIssue({ code: "custom", path: ["lanHostUrl"], message: "client host address and pairing token required" });
  }
});
router.post("/:id/approve", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const [existing] = await db.select().from(offlineLicensesTable).where(eq(offlineLicensesTable.id, id));
  if (!existing) { res.status(404).json({ error: "not found" }); return; }
  if (existing.status === "revoked") { res.status(409).json({ error: "cannot approve a revoked license" }); return; }
  if (existing.status !== "pending") { res.status(409).json({ error: "license is not pending approval" }); return; }

  const expiresAt: Date | null = parsed.data.permanent
    ? null
    : new Date(Date.now() + (parsed.data.trialDays ?? 7) * 86400000);
  const vertical = parsed.data.vertical ?? existing.vertical;
  const country = parsed.data.country ?? existing.country ?? undefined;
  if (hasInvalidZatcaCountry(parsed.data.modules, country)) {
    res.status(400).json({ error: "ترخيص زاتكا يتطلب اختيار السعودية" }); return;
  }
  const setup = {
    appProfile: parsed.data.appProfile ?? "pos",
    netRole: parsed.data.netRole ?? "single",
    lanHostUrl: parsed.data.lanHostUrl,
    lanToken: parsed.data.lanToken,
    lanPort: parsed.data.lanPort ?? 7711,
  };

  const signed = signOfflineLicense({
    licenseKey: existing.licenseKey,
    customerName: existing.customerName,
    vertical,
    plan: existing.plan,
    maxUsers: existing.maxUsers,
    fingerprintHash: existing.fingerprintHash,
    issuedAt: existing.issuedAt.toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    notes: existing.notes ?? undefined,
    country,
    companyTaxNumber: existing.companyTaxNumber ?? undefined,
    companyCrNumber: existing.companyCrNumber ?? undefined,
    companyAddress: existing.companyAddress ?? undefined,
    companyPhone: existing.companyPhone ?? undefined,
    companyEmail: existing.companyEmail ?? undefined,
    source: (existing.source as "admin" | "self_register") ?? "self_register",
    graceDays: existing.graceDays ?? 7,
    appProfile: setup.appProfile,
    netRole: setup.netRole,
    ...(setup.netRole === "host" ? { lanToken: setup.lanToken, lanPort: setup.lanPort } : {}),
    ...(setup.netRole === "client" ? { lanHostUrl: setup.lanHostUrl, lanToken: setup.lanToken } : {}),
    modules: parsed.data.modules,
  });

  // Atomic compare-and-set: only the row that is STILL pending is flipped.
  // Two concurrent approvals → one updates the row, the other matches 0 rows
  // and is rejected 409, so the trial term can never be set twice.
  const [updated] = await db.update(offlineLicensesTable).set({
    status: "active",
    vertical,
    expiresAt,
    country: country ?? null,
    signedFileJson: JSON.stringify(signed),
    publicKeyFingerprint: signed.publicKeyFingerprint,
    updatedAt: new Date(),
  }).where(and(
    eq(offlineLicensesTable.id, id),
    eq(offlineLicensesTable.status, "pending"),
  )).returning();
  if (!updated) { res.status(409).json({ error: "license is not pending approval" }); return; }

  res.json({ ok: true, license: updated, signedFile: signed });
});

// ─── GET /api/admin/offline-licenses/:id/file ────────────────────────
// Re-download the signed file. Forces a re-sign with the current keypair
// if the stored copy is missing (e.g. record predates this feature).
router.get("/:id/file", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const [lic] = await db.select().from(offlineLicensesTable).where(eq(offlineLicensesTable.id, id));
  if (!lic) { res.status(404).json({ error: "not found" }); return; }
  if (lic.status === "revoked") { res.status(403).json({ error: "license revoked" }); return; }

  let signed = lic.signedFileJson ? JSON.parse(lic.signedFileJson) : null;
  if (!signed) {
    signed = signOfflineLicense({
      licenseKey: lic.licenseKey,
      customerName: lic.customerName,
      vertical: lic.vertical,
      plan: lic.plan,
      maxUsers: lic.maxUsers,
      fingerprintHash: lic.fingerprintHash,
      issuedAt: lic.issuedAt.toISOString(),
      expiresAt: lic.expiresAt ? lic.expiresAt.toISOString() : null,
      notes: lic.notes ?? undefined,
      country: lic.country ?? undefined,
      companyTaxNumber: lic.companyTaxNumber ?? undefined,
      companyCrNumber: lic.companyCrNumber ?? undefined,
      companyAddress: lic.companyAddress ?? undefined,
      companyPhone: lic.companyPhone ?? undefined,
      companyEmail: lic.companyEmail ?? undefined,
      source: (lic.source as "admin" | "self_register") ?? "admin",
      graceDays: lic.graceDays ?? 7,
    });
    await db.update(offlineLicensesTable).set({
      signedFileJson: JSON.stringify(signed),
      publicKeyFingerprint: signed.publicKeyFingerprint,
      updatedAt: new Date(),
    }).where(eq(offlineLicensesTable.id, id));
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${lic.licenseKey}.zacolic.json"`);
  res.send(JSON.stringify(signed, null, 2));
});

// ─── PATCH /api/admin/offline-licenses/:id ───────────────────────────
// SuperAdmin edit — primarily for extending / renewing the expiry date,
// but also lets you correct customer name, raise maxUsers, etc. When ANY
// signed field changes (expiresAt, customerName, vertical, plan,
// maxUsers, fingerprintHash, notes) we re-sign with the current keypair
// and overwrite `signedFileJson` so the next download hands the customer
// the updated, freshly-signed file.
const editSchema = z.object({
  customerName: z.string().min(1).max(200).optional(),
  vertical: offlineVerticalSchema.optional(),
  plan: z.string().min(1).max(50).optional(),
  maxUsers: z.number().int().min(1).max(100).optional(),
  fingerprint: z.string().min(8).nullable().optional(),
  // accept "" / null to clear the expiry (make it permanent)
  expiresAt: z.union([z.string().datetime({ offset: true }), z.literal(""), z.null()]).optional(),
  notes: z.string().max(1000).nullable().optional(),
  // Company profile (Task #236) — nullable to allow clearing.
  country: z.string().max(2).nullable().optional(),
  companyTaxNumber: z.string().max(50).nullable().optional(),
  companyCrNumber: z.string().max(50).nullable().optional(),
  companyAddress: z.string().max(300).nullable().optional(),
  companyPhone: z.string().max(50).nullable().optional(),
  companyEmail: z.string().max(120).nullable().optional(),
  graceDays: z.number().int().min(1).max(365).optional(),
  appProfile: z.enum(["pos", "erp"]).optional(),
  netRole: z.enum(["single", "host", "client"]).optional(),
  lanHostUrl: z.string().url().max(300).optional(),
  lanToken: z.string().min(8).max(128).optional(),
  lanPort: z.number().int().min(1).max(65535).optional(),
  modules: offlineModuleSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.netRole === "host" && !value.lanToken) {
    ctx.addIssue({ code: "custom", path: ["lanToken"], message: "host pairing token required" });
  }
  if (value.netRole === "client" && (!value.lanHostUrl || !value.lanToken)) {
    ctx.addIssue({ code: "custom", path: ["lanHostUrl"], message: "client host address and pairing token required" });
  }
});

// Resolve an optional+nullable patch field against the existing value:
// undefined → keep existing; null → clear; value → set.
function mergeField<T>(patch: T | null | undefined, existing: T | null): T | null {
  return patch === undefined ? existing : patch;
}
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const [existing] = await db.select().from(offlineLicensesTable).where(eq(offlineLicensesTable.id, id));
  if (!existing) { res.status(404).json({ error: "not found" }); return; }
  if (existing.status === "revoked") { res.status(409).json({ error: "cannot edit a revoked license" }); return; }

  const existingSetup = readSignedSetup(existing.signedFileJson);
  const merged = {
    customerName: parsed.data.customerName ?? existing.customerName,
    vertical: parsed.data.vertical ?? existing.vertical,
    plan: parsed.data.plan ?? existing.plan,
    maxUsers: parsed.data.maxUsers ?? existing.maxUsers,
    fingerprintHash:
      parsed.data.fingerprint === undefined ? existing.fingerprintHash
      : parsed.data.fingerprint === null ? null
      : hashFingerprint(parsed.data.fingerprint),
    expiresAt:
      parsed.data.expiresAt === undefined ? existing.expiresAt
      : parsed.data.expiresAt === "" || parsed.data.expiresAt === null ? null
      : new Date(parsed.data.expiresAt),
    notes: parsed.data.notes === undefined ? existing.notes : parsed.data.notes,
    country: mergeField(parsed.data.country, existing.country),
    companyTaxNumber: mergeField(parsed.data.companyTaxNumber, existing.companyTaxNumber),
    companyCrNumber: mergeField(parsed.data.companyCrNumber, existing.companyCrNumber),
    companyAddress: mergeField(parsed.data.companyAddress, existing.companyAddress),
    companyPhone: mergeField(parsed.data.companyPhone, existing.companyPhone),
    companyEmail: mergeField(parsed.data.companyEmail, existing.companyEmail),
    graceDays: parsed.data.graceDays ?? existing.graceDays ?? 7,
    modules: parsed.data.modules ?? readSignedModules(existing.signedFileJson),
    appProfile: parsed.data.appProfile ?? existingSetup.appProfile as "pos" | "erp" | undefined,
    netRole: parsed.data.netRole ?? existingSetup.netRole as "single" | "host" | "client" | undefined,
    lanHostUrl: parsed.data.lanHostUrl ?? existingSetup.lanHostUrl as string | undefined,
    lanToken: parsed.data.lanToken ?? existingSetup.lanToken as string | undefined,
    lanPort: parsed.data.lanPort ?? existingSetup.lanPort as number | undefined,
  };
  if (parsed.data.modules?.includes("zatca") && hasInvalidZatcaCountry(parsed.data.modules, merged.country)) {
    res.status(400).json({ error: "ترخيص زاتكا يتطلب اختيار السعودية" }); return;
  }
  // If an existing Saudi license is moved to another country, the newly
  // signed file must no longer carry a Saudi-only entitlement.
  const modules = hasInvalidZatcaCountry(merged.modules, merged.country)
    ? merged.modules?.filter((module) => module !== "zatca")
    : merged.modules;

  const signed = signOfflineLicense({
    licenseKey: existing.licenseKey,
    customerName: merged.customerName,
    vertical: merged.vertical,
    plan: merged.plan,
    maxUsers: merged.maxUsers,
    fingerprintHash: merged.fingerprintHash,
    issuedAt: existing.issuedAt.toISOString(),
    expiresAt: merged.expiresAt ? merged.expiresAt.toISOString() : null,
    notes: merged.notes ?? undefined,
    country: merged.country ?? undefined,
    companyTaxNumber: merged.companyTaxNumber ?? undefined,
    companyCrNumber: merged.companyCrNumber ?? undefined,
    companyAddress: merged.companyAddress ?? undefined,
    companyPhone: merged.companyPhone ?? undefined,
    companyEmail: merged.companyEmail ?? undefined,
    source: (existing.source as "admin" | "self_register") ?? "admin",
    graceDays: merged.graceDays,
    ...(modules ? { modules } : {}),
    ...(merged.appProfile ? { appProfile: merged.appProfile } : {}),
    ...(merged.netRole ? { netRole: merged.netRole } : {}),
    ...(merged.netRole === "host" ? { lanToken: merged.lanToken, lanPort: merged.lanPort ?? 7711 } : {}),
    ...(merged.netRole === "client" ? { lanHostUrl: merged.lanHostUrl, lanToken: merged.lanToken } : {}),
  });

  const [updated] = await db.update(offlineLicensesTable).set({
    customerName: merged.customerName,
    vertical: merged.vertical,
    plan: merged.plan,
    maxUsers: merged.maxUsers,
    fingerprintHash: merged.fingerprintHash,
    expiresAt: merged.expiresAt,
    notes: merged.notes,
    country: merged.country,
    companyTaxNumber: merged.companyTaxNumber,
    companyCrNumber: merged.companyCrNumber,
    companyAddress: merged.companyAddress,
    companyPhone: merged.companyPhone,
    companyEmail: merged.companyEmail,
    graceDays: merged.graceDays,
    // If we were previously "expired" and the new expiry is in the future
    // (or null = permanent), flip back to "active".
    status: (merged.expiresAt === null || merged.expiresAt.getTime() > Date.now()) ? "active" : existing.status,
    signedFileJson: JSON.stringify(signed),
    publicKeyFingerprint: signed.publicKeyFingerprint,
    updatedAt: new Date(),
  }).where(eq(offlineLicensesTable.id, id)).returning();

  res.json({ ok: true, license: updated, signedFile: signed });
});

// ─── POST /api/admin/offline-licenses/:id/revoke ────────────────────
router.post("/:id/revoke", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  await db.update(offlineLicensesTable).set({
    status: "revoked",
    revokedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(offlineLicensesTable.id, id));
  res.json({ ok: true });
});

// ─── POST /api/admin/offline-licenses/:id/clock-unblock ─────────────
// Online clock-rollback unblock (Task #237). Stamps clockUnblockAt = now();
// a SELF-REGISTER device picks it up on its next online revalidate and clears
// its local tamper-lock. Admin file licenses never revalidate online, so this
// is a no-op for them — they must use the offline signed unlock code instead.
router.post("/:id/clock-unblock", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  const [existing] = await db.select().from(offlineLicensesTable).where(eq(offlineLicensesTable.id, id));
  if (!existing) { res.status(404).json({ error: "license not found" }); return; }
  // Online unblock only reaches devices that revalidate online (self_register).
  // Admin file licenses never phone home → stamping would be a silent no-op, so
  // reject it and steer the operator to the offline signed unlock code.
  if (existing.source !== "self_register") {
    res.status(409).json({ error: "هذا ترخيص ملف لا يتصل بالإنترنت — استخدم رمز فكّ الحظر دون اتصال." });
    return;
  }
  await db.update(offlineLicensesTable).set({
    clockUnblockAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(offlineLicensesTable.id, id));
  res.json({ ok: true, source: existing.source });
});

// ─── DELETE /api/admin/offline-licenses/:id ─────────────────────────
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "bad id" }); return; }
  await db.delete(offlineLicensesTable).where(eq(offlineLicensesTable.id, id));
  res.json({ ok: true });
});

// ─── GET /api/admin/offline-licenses/stats ───────────────────────────
router.get("/stats", async (_req, res) => {
  const rows = await db.execute<{ status: string; n: number }>(sql`
    SELECT status, COUNT(*)::int AS n FROM offline_licenses GROUP BY status
  `);
  const out: Record<string, number> = { total: 0, active: 0, revoked: 0, expired: 0, pending: 0 };
  for (const r of (rows.rows ?? rows as any)) {
    out[r.status] = Number(r.n); out.total += Number(r.n);
  }
  res.json(out);
});

export default router;
