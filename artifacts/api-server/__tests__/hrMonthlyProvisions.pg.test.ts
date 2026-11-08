import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  accountsTable,
  companiesTable,
  db,
  employeeContractsTable,
  employeeLeavesTable,
  employeesTable,
  journalEntriesTable,
  journalEntryLinesTable,
  paymentVouchersTable,
  payrollLinesTable,
  payrollRunsTable,
  pool,
  productionCostAllocationsTable,
  productionOrdersTable,
  usersTable,
} from "@workspace/db";
import app from "../src/app.ts";
import { deleteCompanyWithRelations } from "../src/routes/admin.ts";
import { getCostSources } from "../src/routes/production.ts";

const tag = `tt_hr_prov_${randomBytes(8).toString("hex")}`;
let server: http.Server | undefined;
let baseUrl = "";
let companyId = 0;
let userId = 0;
let employeeId = 0;
let token = "";
let accountIds: Record<string, number> = {};

function periodForOffset(offset: number, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { year, month, period, start: `${period}-01`, end };
}

async function api(path: string, method: string, body?: Record<string, unknown>) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${baseUrl}${path}${separator}companyId=${companyId}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as any : {} };
}

function amountFor(lines: any[], accountId: number, column: "debit" | "credit") {
  return Number(lines.filter((line) => line.accountId === accountId)
    .reduce((sum, line) => sum + Number(line[column]), 0).toFixed(2));
}

function getPayrollSource(sources: any[], runId: number) {
  const source = sources.find((row) =>
    row.sourceType === "payroll" && Number(row.sourceRecordId) === runId,
  );
  assert.ok(source, `missing manufacturing payroll source for run ${runId}`);
  return source;
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server!.once("listening", resolve);
    server!.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HR provision test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [company] = await db.insert(companiesTable).values({
    nameAr: `${tag} شركة اختبار`,
    nameEn: `${tag} disposable tenant`,
    vatNumber: "300000000000003",
    crNumber: tag,
    city: "Riyadh",
    street: "Test Street",
    buildingNumber: "1",
    postalCode: "12345",
    country: "SA",
    invoiceType: "both",
    status: "active",
    isInternalDemoWorkspace: false,
    viewAllBranches: true,
    autoPostingEnabled: true,
    autoPostPayroll: true,
    menuPermissions: JSON.stringify({ hr: true, production: true }),
  }).returning({ id: companiesTable.id });
  companyId = company.id;

  token = randomBytes(24).toString("hex");
  const [user] = await db.insert(usersTable).values({
    username: `${tag}_admin`,
    passwordHash: "unused-test-token",
    role: "admin",
    isActive: true,
    viewAllBranches: true,
    sessionToken: token,
    sessionId: "test",
    companyId,
  }).returning({ id: usersTable.id });
  userId = user.id;

  const accounts = await db.insert(accountsTable).values([
    { companyId, code: `${tag}-salary`, nameAr: "مصروف الرواتب", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-eos-exp`, nameAr: "مصروف نهاية الخدمة", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-eos-liab`, nameAr: "مخصص نهاية الخدمة", accountType: "liability", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-leave-exp`, nameAr: "مصروف مخصص الإجازات", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-leave-liab`, nameAr: "مخصص الإجازات", accountType: "liability", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-ticket-exp`, nameAr: "مصروف تذاكر السفر", accountType: "expense", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-ticket-liab`, nameAr: "مخصص تذاكر السفر", accountType: "liability", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-salary-payable`, nameAr: "رواتب مستحقة", accountType: "liability", isActive: true, isPosting: true, level: 4 },
    { companyId, code: `${tag}-cash`, nameAr: "نقدية", accountType: "asset", isActive: true, isPosting: true, level: 4 },
  ]).returning();
  accountIds = Object.fromEntries(accounts.map((account) => [account.code.slice(tag.length + 1), account.id]));

  const [employee] = await db.insert(employeesTable).values({
    companyId,
    code: `${tag}-EMP`,
    nameAr: "موظف اختبار المخصصات",
    nameEn: "Provision Test Employee",
    nationality: "Egyptian",
    hireDate: "2020-01-01",
    status: "active",
    basicSalary: "3600.00",
    housingAllow: "0.00",
    transportAllow: "0.00",
    otherAllow: "0.00",
    annualTravelTicketAmount: "1200.00",
  }).returning({ id: employeesTable.id });
  employeeId = employee.id;

  await db.insert(employeeContractsTable).values({
    companyId,
    employeeId,
    contractNumber: `${tag}-CONTRACT`,
    startDate: "2020-01-01",
    basicSalary: "3600.00",
    housingAllow: "0.00",
    transportAllow: "0.00",
    otherAllow: "0.00",
    vacationDays: 30,
    status: "active",
  });
});

after(async () => {
  try {
    if (companyId) {
      await db.update(companiesTable).set({ deletedAt: new Date() }).where(and(
        eq(companiesTable.id, companyId),
        eq(companiesTable.nameEn, `${tag} disposable tenant`),
        eq(companiesTable.isInternalDemoWorkspace, false),
      ));
      await deleteCompanyWithRelations(companyId, true);
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await pool.end().catch(() => {});
  }
});

test("monthly provisions post, settle, reverse, and reconcile to manufacturing exactly once", {
  timeout: 120_000,
}, async () => {
  const preActivation = periodForOffset(-2);
  const prior = periodForOffset(-1);
  const current = periodForOffset(0);

  const initialSettings = await api("/api/hr/settings", "GET");
  assert.equal(initialSettings.status, 200, JSON.stringify(initialSettings.body));
  assert.equal(initialSettings.body.monthlyProvisionsEnabled, false);
  assert.equal(initialSettings.body.provisionSettlementsReady, true);

  const mapping = {
    salariesExpense: accountIds.salary,
    allowancesExpense: null,
    housingAllowanceExpense: null,
    transportAllowanceExpense: null,
    overtimeExpense: null,
    bonusExpense: null,
    gosiExpense: null,
    eosExpense: accountIds["eos-exp"],
    salariesPayable: accountIds["salary-payable"],
    gosiPayable: null,
    otherDeductions: null,
    employeeLoans: null,
    employeeCustody: null,
    eosProvision: accountIds["eos-liab"],
    leaveProvisionExpense: accountIds["leave-exp"],
    leaveProvisionLiability: accountIds["leave-liab"],
    travelTicketExpense: accountIds["ticket-exp"],
    travelTicketLiability: accountIds["ticket-liab"],
    defaultPayCashBoxId: null,
    defaultPayBankAccountId: null,
  };
  async function postPayroll(period: ReturnType<typeof periodForOffset>) {
    const created = await api("/api/employees/payroll/runs", "POST", {
      year: period.year,
      month: period.month,
      payDate: period.start,
      manufacturingEligible: true,
      approvedManufacturingHours: 240,
      lines: [{
        employeeId,
        basicSalary: 3600,
        housingAllow: 0,
        transportAllow: 0,
        otherAllow: 0,
        overtimeAmount: 0,
        bonusAmount: 0,
        grossSalary: 3600,
        gosiEmployee: 0,
        loanDeduction: 0,
        violationDeduction: 0,
        absenceDeduction: 0,
        otherDeduction: 0,
        totalDeductions: 0,
        netSalary: 3600,
        workedDays: 30,
        absentDays: 0,
      }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const runId = Number(created.body.id);
    assert.ok(runId > 0);
    const posted = await api(`/api/employees/payroll/runs/${runId}/post`, "POST");
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    return runId;
  }

  const mapped = await api("/api/hr/settings", "PUT", { mapping });
  assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
  const oldRunId = await postPayroll(preActivation);
  const [oldRun] = await db.select().from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.id, oldRunId), eq(payrollRunsTable.companyId, companyId)));
  const [oldLine] = await db.select().from(payrollLinesTable)
    .where(eq(payrollLinesTable.payrollRunId, oldRunId));
  assert.equal(oldRun.provisionSnapshotsCaptured, true);
  assert.equal(Number(oldLine.leaveProvisionAmount), 0);
  assert.equal(Number(oldLine.travelTicketProvisionAmount), 0);
  assert.equal(Number(oldLine.eosProvisionAmount), 0);

  const enabled = await api("/api/hr/settings", "PUT", { monthlyProvisionsEnabled: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const enabledSettings = await api("/api/hr/settings", "GET");
  assert.equal(enabledSettings.body.monthlyProvisionsEnabled, true);

  const accrualRunId = await postPayroll(prior);
  const [accrualRun] = await db.select().from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.id, accrualRunId), eq(payrollRunsTable.companyId, companyId)));
  assert.ok(accrualRun.postedJournalId);
  assert.equal(accrualRun.status, "posted");
  assert.equal(accrualRun.provisionSnapshotsCaptured, true);
  const [accrualLine] = await db.select().from(payrollLinesTable)
    .where(eq(payrollLinesTable.payrollRunId, accrualRunId));
  assert.equal(Number(accrualLine.leaveProvisionAmount), 300);
  assert.equal(Number(accrualLine.travelTicketProvisionAmount), 100);
  assert.ok(Number(accrualLine.eosProvisionAmount) > 0);

  const [accrualJournal] = await db.select().from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, accrualRun.postedJournalId!));
  assert.equal(accrualJournal.status, "posted");
  const accrualLines = await db.select().from(journalEntryLinesTable)
    .where(eq(journalEntryLinesTable.entryId, accrualJournal.id));
  const eosAmount = Number(accrualLine.eosProvisionAmount);
  assert.equal(amountFor(accrualLines, accountIds["leave-exp"], "debit"), 300);
  assert.equal(amountFor(accrualLines, accountIds["leave-liab"], "credit"), 300);
  assert.equal(amountFor(accrualLines, accountIds["ticket-exp"], "debit"), 100);
  assert.equal(amountFor(accrualLines, accountIds["ticket-liab"], "credit"), 100);
  assert.equal(amountFor(accrualLines, accountIds["eos-exp"], "debit"), eosAmount);
  assert.equal(amountFor(accrualLines, accountIds["eos-liab"], "credit"), eosAmount);
  assert.equal(
    accrualLines.reduce((sum, line) => sum + Number(line.debit), 0),
    accrualLines.reduce((sum, line) => sum + Number(line.credit), 0),
  );

  const priorBalances = await api("/api/employees/payroll/provision-balances", "GET");
  assert.equal(priorBalances.status, 200, JSON.stringify(priorBalances.body));
  const priorLeave = priorBalances.body.find((row: any) =>
    row.employeeId === employeeId && row.period === prior.period && row.provisionType === "annual_leave",
  );
  const priorTicket = priorBalances.body.find((row: any) =>
    row.employeeId === employeeId && row.period === prior.period && row.provisionType === "travel_ticket",
  );
  assert.equal(Number(priorLeave?.accrued), 300);
  assert.equal(Number(priorTicket?.accrued), 100);

  const beforeManufacturing = await getCostSources(db, companyId, prior.period);
  const priorPayrollSource = getPayrollSource(beforeManufacturing, accrualRunId);
  assert.equal(
    Number(priorPayrollSource.sourceAmount),
    3600 + 300 + 100 + eosAmount,
    "manufacturing consumes payroll cost plus each monthly provision once",
  );

  const settlementRunId = await postPayroll(current);
  const [leave] = await db.insert(employeeLeavesTable).values({
    companyId,
    employeeId,
    leaveType: "annual",
    startDate: current.start,
    endDate: current.start,
    days: 1,
    paid: true,
    status: "approved",
    approvedBy: String(userId),
    approvedAt: new Date(),
  }).returning({ id: employeeLeavesTable.id });

  const [ticketExpenseJournal] = await db.insert(journalEntriesTable).values({
    companyId,
    entryDate: current.start,
    currency: "SAR",
    exchangeRate: "1",
    description: `${tag} posted ticket expense`,
    entryType: "cash_expense",
    status: "posted",
  }).returning({ id: journalEntriesTable.id });
  await db.insert(journalEntryLinesTable).values([
    { entryId: ticketExpenseJournal.id, accountId: accountIds["ticket-exp"], debit: "150.00", credit: "0.00", description: "Ticket expense", sortOrder: 0 },
    { entryId: ticketExpenseJournal.id, accountId: accountIds.cash, debit: "0.00", credit: "150.00", description: "Cash", sortOrder: 1 },
  ]);
  const [ticketVoucher] = await db.insert(paymentVouchersTable).values({
    companyId,
    code: `${tag}-TICKET`,
    date: current.start,
    paymentType: "cash",
    entityType: "employee",
    entityId: null,
    accountId: accountIds["ticket-exp"],
    amount: "150.00",
    refType: "employee_travel_ticket",
    description: "Posted employee ticket expense",
    sourceType: "cash_expense",
    manufacturingEligible: true,
    manufacturingAllocationMethod: "labor_hours",
    approvedManufacturingHours: "240",
    status: "posted",
    journalEntryId: ticketExpenseJournal.id,
  }).returning({ id: paymentVouchersTable.id });

  const leavePayload = {
    employeeId,
    provisionType: "annual_leave",
    provisionPeriod: prior.period,
    sourceType: "employee_leave",
    sourceRecordId: leave.id,
    settlementDate: current.start,
    amount: 100,
  };
  const ticketPayload = {
    employeeId,
    provisionType: "travel_ticket",
    provisionPeriod: prior.period,
    sourceType: "payment_voucher",
    sourceRecordId: ticketVoucher.id,
    settlementDate: current.start,
    amount: 50,
  };
  const leaveSettlement = await api("/api/employees/payroll/provision-settlements", "POST", leavePayload);
  assert.equal(leaveSettlement.status, 201, JSON.stringify(leaveSettlement.body));
  const ticketSettlement = await api("/api/employees/payroll/provision-settlements", "POST", ticketPayload);
  assert.equal(ticketSettlement.status, 201, JSON.stringify(ticketSettlement.body));

  const currentSourcesAfterSettlement = await getCostSources(db, companyId, current.period);
  const currentPayrollSource = getPayrollSource(currentSourcesAfterSettlement, settlementRunId);
  assert.equal(Number(currentPayrollSource.sourceAmount), 3600 +
    Number((await db.select().from(payrollLinesTable)
      .where(eq(payrollLinesTable.payrollRunId, settlementRunId)))[0].leaveProvisionAmount) +
    Number((await db.select().from(payrollLinesTable)
      .where(eq(payrollLinesTable.payrollRunId, settlementRunId)))[0].travelTicketProvisionAmount) +
    Number((await db.select().from(payrollLinesTable)
      .where(eq(payrollLinesTable.payrollRunId, settlementRunId)))[0].eosProvisionAmount) - 100);
  const ticketSourceAfterSettlement = currentSourcesAfterSettlement.find((row: any) =>
    row.sourceType === "cash_expense" && Number(row.sourceRecordId) === ticketVoucher.id,
  );
  assert.equal(Number(ticketSourceAfterSettlement?.sourceAmount), 100);

  const settlementRows = await api("/api/employees/payroll/provision-settlements", "GET");
  assert.equal(settlementRows.status, 200, JSON.stringify(settlementRows.body));
  const leaveRecord = settlementRows.body.find((row: any) => row.id === leaveSettlement.body.id);
  const ticketRecord = settlementRows.body.find((row: any) => row.id === ticketSettlement.body.id);
  assert.ok(leaveRecord?.journalEntryId);
  assert.ok(ticketRecord?.journalEntryId);
  for (const record of [leaveRecord, ticketRecord]) {
    const lines = await db.select().from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.entryId, record.journalEntryId));
    assert.equal(lines.reduce((sum, line) => sum + Number(line.debit), 0),
      lines.reduce((sum, line) => sum + Number(line.credit), 0));
    assert.equal(lines.length, 2);
  }

  const settledBalances = await api("/api/employees/payroll/provision-balances", "GET");
  const settledLeave = settledBalances.body.find((row: any) =>
    row.employeeId === employeeId && row.period === prior.period && row.provisionType === "annual_leave",
  );
  const settledTicket = settledBalances.body.find((row: any) =>
    row.employeeId === employeeId && row.period === prior.period && row.provisionType === "travel_ticket",
  );
  assert.equal(Number(settledLeave?.settled), 100);
  assert.equal(Number(settledLeave?.balance), 200);
  assert.equal(Number(settledTicket?.settled), 50);
  assert.equal(Number(settledTicket?.balance), 50);

  const reversedLeave = await api(
    `/api/employees/payroll/provision-settlements/${leaveSettlement.body.id}/reverse`, "POST", {},
  );
  assert.equal(reversedLeave.status, 200, JSON.stringify(reversedLeave.body));
  const reversedTicket = await api(
    `/api/employees/payroll/provision-settlements/${ticketSettlement.body.id}/reverse`, "POST", {},
  );
  assert.equal(reversedTicket.status, 200, JSON.stringify(reversedTicket.body));
  const restoredSources = await getCostSources(db, companyId, current.period);
  assert.equal(Number(getPayrollSource(restoredSources, settlementRunId).sourceAmount),
    Number(currentPayrollSource.sourceAmount) + 100);
  const restoredTicketSource = restoredSources.find((row: any) =>
    row.sourceType === "cash_expense" && Number(row.sourceRecordId) === ticketVoucher.id,
  );
  assert.equal(Number(restoredTicketSource?.sourceAmount), 150);

  const restoredBalances = await api("/api/employees/payroll/provision-balances", "GET");
  const restoredLeave = restoredBalances.body.find((row: any) =>
    row.employeeId === employeeId && row.period === prior.period && row.provisionType === "annual_leave",
  );
  const restoredTicket = restoredBalances.body.find((row: any) =>
    row.employeeId === employeeId && row.period === prior.period && row.provisionType === "travel_ticket",
  );
  assert.equal(Number(restoredLeave?.settled), 0);
  assert.equal(Number(restoredLeave?.balance), 300);
  assert.equal(Number(restoredTicket?.settled), 0);
  assert.equal(Number(restoredTicket?.balance), 100);

  const [order] = await db.insert(productionOrdersTable).values({
    companyId,
    orderNumber: `${tag}-ORDER`,
    title: "Manufacturing source lock test",
    status: "in_production",
  }).returning({ id: productionOrdersTable.id });
  await db.insert(productionCostAllocationsTable).values([
    {
      companyId,
      orderId: order.id,
      sourceType: "payroll",
      sourceRecordId: settlementRunId,
      periodStart: current.start,
      periodEnd: current.end,
      basis: "test",
      sourceAmount: "3600.00",
      sharePct: "1.000000",
      allocatedAmount: "3600.00",
      createdBy: userId,
    },
    {
      companyId,
      orderId: order.id,
      sourceType: "cash_expense",
      sourceRecordId: ticketVoucher.id,
      periodStart: current.start,
      periodEnd: current.end,
      basis: "test",
      sourceAmount: "150.00",
      sharePct: "1.000000",
      allocatedAmount: "150.00",
      createdBy: userId,
    },
  ]);
  const blockedLeave = await api("/api/employees/payroll/provision-settlements", "POST", leavePayload);
  assert.equal(blockedLeave.status, 409, JSON.stringify(blockedLeave.body));
  const blockedTicket = await api("/api/employees/payroll/provision-settlements", "POST", ticketPayload);
  assert.equal(blockedTicket.status, 409, JSON.stringify(blockedTicket.body));
});
