import { db } from "@workspace/db";
import {
  accountsTable,
  companiesTable,
  cashBoxesTable,
  bankAccountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  payrollRunsTable,
  payrollLinesTable,
  employeesTable,
  employeeLoansTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resolvePostingStatus } from "./postingStatus.js";

type DbOrTx = typeof db;

// Standard HR account codes — must match seeded COA in coaTemplates.ts
const HR_ACCOUNT_CODES = {
  salariesExpense:    "5201",
  allowancesExpense:  "5202",
  gosiExpense:        "5203",
  eosExpense:         "5215",
  salariesPayable:    "21051",
  gosiPayable:        "21052",
  otherDeductions:    "21053",
  employeeLoans:      "11081",
  eosProvision:       "22021",
} as const;

export type HrAccountKey = keyof typeof HR_ACCOUNT_CODES;

export interface HrAccountMap {
  salariesExpense:   number | null;
  allowancesExpense: number | null;
  gosiExpense:       number | null;
  eosExpense:        number | null;
  salariesPayable:   number | null;
  gosiPayable:       number | null;
  otherDeductions:   number | null;
  employeeLoans:     number | null;
  eosProvision:      number | null;
  defaultPayCashBoxId:     number | null;
  defaultPayBankAccountId: number | null;
}

async function findAccountByCode(cid: number, code: string, dx: DbOrTx = db): Promise<number | null> {
  const [a] = await dx.select({ id: accountsTable.id })
    .from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.code, code), eq(accountsTable.isPosting, true)));
  return a?.id ?? null;
}

/**
 * Returns the HR account map for a company. If the company has stored mappings
 * they are used; otherwise the function auto-resolves them from the seeded COA
 * by code (5201 / 5202 / 21051 ...) and persists them on the company.
 */
export async function resolveHrAccounts(cid: number, persist = true, dx: DbOrTx = db): Promise<HrAccountMap> {
  const [c] = await dx.select().from(companiesTable).where(eq(companiesTable.id, cid));
  if (!c) throw new Error("الشركة غير موجودة");

  const map: HrAccountMap = {
    salariesExpense:   c.hrSalariesExpenseAccountId   ?? null,
    allowancesExpense: c.hrAllowancesExpenseAccountId ?? null,
    gosiExpense:       c.hrGosiExpenseAccountId       ?? null,
    eosExpense:        c.hrEosExpenseAccountId        ?? null,
    salariesPayable:   c.hrSalariesPayableAccountId   ?? null,
    gosiPayable:       c.hrGosiPayableAccountId       ?? null,
    otherDeductions:   c.hrOtherDeductionsAccountId   ?? null,
    employeeLoans:     c.hrEmployeeLoansAccountId     ?? null,
    eosProvision:      c.hrEosProvisionAccountId      ?? null,
    defaultPayCashBoxId:     c.hrDefaultPayCashBoxId     ?? null,
    defaultPayBankAccountId: c.hrDefaultPayBankAccountId ?? null,
  };

  // Auto-resolve missing mappings from COA codes
  const updates: any = {};
  const keys: HrAccountKey[] = [
    "salariesExpense","allowancesExpense","gosiExpense","eosExpense",
    "salariesPayable","gosiPayable","otherDeductions","employeeLoans","eosProvision",
  ];
  for (const k of keys) {
    if (!map[k]) {
      const id = await findAccountByCode(cid, HR_ACCOUNT_CODES[k], dx);
      if (id) {
        map[k] = id;
        const col =
          k === "salariesExpense"   ? "hrSalariesExpenseAccountId" :
          k === "allowancesExpense" ? "hrAllowancesExpenseAccountId" :
          k === "gosiExpense"       ? "hrGosiExpenseAccountId" :
          k === "eosExpense"        ? "hrEosExpenseAccountId" :
          k === "salariesPayable"   ? "hrSalariesPayableAccountId" :
          k === "gosiPayable"       ? "hrGosiPayableAccountId" :
          k === "otherDeductions"   ? "hrOtherDeductionsAccountId" :
          k === "employeeLoans"     ? "hrEmployeeLoansAccountId" :
                                       "hrEosProvisionAccountId";
        updates[col] = id;
      }
    }
  }
  if (persist && Object.keys(updates).length) {
    await dx.update(companiesTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(companiesTable.id, cid));
  }
  return map;
}

function num(v: any): number { return Number(v ?? 0) || 0; }
function fix(v: number): string { return v.toFixed(2); }

/** Resolves the DR cash/bank account id from a payment source (cashBoxId or bankAccountId). */
export async function resolveCashAccount(cid: number, opts: { cashBoxId?: number | null; bankAccountId?: number | null; }, dx: DbOrTx = db): Promise<{ accountId: number; label: string }> {
  if (opts.bankAccountId) {
    const [b] = await dx.select().from(bankAccountsTable)
      .where(and(eq(bankAccountsTable.id, opts.bankAccountId), eq(bankAccountsTable.companyId, cid)));
    if (!b?.accountId) throw new Error("البنك المختار غير مرتبط بحساب محاسبي");
    return { accountId: b.accountId, label: `بنك ${b.nameAr ?? b.nameEn ?? ""}`.trim() };
  }
  if (opts.cashBoxId) {
    const [c] = await dx.select().from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.id, opts.cashBoxId), eq(cashBoxesTable.companyId, cid)));
    if (!c?.accountId) throw new Error("الصندوق المختار غير مرتبط بحساب محاسبي");
    return { accountId: c.accountId, label: `صندوق ${c.nameAr ?? c.nameEn ?? ""}`.trim() };
  }
  throw new Error("يجب اختيار صندوق أو حساب بنكي للسداد");
}

// ─── PAYROLL POSTING JOURNAL ─────────────────────────────────────────────────
export async function buildPayrollJournal(cid: number, runId: number, dx: DbOrTx = db): Promise<number> {
  const [run] = await dx.select().from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.id, runId), eq(payrollRunsTable.companyId, cid)));
  if (!run) throw new Error("مسير الرواتب غير موجود");

  const lines = await dx.select().from(payrollLinesTable)
    .where(eq(payrollLinesTable.payrollRunId, runId));
  if (!lines.length) throw new Error("لا توجد سطور في المسير");

  // Aggregate
  let salariesEarned = 0; // basic + overtime + bonus - absence
  let allowances     = 0; // housing + transport + other
  let netPayable     = 0;
  let gosiEmployee   = 0;
  let loanDeduction  = 0;
  let otherDeduction = 0;
  for (const l of lines) {
    salariesEarned += num(l.basicSalary) + num(l.overtimeAmount) + num(l.bonusAmount) - num(l.absenceDeduction);
    allowances     += num(l.housingAllow) + num(l.transportAllow) + num(l.otherAllow);
    netPayable     += num(l.netSalary);
    gosiEmployee   += num(l.gosiEmployee);
    loanDeduction  += num(l.loanDeduction);
    otherDeduction += num(l.otherDeduction);
  }

  const accounts = await resolveHrAccounts(cid, true, dx);
  const missing: string[] = [];
  if (salariesEarned > 0  && !accounts.salariesExpense)   missing.push("مصروف الرواتب (5201)");
  if (allowances > 0      && !accounts.allowancesExpense) missing.push("مصروف البدلات (5202)");
  if (netPayable > 0      && !accounts.salariesPayable)   missing.push("الرواتب المستحقة (21051)");
  if (gosiEmployee > 0    && !accounts.gosiPayable)       missing.push("التأمينات المستحقة (21052)");
  if (loanDeduction > 0   && !accounts.employeeLoans)     missing.push("سلف الموظفين (11081)");
  if (otherDeduction > 0  && !accounts.otherDeductions)   missing.push("استقطاعات أخرى (21053)");
  if (missing.length) throw new Error("الحسابات التالية غير مربوطة في إعدادات الموارد البشرية: " + missing.join("، "));

  const totalDr = +(salariesEarned + allowances).toFixed(2);
  const totalCr = +(netPayable + gosiEmployee + loanDeduction + otherDeduction).toFixed(2);
  if (Math.abs(totalDr - totalCr) > 0.05) {
    throw new Error(`القيد غير متوازن: مدين ${fix(totalDr)} ≠ دائن ${fix(totalCr)}`);
  }

  const period = `${String(run.month).padStart(2, "0")}/${run.year}`;
  const desc = `قيد مسير الرواتب ${run.code} عن الفترة ${period}`;

  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: run.branchId ?? null,
    docNumber: run.code,
    entryDate: run.payDate || run.periodEnd,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "payroll_run",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning();

  const drLines: any[] = [];
  if (salariesEarned > 0)
    drLines.push({ entryId: entry.id, accountId: accounts.salariesExpense, debit: fix(salariesEarned), credit: "0.00",
      description: `رواتب وأجور الفترة ${period}`, sortOrder: 0 });
  if (allowances > 0)
    drLines.push({ entryId: entry.id, accountId: accounts.allowancesExpense, debit: fix(allowances), credit: "0.00",
      description: `بدلات وحوافز الفترة ${period}`, sortOrder: 1 });

  const crLines: any[] = [];
  if (netPayable > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.salariesPayable, debit: "0.00", credit: fix(netPayable),
      description: `صافي الرواتب المستحقة ${period}`, sortOrder: 2 });
  if (gosiEmployee > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.gosiPayable, debit: "0.00", credit: fix(gosiEmployee),
      description: `حصة الموظف من التأمينات ${period}`, sortOrder: 3 });
  if (loanDeduction > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.employeeLoans, debit: "0.00", credit: fix(loanDeduction),
      description: `استرداد أقساط سلف الموظفين ${period}`, sortOrder: 4 });
  if (otherDeduction > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.otherDeductions, debit: "0.00", credit: fix(otherDeduction),
      description: `استقطاعات أخرى ${period}`, sortOrder: 5 });

  await dx.insert(journalEntryLinesTable).values([...drLines, ...crLines]);
  return entry.id;
}

// ─── LOAN DISBURSEMENT JOURNAL ───────────────────────────────────────────────
export async function buildLoanDisbursementJournal(
  cid: number,
  loanId: number,
  source: { cashBoxId?: number | null; bankAccountId?: number | null },
  dx: DbOrTx = db
): Promise<number> {
  const [loan] = await dx.select().from(employeeLoansTable)
    .where(and(eq(employeeLoansTable.id, loanId), eq(employeeLoansTable.companyId, cid)));
  if (!loan) throw new Error("السلفة غير موجودة");

  const amount = num(loan.amount);
  if (amount <= 0) throw new Error("مبلغ السلفة يجب أن يكون أكبر من صفر");

  const [emp] = await dx.select().from(employeesTable).where(eq(employeesTable.id, loan.employeeId));
  const accounts = await resolveHrAccounts(cid, true, dx);
  if (!accounts.employeeLoans) throw new Error("حساب سلف الموظفين (11081) غير مربوط في الإعدادات");

  const cash = await resolveCashAccount(cid, source, dx);
  const desc = `صرف ${loan.loanType === "advance" ? "عُهدة" : "سلفة"} للموظف ${emp?.nameAr ?? ""}`.trim();

  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: emp?.branchId ?? null,
    docNumber: `LOAN-${loan.id}`,
    entryDate: loan.loanDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "employee_loan",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: accounts.employeeLoans, debit: fix(amount), credit: "0.00",
      description: desc, sortOrder: 0 },
    { entryId: entry.id, accountId: cash.accountId,         debit: "0.00",      credit: fix(amount),
      description: cash.label,                              sortOrder: 1 },
  ]);
  return entry.id;
}

// ─── EOS PAYMENT JOURNAL ─────────────────────────────────────────────────────
export async function buildEosPaymentJournal(
  cid: number,
  employeeId: number,
  amount: number,
  payDate: string,
  source: { cashBoxId?: number | null; bankAccountId?: number | null },
  opts: { useProvision?: boolean; description?: string } = {},
  dx: DbOrTx = db
): Promise<number> {
  if (!(amount > 0)) throw new Error("قيمة المكافأة يجب أن تكون أكبر من صفر");
  const [emp] = await dx.select().from(employeesTable)
    .where(and(eq(employeesTable.id, employeeId), eq(employeesTable.companyId, cid)));
  if (!emp) throw new Error("الموظف غير موجود");

  const accounts = await resolveHrAccounts(cid, true, dx);
  const drAccountId = opts.useProvision ? accounts.eosProvision : accounts.eosExpense;
  if (!drAccountId) throw new Error(opts.useProvision
    ? "حساب مخصص نهاية الخدمة (22021) غير مربوط"
    : "حساب مصروف نهاية الخدمة (5215) غير مربوط");

  const cash = await resolveCashAccount(cid, source, dx);
  const desc = opts.description || `صرف مكافأة نهاية الخدمة للموظف ${emp.nameAr}`;

  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: emp.branchId ?? null,
    docNumber: `EOS-${employeeId}-${payDate.replace(/-/g, "")}`,
    entryDate: payDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "eos_payment",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: drAccountId,    debit: fix(amount), credit: "0.00",
      description: opts.useProvision ? `إقفال مخصص نهاية الخدمة` : `مصروف مكافأة نهاية الخدمة`, sortOrder: 0 },
    { entryId: entry.id, accountId: cash.accountId, debit: "0.00",      credit: fix(amount),
      description: cash.label, sortOrder: 1 },
  ]);
  return entry.id;
}
