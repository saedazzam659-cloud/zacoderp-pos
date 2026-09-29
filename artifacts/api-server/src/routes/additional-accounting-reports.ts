import { Router, type Request, type Response } from "express";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  accountsTable,
  auditLogTable,
  costCentersTable,
  db,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";
import { extractAuth, getAllowedBranchIds, pushBranchScope, resolveCompanyId } from "../middleware/auth.js";
import { requireAdditionalAccountingReport } from "../middleware/permissions.js";

const router = Router();
const REPORT_IDS = [
  "general_ledger", "trial_balance_balances", "expense_analysis",
  "revenue_analysis", "cost_center_report", "comparative_profit_loss",
  "changes_in_equity", "journal_audit",
] as const;
type ReportId = typeof REPORT_IDS[number];

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryNumber(value: unknown): number | undefined {
  const n = Number(queryString(value));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function getCompany(req: Request): number | undefined {
  const requested = queryNumber((req.query as any).companyId);
  return resolveCompanyId(req, requested);
}

function getBranch(req: Request): number | undefined {
  return queryNumber((req.query as any).branchId);
}

function dates(req: Request) {
  const q = req.query as any;
  return {
    fromDate: queryString(q.fromDate),
    toDate: queryString(q.toDate),
    comparisonFromDate: queryString(q.comparisonFromDate),
    comparisonToDate: queryString(q.comparisonToDate),
  };
}

async function costCenterTokens(companyId: number, raw: unknown): Promise<string[]> {
  const values = queryString(raw)?.split(",").map(Number)
    .filter(n => Number.isInteger(n) && n > 0) ?? [];
  if (!values.length) return [];
  const rows = await db.select({ id: costCentersTable.id, code: costCentersTable.code })
    .from(costCentersTable)
    .where(and(eq(costCentersTable.companyId, companyId), inArray(costCentersTable.id, values)));
  return [...new Set(values.flatMap(id => [String(id), ...rows.filter(r => r.id === id).map(r => r.code)]))];
}

async function financialContext(req: Request, companyId: number, includeDate = true) {
  const q = req.query as any;
  const filters: any[] = [
    eq(journalEntriesTable.companyId, companyId),
    eq(journalEntriesTable.status, "posted"),
  ];
  if (pushBranchScope(req, filters, journalEntriesTable.branchId, getBranch(req)) === "deny") {
    return { filters: null, lineFilters: null, costTokens: [] as string[] };
  }
  const d = dates(req);
  if (includeDate && d.fromDate) filters.push(gte(journalEntriesTable.entryDate, d.fromDate));
  if (includeDate && d.toDate) filters.push(lte(journalEntriesTable.entryDate, d.toDate));
  const costTokens = await costCenterTokens(companyId, q.costCenterId);
  const lineFilters = [...filters];
  if (costTokens.length === 1) lineFilters.push(eq(journalEntryLinesTable.costCenter, costTokens[0]));
  if (costTokens.length > 1) lineFilters.push(inArray(journalEntryLinesTable.costCenter, costTokens));
  const accountId = queryNumber(q.accountId);
  if (accountId) lineFilters.push(eq(journalEntryLinesTable.accountId, accountId));
  return { filters, lineFilters, costTokens };
}

async function sumsByAccount(lineFilters: any[] | null, opening: boolean, companyId: number, req: Request) {
  if (!lineFilters) return new Map<number, { debit: number; credit: number }>();
  const filters = [...lineFilters];
  if (opening) {
    const from = dates(req).fromDate;
    if (!from) return new Map();
    filters.push(sql`${journalEntriesTable.entryDate} < ${from}`);
  }
  const rows = await db.select({
    accountId: journalEntryLinesTable.accountId,
    debit: sql<string>`SUM(${journalEntryLinesTable.debit})`,
    credit: sql<string>`SUM(${journalEntryLinesTable.credit})`,
  }).from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
    .where(and(...filters, eq(journalEntriesTable.companyId, companyId)))
    .groupBy(journalEntryLinesTable.accountId);
  return new Map(rows.filter(r => r.accountId != null).map(r => [
    r.accountId as number,
    { debit: Number(r.debit || 0), credit: Number(r.credit || 0) },
  ]));
}

async function accountRows(companyId: number, req: Request, mode?: "expense" | "revenue" | "equity") {
  const ctx = await financialContext(req, companyId);
  const accounts = await db.select().from(accountsTable)
    .where(eq(accountsTable.companyId, companyId)).orderBy(asc(accountsTable.code));
  const filtered = mode ? accounts.filter(a => a.accountType === mode) : accounts;
  const period = await sumsByAccount(ctx.lineFilters, false, companyId, req);
  // Build opening predicates without the period date window; sumsByAccount
  // then applies the strict pre-fromDate boundary.
  const openingReq = {
    ...req,
    query: { ...req.query, fromDate: undefined, toDate: undefined },
  } as unknown as Request;
  const openingCtx = await financialContext(openingReq, companyId);
  const opening = await sumsByAccount(openingCtx.lineFilters, true, companyId, req);
  const includeZero = String((req.query as any).includeZero).toLowerCase() === "true";
  return filtered.map(a => {
    const p = period.get(a.id) ?? { debit: 0, credit: 0 };
    const o = opening.get(a.id) ?? { debit: 0, credit: 0 };
    const periodBalance = p.debit - p.credit;
    const openingBalance = o.debit - o.credit;
    return {
      accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn,
      accountType: a.accountType, openingDebit: o.debit, openingCredit: o.credit,
      openingBalance, periodDebit: p.debit, periodCredit: p.credit,
      periodBalance, closingBalance: openingBalance + periodBalance,
      ...(includeZero || Math.abs(openingBalance) + Math.abs(periodBalance) > 0 ? {} : { __hidden: true }),
    };
  }).filter(row => !("__hidden" in row));
}

async function reportData(reportId: ReportId, req: Request, companyId: number): Promise<{ rows: any[]; limitations?: string[] }> {
  if (reportId === "general_ledger") {
    const ctx = await financialContext(req, companyId);
    if (!ctx.lineFilters) return { rows: [] };
    const rows = await db.select({
      lineId: journalEntryLinesTable.id, entryId: journalEntriesTable.id,
      entryDate: journalEntriesTable.entryDate, docNumber: journalEntriesTable.docNumber,
      entryType: journalEntriesTable.entryType, accountId: journalEntryLinesTable.accountId,
      accountCode: accountsTable.code, accountNameAr: accountsTable.nameAr,
      costCenter: journalEntryLinesTable.costCenter, debit: journalEntryLinesTable.debit,
      credit: journalEntryLinesTable.credit,
      description: sql<string>`COALESCE(${journalEntryLinesTable.description}, ${journalEntriesTable.description}, '')`,
    }).from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .innerJoin(accountsTable, eq(journalEntryLinesTable.accountId, accountsTable.id))
      .where(and(...ctx.lineFilters, eq(accountsTable.companyId, companyId)))
      .orderBy(asc(journalEntriesTable.entryDate), asc(journalEntriesTable.id), asc(journalEntryLinesTable.id));
    return { rows };
  }
  if (reportId === "trial_balance_balances") return { rows: await accountRows(companyId, req) };
  if (reportId === "expense_analysis") return { rows: await accountRows(companyId, req, "expense") };
  if (reportId === "revenue_analysis") return { rows: await accountRows(companyId, req, "revenue") };
  if (reportId === "changes_in_equity") return { rows: await accountRows(companyId, req, "equity") };
  if (reportId === "cost_center_report") {
    const ctx = await financialContext(req, companyId);
    if (!ctx.filters) return { rows: [] };
    const rows = await db.select({
      costCenter: journalEntryLinesTable.costCenter,
      debit: sql<string>`SUM(${journalEntryLinesTable.debit})`,
      credit: sql<string>`SUM(${journalEntryLinesTable.credit})`,
    }).from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(...ctx.lineFilters!, queryNumber((req.query as any).accountId)
        ? eq(journalEntryLinesTable.accountId, queryNumber((req.query as any).accountId)!)
        : sql`TRUE`))
      .groupBy(journalEntryLinesTable.costCenter)
      .orderBy(asc(journalEntryLinesTable.costCenter));
    return { rows: rows.map(r => ({ ...r, debit: Number(r.debit || 0), credit: Number(r.credit || 0), balance: Number(r.debit || 0) - Number(r.credit || 0) })) };
  }
  if (reportId === "comparative_profit_loss") {
    const current = await accountRows(companyId, req);
    const d = dates(req);
    const comparisonReq = { ...req, query: { ...req.query, fromDate: d.comparisonFromDate, toDate: d.comparisonToDate } } as unknown as Request;
    const comparison = await accountRows(companyId, comparisonReq);
    const byId = new Map(comparison.map(r => [r.accountId, r]));
    return { rows: current.filter(r => r.accountType === "revenue" || r.accountType === "expense").map(r => {
      const c = byId.get(r.accountId);
      return { ...r, comparisonPeriodDebit: c?.periodDebit ?? 0, comparisonPeriodCredit: c?.periodCredit ?? 0, variance: r.periodBalance - (c?.periodBalance ?? 0) };
    }) };
  }
  const q = req.query as any;
  // audit_log has no branch_id. Never return company-wide journal audit data
  // to a user whose authorization is restricted to selected branches.
  if (getBranch(req) || getAllowedBranchIds(req) !== null) {
    return { rows: [], limitations: ["لا يحتوي audit_log على branch_id؛ لم تُعرض بيانات لتجنب تجاوز نطاق الفروع المصرح به."] };
  }
  const filters: any[] = [eq(auditLogTable.companyId, companyId), eq(auditLogTable.module, "journal_entries")];
  if (q.fromDate) filters.push(gte(auditLogTable.createdAt, new Date(`${q.fromDate}T00:00:00.000Z`)));
  if (q.toDate) filters.push(lte(auditLogTable.createdAt, new Date(`${q.toDate}T23:59:59.999Z`)));
  const rows = await db.select({
    id: auditLogTable.id, userId: auditLogTable.userId, username: auditLogTable.username,
    action: auditLogTable.action, method: auditLogTable.method, path: auditLogTable.path,
    entityType: auditLogTable.entityType, entityId: auditLogTable.entityId,
    statusCode: auditLogTable.statusCode, metadata: auditLogTable.metadata,
    createdAt: auditLogTable.createdAt,
  }).from(auditLogTable).where(and(...filters)).orderBy(asc(auditLogTable.createdAt));
  return { rows, limitations: ["سجل التدقيق يعرض البيانات الفعلية المتاحة في audit_log؛ لا توجد لقطات before/after لكل حقل."] };
}

router.use(extractAuth);
router.get("/:reportId", (req, res, next) => {
  const id = String(req.params.reportId);
  if (!(REPORT_IDS as readonly string[]).includes(id)) {
    res.status(404).json({ error: "التقرير غير موجود" }); return;
  }
  return requireAdditionalAccountingReport(id)(req, res, next);
}, async (req, res): Promise<void> => {
  const reportId = String(req.params.reportId) as ReportId;
  const companyId = getCompany(req);
  if (!companyId) { res.status(400).json({ error: "companyId غير صالح" }); return; }
  try {
    const result = await reportData(reportId, req, companyId);
    res.json({ reportId, ...result });
  } catch (error: any) {
    req.log?.error?.({ err: error }, "additional accounting report failed");
    res.status(500).json({ error: "تعذر تحميل التقرير" });
  }
});

export default router;