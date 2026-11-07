import { Router } from "express";
import { EMPLOYEE_PROVISION_SETTLEMENTS_READY } from "../lib/hrProvisionReadiness.js";
import { db } from "@workspace/db";
import { companiesTable, accountsTable, cashBoxesTable, bankAccountsTable } from "@workspace/db";
import { and, eq, asc, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { resolveHrAccounts } from "../lib/hr-journals.js";

const router = Router();
router.use(extractAuth);

// Clamp each lead time to 1–3650 days; unknown keys dropped, bad values → 90.
function sanitizeAlertThresholds(raw: any, previous: any = {}): {
  iqama: number; contract: number; passport: number; workPermit: number;
  medicalInsurance: number; vehicleInsurance: number;
} {
  const clamp = (v: any, fallback = 90) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : fallback;
  };
  return {
    iqama:      clamp(raw?.iqama ?? previous?.iqama),
    contract:   clamp(raw?.contract ?? previous?.contract),
    passport:   clamp(raw?.passport ?? previous?.passport),
    workPermit: clamp(raw?.workPermit ?? previous?.workPermit),
    medicalInsurance: clamp(raw?.medicalInsurance ?? previous?.medicalInsurance),
    vehicleInsurance: clamp(raw?.vehicleInsurance ?? previous?.vehicleInsurance, 60),
  };
}

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

// GET current settings + auto-resolve any missing mapping
router.get("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const accounts = await resolveHrAccounts(cid, true);
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, cid));
    const allAccounts = await db.select({
      id: accountsTable.id, code: accountsTable.code,
      nameAr: accountsTable.nameAr, nameEn: accountsTable.nameEn,
      accountType: accountsTable.accountType,
      isPosting: accountsTable.isPosting,
    }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isPosting, true), eq(accountsTable.isActive, true)))
      .orderBy(asc(accountsTable.code));
    const cashBoxes = await db.select({ id: cashBoxesTable.id, nameAr: cashBoxesTable.nameAr, nameEn: cashBoxesTable.nameEn })
      .from(cashBoxesTable).where(eq(cashBoxesTable.companyId, cid)).orderBy(asc(cashBoxesTable.nameAr));
    const banks = await db.select({ id: bankAccountsTable.id, nameAr: bankAccountsTable.nameAr, nameEn: bankAccountsTable.nameEn })
      .from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid)).orderBy(asc(bankAccountsTable.nameAr));

    res.json({
      mapping: {
        salariesExpense:        company?.hrSalariesExpenseAccountId   ?? accounts.salariesExpense,
        allowancesExpense:      company?.hrAllowancesExpenseAccountId ?? accounts.allowancesExpense,
        gosiExpense:            company?.hrGosiExpenseAccountId       ?? accounts.gosiExpense,
        eosExpense:             company?.hrEosExpenseAccountId        ?? accounts.eosExpense,
        salariesPayable:        company?.hrSalariesPayableAccountId   ?? accounts.salariesPayable,
        gosiPayable:            company?.hrGosiPayableAccountId       ?? accounts.gosiPayable,
        otherDeductions:        company?.hrOtherDeductionsAccountId   ?? accounts.otherDeductions,
        employeeLoans:          company?.hrEmployeeLoansAccountId     ?? accounts.employeeLoans,
        employeeCustody:        company?.hrEmployeeCustodyAccountId   ?? accounts.employeeCustody,
        eosProvision:           company?.hrEosProvisionAccountId      ?? accounts.eosProvision,
        leaveProvisionExpense:  company?.hrLeaveProvisionExpenseAccountId ?? accounts.leaveProvisionExpense,
        leaveProvisionLiability: company?.hrLeaveProvisionLiabilityAccountId ?? accounts.leaveProvisionLiability,
        travelTicketExpense:    company?.hrTravelTicketExpenseAccountId ?? accounts.travelTicketExpense,
        travelTicketLiability:  company?.hrTravelTicketLiabilityAccountId ?? accounts.travelTicketLiability,
        defaultPayCashBoxId:    company?.hrDefaultPayCashBoxId        ?? null,
        defaultPayBankAccountId:company?.hrDefaultPayBankAccountId    ?? null,
      },
      alertThresholds: {
        iqama:      (company?.hrAlertThresholds as any)?.iqama      ?? 90,
        contract:   (company?.hrAlertThresholds as any)?.contract   ?? 90,
        passport:   (company?.hrAlertThresholds as any)?.passport   ?? 90,
        workPermit: (company?.hrAlertThresholds as any)?.workPermit ?? 90,
        medicalInsurance: (company?.hrAlertThresholds as any)?.medicalInsurance ?? 90,
        vehicleInsurance: (company?.hrAlertThresholds as any)?.vehicleInsurance ?? 60,
      },
      monthlyProvisionsEnabled: company?.hrMonthlyProvisionsEnabled === true,
      provisionSettlementsReady: EMPLOYEE_PROVISION_SETTLEMENTS_READY,
      accounts: allAccounts,
      cashBoxes,
      bankAccounts: banks,
    });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// PUT — save mapping
router.put("/", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    // Partial-patch semantics: only rewrite the account mapping when a
    // non-empty `mapping` object is explicitly provided — a thresholds-only
    // save (or a lost/empty mapping) must NEVER null the account mappings.
    const m = req.body?.mapping;
    const hasMapping = m && typeof m === "object" && Object.keys(m).length > 0;
    const toInt = (v: any) => (v == null || v === "" ? null : Number(v));
    const set: Record<string, any> = { updatedAt: new Date() };
    if (req.body?.monthlyProvisionsEnabled === true) {
      const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, cid));
      if (!EMPLOYEE_PROVISION_SETTLEMENTS_READY && !company?.hrMonthlyProvisionsEnabled) {
        res.status(409).json({ error: "يبقى تفعيل المخصصات مغلقًا حتى اكتمال التحقق من التسويات والتكاليف" }); return;
      }
      const accountId = (key: string, column: keyof typeof company) =>
        hasMapping && key in m ? toInt(m[key]) : Number(company?.[column] ?? 0) || null;
      const required = [
        { key: "eosExpense", column: "hrEosExpenseAccountId", type: "expense" },
        { key: "eosProvision", column: "hrEosProvisionAccountId", type: "liability" },
        { key: "leaveProvisionExpense", column: "hrLeaveProvisionExpenseAccountId", type: "expense" },
        { key: "leaveProvisionLiability", column: "hrLeaveProvisionLiabilityAccountId", type: "liability" },
        { key: "travelTicketExpense", column: "hrTravelTicketExpenseAccountId", type: "expense" },
        { key: "travelTicketLiability", column: "hrTravelTicketLiabilityAccountId", type: "liability" },
      ] as const;
      const ids = required.map((item) => accountId(item.key, item.column));
      if (ids.some((id) => !id)) {
        res.status(400).json({ error: "اربط حسابات مصروف ومخصص الإجازات ونهاية الخدمة وتذاكر السفر أولاً" });
        return;
      }
      const owned = await db.select({ id: accountsTable.id, accountType: accountsTable.accountType, isPosting: accountsTable.isPosting })
        .from(accountsTable).where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, ids as number[])));
      if (owned.length !== new Set(ids).size || required.some((item) =>
        !owned.some((account) => account.id === accountId(item.key, item.column) &&
          account.accountType === item.type && account.isPosting))) {
        res.status(400).json({ error: "تحقق من نوع حسابات المخصصات وأنها حسابات ترحيل للشركة الحالية" });
        return;
      }
    }
    if (hasMapping) {
      Object.assign(set, {
        hrSalariesExpenseAccountId:   toInt(m.salariesExpense),
        hrAllowancesExpenseAccountId: toInt(m.allowancesExpense),
        hrGosiExpenseAccountId:       toInt(m.gosiExpense),
        hrEosExpenseAccountId:        toInt(m.eosExpense),
        hrSalariesPayableAccountId:   toInt(m.salariesPayable),
        hrGosiPayableAccountId:       toInt(m.gosiPayable),
        hrOtherDeductionsAccountId:   toInt(m.otherDeductions),
        hrEmployeeLoansAccountId:     toInt(m.employeeLoans),
        hrEmployeeCustodyAccountId:   toInt(m.employeeCustody),
        hrEosProvisionAccountId:      toInt(m.eosProvision),
        hrLeaveProvisionExpenseAccountId: toInt(m.leaveProvisionExpense),
        hrLeaveProvisionLiabilityAccountId: toInt(m.leaveProvisionLiability),
        hrTravelTicketExpenseAccountId: toInt(m.travelTicketExpense),
        hrTravelTicketLiabilityAccountId: toInt(m.travelTicketLiability),
        hrDefaultPayCashBoxId:        toInt(m.defaultPayCashBoxId),
        hrDefaultPayBankAccountId:    toInt(m.defaultPayBankAccountId),
      });
    }
    if (req.body?.alertThresholds !== undefined) {
      const [company] = await db.select({ thresholds: companiesTable.hrAlertThresholds })
        .from(companiesTable).where(eq(companiesTable.id, cid));
      set.hrAlertThresholds = sanitizeAlertThresholds(req.body.alertThresholds, company?.thresholds);
    }
    if (typeof req.body?.monthlyProvisionsEnabled === "boolean") {
      set.hrMonthlyProvisionsEnabled = req.body.monthlyProvisionsEnabled;
    }
    await db.update(companiesTable).set(set).where(eq(companiesTable.id, cid));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

export default router;
