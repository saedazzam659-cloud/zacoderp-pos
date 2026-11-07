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
  payrollAllocationSnapshotsTable,
  employeesTable,
  employeeContractsTable,
  employeeLoansTable,
  employeeCustodiesTable,
  employeeCustodySettlementsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { resolvePostingStatus } from "./postingStatus.js";
import { assertWritableForDate } from "./periodGuard.js";
import { nextJeSubSequence, resolveJeNumber } from "./sequences.js";
import { isHrPostingBranchBackfill, resolveHrPostingBranch } from "./hrPostingBranch.js";
import { allocateComponentBySnapshots } from "./payrollAllocation.js";
import { getLinkedSourceJournalEntry, replaceLinkedSourceJournalEntry } from "./sourceJournalEntryLifecycle.js";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  employeeCustody:    "11082",
  eosProvision:       "22021",
  leaveProvisionExpense: "5217",
  leaveProvisionLiability: "22022",
  travelTicketExpense: "5218",
  travelTicketLiability: "22023",
} as const;

export type HrAccountKey = keyof typeof HR_ACCOUNT_CODES;
const HR_ACCOUNT_COLUMNS: Record<HrAccountKey, string> = {
  salariesExpense: "hrSalariesExpenseAccountId",
  allowancesExpense: "hrAllowancesExpenseAccountId",
  gosiExpense: "hrGosiExpenseAccountId",
  eosExpense: "hrEosExpenseAccountId",
  salariesPayable: "hrSalariesPayableAccountId",
  gosiPayable: "hrGosiPayableAccountId",
  otherDeductions: "hrOtherDeductionsAccountId",
  employeeLoans: "hrEmployeeLoansAccountId",
  employeeCustody: "hrEmployeeCustodyAccountId",
  eosProvision: "hrEosProvisionAccountId",
  leaveProvisionExpense: "hrLeaveProvisionExpenseAccountId",
  leaveProvisionLiability: "hrLeaveProvisionLiabilityAccountId",
  travelTicketExpense: "hrTravelTicketExpenseAccountId",
  travelTicketLiability: "hrTravelTicketLiabilityAccountId",
};

export interface HrAccountMap {
  salariesExpense:   number | null;
  allowancesExpense: number | null;
  gosiExpense:       number | null;
  eosExpense:        number | null;
  salariesPayable:   number | null;
  gosiPayable:       number | null;
  otherDeductions:   number | null;
  employeeLoans:     number | null;
  employeeCustody:   number | null;
  eosProvision:      number | null;
  leaveProvisionExpense: number | null;
  leaveProvisionLiability: number | null;
  travelTicketExpense: number | null;
  travelTicketLiability: number | null;
  defaultPayCashBoxId:     number | null;
  defaultPayBankAccountId: number | null;
}

async function findAccountByCode(cid: number, code: string, dx: DbOrTx = db): Promise<number | null> {
  const [a] = await dx.select({ id: accountsTable.id })
    .from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.code, code), eq(accountsTable.isPosting, true)));
  return a?.id ?? null;
}

/** Ensures a ledger account can never cross a company boundary in a JE. */
export async function assertCompanyAccount(
  cid: number,
  accountId: number | null | undefined,
  label: string,
  dx: DbOrTx = db,
): Promise<number> {
  if (!accountId) throw new Error(`${label} غير مرتبط بحساب محاسبي`);
  const [account] = await dx.select({ id: accountsTable.id }).from(accountsTable)
    .where(and(eq(accountsTable.id, accountId), eq(accountsTable.companyId, cid)));
  if (!account) throw new Error(`${label} غير موجود أو لا يتبع الشركة الحالية`);
  return account.id;
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
    employeeCustody:   c.hrEmployeeCustodyAccountId   ?? null,
    eosProvision:      c.hrEosProvisionAccountId      ?? null,
    leaveProvisionExpense: c.hrLeaveProvisionExpenseAccountId ?? null,
    leaveProvisionLiability: c.hrLeaveProvisionLiabilityAccountId ?? null,
    travelTicketExpense: c.hrTravelTicketExpenseAccountId ?? null,
    travelTicketLiability: c.hrTravelTicketLiabilityAccountId ?? null,
    defaultPayCashBoxId:     c.hrDefaultPayCashBoxId     ?? null,
    defaultPayBankAccountId: c.hrDefaultPayBankAccountId ?? null,
  };

  // Auto-resolve missing mappings from COA codes
  const updates: any = {};
  const keys: HrAccountKey[] = [
    "salariesExpense","allowancesExpense","gosiExpense","eosExpense",
    "salariesPayable","gosiPayable","otherDeductions","employeeLoans","employeeCustody","eosProvision",
    "leaveProvisionExpense","leaveProvisionLiability","travelTicketExpense","travelTicketLiability",
  ];
  // Restores can leave company mapping columns pointing at account IDs from a
  // different tenant. Treat those mappings as missing so code discovery below
  // can only select an account scoped to this company.
  const storedIds = [...new Set(keys.map(k => map[k]).filter((id): id is number => id != null))];
  if (storedIds.length) {
    const owned = await dx.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), inArray(accountsTable.id, storedIds)));
    const ownedIds = new Set(owned.map(a => a.id));
    for (const k of keys) {
      if (map[k] != null && !ownedIds.has(map[k]!)) {
        map[k] = null;
        updates[HR_ACCOUNT_COLUMNS[k]] = null;
      }
    }
  }
  for (const k of keys) {
    if (!map[k]) {
      const id = await findAccountByCode(cid, HR_ACCOUNT_CODES[k], dx);
      if (id) {
        map[k] = id;
        updates[HR_ACCOUNT_COLUMNS[k]] = id;
      }
    }
  }
  if (persist && Object.keys(updates).length) {
    await dx.update(companiesTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(companiesTable.id, cid));
  }
  // Custody falls back to the combined loans/advances account (11081) when a
  // dedicated custody account (11082) hasn't been seeded yet. Not persisted, so
  // it auto-upgrades the moment a real custody account exists.
  if (!map.employeeCustody) map.employeeCustody = map.employeeLoans;
  return map;
}

function num(v: any): number { return Number(v ?? 0) || 0; }
function fix(v: number): string { return v.toFixed(2); }
function roundMoney(v: number): number { return Math.round((v + Number.EPSILON) * 100) / 100; }
function priorDay(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function eosLiabilityAt(hireDate: string | null, asOfDate: string, monthlyWage: number): number {
  if (!hireDate || asOfDate < hireDate) return 0;
  const hire = new Date(`${hireDate.slice(0, 10)}T00:00:00.000Z`).getTime();
  const asOf = new Date(`${asOfDate.slice(0, 10)}T00:00:00.000Z`).getTime();
  const years = Math.max(0, (asOf - hire) / (365.25 * 86_400_000));
  const gross = (Math.min(years, 5) * monthlyWage / 2) + (Math.max(0, years - 5) * monthlyWage);
  const resignationFactor = years < 2 ? 0 : years < 5 ? 1 / 3 : years < 10 ? 2 / 3 : 1;
  return roundMoney(gross * resignationFactor);
}

/** Resolves the cash/bank ledger and its owning branch from a payment source. */
export async function resolveCashAccount(
  cid: number,
  opts: { cashBoxId?: number | null; bankAccountId?: number | null; },
  dx: DbOrTx = db,
): Promise<{ accountId: number; label: string; branchId: number | null }> {
  if (opts.bankAccountId) {
    const [b] = await dx.select().from(bankAccountsTable)
      .where(and(eq(bankAccountsTable.id, opts.bankAccountId), eq(bankAccountsTable.companyId, cid)));
    const accountId = await assertCompanyAccount(cid, b?.accountId, "البنك المختار", dx);
    return {
      accountId,
      label: `بنك ${b.nameAr ?? b.nameEn ?? ""}`.trim(),
      branchId: b.branchId ?? b.branchIds?.[0] ?? null,
    };
  }
  if (opts.cashBoxId) {
    const [c] = await dx.select().from(cashBoxesTable)
      .where(and(eq(cashBoxesTable.id, opts.cashBoxId), eq(cashBoxesTable.companyId, cid)));
    const accountId = await assertCompanyAccount(cid, c?.accountId, "الصندوق المختار", dx);
    return {
      accountId,
      label: `صندوق ${c.nameAr ?? c.nameEn ?? ""}`.trim(),
      branchId: c.branchId ?? null,
    };
  }
  throw new Error("يجب اختيار صندوق أو حساب بنكي للسداد");
}

// ─── PAYROLL POSTING JOURNAL ─────────────────────────────────────────────────
export async function buildPayrollJournal(
  cid: number,
  runId: number,
  dx: DbOrTx = db,
  retainedEntryId?: number | null,
): Promise<number> {
  const [run] = await dx.select().from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.id, runId), eq(payrollRunsTable.companyId, cid)));
  if (!run) throw new Error("مسير الرواتب غير موجود");

  const lines = await dx.select().from(payrollLinesTable)
    .where(eq(payrollLinesTable.payrollRunId, runId));
  if (!lines.length) throw new Error("لا توجد سطور في المسير");
  const snapshots = await dx.select().from(payrollAllocationSnapshotsTable)
    .where(and(eq(payrollAllocationSnapshotsTable.companyId, cid), eq(payrollAllocationSnapshotsTable.payrollRunId, runId)));

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
    // Violation deductions ride the "استقطاعات أخرى" account (21053).
    otherDeduction += num(l.otherDeduction) + num((l as any).violationDeduction);
  }

  const accounts = await resolveHrAccounts(cid, true, dx);
  const [companyProvisions] = await dx.select({ enabled: companiesTable.hrMonthlyProvisionsEnabled })
    .from(companiesTable).where(eq(companiesTable.id, cid));
  const provisionsEnabled = companyProvisions?.enabled === true;
  const employeeIds = [...new Set(lines.map((line) => line.employeeId))];
  const [employeeRows, contracts] = await Promise.all([
    dx.select().from(employeesTable).where(and(
      eq(employeesTable.companyId, cid),
      inArray(employeesTable.id, employeeIds),
    )),
    dx.select().from(employeeContractsTable).where(and(
      eq(employeeContractsTable.companyId, cid),
      inArray(employeeContractsTable.employeeId, employeeIds),
    )),
  ]);
  const employeesById = new Map(employeeRows.map((employee) => [employee.id, employee]));
  const contractsByEmployee = new Map<number, typeof contracts>();
  for (const contract of contracts) {
    const list = contractsByEmployee.get(contract.employeeId) ?? [];
    list.push(contract);
    contractsByEmployee.set(contract.employeeId, list);
  }
  const periodStartDate = String(run.periodStart).slice(0, 10);
  const periodEndDate = String(run.periodEnd).slice(0, 10);
  const captureProvisionSnapshots = !run.provisionSnapshotsCaptured && !run.postedJournalId;
  const provisionRows = provisionsEnabled || run.provisionSnapshotsCaptured || captureProvisionSnapshots
    ? lines.map((line) => {
    const employee = employeesById.get(line.employeeId);
    const currentContract = (contractsByEmployee.get(line.employeeId) ?? [])
      .filter((contract) =>
        contract.status === "active" &&
        contract.startDate <= periodEndDate &&
        (!contract.endDate || contract.endDate >= periodStartDate),
      )
      .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
    const monthlyWage = num(line.basicSalary) + num(line.housingAllow) + num(line.transportAllow);
    const eosCurrent = eosLiabilityAt(employee?.hireDate ?? null, periodEndDate, monthlyWage);
    const eosPrior = eosLiabilityAt(employee?.hireDate ?? null, priorDay(periodStartDate), monthlyWage);
    const computedEos = provisionsEnabled ? roundMoney(eosCurrent - eosPrior) : 0;
    const annualLeaveDays = Math.max(0, num(currentContract?.vacationDays ?? 21));
    const computedLeave = provisionsEnabled ? roundMoney(monthlyWage * annualLeaveDays / 360) : 0;
    const computedTicket = provisionsEnabled ? roundMoney(num(employee?.annualTravelTicketAmount) / 12) : 0;
    const eosChange = run.provisionSnapshotsCaptured ? num(line.eosProvisionAmount) : computedEos;
    const leaveAmount = run.provisionSnapshotsCaptured ? num(line.leaveProvisionAmount) : computedLeave;
    const ticketAmount = run.provisionSnapshotsCaptured ? num(line.travelTicketProvisionAmount) : computedTicket;
    return { line, eosChange, leaveAmount, ticketAmount };
  }) : [];
  if (captureProvisionSnapshots) {
    for (const row of provisionRows) {
      await dx.update(payrollLinesTable).set({
        eosProvisionAmount: fix(row.eosChange),
        leaveProvisionAmount: fix(row.leaveAmount),
        travelTicketProvisionAmount: fix(row.ticketAmount),
      }).where(eq(payrollLinesTable.id, row.line.id));
    }
    await dx.update(payrollRunsTable).set({ provisionSnapshotsCaptured: true })
      .where(and(eq(payrollRunsTable.id, runId), eq(payrollRunsTable.companyId, cid)));
  }
  const leaveProvisionTotal = roundMoney(provisionRows.reduce((sum, row) => sum + row.leaveAmount, 0));
  const ticketProvisionTotal = roundMoney(provisionRows.reduce((sum, row) => sum + row.ticketAmount, 0));
  const eosProvisionTotal = roundMoney(provisionRows.reduce((sum, row) => sum + row.eosChange, 0));
  const hasEosProvision = provisionRows.some((row) => row.eosChange !== 0);
  const missing: string[] = [];
  if (salariesEarned > 0  && !accounts.salariesExpense)   missing.push("مصروف الرواتب (5201)");
  if (allowances > 0      && !accounts.allowancesExpense) missing.push("مصروف البدلات (5202)");
  if (netPayable > 0      && !accounts.salariesPayable)   missing.push("الرواتب المستحقة (21051)");
  if (gosiEmployee > 0    && !accounts.gosiPayable)       missing.push("التأمينات المستحقة (21052)");
  if (loanDeduction > 0   && !accounts.employeeLoans)     missing.push("سلف الموظفين (11081)");
  if (otherDeduction > 0  && !accounts.otherDeductions)   missing.push("استقطاعات أخرى (21053)");
  if (hasEosProvision && (!accounts.eosExpense || !accounts.eosProvision))
    missing.push("مصروف/مخصص نهاية الخدمة");
  if (leaveProvisionTotal > 0 && (!accounts.leaveProvisionExpense || !accounts.leaveProvisionLiability))
    missing.push("مصروف/مخصص الإجازات");
  if (ticketProvisionTotal > 0 && (!accounts.travelTicketExpense || !accounts.travelTicketLiability))
    missing.push("مصروف/مخصص تذاكر السفر");
  if (missing.length) throw new Error("الحسابات التالية غير مربوطة في إعدادات الموارد البشرية: " + missing.join("، "));

  const totalDr = +(salariesEarned + allowances).toFixed(2);
  const totalCr = +(netPayable + gosiEmployee + loanDeduction + otherDeduction).toFixed(2);
  if (Math.abs(totalDr - totalCr) > 0.05) {
    throw new Error(`القيد غير متوازن: مدين ${fix(totalDr)} ≠ دائن ${fix(totalCr)}`);
  }

  const period = `${String(run.month).padStart(2, "0")}/${run.year}`;
  const desc = `قيد الرواتب والمخصصات الشهرية ${run.code} عن الفترة ${period}`;

  const payrollDate = run.payDate || run.periodEnd;
  const prW = await assertWritableForDate(cid, payrollDate);
  if (!prW.ok) throw new Error(prW.reason);
  // JE draws its own continuous "journal_entry" number; run code stays in the
  // description + source link. Falls back to the run code.
  // Reuses a stashed number on unpost→repost (keyed payroll_run:runId) so
  // re-approving a payroll run keeps its original JE number (no gaps).
  const retainedEntry = retainedEntryId
    ? await getLinkedSourceJournalEntry(dx, cid, retainedEntryId, "payroll_run")
    : null;
  const jeStatus = await resolvePostingStatus(cid, "payroll");
  const header = {
    companyId: cid,
    branchId: run.branchId ?? null,
    docNumber: retainedEntry ? retainedEntry.docNumber : (await resolveJeNumber({
      companyId: cid, sourceType: "payroll_run", sourceId: runId, subType: "hr_payroll",
      branchId: run.branchId ?? null, docDate: payrollDate, userId: null, dx: dx as any,
    })) ?? run.code,
    entryDate: payrollDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "payroll_run",
    status: jeStatus,
  };
  const [entry] = retainedEntry ? [{ id: retainedEntry.id }] : await dx.insert(journalEntriesTable).values(header).returning();

  const drLines: any[] = [];
  // New runs have immutable daily snapshots. Split EACH expense class by the
  // same frozen cost-center weights, independently rounding in cents, so the
  // old salary/allowance aggregate totals remain mathematically identical.
  const snapshotsByLine = new Map<number, typeof snapshots>();
  for (const snapshot of snapshots) {
    const list = snapshotsByLine.get(snapshot.payrollLineId) ?? [];
    list.push(snapshot); snapshotsByLine.set(snapshot.payrollLineId, list);
  }
  const debitBuckets = new Map<string, { accountId: number; costCenter: string | null; amount: number; label: string }>();
  const addDebit = (accountId: number, costCenterId: number | null, amount: number, label: string) => {
    if (!amount) return;
    const costCenter = costCenterId == null ? null : String(costCenterId);
    const key = `${accountId}:${costCenter ?? ""}`;
    const old = debitBuckets.get(key);
    if (old) old.amount = +(old.amount + amount).toFixed(2);
    else debitBuckets.set(key, { accountId, costCenter, amount, label });
  };
  for (const line of lines) {
    const lineSnapshots = snapshotsByLine.get(line.id) ?? [];
    const salaryAmount = +(num(line.basicSalary) + num(line.overtimeAmount) + num(line.bonusAmount) - num(line.absenceDeduction)).toFixed(2);
    const allowanceAmount = +(num(line.housingAllow) + num(line.transportAllow) + num(line.otherAllow)).toFixed(2);
    if (!lineSnapshots.length) { // legacy run created before allocation feature
      addDebit(accounts.salariesExpense!, null, salaryAmount, `رواتب وأجور الفترة ${period}`);
      addDebit(accounts.allowancesExpense!, null, allowanceAmount, `بدلات وحوافز الفترة ${period}`);
      continue;
    }
    for (const part of allocateComponentBySnapshots(salaryAmount, lineSnapshots))
      addDebit(accounts.salariesExpense!, part.costCenterId, part.amount, `رواتب وأجور الفترة ${period}`);
    for (const part of allocateComponentBySnapshots(allowanceAmount, lineSnapshots))
      addDebit(accounts.allowancesExpense!, part.costCenterId, part.amount, `بدلات وحوافز الفترة ${period}`);
  }
  const provisionDebitLines: any[] = [];
  const provisionCreditLines: any[] = [];
  const addProvision = (
    expenseAccountId: number,
    liabilityAccountId: number,
    amount: number,
    lineSnapshots: typeof snapshots,
    expenseDescription: string,
    liabilityDescription: string,
  ) => {
    const value = roundMoney(amount);
    if (!value) return;
    if (value > 0) {
      const allocations = lineSnapshots.length
        ? allocateComponentBySnapshots(value, lineSnapshots, "provision")
        : [{ costCenterId: null, amount: value }];
      for (const part of allocations) {
        addDebit(expenseAccountId, part.costCenterId, part.amount, expenseDescription);
      }
      provisionCreditLines.push({
        entryId: 0, accountId: liabilityAccountId, debit: "0.00", credit: fix(value),
        description: liabilityDescription, sortOrder: 0,
      });
    } else {
      const absValue = Math.abs(value);
      provisionDebitLines.push({
        entryId: 0, accountId: liabilityAccountId, debit: fix(absValue), credit: "0.00",
        description: `تخفيض ${liabilityDescription}`, sortOrder: 0,
      });
      const allocations = lineSnapshots.length
        ? allocateComponentBySnapshots(absValue, lineSnapshots, "provision")
        : [{ costCenterId: null, amount: absValue }];
      for (const part of allocations) {
        provisionCreditLines.push({
          entryId: 0, accountId: expenseAccountId, costCenter: part.costCenterId == null ? null : String(part.costCenterId),
          debit: "0.00", credit: fix(part.amount), description: `عكس ${expenseDescription}`, sortOrder: 0,
        });
      }
    }
  };
  for (const row of provisionRows) {
    const lineSnapshots = snapshotsByLine.get(row.line.id) ?? [];
    if (row.eosChange) {
      addProvision(accounts.eosExpense!, accounts.eosProvision!, row.eosChange, lineSnapshots,
        `مصروف استحقاق نهاية الخدمة ${period}`, `مخصص نهاية الخدمة ${period}`);
    }
    if (row.leaveAmount > 0) {
      addProvision(accounts.leaveProvisionExpense!, accounts.leaveProvisionLiability!, row.leaveAmount, lineSnapshots,
        `مصروف مخصص الإجازات ${period}`, `مخصص الإجازات ${period}`);
    }
    if (row.ticketAmount > 0) {
      addProvision(accounts.travelTicketExpense!, accounts.travelTicketLiability!, row.ticketAmount, lineSnapshots,
        `مصروف تذاكر السفر ${period}`, `مخصص تذاكر السفر ${period}`);
    }
  }
  let debitOrder = 0;
  for (const bucket of debitBuckets.values()) {
    if (bucket.amount > 0) drLines.push({ entryId: entry.id, accountId: bucket.accountId, costCenter: bucket.costCenter,
      debit: fix(bucket.amount), credit: "0.00", description: bucket.label, sortOrder: debitOrder++ });
  }

  const crLines: any[] = [];
  if (netPayable > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.salariesPayable, debit: "0.00", credit: fix(netPayable),
       description: `صافي الرواتب المستحقة ${period}`, sortOrder: debitOrder++ });
  if (gosiEmployee > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.gosiPayable, debit: "0.00", credit: fix(gosiEmployee),
       description: `حصة الموظف من التأمينات ${period}`, sortOrder: debitOrder++ });
  if (loanDeduction > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.employeeLoans, debit: "0.00", credit: fix(loanDeduction),
       description: `استرداد أقساط سلف الموظفين ${period}`, sortOrder: debitOrder++ });
  if (otherDeduction > 0)
    crLines.push({ entryId: entry.id, accountId: accounts.otherDeductions, debit: "0.00", credit: fix(otherDeduction),
       description: `استقطاعات أخرى ${period}`, sortOrder: debitOrder++ });

  for (const line of provisionDebitLines) {
    line.entryId = entry.id;
    line.sortOrder = debitOrder++;
  }
  for (const line of provisionCreditLines) {
    line.entryId = entry.id;
    line.sortOrder = debitOrder++;
  }
  const journalLines = [...drLines, ...provisionDebitLines, ...crLines, ...provisionCreditLines];
  const journalDebit = roundMoney(journalLines.reduce((sum, line) => sum + num(line.debit), 0));
  const journalCredit = roundMoney(journalLines.reduce((sum, line) => sum + num(line.credit), 0));
  if (Math.abs(journalDebit - journalCredit) > 0.05) {
    throw new Error(`القيد غير متوازن بعد احتساب المخصصات: مدين ${fix(journalDebit)} ≠ دائن ${fix(journalCredit)}`);
  }
  if (retainedEntry) {
    return replaceLinkedSourceJournalEntry(dx, {
      companyId: cid,
      entryId: retainedEntry.id,
      entryType: "payroll_run",
      header,
      lines: journalLines,
      sequenceProtected: !!(run as any).isSequenceProtected,
    });
  }
  await dx.insert(journalEntryLinesTable).values(journalLines);
  return entry.id;
}

// ─── PAYROLL PAYMENT JOURNAL (صرف الرواتب) ──────────────────────────────────
// DR salaries payable (21051) / CR cash|bank — the actual salary disbursement
// after the payroll run has been posted (which credited 21051).
export async function buildEmployeeProvisionSettlementJournal(
  cid: number,
  settlementId: number,
  settlement: { provisionType: "annual_leave" | "travel_ticket"; employeeId: number; amount: unknown; settlementDate: string; provisionPeriod: string },
  dx: DbOrTx = db,
): Promise<number> {
  const accounts = await resolveHrAccounts(cid, true, dx);
  const leave = settlement.provisionType === "annual_leave";
  const liability = leave ? accounts.leaveProvisionLiability : accounts.travelTicketLiability;
  const expense = leave ? accounts.salariesExpense : accounts.travelTicketExpense;
  if (!liability || !expense) throw new Error("حسابات تسوية المخصص غير مربوطة");
  const amount = roundMoney(num(settlement.amount));
  if (!(amount > 0)) throw new Error("مبلغ التسوية يجب أن يكون موجباً");
  const writable = await assertWritableForDate(cid, settlement.settlementDate);
  if (!writable.ok) throw new Error(writable.reason);
  const period = settlement.provisionPeriod;
  const description = leave
    ? `تسوية مخصص إجازة الموظف ${settlement.employeeId} عن ${period}`
    : `تسوية مخصص تذكرة الموظف ${settlement.employeeId} عن ${period}`;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: null,
    docNumber: (await resolveJeNumber({
      companyId: cid, sourceType: "employee_provision_settlement", sourceId: settlementId,
      subType: "hr_payroll", branchId: null, docDate: settlement.settlementDate,
      userId: null, dx: dx as any,
    })) ?? `HRS-${settlementId}`,
    entryDate: settlement.settlementDate,
    currency: "SAR",
    exchangeRate: "1",
    description,
    entryType: "employee_provision_settlement",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning({ id: journalEntriesTable.id });
  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: liability, debit: fix(amount), credit: "0.00", description: `تخفيض مخصص ${period}`, sortOrder: 0 },
    { entryId: entry.id, accountId: expense, debit: "0.00", credit: fix(amount), description, sortOrder: 1 },
  ]);
  return entry.id;
}

export async function buildPayrollPaymentJournal(
  cid: number,
  runId: number,
  payDate: string,
  source: { cashBoxId?: number | null; bankAccountId?: number | null },
  dx: DbOrTx = db,
  retainedEntryId?: number | null,
): Promise<number> {
  const [run] = await dx.select().from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.id, runId), eq(payrollRunsTable.companyId, cid)));
  if (!run) throw new Error("مسير الرواتب غير موجود");

  const amount = num(run.totalNet);
  if (amount <= 0) throw new Error("صافي المسير يجب أن يكون أكبر من صفر");

  const accounts = await resolveHrAccounts(cid, true, dx);
  if (!accounts.salariesPayable) throw new Error("حساب الرواتب المستحقة (21051) غير مربوط في إعدادات الموارد البشرية");
  const cash = await resolveCashAccount(cid, source, dx);
  const postingBranchId = resolveHrPostingBranch(run.branchId, cash.branchId);

  const period = `${String(run.month).padStart(2, "0")}/${run.year}`;
  const desc = `صرف رواتب المسير ${run.code} عن الفترة ${period}`;

  const w = await assertWritableForDate(cid, payDate);
  if (!w.ok) throw new Error(w.reason);
  // Reuses the retained row for protected payroll sources; legacy entries
  // continue to use the keyed reservation after unpay.
  const retainedEntry = retainedEntryId
    ? await getLinkedSourceJournalEntry(dx, cid, retainedEntryId, "payroll_payment")
    : null;
  const header = {
    companyId: cid,
    branchId: postingBranchId,
    docNumber: retainedEntry ? retainedEntry.docNumber : (await resolveJeNumber({
      companyId: cid, sourceType: "payroll_pay", sourceId: runId, subType: "hr_payroll",
      branchId: postingBranchId, docDate: payDate, userId: null, dx: dx as any,
    })) ?? `PAY-${run.code}`,
    entryDate: payDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "payroll_payment",
    status: await resolvePostingStatus(cid, "payroll"),
    isSequenceProtected: !!(run as any).isSequenceProtected || !!retainedEntry?.isSequenceProtected,
  };
  const [entry] = retainedEntry ? [{ id: retainedEntry.id }] : await dx.insert(journalEntriesTable).values(header).returning();

  const lines = [
    { entryId: entry.id, accountId: accounts.salariesPayable, debit: fix(amount), credit: "0.00",
      description: `سداد صافي رواتب الفترة ${period}`, sortOrder: 0 },
    { entryId: entry.id, accountId: cash.accountId, debit: "0.00", credit: fix(amount),
      description: cash.label, sortOrder: 1 },
  ];
  if (retainedEntry) {
    return replaceLinkedSourceJournalEntry(dx, {
      companyId: cid,
      entryId: retainedEntry.id,
      entryType: "payroll_payment",
      header,
      lines,
    });
  }
  await dx.insert(journalEntryLinesTable).values(lines);
  return entry.id;
}

// Resolves the loan receivable account for a loan row: the row's own
// loan_account_id wins, else the company loans mapping (11081). Throws when
// nothing resolves so postings never silently misfire.
async function resolveLoanAccount(cid: number, loanAccountId: number | null, dx: DbOrTx): Promise<number> {
  // Defense-in-depth: only honor the row's account when it still belongs to
  // this company and is a posting account (the API boundary validates on write,
  // but a stale/foreign id must never silently post to another tenant's GL).
  if (loanAccountId) {
    const [a] = await dx.select({ id: accountsTable.id })
      .from(accountsTable)
      .where(and(eq(accountsTable.id, loanAccountId), eq(accountsTable.companyId, cid), eq(accountsTable.isPosting, true)));
    if (a) return a.id;
  }
  const accounts = await resolveHrAccounts(cid, true, dx);
  if (!accounts.employeeLoans) throw new Error("حساب سلف الموظفين (11081) غير مربوط في إعدادات الموارد البشرية");
  return accounts.employeeLoans;
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
  const loanAccountId = await resolveLoanAccount(cid, loan.loanAccountId, dx);

  const cash = await resolveCashAccount(cid, source, dx);
  const postingBranchId = resolveHrPostingBranch(emp?.branchId, cash.branchId);
  const desc = `صرف ${loan.loanType === "advance" ? "عُهدة" : "سلفة"} للموظف ${emp?.nameAr ?? ""}`.trim();

  const loanW = await assertWritableForDate(cid, loan.loanDate);
  if (!loanW.ok) throw new Error(loanW.reason);
  // JE draws its own continuous "journal_entry" number; falls back to LOAN-*.
  // Reuses a stashed number on unpost→re-disburse (keyed employee_loan:loanId).
  const jeDocNumber = (await resolveJeNumber({
    companyId: cid, sourceType: "employee_loan", sourceId: loan.id, subType: "hr_loan",
    branchId: postingBranchId, docDate: loan.loanDate, userId: null, dx: dx as any,
  })) ?? `LOAN-${loan.id}`;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: postingBranchId,
    docNumber: jeDocNumber,
    entryDate: loan.loanDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "employee_loan",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: loanAccountId,  debit: fix(amount), credit: "0.00",
      description: desc, sortOrder: 0 },
    { entryId: entry.id, accountId: cash.accountId, debit: "0.00",      credit: fix(amount),
      description: cash.label,                      sortOrder: 1 },
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
  const postingBranchId = resolveHrPostingBranch(emp.branchId, cash.branchId);
  const desc = opts.description || `صرف مكافأة نهاية الخدمة للموظف ${emp.nameAr}`;

  const eosW = await assertWritableForDate(cid, payDate);
  if (!eosW.ok) throw new Error(eosW.reason);
  // JE draws its own continuous "journal_entry" number; falls back to EOS-*.
  const jeDocNumber = (await nextJeSubSequence(cid, "hr_eos", {
    userId: null, refTable: "journal_entries", branchId: postingBranchId, docDate: payDate,
  })) ?? `EOS-${employeeId}-${payDate.replace(/-/g, "")}`;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: postingBranchId,
    docNumber: jeDocNumber,
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

// ─── CUSTODY (العُهد) JOURNALS ────────────────────────────────────────────────
// Resolves the custody receivable account for a custody row: the row's own
// custody_account_id wins, else the company custody mapping (11082 → fallback
// 11081). Throws when nothing resolves so postings never silently misfire.
export async function resolveCustodyAccount(cid: number, custodyAccountId: number | null, dx: DbOrTx): Promise<number> {
  if (custodyAccountId) {
    const [account] = await dx.select({ id: accountsTable.id }).from(accountsTable)
      .where(and(eq(accountsTable.id, custodyAccountId), eq(accountsTable.companyId, cid)));
    if (account) return account.id;
  }
  const accounts = await resolveHrAccounts(cid, true, dx);
  if (!accounts.employeeCustody) throw new Error("حساب عُهد الموظفين (11082) غير مربوط في إعدادات الموارد البشرية");
  return assertCompanyAccount(cid, accounts.employeeCustody, "حساب عُهد الموظفين", dx);
}

/** صرف عهدة — DR employee custody / CR cash|bank. */
export async function buildCustodyDisbursementJournal(
  cid: number,
  custodyId: number,
  source: { cashBoxId?: number | null; bankAccountId?: number | null },
  dx: DbOrTx = db
): Promise<number> {
  const [cust] = await dx.select().from(employeeCustodiesTable)
    .where(and(eq(employeeCustodiesTable.id, custodyId), eq(employeeCustodiesTable.companyId, cid)));
  if (!cust) throw new Error("العهدة غير موجودة");

  const amount = num(cust.amount);
  if (amount <= 0) throw new Error("مبلغ العهدة يجب أن يكون أكبر من صفر");

  const [emp] = await dx.select().from(employeesTable).where(eq(employeesTable.id, cust.employeeId));
  const custodyAccountId = await resolveCustodyAccount(cid, cust.custodyAccountId, dx);
  const cash = await resolveCashAccount(cid, source, dx);
  const postingBranchId = resolveHrPostingBranch(cust.branchId, cash.branchId, emp?.branchId);
  const branchBackfill = isHrPostingBranchBackfill(cust.branchId, postingBranchId);
  const desc = `صرف عهدة للموظف ${emp?.nameAr ?? ""}`.trim();

  const w = await assertWritableForDate(cid, cust.custodyDate);
  if (!w.ok) throw new Error(w.reason);
  // Legacy custody rows could be branchless even when their selected payment
  // source belongs to a branch. Persist the resolved branch so settlement,
  // return and future reposts all use the same JE counter bucket.
  if (branchBackfill) {
    await dx.update(employeeCustodiesTable)
      .set({ branchId: postingBranchId, updatedAt: new Date() })
      .where(and(
        eq(employeeCustodiesTable.id, cust.id),
        eq(employeeCustodiesTable.companyId, cid),
      ));
  }
  // Reuses a stashed number on unpost→re-disburse (keyed employee_custody_disb:custodyId).
  // When this call is also fixing a missing source branch, discard the old
  // reservation: it may have been issued from branch 0 (e.g. .../0013) rather
  // than the real branch's running counter (e.g. .../2387).
  const jeDocNumber = (await resolveJeNumber({
    companyId: cid, sourceType: "employee_custody_disb", sourceId: cust.id, subType: "hr_custody",
    branchId: postingBranchId, docDate: cust.custodyDate, userId: null, dx: dx as any,
    reuseReserved: !branchBackfill,
  })) ?? `CUST-${cust.id}`;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: postingBranchId,
    docNumber: jeDocNumber,
    entryDate: cust.custodyDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "employee_custody",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: custodyAccountId, debit: fix(amount), credit: "0.00",
      description: desc, sortOrder: 0 },
    { entryId: entry.id, accountId: cash.accountId,   debit: "0.00",      credit: fix(amount),
      description: desc, sortOrder: 1 },
  ]);
  return entry.id;
}

/** تسوية عهدة بمصروف — DR expense / CR employee custody. */
export async function buildCustodySettlementJournal(
  cid: number,
  settlementId: number,
  dx: DbOrTx = db
): Promise<number> {
  const [stl] = await dx.select().from(employeeCustodySettlementsTable)
    .where(and(eq(employeeCustodySettlementsTable.id, settlementId), eq(employeeCustodySettlementsTable.companyId, cid)));
  if (!stl) throw new Error("سطر التسوية غير موجود");
  const amount = num(stl.amount);
  if (amount <= 0) throw new Error("مبلغ التسوية يجب أن يكون أكبر من صفر");
  if (!stl.expenseAccountId) throw new Error("يجب اختيار حساب المصروف للتسوية");

  const [cust] = await dx.select().from(employeeCustodiesTable)
    .where(and(eq(employeeCustodiesTable.id, stl.custodyId), eq(employeeCustodiesTable.companyId, cid)));
  if (!cust) throw new Error("العهدة غير موجودة");
  const [emp] = await dx.select().from(employeesTable).where(eq(employeesTable.id, cust.employeeId));
  const custodyAccountId = await resolveCustodyAccount(cid, cust.custodyAccountId, dx);
  const expenseAccountId = await assertCompanyAccount(cid, stl.expenseAccountId, "حساب مصروف التسوية", dx);

  const baseDesc = `تسوية عهدة — ${stl.description || "مصروف"}`;
  const desc = stl.invoiceNumber ? `${baseDesc} (فاتورة ${stl.invoiceNumber})` : baseDesc;

  const w = await assertWritableForDate(cid, stl.settleDate);
  if (!w.ok) throw new Error(w.reason);
  const jeDocNumber = (await nextJeSubSequence(cid, "hr_custody", {
    userId: null, refTable: "journal_entries", branchId: cust.branchId ?? emp?.branchId ?? null, docDate: stl.settleDate,
  })) ?? `CUST-STL-${stl.id}`;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: cust.branchId ?? emp?.branchId ?? null,
    docNumber: jeDocNumber,
    entryDate: stl.settleDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "employee_custody_settlement",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: expenseAccountId, debit: fix(amount), credit: "0.00",
      description: desc, sortOrder: 0 },
    { entryId: entry.id, accountId: custodyAccountId,     debit: "0.00",      credit: fix(amount),
      description: `إقفال من عهدة الموظف ${emp?.nameAr ?? ""}`.trim(), sortOrder: 1 },
  ]);
  return entry.id;
}

/** إرجاع باقي العهدة — DR cash|bank / CR employee custody. */
export async function buildCustodyReturnJournal(
  cid: number,
  custodyId: number,
  amount: number,
  returnDate: string,
  source: { cashBoxId?: number | null; bankAccountId?: number | null },
  dx: DbOrTx = db
): Promise<number> {
  if (!(amount > 0)) throw new Error("قيمة الإرجاع يجب أن تكون أكبر من صفر");
  const [cust] = await dx.select().from(employeeCustodiesTable)
    .where(and(eq(employeeCustodiesTable.id, custodyId), eq(employeeCustodiesTable.companyId, cid)));
  if (!cust) throw new Error("العهدة غير موجودة");
  const [emp] = await dx.select().from(employeesTable).where(eq(employeesTable.id, cust.employeeId));
  const custodyAccountId = await resolveCustodyAccount(cid, cust.custodyAccountId, dx);
  const cash = await resolveCashAccount(cid, source, dx);
  const postingBranchId = resolveHrPostingBranch(cust.branchId, cash.branchId, emp?.branchId);
  const desc = `إرجاع باقي عهدة الموظف ${emp?.nameAr ?? ""}`.trim();

  const w = await assertWritableForDate(cid, returnDate);
  if (!w.ok) throw new Error(w.reason);
  const jeDocNumber = (await nextJeSubSequence(cid, "hr_custody", {
    userId: null, refTable: "journal_entries", branchId: postingBranchId, docDate: returnDate,
  })) ?? `CUST-RET-${cust.id}`;
  const [entry] = await dx.insert(journalEntriesTable).values({
    companyId: cid,
    branchId: postingBranchId,
    docNumber: jeDocNumber,
    entryDate: returnDate,
    currency: "SAR",
    exchangeRate: "1",
    description: desc,
    entryType: "employee_custody_return",
    status: await resolvePostingStatus(cid, "payroll"),
  }).returning();

  await dx.insert(journalEntryLinesTable).values([
    { entryId: entry.id, accountId: cash.accountId,   debit: fix(amount), credit: "0.00",
      description: cash.label, sortOrder: 0 },
    { entryId: entry.id, accountId: custodyAccountId, debit: "0.00",      credit: fix(amount),
      description: desc, sortOrder: 1 },
  ]);
  return entry.id;
}
