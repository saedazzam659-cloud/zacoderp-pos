// ─────────────────────────────────────────────────────────────────────────
// Fixed Assets AI helpers — Risk scoring, depreciation forecast,
// recommendation engine (keep/maintain/replace/sell), and expiry alerts.
// Falls back to deterministic rule-based logic when the AI proxy is unset.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  fixedAssetsTable, faMaintenanceTable, faDepreciationRunsTable,
  accountsTable, companiesTable,
} from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("fixed_assets"));
router.use(moduleAudit("fixed_assets"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

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
  const totalMonths = Math.max(1, Math.round(lifeYears * 12));
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
      ai: isAIAvailable(),
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
        const totalMonths = Math.max(1, Math.round(Number(a.lifeYears || 5) * 12));
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
router.post("/advice", requireAiFeature("fixed_assets_ai"), async (req, res) => {
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

    if (!isAIAvailable()) {
      await logAiUsage(req, { status: "allowed", provider: "rule" });
      res.json({ ai: false, advice: fallback });
      return;
    }
    const prompt = `لديك بيانات أصول ثابتة لشركة سعودية:
- عدد الأصول: ${totalAssets}
- القيمة الدفترية الإجمالية: ${totalBook.toFixed(2)} ر.س
- إجمالي تكاليف الصيانة: ${totalMaint.toFixed(2)} ر.س
- أصول عالية الخطورة: ${highRisk}
اكتب نصيحة إدارية مختصرة (3-4 أسطر) باللغة العربية حول إدارة هذه الأصول.`;
    const result = await aiChat([{ role: "user", content: prompt }], { maxTokens: 400,
      providers: ["gemini"] });
    if (!result.ok) {
      await logAiUsage(req, { status: "allowed", provider: "rule", meta: { reason: result.reason } });
      res.json({ ai: false, advice: fallback });
      return;
    }
    await logAiUsage(req, { status: "allowed", provider: result.provider });
    res.json({ ai: true, advice: result.text.trim() || fallback });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AI Auto-Seed for Fixed-Asset GL accounts (per IAS 16 / IFRS).
//   POST /seed-fa-accounts
// For each of the 6 company-level FA account slots:
//   1. Tries to MATCH the best existing posting account in the COA by
//      Arabic keyword scoring (also requires the right account_type).
//   2. If no acceptable match, CREATES a new account using the canonical
//      international code/name (1210/1280/5400/1290/4910/5450) under a
//      sensible parent if one exists.  Codes are auto-suffixed if the
//      preferred code is already taken so we never collide.
//   3. Patches `companies` with the resolved IDs in one atomic update.
// Returns a manifest the UI can show: per-field action (matched|created),
// account code/name, and a short Arabic reason.
// ─────────────────────────────────────────────────────────────────────────
type FaSlot = {
  field: "faAssetCostAccountId" | "faAccumDepreciationAccountId"
       | "faDepreciationExpenseAccountId" | "faAcquisitionClearingAccountId"
       | "faDisposalGainAccountId" | "faDisposalLossAccountId";
  label: string;                       // Arabic field label for the UI
  type: "asset" | "expense" | "revenue"; // required account_type
  // Keywords used for Arabic matching against existing accounts. The first
  // entry of `must` is the strongest positive signal; `nice` adds bonus.
  must: string[];
  nice: string[];
  avoid: string[];                     // negative score (excludes wrong ones)
  // Canonical IFRS-aligned code + Arabic name to use when creating.
  newCode: string;
  newNameAr: string;
  newNameEn: string;
  // Preferred parent code (created only if user has it; otherwise top-level).
  parentCode: string;
  reportDirection: "balance_sheet" | "income_statement";
};

const FA_SLOTS: FaSlot[] = [
  {
    field: "faAssetCostAccountId",
    label: "حساب تكلفة الأصل",
    type: "asset",
    must: ["تكلفة", "أصول ثابتة", "اصول ثابتة"],
    nice: ["معدات", "سيارات", "أثاث", "مباني", "مبانى"],
    avoid: ["مجمع", "إهلاك", "اهلاك", "وسيط", "ربح", "خسارة"],
    newCode: "1210",
    newNameAr: "تكلفة الأصول الثابتة",
    newNameEn: "Property, Plant & Equipment - Cost",
    parentCode: "1200",
    reportDirection: "balance_sheet",
  },
  {
    field: "faAccumDepreciationAccountId",
    label: "حساب مجمع الإهلاك",
    type: "asset",
    must: ["مجمع", "إهلاك", "اهلاك"],
    nice: ["مجمع إهلاك", "مجمع اهلاك"],
    avoid: ["مصروف", "ربح", "خسارة", "وسيط"],
    newCode: "1280",
    newNameAr: "مجمع إهلاك الأصول الثابتة",
    newNameEn: "Accumulated Depreciation - PPE",
    parentCode: "1200",
    reportDirection: "balance_sheet",
  },
  {
    field: "faDepreciationExpenseAccountId",
    label: "حساب مصروف الإهلاك",
    type: "expense",
    must: ["مصروف", "إهلاك", "اهلاك"],
    nice: ["مصروف إهلاك", "مصروف اهلاك"],
    avoid: ["مجمع", "ربح", "خسارة", "وسيط"],
    newCode: "5400",
    newNameAr: "مصروف إهلاك الأصول الثابتة",
    newNameEn: "Depreciation Expense",
    parentCode: "5000",
    reportDirection: "income_statement",
  },
  {
    field: "faAcquisitionClearingAccountId",
    label: "حساب وسيط الاقتناء/الاستبعاد",
    type: "asset",
    must: ["وسيط", "اقتناء", "تسوية"],
    nice: ["clearing", "استبعاد", "أصول"],
    avoid: ["مجمع", "إهلاك", "اهلاك", "مصروف", "ربح", "خسارة"],
    newCode: "1290",
    newNameAr: "وسيط اقتناء واستبعاد الأصول الثابتة",
    newNameEn: "Fixed Assets Acquisition/Disposal Clearing",
    parentCode: "1200",
    reportDirection: "balance_sheet",
  },
  {
    field: "faDisposalGainAccountId",
    label: "حساب أرباح بيع الأصول",
    type: "revenue",
    must: ["ربح", "بيع", "أصول"],
    nice: ["أرباح", "ارباح", "استبعاد"],
    avoid: ["خسارة", "خسائر", "مصروف", "إهلاك", "اهلاك"],
    newCode: "4910",
    newNameAr: "أرباح بيع الأصول الثابتة",
    newNameEn: "Gain on Disposal of Fixed Assets",
    parentCode: "4900",
    reportDirection: "income_statement",
  },
  {
    field: "faDisposalLossAccountId",
    label: "حساب خسائر بيع الأصول",
    type: "expense",
    must: ["خسارة", "بيع", "أصول"],
    nice: ["خسائر", "استبعاد"],
    avoid: ["ربح", "أرباح", "ارباح", "إهلاك", "اهلاك"],
    newCode: "5450",
    newNameAr: "خسائر بيع الأصول الثابتة",
    newNameEn: "Loss on Disposal of Fixed Assets",
    parentCode: "5000",
    reportDirection: "income_statement",
  },
];

// Normalize Arabic text for fuzzy matching (strip diacritics, unify alif).
function normAr(s: string): string {
  return (s || "")
    .replace(/[\u064B-\u0652]/g, "")     // diacritics
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
}

// Score how well an account matches a slot. Returns -Infinity for type
// mismatch or if any "avoid" keyword appears (so we never wire e.g. مجمع
// الإهلاك into the cost slot).
function scoreAccount(acc: any, slot: FaSlot): number {
  if (acc.accountType !== slot.type) return -Infinity;
  if (!acc.isPosting || !acc.isActive) return -Infinity;
  const hay = normAr(`${acc.nameAr || ""} ${acc.nameEn || ""}`);
  for (const bad of slot.avoid) {
    if (hay.includes(normAr(bad))) return -Infinity;
  }
  let score = 0;
  for (const m of slot.must) {
    if (hay.includes(normAr(m))) score += 10;
  }
  for (const n of slot.nice) {
    if (hay.includes(normAr(n))) score += 3;
  }
  // Need at least one "must" hit to be considered a real match.
  return score >= 10 ? score : -Infinity;
}

// Find a unique code: if `preferred` is taken, try `preferred-1`, `-2`, …
function uniqueCode(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred;
  for (let i = 1; i < 100; i++) {
    const c = `${preferred}-${i}`;
    if (!taken.has(c)) return c;
  }
  return `${preferred}-${Date.now()}`;
}

router.post("/seed-fa-accounts", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;

    // Authorization: only an admin of THIS company (or a SuperAdmin) may
    // mutate the chart of accounts + tenant-wide FA mappings. Mirrors the
    // guard on PATCH /companies/:id/general-settings.
    const u = (req as any).authUser;
    if (u.role !== "superadmin" && !(u.companyId === cid && u.role === "admin")) {
      res.status(403).json({ error: "تحتاج صلاحية مدير الشركة لتنفيذ هذا الإجراء" });
      return;
    }

    const all = await db.select().from(accountsTable)
      .where(eq(accountsTable.companyId, cid))
      .orderBy(asc(accountsTable.code));

    const takenCodes = new Set(all.map(a => a.code));
    const byCode: Record<string, any> = {};
    for (const a of all) byCode[a.code] = a;

    const results: Array<{
      field: string; label: string;
      action: "matched" | "created";
      accountId: number; code: string; nameAr: string;
      reason: string;
    }> = [];

    const mapping: Record<string, number> = {};

    for (const slot of FA_SLOTS) {
      // 1) Try to match an existing account.
      let bestAcc: any = null; let bestScore = -Infinity;
      for (const a of all) {
        const s = scoreAccount(a, slot);
        if (s > bestScore) { bestScore = s; bestAcc = a; }
      }

      if (bestAcc && bestScore > -Infinity) {
        results.push({
          field: slot.field, label: slot.label,
          action: "matched",
          accountId: bestAcc.id, code: bestAcc.code, nameAr: bestAcc.nameAr,
          reason: `تطابق ذكي مع حساب موجود (نقاط: ${bestScore})`,
        });
        mapping[slot.field] = bestAcc.id;
        continue;
      }

      // 2) Create a new account using the canonical IFRS code.
      const code = uniqueCode(slot.newCode, takenCodes);
      const parent = byCode[slot.parentCode] || null;
      const [created] = await db.insert(accountsTable).values({
        companyId: cid,
        code,
        nameAr: slot.newNameAr,
        nameEn: slot.newNameEn,
        accountType: slot.type as any,
        parentId: parent?.id ?? null,
        level: parent ? 2 : 1,
        reportDirection: slot.reportDirection,
        isPosting: true,
        isActive: true,
      }).returning();
      takenCodes.add(code);
      byCode[code] = created;
      all.push(created);
      results.push({
        field: slot.field, label: slot.label,
        action: "created",
        accountId: created.id, code: created.code, nameAr: created.nameAr,
        reason: parent
          ? `تم إنشاؤه تحت الحساب الأب (${parent.code} ${parent.nameAr})`
          : `تم إنشاؤه كحساب رئيسي (لا يوجد حساب أب بالكود ${slot.parentCode})`,
      });
      mapping[slot.field] = created.id;
    }

    // 3) Persist mapping on the company record.
    await db.update(companiesTable)
      .set({ ...mapping, updatedAt: new Date() })
      .where(eq(companiesTable.id, cid));

    const createdCount = results.filter(r => r.action === "created").length;
    const matchedCount = results.filter(r => r.action === "matched").length;
    res.json({
      ok: true,
      summary: { matched: matchedCount, created: createdCount, total: results.length },
      results,
      mapping,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
