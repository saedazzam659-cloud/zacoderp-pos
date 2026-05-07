// ─────────────────────────────────────────────────────────────────────────
// Smart Installment Sales — contracts, AI credit scoring, schedule,
// payments, alerts. Multi-tenant (companyId scoped). RBAC gate: module
// key "installments". All endpoints require an authenticated user;
// SuperAdmin bypasses the module gate.
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  installmentContractsTable,
  installmentsTable,
  installmentPaymentsTable,
  installmentSettingsTable,
  customersTable,
} from "@workspace/db";
import { and, desc, eq, sql, lte, gte } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { nextSequenceOrFallback } from "../lib/sequences.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("installments"));
router.use(moduleAudit("installments"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function requireCid(req: any, res: any): number | null {
  const raw = req.query.companyId ? Number(req.query.companyId) : undefined;
  const cid = resolveCompanyId(req, raw);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// ─── Code generator ─────────────────────────────────────────────────────
async function nextContractNumber(cid: number): Promise<string> {
  const rows = await db.select({ n: installmentContractsTable.contractNumber })
    .from(installmentContractsTable)
    .where(eq(installmentContractsTable.companyId, cid));
  let max = 0;
  for (const r of rows) {
    const m = /^INS(\d+)$/.exec(String(r.n).trim());
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return `INS${String(max + 1).padStart(5, "0")}`;
}

// ════════════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════════════
async function loadSettings(cid: number) {
  const [row] = await db.select().from(installmentSettingsTable)
    .where(eq(installmentSettingsTable.companyId, cid));
  if (row) return row;
  // Create defaults on first read so the UI always has a row to edit.
  const [fresh] = await db.insert(installmentSettingsTable)
    .values({ companyId: cid })
    .onConflictDoNothing({ target: installmentSettingsTable.companyId })
    .returning();
  if (fresh) return fresh;
  const [again] = await db.select().from(installmentSettingsTable)
    .where(eq(installmentSettingsTable.companyId, cid));
  return again;
}

router.get("/settings", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    res.json(await loadSettings(cid));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/settings", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    await loadSettings(cid);
    const [row] = await db.update(installmentSettingsTable).set({
      minScoreApproval:    b.minScoreApproval    != null ? Number(b.minScoreApproval)    : undefined,
      minScoreReview:      b.minScoreReview      != null ? Number(b.minScoreReview)      : undefined,
      defaultInterestRate: b.defaultInterestRate != null ? String(b.defaultInterestRate) : undefined,
      maxInstallments:     b.maxInstallments     != null ? Number(b.maxInstallments)     : undefined,
      aiEnabled:           b.aiEnabled           != null ? !!b.aiEnabled                 : undefined,
      notes:               b.notes ?? null,
      updatedAt:           new Date(),
    }).where(eq(installmentSettingsTable.companyId, cid)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// AI CREDIT SCORING (rule-based, server-authoritative)
// ════════════════════════════════════════════════════════════════════════
// Pure function — consumed by /score endpoint, contract create + update
// so the score is always recomputed from the same rules. Returns a number
// 0-100, an estimated probability of default (0-100), and a risk band.
function computeCreditScore(input: {
  monthlyIncome:      number;
  monthlyObligations: number;
  installmentAmount:  number;
  age:                number | null;
  occupation:         string | null;
  installmentCount:   number;
}): { score: number; defaultProbability: number; risk: "low" | "medium" | "high"; reasons: string[] } {
  const reasons: string[] = [];
  let score = 50; // neutral baseline

  const income = Math.max(0, Number(input.monthlyIncome) || 0);
  const oblig  = Math.max(0, Number(input.monthlyObligations) || 0);
  const inst   = Math.max(0, Number(input.installmentAmount) || 0);

  // 1) Debt-to-Income ratio (DTI) including the new installment.
  const dti = income > 0 ? ((oblig + inst) / income) : 1;
  if (dti <= 0.3)      { score += 25; reasons.push("نسبة الالتزام منخفضة (≤ 30٪ من الدخل)"); }
  else if (dti <= 0.4) { score += 18; reasons.push("نسبة التزام مقبولة"); }
  else if (dti <= 0.5) { score += 8;  reasons.push("نسبة التزام متوسطة"); }
  else if (dti <= 0.6) { score -= 10; reasons.push("نسبة التزام مرتفعة"); }
  else                 { score -= 25; reasons.push("نسبة التزام عالية جداً (> 60٪)"); }

  // 2) Income tier (absolute monthly income).
  if (income >= 15000)      { score += 12; reasons.push("دخل شهري قوي"); }
  else if (income >= 8000)  { score += 8;  reasons.push("دخل شهري جيد"); }
  else if (income >= 4000)  { score += 3; }
  else if (income > 0)      { score -= 5;  reasons.push("دخل شهري منخفض"); }
  else                      { score -= 20; reasons.push("لم يتم إدخال دخل شهري"); }

  // 3) Age — under 21 or over 65 elevates risk.
  const age = input.age ?? 0;
  if (age >= 25 && age <= 55) { score += 8;  reasons.push("الفئة العمرية ضمن النطاق المنخفض المخاطر"); }
  else if (age >= 21 && age <= 65) { score += 3; }
  else if (age > 0)           { score -= 8; reasons.push("فئة عمرية خارج النطاق المثالي"); }

  // 4) Occupation hints (very loose Arabic keyword match).
  const occ = (input.occupation ?? "").toLowerCase();
  const stable = ["موظف حكومي", "حكومي", "معلم", "طبيب", "مهندس", "ضابط", "جيش", "موظف", "بنك"];
  const risky  = ["حر", "موسمي", "بدون", "متعطل", "طالب"];
  if (stable.some(w => occ.includes(w))) { score += 7; reasons.push("وظيفة مستقرة"); }
  else if (risky.some(w => occ.includes(w))) { score -= 8; reasons.push("وظيفة متغيرة الدخل"); }

  // 5) Tenor — long tenors raise default probability.
  const n = Math.max(1, Number(input.installmentCount) || 1);
  if (n <= 6)        { score += 4; }
  else if (n <= 12)  { score += 2; }
  else if (n <= 24)  { score += 0; }
  else if (n <= 36)  { score -= 4; reasons.push("مدة تقسيط طويلة"); }
  else               { score -= 10; reasons.push("مدة تقسيط طويلة جداً"); }

  // Clamp + derive risk band & default probability.
  score = Math.max(0, Math.min(100, Math.round(score)));
  let risk: "low" | "medium" | "high" = "medium";
  if (score >= 75)      risk = "low";
  else if (score < 55)  risk = "high";
  // Map score → default probability (inverse, clamped to 1-95%).
  const defaultProbability = Math.max(1, Math.min(95, Math.round(100 - score * 0.95)));
  return { score, defaultProbability, risk, reasons };
}

router.post("/score", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const settings = await loadSettings(cid);
    const installmentAmount = Number(b.installmentAmount ?? 0);
    const result = computeCreditScore({
      monthlyIncome:      Number(b.monthlyIncome ?? 0),
      monthlyObligations: Number(b.monthlyObligations ?? 0),
      installmentAmount,
      age:                b.age != null ? Number(b.age) : null,
      occupation:         b.occupation ?? null,
      installmentCount:   Number(b.installmentCount ?? 1),
    });
    let decision: "approve" | "review" | "reject";
    if (result.score >= settings.minScoreApproval) decision = "approve";
    else if (result.score >= settings.minScoreReview) decision = "review";
    else decision = "reject";
    res.json({ ...result, decision, thresholds: {
      approve: settings.minScoreApproval,
      review:  settings.minScoreReview,
    }});
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// SCHEDULE GENERATOR
// ════════════════════════════════════════════════════════════════════════
// Equal-instalment schedule with simple interest. Returns dates as
// YYYY-MM-DD strings and amounts as numbers. The last instalment absorbs
// rounding so the sum exactly equals the financed total.
function buildSchedule(input: {
  financedAmount:       number;
  interestRate:         number;   // annual %, simple interest over the tenor
  installmentCount:     number;
  firstInstallmentDate: string;   // YYYY-MM-DD
}): { dueDate: string; amount: number }[] {
  const n = Math.max(1, Math.floor(input.installmentCount || 1));
  const tenorYears = n / 12;
  const interest = Math.max(0, input.financedAmount * (input.interestRate / 100) * tenorYears);
  const total = input.financedAmount + interest;
  const base = Math.round((total / n) * 100) / 100;
  const out: { dueDate: string; amount: number }[] = [];
  const [yy, mm, dd] = input.firstInstallmentDate.split("-").map(Number);
  let runningSum = 0;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(yy, (mm - 1) + i, dd));
    const dueDate = d.toISOString().slice(0, 10);
    const amount = i === n - 1 ? Math.round((total - runningSum) * 100) / 100 : base;
    runningSum += amount;
    out.push({ dueDate, amount });
  }
  return out;
}

router.post("/schedule-preview", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const financedAmount = Math.max(0, Number(b.cashPrice ?? 0) - Number(b.downPayment ?? 0));
    const rows = buildSchedule({
      financedAmount,
      interestRate:         Number(b.interestRate ?? 0),
      installmentCount:     Number(b.installmentCount ?? 1),
      firstInstallmentDate: String(b.firstInstallmentDate ?? new Date().toISOString().slice(0, 10)),
    });
    const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
    res.json({
      financedAmount,
      totalAmount:       Math.round(totalAmount * 100) / 100,
      totalInterest:     Math.round((totalAmount - financedAmount) * 100) / 100,
      installmentAmount: rows[0]?.amount ?? 0,
      schedule:          rows,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// CONTRACTS
// ════════════════════════════════════════════════════════════════════════
router.get("/contracts", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const status = req.query.status ? String(req.query.status) : null;
    const where = status
      ? and(eq(installmentContractsTable.companyId, cid), eq(installmentContractsTable.status, status as any))
      : eq(installmentContractsTable.companyId, cid);
    const rows = await db.select().from(installmentContractsTable)
      .where(where!).orderBy(desc(installmentContractsTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/contracts/:id", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.select().from(installmentContractsTable)
      .where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid)));
    if (!row) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    const schedule = await db.select().from(installmentsTable)
      .where(eq(installmentsTable.contractId, id))
      .orderBy(installmentsTable.installmentNumber);
    const payments = await db.select().from(installmentPaymentsTable)
      .where(eq(installmentPaymentsTable.contractId, id))
      .orderBy(desc(installmentPaymentsTable.id));
    res.json({ ...row, schedule, payments });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

async function persistSchedule(contractId: number, cid: number, rows: { dueDate: string; amount: number }[]) {
  await db.delete(installmentsTable).where(eq(installmentsTable.contractId, contractId));
  if (rows.length === 0) return;
  await db.insert(installmentsTable).values(rows.map((r, i) => ({
    contractId,
    companyId:         cid,
    installmentNumber: i + 1,
    dueDate:           r.dueDate,
    amount:            String(r.amount),
  })));
}

router.post("/contracts", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const b = req.body ?? {};
    const customerName = String(b.customerName ?? "").trim();
    if (!customerName)        { res.status(400).json({ error: "اسم العميل مطلوب" }); return; }
    if (!b.productDescription) { res.status(400).json({ error: "وصف المنتج / الخدمة مطلوب" }); return; }
    if (!b.firstInstallmentDate) { res.status(400).json({ error: "تاريخ أول قسط مطلوب" }); return; }

    const cashPrice    = Number(b.cashPrice ?? 0);
    const downPayment  = Number(b.downPayment ?? 0);
    const financed     = Math.max(0, cashPrice - downPayment);
    const interestRate = Number(b.interestRate ?? 0);
    const n            = Math.max(1, Number(b.installmentCount ?? 1));

    const sched = buildSchedule({
      financedAmount: financed,
      interestRate,
      installmentCount: n,
      firstInstallmentDate: String(b.firstInstallmentDate),
    });
    const totalAmount = sched.reduce((s, r) => s + r.amount, 0);
    const installmentAmount = sched[0]?.amount ?? 0;

    const score = computeCreditScore({
      monthlyIncome:      Number(b.monthlyIncome ?? 0),
      monthlyObligations: Number(b.monthlyObligations ?? 0),
      installmentAmount,
      age:                b.age != null ? Number(b.age) : null,
      occupation:         b.occupation ?? null,
      installmentCount:   n,
    });

    const contractNumber = String(b.contractNumber ?? "").trim() || await nextSequenceOrFallback(
      cid,
      "installment_contract",
      { userId: (req as any).authUser?.id ?? null, refTable: "installment_contracts", branchId: b.branchId ? Number(b.branchId) : null },
      () => nextContractNumber(cid),
    );

    const [row] = await db.insert(installmentContractsTable).values({
      companyId:            cid,
      branchId:             b.branchId ? Number(b.branchId) : null,
      contractNumber,
      customerId:           b.customerId ? Number(b.customerId) : null,
      customerName,
      nationalId:           b.nationalId || null,
      occupation:           b.occupation || null,
      monthlyIncome:        String(Number(b.monthlyIncome ?? 0)),
      monthlyObligations:   String(Number(b.monthlyObligations ?? 0)),
      age:                  b.age != null && b.age !== "" ? Number(b.age) : null,
      phone:                b.phone || null,
      address:              b.address || null,
      productDescription:   String(b.productDescription),
      cashPrice:            String(cashPrice),
      downPayment:          String(downPayment),
      financedAmount:       String(financed),
      interestRate:         String(interestRate),
      totalInterest:        String(Math.max(0, totalAmount - financed)),
      installmentCount:     n,
      installmentAmount:    String(installmentAmount),
      totalAmount:          String(totalAmount),
      firstInstallmentDate: String(b.firstInstallmentDate),
      creditScore:          score.score,
      riskLevel:            score.risk,
      defaultProbability:   String(score.defaultProbability),
      aiAnalysis:           score.reasons.join(" • "),
      status:               b.status === "approved" || b.status === "active" ? "pending" : (b.status ?? "draft"),
      notes:                b.notes || null,
      createdBy:            req.authUser?.username ?? null,
    }).returning();
    await persistSchedule(row.id, cid, sched);
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message).includes("duplicate") || e?.code === "23505") {
      res.status(409).json({ error: "رقم العقد مستخدم مسبقاً" });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

router.put("/contracts/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const [existing] = await db.select().from(installmentContractsTable)
      .where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    if (existing.status === "active" || existing.status === "completed") {
      res.status(409).json({ error: "لا يمكن تعديل عقد بعد تفعيله — يرجى الإلغاء وإنشاء عقد جديد." });
      return;
    }

    const cashPrice    = Number(b.cashPrice ?? existing.cashPrice);
    const downPayment  = Number(b.downPayment ?? existing.downPayment);
    const financed     = Math.max(0, cashPrice - downPayment);
    const interestRate = Number(b.interestRate ?? existing.interestRate);
    const n            = Math.max(1, Number(b.installmentCount ?? existing.installmentCount));
    const firstDate    = String(b.firstInstallmentDate ?? existing.firstInstallmentDate);

    const sched = buildSchedule({ financedAmount: financed, interestRate, installmentCount: n, firstInstallmentDate: firstDate });
    const totalAmount = sched.reduce((s, r) => s + r.amount, 0);
    const installmentAmount = sched[0]?.amount ?? 0;

    const score = computeCreditScore({
      monthlyIncome:      Number(b.monthlyIncome      ?? existing.monthlyIncome),
      monthlyObligations: Number(b.monthlyObligations ?? existing.monthlyObligations),
      installmentAmount,
      age:                b.age != null ? Number(b.age) : (existing.age ?? null),
      occupation:         b.occupation ?? existing.occupation ?? null,
      installmentCount:   n,
    });

    const [row] = await db.update(installmentContractsTable).set({
      branchId:             b.branchId !== undefined ? (b.branchId ? Number(b.branchId) : null) : undefined,
      customerId:           b.customerId !== undefined ? (b.customerId ? Number(b.customerId) : null) : undefined,
      customerName:         b.customerName != null ? String(b.customerName).trim() : undefined,
      nationalId:           b.nationalId ?? null,
      occupation:           b.occupation ?? null,
      monthlyIncome:        b.monthlyIncome      != null ? String(b.monthlyIncome)      : undefined,
      monthlyObligations:   b.monthlyObligations != null ? String(b.monthlyObligations) : undefined,
      age:                  b.age != null && b.age !== "" ? Number(b.age) : null,
      phone:                b.phone ?? null,
      address:              b.address ?? null,
      productDescription:   b.productDescription != null ? String(b.productDescription) : undefined,
      cashPrice:            String(cashPrice),
      downPayment:          String(downPayment),
      financedAmount:       String(financed),
      interestRate:         String(interestRate),
      totalInterest:        String(Math.max(0, totalAmount - financed)),
      installmentCount:     n,
      installmentAmount:    String(installmentAmount),
      totalAmount:          String(totalAmount),
      firstInstallmentDate: firstDate,
      creditScore:          score.score,
      riskLevel:            score.risk,
      defaultProbability:   String(score.defaultProbability),
      aiAnalysis:           score.reasons.join(" • "),
      notes:                b.notes ?? null,
      updatedAt:            new Date(),
    }).where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid))).returning();
    await persistSchedule(id, cid, sched);
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/contracts/:id/approve", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(installmentContractsTable).set({
      status:     "active",
      approvedBy: req.authUser?.username ?? null,
      approvedAt: new Date(),
      updatedAt:  new Date(),
    }).where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/contracts/:id/reject", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const reason = String(req.body?.reason ?? "").trim() || "بدون سبب محدد";
    const [row] = await db.update(installmentContractsTable).set({
      status:         "rejected",
      rejectedReason: reason,
      updatedAt:      new Date(),
    }).where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/contracts/:id/cancel", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(installmentContractsTable).set({
      status: "cancelled", updatedAt: new Date(),
    }).where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/contracts/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select().from(installmentContractsTable)
      .where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    if (existing.status === "active" || existing.status === "completed") {
      res.status(409).json({ error: "لا يمكن حذف عقد مفعّل — يجب إلغاؤه أولاً." });
      return;
    }
    await db.delete(installmentContractsTable)
      .where(and(eq(installmentContractsTable.id, id), eq(installmentContractsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ════════════════════════════════════════════════════════════════════════
router.post("/contracts/:id/payments", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const contractId = Number(req.params.id);
    const b = req.body ?? {};

    const [contract] = await db.select().from(installmentContractsTable)
      .where(and(eq(installmentContractsTable.id, contractId), eq(installmentContractsTable.companyId, cid)));
    if (!contract) { res.status(404).json({ error: "العقد غير موجود" }); return; }
    if (contract.status !== "active") {
      res.status(409).json({ error: "لا يمكن تسجيل دفعة على عقد غير مفعّل." });
      return;
    }

    const amount = Number(b.amount ?? 0);
    if (!(amount > 0)) { res.status(400).json({ error: "قيمة الدفعة يجب أن تكون أكبر من صفر" }); return; }

    const installmentId = b.installmentId ? Number(b.installmentId) : null;
    let targetInstallment = null as null | typeof installmentsTable.$inferSelect;
    if (installmentId) {
      const [it] = await db.select().from(installmentsTable)
        .where(and(eq(installmentsTable.id, installmentId), eq(installmentsTable.contractId, contractId)));
      if (!it) { res.status(404).json({ error: "القسط غير موجود" }); return; }
      targetInstallment = it;
    } else {
      // Auto-pick the next unpaid instalment.
      const [it] = await db.select().from(installmentsTable)
        .where(and(eq(installmentsTable.contractId, contractId), sql`${installmentsTable.status} <> 'paid'`))
        .orderBy(installmentsTable.installmentNumber)
        .limit(1);
      targetInstallment = it ?? null;
    }

    const [payment] = await db.insert(installmentPaymentsTable).values({
      companyId:     cid,
      contractId,
      installmentId: targetInstallment?.id ?? null,
      amount:        String(amount),
      paymentMethod: ["cash","transfer","card","wallet"].includes(b.paymentMethod) ? b.paymentMethod : "cash",
      receivedBy:    req.authUser?.username ?? null,
      reference:     b.reference || null,
      notes:         b.notes || null,
    }).returning();

    if (targetInstallment) {
      const newPaid = Number(targetInstallment.paidAmount) + amount;
      const due     = Number(targetInstallment.amount);
      const status  = newPaid >= due - 0.01 ? "paid" : (newPaid > 0 ? "partial" : "pending");
      await db.update(installmentsTable).set({
        paidAmount: String(newPaid),
        paidAt:     status === "paid" ? new Date() : targetInstallment.paidAt,
        status:     status as any,
      }).where(eq(installmentsTable.id, targetInstallment.id));
    }

    // Mark contract complete if every installment is paid.
    const remaining = await db.select({ n: sql<number>`count(*)::int` })
      .from(installmentsTable)
      .where(and(eq(installmentsTable.contractId, contractId), sql`${installmentsTable.status} <> 'paid'`));
    if ((remaining[0]?.n ?? 0) === 0) {
      await db.update(installmentContractsTable).set({ status: "completed", updatedAt: new Date() })
        .where(eq(installmentContractsTable.id, contractId));
    }

    res.status(201).json(payment);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// REPORTS — due / overdue / risk / profits
// ════════════════════════════════════════════════════════════════════════
function refreshOverdueWhere(cid: number) {
  // Mark unpaid installments past today as overdue (server-computed view).
  const today = new Date().toISOString().slice(0, 10);
  return db.update(installmentsTable).set({ status: "overdue" })
    .where(and(
      eq(installmentsTable.companyId, cid),
      sql`${installmentsTable.dueDate} < ${today}`,
      sql`${installmentsTable.status} = 'pending'`,
    ));
}

router.get("/reports/due", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    await refreshOverdueWhere(cid);
    const days = Number(req.query.days ?? 30);
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    const rows = await db.select({
      i: installmentsTable,
      contractNumber: installmentContractsTable.contractNumber,
      customerName:   installmentContractsTable.customerName,
      phone:          installmentContractsTable.phone,
    })
      .from(installmentsTable)
      .leftJoin(installmentContractsTable, eq(installmentContractsTable.id, installmentsTable.contractId))
      .where(and(
        eq(installmentsTable.companyId, cid),
        sql`${installmentsTable.status} <> 'paid'`,
        gte(installmentsTable.dueDate, today),
        lte(installmentsTable.dueDate, horizon),
      ))
      .orderBy(installmentsTable.dueDate);
    res.json(rows.map(r => ({ ...r.i, contractNumber: r.contractNumber, customerName: r.customerName, phone: r.phone })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/reports/overdue", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    await refreshOverdueWhere(cid);
    const rows = await db.select({
      i: installmentsTable,
      contractNumber: installmentContractsTable.contractNumber,
      customerName:   installmentContractsTable.customerName,
      phone:          installmentContractsTable.phone,
    })
      .from(installmentsTable)
      .leftJoin(installmentContractsTable, eq(installmentContractsTable.id, installmentsTable.contractId))
      .where(and(
        eq(installmentsTable.companyId, cid),
        sql`${installmentsTable.status} = 'overdue'`,
      ))
      .orderBy(installmentsTable.dueDate);
    res.json(rows.map(r => ({ ...r.i, contractNumber: r.contractNumber, customerName: r.customerName, phone: r.phone })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/reports/risk", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select({
      id:                 installmentContractsTable.id,
      contractNumber:     installmentContractsTable.contractNumber,
      customerName:       installmentContractsTable.customerName,
      creditScore:        installmentContractsTable.creditScore,
      riskLevel:          installmentContractsTable.riskLevel,
      defaultProbability: installmentContractsTable.defaultProbability,
      totalAmount:        installmentContractsTable.totalAmount,
      status:             installmentContractsTable.status,
    })
      .from(installmentContractsTable)
      .where(eq(installmentContractsTable.companyId, cid))
      .orderBy(desc(installmentContractsTable.defaultProbability));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/stats", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    await refreshOverdueWhere(cid);
    const [contracts]    = await db.select({ n: sql<number>`count(*)::int` })
      .from(installmentContractsTable).where(eq(installmentContractsTable.companyId, cid));
    const [active]       = await db.select({ n: sql<number>`count(*)::int` })
      .from(installmentContractsTable)
      .where(and(eq(installmentContractsTable.companyId, cid), eq(installmentContractsTable.status, "active")));
    const [pending]      = await db.select({ n: sql<number>`count(*)::int` })
      .from(installmentContractsTable)
      .where(and(eq(installmentContractsTable.companyId, cid), eq(installmentContractsTable.status, "pending")));
    const [overdue]      = await db.select({ n: sql<number>`count(*)::int` })
      .from(installmentsTable)
      .where(and(eq(installmentsTable.companyId, cid), sql`${installmentsTable.status} = 'overdue'`));
    const [profits]      = await db.select({ s: sql<string>`COALESCE(SUM(${installmentContractsTable.totalInterest}), 0)` })
      .from(installmentContractsTable)
      .where(and(eq(installmentContractsTable.companyId, cid), sql`${installmentContractsTable.status} IN ('active','completed')`));
    const [outstanding]  = await db.select({ s: sql<string>`COALESCE(SUM(${installmentsTable.amount} - ${installmentsTable.paidAmount}), 0)` })
      .from(installmentsTable)
      .leftJoin(installmentContractsTable, eq(installmentContractsTable.id, installmentsTable.contractId))
      .where(and(
        eq(installmentsTable.companyId, cid),
        sql`${installmentContractsTable.status} = 'active'`,
        sql`${installmentsTable.status} <> 'paid'`,
      ));
    const [collected]    = await db.select({ s: sql<string>`COALESCE(SUM(${installmentPaymentsTable.amount}), 0)` })
      .from(installmentPaymentsTable).where(eq(installmentPaymentsTable.companyId, cid));
    res.json({
      contracts:   contracts?.n ?? 0,
      active:      active?.n ?? 0,
      pending:     pending?.n ?? 0,
      overdue:     overdue?.n ?? 0,
      profits:     Number(profits?.s ?? 0),
      outstanding: Number(outstanding?.s ?? 0),
      collected:   Number(collected?.s ?? 0),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Customer dropdown helper (read-only) ───────────────────────────────
router.get("/customers-lookup", async (req, res) => {
  try {
    const cid = requireCid(req, res); if (!cid) return;
    const rows = await db.select({
      id: customersTable.id, nameAr: customersTable.nameAr, phone: customersTable.phone,
    }).from(customersTable).where(eq(customersTable.companyId, cid)).limit(500);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
