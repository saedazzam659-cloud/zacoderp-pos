// Public (no-auth) endpoint that the /download landing page calls to
// fetch the active Windows installer URL for the visitor's country.
// Cache-friendly and intentionally minimal.

import { Router } from "express";
import { db } from "@workspace/db";
import { downloadReleasesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { getPublicKeyInfo } from "../lib/offlineLicenseSigner.js";

const router = Router();

// GET /api/public/download/offline-license-public-key
// (mounted via router.use("/public/download", publicDownloadRouter))
// Exposes ONLY the Ed25519 public key + fingerprint used to sign
// standalone POS license files. Safe to expose: public keys reveal
// nothing — they are intentionally meant for verifiers (the desktop
// app) to fetch and pin. Without this endpoint, every fresh install
// on a different machine fails with "هذا الترخيص لم يُوقَّع بمفتاح
// هذه النسخة من التطبيق" whenever the server's signing key drifts
// from the MSI build's hardcoded constant — which is what just
// happened on the user's new laptop.
router.get("/offline-license-public-key", (_req, res) => {
  const info = getPublicKeyInfo();
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    publicKeyB64: info.publicKeyB64,
    fingerprint: info.publicKeyFingerprint,
    source: info.source,
  });
});

// GET /api/public/download/release?country=SA&platform=win-x64
router.get("/release", async (req, res) => {
  const country = String(req.query.country || "").toUpperCase() || "SA";
  const platform = String(req.query.platform || "win-x64");
  const [row] = await db.select().from(downloadReleasesTable)
    .where(and(
      eq(downloadReleasesTable.countryCode, country),
      eq(downloadReleasesTable.platform, platform),
      eq(downloadReleasesTable.isActive, true),
    ))
    .orderBy(desc(downloadReleasesTable.publishedAt))
    .limit(1);
  if (!row) {
    // Fallback to global ("ALL") country.
    const [fallback] = await db.select().from(downloadReleasesTable)
      .where(and(
        eq(downloadReleasesTable.countryCode, "ALL"),
        eq(downloadReleasesTable.platform, platform),
        eq(downloadReleasesTable.isActive, true),
      ))
      .orderBy(desc(downloadReleasesTable.publishedAt))
      .limit(1);
    if (!fallback) { res.status(404).json({ error: "no release available for this country" }); return; }
    res.json({ ...fallback, fallback: true }); return;
  }
  res.json(row);
});

// GET /api/public/download/countries → list of country codes that have an active release.
router.get("/countries", async (_req, res) => {
  const rows = await db.selectDistinct({ countryCode: downloadReleasesTable.countryCode })
    .from(downloadReleasesTable)
    .where(eq(downloadReleasesTable.isActive, true));
  res.json(rows.map((r) => r.countryCode));
});

export default router;
