// SuperAdmin AI controls — manage per-company feature toggles, quotas
// and view usage stats. Mounted at /api/admin/ai-controls.
//
// All endpoints require role === "superadmin". The frontend lives at
// /admin/ai-controls. Companion data sources:
//   - ai_feature_settings (overrides, system defaults when company_id IS NULL)
//   - ai_usage_log         (every gated AI call lands here)
//   - AI_FEATURE_CATALOG   (compile-time list of feature keys + Arabic labels)
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { AI_FEATURE_CATALOG, type AiFeatureKey } from "@workspace/db";
import { extractAuth } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

async function requireSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const u = (req as any).authUser;
  if (!u || !u.isActive || u.role !== "superadmin") {
    res.status(403).json({ error: "superadmin required" });
    return;
  }
  next();
}

// ─── GET /catalog ─────────────────────────────────────────────────────────
// Static catalog of features. Lets the UI render the toggle table even
// when ai_feature_settings is empty.
router.get("/catalog", requireSuperAdmin, (_req, res) => {
  res.json({ features: AI_FEATURE_CATALOG });
});

// ─── GET /settings?companyId= ─────────────────────────────────────────────
// Returns every feature key with the effective setting for the requested
// company (company override > system default > catalog default). The UI
// merges this with the catalog for display.
router.get("/settings", requireSuperAdmin, async (req, res) => {
  const companyIdRaw = req.query.companyId;
  const companyId = companyIdRaw == null || companyIdRaw === ""
    ? null
    : Number(companyIdRaw);
  if (companyId != null && !Number.isFinite(companyId)) {
    res.status(400).json({ error: "companyId must be numeric or omitted (system defaults)" });
    return;
  }

  try {
    const overrides: any = companyId == null
      ? await db.execute(sql`
          SELECT feature_key, is_enabled, daily_limit, monthly_limit, note, updated_at
            FROM ai_feature_settings
           WHERE company_id IS NULL
        `)
      : await db.execute(sql`
          SELECT feature_key, is_enabled, daily_limit, monthly_limit, note, updated_at
            FROM ai_feature_settings
           WHERE company_id = ${companyId}
        `);

    const systemDefaults: any = await db.execute(sql`
      SELECT feature_key, is_enabled, daily_limit, monthly_limit
        FROM ai_feature_settings
       WHERE company_id IS NULL
    `);
    const sysMap = new Map<string, any>(
      (systemDefaults.rows ?? []).map((r: any) => [r.feature_key, r]),
    );

    const overrideMap = new Map<string, any>(
      (overrides.rows ?? []).map((r: any) => [r.feature_key, r]),
    );

    const settings = AI_FEATURE_CATALOG.map(f => {
      const ov  = overrideMap.get(f.key);
      const sys = sysMap.get(f.key);
      const eff = ov ?? sys;
      return {
        featureKey:    f.key,
        labelAr:       f.labelAr,
        tier:          f.tier,
        catalogDaily:  f.defaultDaily,
        isEnabled:     eff?.is_enabled ?? true,
        dailyLimit:    eff?.daily_limit ?? f.defaultDaily,
        monthlyLimit:  eff?.monthly_limit ?? null,
        note:          ov?.note ?? null,
        source:        ov ? "company" : sys ? "system" : "catalog",
        updatedAt:     ov?.updated_at ?? sys?.updated_at ?? null,
      };
    });

    res.json({ companyId, settings });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── PUT /settings ────────────────────────────────────────────────────────
// Bulk upsert. The UI sends the full list of edited rows in one request.
// Setting company_id = null = edit the system defaults.
const upsertSchema = z.object({
  companyId: z.number().int().positive().nullable(),
  settings: z.array(z.object({
    featureKey:   z.string().min(1).max(64),
    isEnabled:    z.boolean(),
    dailyLimit:   z.number().int().min(0).max(100000).nullable(),
    monthlyLimit: z.number().int().min(0).max(10000000).nullable(),
    note:         z.string().max(500).nullable().optional(),
  })).min(1),
});
router.put("/settings", requireSuperAdmin, async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", details: parsed.error.flatten() });
    return;
  }
  const { companyId, settings } = parsed.data;
  const updatedBy = (req as any).authUser?.id ?? null;
  const validKeys = new Set<string>(AI_FEATURE_CATALOG.map(f => f.key as string));

  try {
    for (const s of settings) {
      if (!validKeys.has(s.featureKey)) continue;
      // Upsert via DELETE+INSERT — keeps logic simple across NULL company_id.
      if (companyId == null) {
        await db.execute(sql`DELETE FROM ai_feature_settings WHERE company_id IS NULL AND feature_key = ${s.featureKey}`);
      } else {
        await db.execute(sql`DELETE FROM ai_feature_settings WHERE company_id = ${companyId} AND feature_key = ${s.featureKey}`);
      }
      await db.execute(sql`
        INSERT INTO ai_feature_settings
          (company_id, feature_key, is_enabled, daily_limit, monthly_limit, note, updated_by, updated_at)
        VALUES (
          ${companyId},
          ${s.featureKey},
          ${s.isEnabled},
          ${s.dailyLimit},
          ${s.monthlyLimit},
          ${s.note ?? null},
          ${updatedBy},
          NOW()
        )
      `);
    }
    res.json({ ok: true, count: settings.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── POST /disable-all ────────────────────────────────────────────────────
// Kill switch — disables every catalog feature for the company in one
// click. Useful when a tenant abuses the system.
const killSchema = z.object({
  companyId: z.number().int().positive(),
  note:      z.string().max(500).optional(),
});
router.post("/disable-all", requireSuperAdmin, async (req, res) => {
  const parsed = killSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "companyId required" }); return; }
  const { companyId, note } = parsed.data;
  const updatedBy = (req as any).authUser?.id ?? null;
  try {
    for (const f of AI_FEATURE_CATALOG) {
      await db.execute(sql`DELETE FROM ai_feature_settings WHERE company_id = ${companyId} AND feature_key = ${f.key}`);
      await db.execute(sql`
        INSERT INTO ai_feature_settings (company_id, feature_key, is_enabled, daily_limit, note, updated_by)
        VALUES (${companyId}, ${f.key}, FALSE, 0, ${note ?? "تم الإيقاف الجماعي من شاشة المشرف العام"}, ${updatedBy})
      `);
    }
    res.json({ ok: true, count: AI_FEATURE_CATALOG.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── POST /disable-paid ───────────────────────────────────────────────────
// Bulk-disable only the catalog entries flagged `tier: "paid"` (LLM
// callers like Gemini / OpenAI). Free / rule-based features keep
// working. `companyId: null` = update system defaults so every tenant
// without explicit overrides starts with paid features OFF.
const disablePaidSchema = z.object({
  companyId: z.number().int().positive().nullable(),
  note:      z.string().max(500).optional(),
});
router.post("/disable-paid", requireSuperAdmin, async (req, res) => {
  const parsed = disablePaidSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid body" }); return; }
  const { companyId, note } = parsed.data;
  const updatedBy = (req as any).authUser?.id ?? null;
  const paidFeatures = AI_FEATURE_CATALOG.filter(f => f.tier === "paid");
  try {
    for (const f of paidFeatures) {
      if (companyId == null) {
        await db.execute(sql`DELETE FROM ai_feature_settings WHERE company_id IS NULL AND feature_key = ${f.key}`);
        await db.execute(sql`
          INSERT INTO ai_feature_settings (company_id, feature_key, is_enabled, daily_limit, note, updated_by)
          VALUES (NULL, ${f.key}, FALSE, 0, ${note ?? "إيقاف افتراضي للميزات المدفوعة على مستوى النظام"}, ${updatedBy})
        `);
      } else {
        await db.execute(sql`DELETE FROM ai_feature_settings WHERE company_id = ${companyId} AND feature_key = ${f.key}`);
        await db.execute(sql`
          INSERT INTO ai_feature_settings (company_id, feature_key, is_enabled, daily_limit, note, updated_by)
          VALUES (${companyId}, ${f.key}, FALSE, 0, ${note ?? "إيقاف الميزات المدفوعة من شاشة المشرف العام"}, ${updatedBy})
        `);
      }
    }
    res.json({ ok: true, count: paidFeatures.length, scope: companyId == null ? "system" : "company" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── POST /enable-all ─────────────────────────────────────────────────────
// Reverse of disable-all: removes all company-specific overrides, so the
// company falls back to system defaults.
router.post("/enable-all", requireSuperAdmin, async (req, res) => {
  const parsed = killSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "companyId required" }); return; }
  const { companyId } = parsed.data;
  try {
    await db.execute(sql`DELETE FROM ai_feature_settings WHERE company_id = ${companyId}`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── GET /usage?companyId=&days= ──────────────────────────────────────────
// Aggregated usage stats per feature for the given window. Powers the
// "today / month" counters in the admin dashboard.
router.get("/usage", requireSuperAdmin, async (req, res) => {
  const companyIdRaw = req.query.companyId;
  const companyId = companyIdRaw == null || companyIdRaw === ""
    ? null
    : Number(companyIdRaw);
  if (companyId != null && !Number.isFinite(companyId)) {
    res.status(400).json({ error: "companyId must be numeric" });
    return;
  }
  const days = Math.max(1, Math.min(90, Number(req.query.days || 30)));
  const since = new Date(Date.now() - days * 86400 * 1000);
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);

  const companyCond = companyId == null ? sql`TRUE` : sql`company_id = ${companyId}`;

  try {
    const rolling: any = await db.execute(sql`
      SELECT feature_key, status, COUNT(*) AS n,
             COALESCE(SUM(tokens_in),0)  AS tokens_in,
             COALESCE(SUM(tokens_out),0) AS tokens_out
        FROM ai_usage_log
       WHERE ${companyCond} AND created_at >= ${since.toISOString()}
    GROUP BY feature_key, status
    `);

    const today: any = await db.execute(sql`
      SELECT feature_key, COUNT(*) FILTER (WHERE status='allowed') AS allowed,
                          COUNT(*) FILTER (WHERE status LIKE 'blocked_%') AS blocked
        FROM ai_usage_log
       WHERE ${companyCond} AND created_at >= ${dayStart.toISOString()}
    GROUP BY feature_key
    `);

    const month: any = await db.execute(sql`
      SELECT feature_key, COUNT(*) FILTER (WHERE status='allowed') AS allowed
        FROM ai_usage_log
       WHERE ${companyCond} AND created_at >= ${monthStart.toISOString()}
    GROUP BY feature_key
    `);

    res.json({
      companyId, days,
      rolling: rolling.rows ?? [],
      today:   today.rows   ?? [],
      month:   month.rows   ?? [],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── GET /companies ───────────────────────────────────────────────────────
// Small helper so the dropdown in the UI doesn't have to call another
// route. Only returns id+name; full company management lives elsewhere.
router.get("/companies", requireSuperAdmin, async (_req, res) => {
  try {
    const r: any = await db.execute(sql`
      SELECT id, name_ar, name_en
        FROM companies
       WHERE COALESCE(is_deleted, FALSE) = FALSE
    ORDER BY id
    `);
    res.json({ companies: (r.rows ?? []).map((c: any) => ({
      id: c.id, nameAr: c.name_ar, nameEn: c.name_en,
    })) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── GET /cost-by-company ─────────────────────────────────────────────────
// Aggregate `ai_usage_log` (status='allowed' only) over the past N days
// and multiply each feature's call count by its `usdPerCall` estimate
// from the catalog. Returns one row per company sorted by spend DESC so
// the SuperAdmin can see at a glance which tenants drive the AI bill.
router.get("/cost-by-company", requireSuperAdmin, async (req, res) => {
  // Guard against non-numeric ?days=abc which would otherwise become NaN
  // and produce an Invalid Date, crashing toISOString() with a 500.
  const daysRaw = Number(req.query.days ?? 30);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, daysRaw)) : 30;
  const since = new Date(Date.now() - days * 86400 * 1000);
  try {
    const usage: any = await db.execute(sql`
      SELECT l.company_id, l.feature_key, COUNT(*) AS calls,
             COALESCE(c.name_ar, c.name_en, CONCAT('شركة #', l.company_id::text)) AS company_name,
             c.name_en AS name_en
        FROM ai_usage_log l
        LEFT JOIN companies c ON c.id = l.company_id
       WHERE l.status = 'allowed'
         AND l.created_at >= ${since.toISOString()}
    GROUP BY l.company_id, l.feature_key, c.name_ar, c.name_en
    `);

    const priceMap = new Map<string, number>(
      AI_FEATURE_CATALOG.map(f => [f.key, f.usdPerCall as number]),
    );
    const tierMap = new Map<string, "free" | "paid">(
      AI_FEATURE_CATALOG.map(f => [f.key, f.tier as "free" | "paid"]),
    );

    const byCompany = new Map<number | null, {
      companyId: number | null;
      companyName: string;
      nameEn: string | null;
      totalCalls: number;
      paidCalls: number;
      estimatedUsd: number;
      byFeature: Array<{ featureKey: string; calls: number; usd: number; tier: "free"|"paid" }>;
    }>();

    for (const row of (usage.rows ?? [])) {
      const cid = row.company_id == null ? null : Number(row.company_id);
      const calls = Number(row.calls || 0);
      const price = priceMap.get(row.feature_key) ?? 0;
      const tier = tierMap.get(row.feature_key) ?? "paid";
      const usd = calls * price;

      let agg = byCompany.get(cid);
      if (!agg) {
        agg = {
          companyId:   cid,
          companyName: row.company_name || (cid == null ? "بدون شركة (نظام)" : `شركة #${cid}`),
          nameEn:      row.name_en ?? null,
          totalCalls:  0,
          paidCalls:   0,
          estimatedUsd: 0,
          byFeature:   [],
        };
        byCompany.set(cid, agg);
      }
      agg.totalCalls += calls;
      if (tier === "paid") agg.paidCalls += calls;
      agg.estimatedUsd += usd;
      agg.byFeature.push({ featureKey: row.feature_key, calls, usd, tier });
    }

    const companies = Array.from(byCompany.values())
      .map(c => ({
        ...c,
        estimatedUsd: Number(c.estimatedUsd.toFixed(4)),
        byFeature: c.byFeature.sort((a, b) => b.usd - a.usd),
      }))
      .sort((a, b) => b.estimatedUsd - a.estimatedUsd);

    const grandTotalUsd = Number(
      companies.reduce((s, c) => s + c.estimatedUsd, 0).toFixed(4),
    );
    const grandTotalCalls = companies.reduce((s, c) => s + c.totalCalls, 0);

    res.json({ days, companies, grandTotalUsd, grandTotalCalls });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ─── GET /recent-blocked ──────────────────────────────────────────────────
// Tail of the usage log filtered to blocked entries — quick way to spot
// tenants hitting their quota repeatedly.
router.get("/recent-blocked", requireSuperAdmin, async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  try {
    const r: any = await db.execute(sql`
      SELECT l.id, l.company_id, l.user_id, l.feature_key, l.status, l.created_at,
             c.name_ar AS company_name_ar
        FROM ai_usage_log l
        LEFT JOIN companies c ON c.id = l.company_id
       WHERE l.status LIKE 'blocked_%'
    ORDER BY l.created_at DESC
       LIMIT ${limit}
    `);
    res.json({ entries: r.rows ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

export default router;
