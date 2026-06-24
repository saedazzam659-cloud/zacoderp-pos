import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, accountsTable, cashBoxesTable, bankAccountsTable } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { resolveHrAccounts } from "../lib/hr-journals.js";

const router = Router();
router.use(extractAuth);

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
        defaultPayCashBoxId:    company?.hrDefaultPayCashBoxId        ?? null,
        defaultPayBankAccountId:company?.hrDefaultPayBankAccountId    ?? null,
      },
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
    const m = req.body?.mapping || {};
    const toInt = (v: any) => (v == null || v === "" ? null : Number(v));
    await db.update(companiesTable).set({
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
      hrDefaultPayCashBoxId:        toInt(m.defaultPayCashBoxId),
      hrDefaultPayBankAccountId:    toInt(m.defaultPayBankAccountId),
      updatedAt: new Date(),
    }).where(eq(companiesTable.id, cid));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

export default router;
