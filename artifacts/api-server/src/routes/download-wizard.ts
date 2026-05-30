// Protected install-wizard backend (/install page).
// Gates POS Desktop MSI downloads behind BOTH a valid user login (Bearer
// token from /api/auth/login) AND a SuperAdmin-issued activation code.
// The public /download page stays open; this is the locked path so not
// just anyone can grab the installer.

import { Router } from "express";
import { db } from "@workspace/db";
import { downloadAccessCodesTable, downloadReleasesTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { extractAuth } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

type WizardUser = { id: number; role: string; companyId: number | null };

function requireUser(req: any, res: any): WizardUser | null {
  const u = req.authUser as WizardUser | undefined;
  if (!u) { res.status(401).json({ error: "يجب تسجيل الدخول أولاً للمتابعة" }); return null; }
  return u;
}

// Validate an activation code WITHOUT consuming a use.
async function checkCode(rawCode: string, user: WizardUser):
  Promise<{ ok: true; row: typeof downloadAccessCodesTable.$inferSelect } | { error: string; status: 400 | 401 | 403 }> {
  const code = (rawCode || "").trim().toUpperCase();
  if (!code) return { error: "أدخل كود التفعيل", status: 400 };
  const [row] = await db.select().from(downloadAccessCodesTable)
    .where(eq(downloadAccessCodesTable.code, code));
  if (!row) return { error: "كود التفعيل غير صحيح", status: 401 };
  if (!row.isActive) return { error: "تم إيقاف كود التفعيل هذا. تواصل مع الدعم.", status: 403 };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now())
    return { error: "انتهت صلاحية كود التفعيل", status: 403 };
  if (row.companyId != null && row.companyId !== user.companyId)
    return { error: "كود التفعيل غير مخصص لحساب شركتك", status: 403 };
  if (row.maxUses != null && row.usedCount >= row.maxUses)
    return { error: "تم استنفاد عدد مرات استخدام هذا الكود", status: 403 };
  return { ok: true, row };
}

async function resolveRelease(country: string, platform: string) {
  const [row] = await db.select().from(downloadReleasesTable)
    .where(and(
      eq(downloadReleasesTable.countryCode, country),
      eq(downloadReleasesTable.platform, platform),
      eq(downloadReleasesTable.isActive, true),
    ))
    .orderBy(desc(downloadReleasesTable.publishedAt)).limit(1);
  if (row) return row;
  const [fallback] = await db.select().from(downloadReleasesTable)
    .where(and(
      eq(downloadReleasesTable.countryCode, "ALL"),
      eq(downloadReleasesTable.platform, platform),
      eq(downloadReleasesTable.isActive, true),
    ))
    .orderBy(desc(downloadReleasesTable.publishedAt)).limit(1);
  return fallback ? { ...fallback, fallback: true } : null;
}

const codeSchema = z.object({ code: z.string().min(1).max(100) });

// POST /api/download-wizard/verify — step 1 gate (login + code). No consume.
router.post("/verify", async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "أدخل كود التفعيل" }); return; }
  const r = await checkCode(parsed.data.code, user);
  if (!("ok" in r)) { res.status(r.status).json({ error: r.error }); return; }
  res.json({
    ok: true,
    label: r.row.label ?? null,
    remainingUses: r.row.maxUses == null ? null : Math.max(0, r.row.maxUses - r.row.usedCount),
  });
});

// GET /api/download-wizard/release?code=&country=&platform= — step 2 display. No consume.
router.get("/release", async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const r = await checkCode(String(req.query.code || ""), user);
  if (!("ok" in r)) { res.status(r.status).json({ error: r.error }); return; }
  const country = String(req.query.country || "").toUpperCase() || "SA";
  const platform = String(req.query.platform || "win-x64");
  const release = await resolveRelease(country, platform);
  if (!release) { res.status(404).json({ error: "لا يتوفر إصدار للدولة المحددة حالياً" }); return; }
  // Metadata ONLY — never expose downloadUrl here, or a caller could grab the
  // installer link and skip /claim, defeating the per-code use limit. The URL
  // is handed out exclusively by /claim AFTER a use is atomically consumed.
  res.json({
    id: release.id,
    countryCode: release.countryCode,
    platform: release.platform,
    version: release.version,
    fileSizeBytes: release.fileSizeBytes,
    checksumSha256: release.checksumSha256,
    releaseNotes: release.releaseNotes,
    publishedAt: release.publishedAt,
    fallback: (release as { fallback?: boolean }).fallback ?? false,
  });
});

// POST /api/download-wizard/claim — step 3 download. Atomically consumes one use.
const claimSchema = z.object({
  code: z.string().min(1).max(100),
  country: z.string().min(1).max(8).optional(),
  platform: z.string().min(1).max(20).optional(),
});
router.post("/claim", async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "بيانات غير صالحة" }); return; }
  const pre = await checkCode(parsed.data.code, user);
  if (!("ok" in pre)) { res.status(pre.status).json({ error: pre.error }); return; }
  const country = (parsed.data.country || "SA").toUpperCase();
  const platform = parsed.data.platform || "win-x64";
  const release = await resolveRelease(country, platform);
  if (!release) { res.status(404).json({ error: "لا يتوفر إصدار للدولة المحددة حالياً" }); return; }

  // Atomic consume guarded by maxUses — the WHERE re-checks the cap so two
  // concurrent claims can never push usedCount past maxUses (race-safe).
  const consumed = await db.update(downloadAccessCodesTable)
    .set({ usedCount: sql`${downloadAccessCodesTable.usedCount} + 1`, updatedAt: new Date() })
    .where(and(
      eq(downloadAccessCodesTable.id, pre.row.id),
      eq(downloadAccessCodesTable.isActive, true),
      // Re-check ALL gating conditions inside the atomic UPDATE to close the
      // TOCTOU window between checkCode() and the consume (expiry crossing,
      // admin revoke/rebind, or the use cap being hit by a concurrent claim).
      sql`(${downloadAccessCodesTable.maxUses} IS NULL OR ${downloadAccessCodesTable.usedCount} < ${downloadAccessCodesTable.maxUses})`,
      sql`(${downloadAccessCodesTable.expiresAt} IS NULL OR ${downloadAccessCodesTable.expiresAt} > ${new Date()})`,
      sql`(${downloadAccessCodesTable.companyId} IS NULL OR ${downloadAccessCodesTable.companyId} = ${user.companyId})`,
    ))
    .returning({ usedCount: downloadAccessCodesTable.usedCount, maxUses: downloadAccessCodesTable.maxUses });
  if (consumed.length === 0) { res.status(403).json({ error: "تعذّر استخدام كود التفعيل — قد يكون منتهياً أو مستنفداً" }); return; }

  res.json({
    downloadUrl: release.downloadUrl,
    version: release.version,
    remainingUses: consumed[0].maxUses == null ? null : Math.max(0, consumed[0].maxUses - consumed[0].usedCount),
  });
});

export default router;
