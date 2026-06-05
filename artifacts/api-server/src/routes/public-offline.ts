// Task #236 — Public (no-auth) endpoints for STANDALONE pos-desktop devices.
//
// Standalone devices used to be 100% offline (Task #233): the operator dropped
// a SuperAdmin-signed `.zacolic.json` file in by hand. This adds an optional
// ONLINE path: the device registers its company profile + hardware fingerprint
// with the cloud, receives an Ed25519-signed license, and periodically
// re-validates so the SuperAdmin can remotely renew / shorten expiry or revoke.
//
// Mounted at /api/public/offline (NO auth — like /public/download). The only
// trust anchor is the Ed25519 signature: anything these endpoints return is
// signed with the server key and verified against the build's pinned public
// key on the device, so an unauthenticated caller cannot forge a usable license.

import { Router } from "express";
import { db } from "@workspace/db";
import { offlineLicensesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { generateLicenseKey, hashFingerprint } from "../lib/posDesktopGuards.js";
import { signOfflineLicense } from "../lib/offlineLicenseSigner.js";

const router = Router();

const DEFAULT_GRACE_DAYS = 7;

// Compute the effective status of a license row at read time. The stored
// `status` column only flips to "expired" lazily, so we also evaluate the
// expiry date here so a device learns immediately when its term lapses.
function effectiveStatus(row: { status: string; expiresAt: Date | null }): "active" | "revoked" | "expired" {
  if (row.status === "revoked") return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return "expired";
  return "active";
}

// ─── POST /api/public/offline/register ───────────────────────────────
// A standalone device self-registers its company profile + fingerprint.
// Creates a `source='self_register'` row with NO expiry (the SuperAdmin
// imposes/renews one later from /admin/offline-licenses) and returns the
// freshly-signed license file for the device to store.
const registerSchema = z.object({
  customerName: z.string().min(1).max(200),
  vertical: z.enum(["retail", "pharmacy", "restaurant", "grocery"]).default("retail"),
  fingerprint: z.string().min(8),
  country: z.string().max(2).optional(),
  companyTaxNumber: z.string().max(50).optional(),
  companyCrNumber: z.string().max(50).optional(),
  companyAddress: z.string().max(300).optional(),
  companyPhone: z.string().max(50).optional(),
  companyEmail: z.string().max(120).optional(),
  appVersion: z.string().max(40).optional(),
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const d = parsed.data;
  const fpHash = hashFingerprint(d.fingerprint);

  // Idempotency: if this exact fingerprint already self-registered, return its
  // existing (current) signed file instead of minting a duplicate license.
  const existing = await db.select().from(offlineLicensesTable)
    .where(eq(offlineLicensesTable.fingerprintHash, fpHash));
  const prior = existing.find((r) => r.source === "self_register");
  if (prior) {
    if (prior.status === "revoked") { res.status(403).json({ error: "license revoked", status: "revoked" }); return; }
    let signed = prior.signedFileJson ? JSON.parse(prior.signedFileJson) : null;
    if (!signed) {
      signed = signOfflineLicense({
        licenseKey: prior.licenseKey,
        customerName: prior.customerName,
        vertical: prior.vertical,
        plan: prior.plan,
        maxUsers: prior.maxUsers,
        fingerprintHash: prior.fingerprintHash,
        issuedAt: prior.issuedAt.toISOString(),
        expiresAt: prior.expiresAt ? prior.expiresAt.toISOString() : null,
        notes: prior.notes ?? undefined,
        country: prior.country ?? undefined,
        companyTaxNumber: prior.companyTaxNumber ?? undefined,
        companyCrNumber: prior.companyCrNumber ?? undefined,
        companyAddress: prior.companyAddress ?? undefined,
        companyPhone: prior.companyPhone ?? undefined,
        companyEmail: prior.companyEmail ?? undefined,
        source: "self_register",
        graceDays: prior.graceDays ?? DEFAULT_GRACE_DAYS,
      });
      await db.update(offlineLicensesTable).set({
        signedFileJson: JSON.stringify(signed),
        publicKeyFingerprint: signed.publicKeyFingerprint,
        lastSeenAt: new Date(),
        appVersion: d.appVersion ?? prior.appVersion,
        updatedAt: new Date(),
      }).where(eq(offlineLicensesTable.id, prior.id));
    } else {
      await db.update(offlineLicensesTable).set({
        lastSeenAt: new Date(),
        appVersion: d.appVersion ?? prior.appVersion,
        updatedAt: new Date(),
      }).where(eq(offlineLicensesTable.id, prior.id));
    }
    res.json({ ok: true, status: effectiveStatus(prior), licenseKey: prior.licenseKey, signedFile: signed, alreadyRegistered: true });
    return;
  }

  const licenseKey = generateLicenseKey();
  const issuedAt = new Date();
  const signed = signOfflineLicense({
    licenseKey,
    customerName: d.customerName,
    vertical: d.vertical,
    plan: "standalone_pos",
    maxUsers: 5,
    fingerprintHash: fpHash,
    issuedAt: issuedAt.toISOString(),
    expiresAt: null,
    country: d.country,
    companyTaxNumber: d.companyTaxNumber,
    companyCrNumber: d.companyCrNumber,
    companyAddress: d.companyAddress,
    companyPhone: d.companyPhone,
    companyEmail: d.companyEmail,
    source: "self_register",
    graceDays: DEFAULT_GRACE_DAYS,
  });

  // `onConflictDoNothing` on the partial unique index (fingerprint_hash WHERE
  // source='self_register') makes concurrent registers for the SAME device
  // race-safe: only one INSERT wins, the loser gets an empty `returning()` and
  // we fall back to re-reading + returning the winner's signed file. This
  // prevents minting duplicate licenses for one machine.
  const inserted = await db.insert(offlineLicensesTable).values({
    licenseKey,
    customerName: d.customerName,
    vertical: d.vertical,
    plan: "standalone_pos",
    maxUsers: 5,
    fingerprintHash: fpHash,
    expiresAt: null,
    issuedAt,
    country: d.country ?? null,
    companyTaxNumber: d.companyTaxNumber ?? null,
    companyCrNumber: d.companyCrNumber ?? null,
    companyAddress: d.companyAddress ?? null,
    companyPhone: d.companyPhone ?? null,
    companyEmail: d.companyEmail ?? null,
    source: "self_register",
    graceDays: DEFAULT_GRACE_DAYS,
    lastSeenAt: issuedAt,
    appVersion: d.appVersion ?? null,
    signedFileJson: JSON.stringify(signed),
    publicKeyFingerprint: signed.publicKeyFingerprint,
  }).onConflictDoNothing({
    target: offlineLicensesTable.fingerprintHash,
    where: sql`source = 'self_register' AND fingerprint_hash IS NOT NULL`,
  }).returning();

  const created = inserted[0];
  if (!created) {
    // Lost the race — another concurrent register already created the row.
    const rows = await db.select().from(offlineLicensesTable)
      .where(eq(offlineLicensesTable.fingerprintHash, fpHash));
    const winner = rows.find((r) => r.source === "self_register");
    if (winner) {
      const winnerSigned = winner.signedFileJson ? JSON.parse(winner.signedFileJson) : signed;
      res.json({ ok: true, status: effectiveStatus(winner), licenseKey: winner.licenseKey, signedFile: winnerSigned, alreadyRegistered: true });
      return;
    }
    res.status(409).json({ error: "registration conflict", status: "conflict" });
    return;
  }

  res.json({ ok: true, status: "active", licenseKey: created.licenseKey, signedFile: signed });
});

// ─── POST /api/public/offline/revalidate ─────────────────────────────
// A standalone device periodically calls this to (a) prove it is online so
// its offline-grace timer resets, and (b) pull the latest signed file so the
// SuperAdmin's remote expiry/renew/revoke changes take effect. Returns the
// current status; on `active` it also returns the latest signed file.
const revalidateSchema = z.object({
  licenseKey: z.string().min(1).max(120),
  fingerprint: z.string().min(8),
  appVersion: z.string().max(40).optional(),
});

router.post("/revalidate", async (req, res) => {
  const parsed = revalidateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "bad payload", details: parsed.error.issues }); return; }
  const { licenseKey, fingerprint, appVersion } = parsed.data;
  const [lic] = await db.select().from(offlineLicensesTable)
    .where(eq(offlineLicensesTable.licenseKey, licenseKey));
  if (!lic) { res.status(404).json({ error: "license not found", status: "not_found" }); return; }

  // INVARIANT (Task #233 preserved): admin-issued FILE licenses are 100% offline
  // and must NEVER participate in cloud revalidation/binding. Only devices that
  // self-registered online (source='self_register') are managed remotely. We
  // report 404/not_found (not 403) so an admin license is indistinguishable from
  // an unknown key — this endpoint must not mutate or leak admin-license state.
  if (lic.source !== "self_register") {
    res.status(404).json({ error: "license not found", status: "not_found" });
    return;
  }

  const fpHash = hashFingerprint(fingerprint);
  // Hardware binding: a bound license may only revalidate from its own machine.
  if (lic.fingerprintHash && lic.fingerprintHash !== fpHash) {
    res.status(409).json({ error: "fingerprint mismatch", status: "fingerprint_mismatch" });
    return;
  }

  const status = effectiveStatus(lic);
  if (status === "revoked") { res.json({ status: "revoked" }); return; }

  // Bind-on-first-use: an unbound license captures this device's fingerprint
  // and is re-signed so the file carries the binding from now on.
  let signed = lic.signedFileJson ? JSON.parse(lic.signedFileJson) : null;
  let boundFp = lic.fingerprintHash;
  if (!lic.fingerprintHash) {
    boundFp = fpHash;
    signed = signOfflineLicense({
      licenseKey: lic.licenseKey,
      customerName: lic.customerName,
      vertical: lic.vertical,
      plan: lic.plan,
      maxUsers: lic.maxUsers,
      fingerprintHash: fpHash,
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
      graceDays: lic.graceDays ?? DEFAULT_GRACE_DAYS,
    });
  }

  await db.update(offlineLicensesTable).set({
    fingerprintHash: boundFp,
    lastSeenAt: new Date(),
    appVersion: appVersion ?? lic.appVersion,
    ...(signed ? { signedFileJson: JSON.stringify(signed), publicKeyFingerprint: signed.publicKeyFingerprint } : {}),
    updatedAt: new Date(),
  }).where(eq(offlineLicensesTable.id, lic.id));

  if (status === "expired") { res.json({ status: "expired", signedFile: signed ?? undefined }); return; }
  res.json({ status: "active", signedFile: signed ?? undefined });
});

export default router;
