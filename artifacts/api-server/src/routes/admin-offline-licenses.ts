// Task #199 — SuperAdmin management of Standalone (offline-only) POS licenses.
// These licenses are NOT tied to a cloud company; they ship as a signed JSON file
// the customer drops into the desktop app. No /api/sync coupling, no impersonation.

import { Router } from "express";
import { db } from "@workspace/db";
import { offlineLicensesTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth } from "../middleware/auth.js";
import { generateLicenseKey, hashFingerprint } from "../lib/posDesktopGuards.js";
import { signOfflineLicense, getPublicKeyInfo } from "../lib/offlineLicenseSigner.js";

const router = Router();
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
  res.json(rows);
});

// ─── GET /api/admin/offline-licenses/public-key ──────────────────────
// Returns the current Ed25519 public key. Bundle this into every
// pos-desktop build (Vite env: VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64).
router.get("/public-key", (_req, res) => {
  res.json(getPublicKeyInfo());
});

const createSchema = z.object({
  customerName: z.string().min(1).max(200),
  vertical: z.enum(["retail", "pharmacy", "restaurant", "grocery"]).default("retail"),
  plan: z.string().min(1).max(50).default("standalone_pos"),
  maxUsers: z.number().int().min(1).max(100).default(5),
  fingerprint: z.string().min(8).optional(),   // optional pre-bind
  expiresAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().max(1000).optional(),
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
    signedFileJson: JSON.stringify(signed),
    publicKeyFingerprint: signed.publicKeyFingerprint,
    createdByUserId: userId,
  }).returning();

  res.json({ ok: true, license: created, signedFile: signed });
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
  const out: Record<string, number> = { total: 0, active: 0, revoked: 0, expired: 0 };
  for (const r of (rows.rows ?? rows as any)) {
    out[r.status] = Number(r.n); out.total += Number(r.n);
  }
  res.json(out);
});

export default router;
