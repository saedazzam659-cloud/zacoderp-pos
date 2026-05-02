// ─────────────────────────────────────────────────────────────────────────
// Fixed Assets AI helpers — Risk scoring, depreciation forecast,
// recommendation engine (keep/maintain/replace/sell), and expiry alerts.
// Falls back to deterministic rule-based logic when the AI proxy is unset.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  fixedAssetsTable, faMaintenanceTable, faDepreciationRunsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("fixed_assets"));
router.use(moduleAudit("fixed_assets"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

function requireCid(req: any, res: any): number | null {
  const raw = req.body?.companyId ?? req.query.companyId;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// Compute deterministic risk score (0..100) based on age, maintenance cost
// ratio, and depreciation progress.
function computeRisk(asset: any, maintCost: number): {
  score: number; level: "low"|"medium"|"high"; recommendation: string;
  remainingMonths: number; ageMonths: number;
} {
  const purchase = Number(asset.purchaseValue || 0) || 1;
  const accum    = Number(asset.accumulatedDepreciation || 0);
  const lifeYears = Number(asset.lifeYears || 5);
  const totalMonths = lifeYears * 12;
  const start = asset.depreciationStart ? new Date(asset.depreciationStart) : (asset.purchaseDate ? new Date(asset.purchaseDate) : new Date());
  const now = new Date();
  const ageMonths = Math.max(0, Math.floor((now.getTime() - start.getTime()) / (30 * 86_400_000)));
  const remainingMonths = Math.max(0, totalMonths - ageMonths);
  const depRatio   = Math.min(1, accum / Math.max(1, purchase));
  const maintRatio = maintCost / purchase;

  let score = 10;
  score += depRatio * 50;          // 0..50 from depreciation progress
  score += Math.min(30, maintRatio * 100); // 0..30 from maintenance cost ratio
  if (remainingMonths <= 6) score += 15;
  if (asset.status === "in_maintenance") score += 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  let recommendation = "keep";
  if (level === "high")   recommendation = maintRatio > 0.4 ? "replace" : "sell";
  else if (level === "medium") recommendation = "maintain";
  else recommendation = "keep";

  return { score, level, recommendation, remainingMonths, ageMonths };
}

// Single-asset analysis
router.get("/analyze/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [asset] = await db.select().from(fixedAssetsTable)
      .where(and(eq(fixedAssetsTable.id, id), eq(fixedAssetsTable.companyId, cid)));
    if (!asset) { res.status(404).json({ error: "الأصل غير موجود" }); return; }
    const maint = await db.select().from(faMaintenanceTable)
      .where(and(eq(faMaintenanceTable.companyId, cid), eq(faMaintenanceTable.assetId, id)));
    const totalMaintCost = maint.reduce((s, m) => s + Number(m.cost || 0), 0);
    const risk = computeRisk(asset, totalMaintCost);
    // Persist back to asset
    await db.update(fixedAssetsTable).set({
      riskLevel: risk.level,
      aiRecommendation: risk.recommendation,
      updatedAt: new Date(),
    }).where(and(eq(fixedAssetsTable.id, id), eq(fixedAssetsTable.companyId, cid)));
    res.json({
      assetId: id, code: asset.code, nameAr: asset.nameAr,
      maintenanceCount: maint.length, totalMaintenanceCost: totalMaintCost,
      ...risk,
      bookValue: Number(asset.bookValue || 0),
      purchaseValue: Number(asset.purchaseValue || 0),
      ai: !!OPENAI_BASE && !!OPENAI_KEY,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Bulk: analyze all active assets and persist risk + recommendation
router.post("/analyze-all", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const assets = await db.select().from(fixedAssetsTable)
      .where(eq(fixedAssetsTable.companyId, cid));
    const maintAll = await db.select().from(faMaintenanceTable)
      .where(eq(faMaintenanceTable.companyId, cid));
    const costByAsset: Record<number, number> = {};
    for (const m of maintAll) costByAsset[m.assetId] = (costByAsset[m.assetId] || 0) + Number(m.cost || 0);
    const out: any[] = [];
    for (const a of assets) {
      const r = computeRisk(a, costByAsset[a.id] || 0);
      await db.update(fixedAssetsTable).set({
        riskLevel: r.level,
        aiRecommendation: r.recommendation,
        updatedAt: new Date(),
      }).where(and(eq(fixedAssetsTable.id, a.id), eq(fixedAssetsTable.companyId, cid)));
      out.push({
        id: a.id, code: a.code, nameAr: a.nameAr,
        ...r, totalMaintenanceCost: costByAsset[a.id] || 0,
        bookValue: Number(a.bookValue || 0),
      });
    }
    out.sort((x, y) => y.score - x.score);
    res.json({ analyzed: out.length, items: out });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Depreciation forecast — next N months for all active assets
router.get("/forecast", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const months = Math.min(36, Math.max(1, Number(req.query.months ?? 12)));
    const assets = await db.select().from(fixedAssetsTable)
      .where(and(eq(fixedAssetsTable.companyId, cid), eq(fixedAssetsTable.status, "active" as any)));
    const series: { period: string; depreciation: number }[] = [];
    const now = new Date();
    for (let i = 0; i < months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      let total = 0;
      for (const a of assets) {
        const purchase = Number(a.purchaseValue || 0);
        const scrap    = Number(a.scrapValue || 0);
        const totalMonths = Math.max(1, Number(a.lifeYears || 5) * 12);
        const monthly = (purchase - scrap) / totalMonths;
        total += monthly;
      }
      series.push({ period, depreciation: Number(total.toFixed(2)) });
    }
    res.json({ months, series });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Alerts: insurance expiry + maintenance due (high mileage)
router.get("/alerts", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const assets = await db.select().from(fixedAssetsTable)
      .where(eq(fixedAssetsTable.companyId, cid));
    const today = new Date();
    const insuranceAlerts = assets
      .filter(a => a.insuranceEnd)
      .map(a => {
        const end = new Date(a.insuranceEnd!);
        const daysLeft = Math.ceil((end.getTime() - today.getTime()) / 86_400_000);
        return { id: a.id, code: a.code, nameAr: a.nameAr, insuranceEnd: a.insuranceEnd, daysLeft };
      })
      .filter(x => x.daysLeft <= 60)
      .sort((a, b) => a.daysLeft - b.daysLeft);
    const maintAll = await db.select().from(faMaintenanceTable)
      .where(eq(faMaintenanceTable.companyId, cid));
    const lastByAsset: Record<number, string | null> = {};
    for (const m of maintAll) {
      const cur = lastByAsset[m.assetId];
      if (!cur || m.serviceDate > cur) lastByAsset[m.assetId] = m.serviceDate;
    }
    const maintAlerts = assets
      .filter(a => a.status === "active")
      .map(a => {
        const last = lastByAsset[a.id];
        const dueDays = last ? Math.floor((today.getTime() - new Date(last).getTime()) / 86_400_000) : 9999;
        return { id: a.id, code: a.code, nameAr: a.nameAr, lastService: last, daysSinceLast: dueDays };
      })
      .filter(x => x.daysSinceLast >= 180)
      .sort((a, b) => b.daysSinceLast - a.daysSinceLast);
    res.json({ insuranceAlerts, maintenanceAlerts: maintAlerts });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// AI advisor — natural language summary using OpenAI proxy if available;
// otherwise fall back to a deterministic Arabic narrative.
router.post("/advice", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const assets = await db.select().from(fixedAssetsTable).where(eq(fixedAssetsTable.companyId, cid));
    const maint = await db.select().from(faMaintenanceTable).where(eq(faMaintenanceTable.companyId, cid));
    const totalAssets = assets.length;
    const totalMaint = maint.reduce((s, m) => s + Number(m.cost || 0), 0);
    const totalBook  = assets.reduce((s, a) => s + Number(a.bookValue || 0), 0);
    const highRisk = assets.filter(a => a.riskLevel === "high").length;
    const fallback = `لديك ${totalAssets} أصل بقيمة دفترية إجمالية ${totalBook.toFixed(2)} ر.س. ` +
      `إجمالي تكاليف الصيانة ${totalMaint.toFixed(2)} ر.س. ` +
      `يوجد ${highRisk} أصل بمستوى خطورة عالي يحتاج مراجعة.` +
      (highRisk > 0 ? " يُنصح بدراسة استبدال الأصول عالية الخطورة لخفض تكلفة الصيانة." : "");

    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.json({ ai: false, advice: fallback });
      return;
    }
    try {
      const prompt = `لديك بيانات أصول ثابتة لشركة سعودية:
- عدد الأصول: ${totalAssets}
- القيمة الدفترية الإجمالية: ${totalBook.toFixed(2)} ر.س
- إجمالي تكاليف الصيانة: ${totalMaint.toFixed(2)} ر.س
- أصول عالية الخطورة: ${highRisk}
اكتب نصيحة إدارية مختصرة (3-4 أسطر) باللغة العربية حول إدارة هذه الأصول.`;
      const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4, max_tokens: 250,
        }),
      });
      const j: any = await r.json();
      const advice = j?.choices?.[0]?.message?.content?.trim() || fallback;
      res.json({ ai: true, advice });
    } catch {
      res.json({ ai: false, advice: fallback });
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
