import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { accountsTable, journalEntriesTable, journalEntryLinesTable, salesInvoicesTable, purchaseInvoicesTable } from "@workspace/db";
import { eq, and, sql, gte, lte, asc } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);
// Hard auth gate — extractAuth alone is non-blocking, so anonymous callers
// could previously read tenant accounting reports by passing ?companyId=. Now
// every endpoint requires a valid Bearer token.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

function getBid(req: any): number | undefined {
  const v = req.query.branchId;
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ─── helper: get account balances (aggregated from lines) ─────────────────────
// Returns one row per active account with:
//   • totalDebit / totalCredit / balance — movement totals inside the
//     [fromDate..toDate] window (period movements). `balance` is the
//     signed (debit − credit) movement balance for the period and is
//     kept for backward compatibility with the balance sheet, income
//     statement and chart-of-accounts callers.
//   • openingDebit / openingCredit / openingBalance — sum of every
//     line on entries STRICTLY BEFORE `fromDate`. When `fromDate` is
//     omitted, opening is treated as zero (the report is "since
//     inception"). `openingBalance = openingDebit − openingCredit`.
//   • closingDebit / closingCredit / closingBalance — opening +
//     period movements. Useful for the trial-balance UI which needs
//     the three sections side-by-side.
async function getAccountBalances(req: Request, cid: number, fromDate?: string, toDate?: string, branchId?: number) {
  // Get all accounts for company
  const accounts = await db.select().from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)))
    .orderBy(asc(accountsTable.code));

  // Per-user branch scope. If the caller has zero allowed branches
  // we short-circuit to an empty array (no rows to aggregate).
  const baseFilters: any[] = [eq(journalEntriesTable.companyId, cid)];
  if (pushBranchScope(req, baseFilters, journalEntriesTable.branchId, branchId) === "deny") {
    return [] as any[];
  }

  // Period filters: only entries inside [fromDate..toDate]
  const periodFilters = [...baseFilters];
  if (fromDate) periodFilters.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate)   periodFilters.push(lte(journalEntriesTable.entryDate, toDate));

  // Helper to sum debit/credit per account under a set of filters.
  async function aggregate(filters: any[]) {
    const rows = await db
      .select({
        accountId: journalEntryLinesTable.accountId,
        debit:     sql<string>`SUM(${journalEntryLinesTable.debit})`,
        credit:    sql<string>`SUM(${journalEntryLinesTable.credit})`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(...filters))
      .groupBy(journalEntryLinesTable.accountId);
    const map = new Map<number, { debit: number; credit: number }>();
    for (const l of rows) {
      if (l.accountId) {
        map.set(l.accountId, { debit: Number(l.debit || 0), credit: Number(l.credit || 0) });
      }
    }
    return map;
  }

  const periodMap = await aggregate(periodFilters);

  // Opening balance is "everything strictly before fromDate". When no
  // fromDate is supplied the trial balance is "since inception" and
  // opening collapses to zero — we skip the extra query entirely.
  let openingMap: Map<number, { debit: number; credit: number }>;
  if (fromDate) {
    const openingFilters = [...baseFilters, sql`${journalEntriesTable.entryDate} < ${fromDate}`];
    openingMap = await aggregate(openingFilters);
  } else {
    openingMap = new Map();
  }

  return accounts.map(a => {
    const op = openingMap.get(a.id) ?? { debit: 0, credit: 0 };
    const pe = periodMap.get(a.id)  ?? { debit: 0, credit: 0 };
    const openingBalance = op.debit - op.credit;
    const balance        = pe.debit - pe.credit; // period movement balance
    const closingBalance = openingBalance + balance;
    return {
      ...a,
      // Period movements (kept under the original names for callers)
      totalDebit:  pe.debit,
      totalCredit: pe.credit,
      balance,
      // Opening (before fromDate). One side is zero by convention.
      openingDebit:   openingBalance > 0 ?  openingBalance : 0,
      openingCredit:  openingBalance < 0 ? -openingBalance : 0,
      openingBalance,
      // Closing = opening + period (signed)
      closingDebit:   closingBalance > 0 ?  closingBalance : 0,
      closingCredit:  closingBalance < 0 ? -closingBalance : 0,
      closingBalance,
    };
  });
}

// ─── TRIAL BALANCE ─────────────────────────────────────────────────────────────
router.get("/trial-balance", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { fromDate, toDate } = req.query as any;
    const rows = await getAccountBalances(req, cid, fromDate, toDate, bid);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── BALANCE SHEET ─────────────────────────────────────────────────────────────
router.get("/balance-sheet", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({}); return; }
    const bid = getBid(req);
    const { asOfDate } = req.query as any;
    const rows = await getAccountBalances(req, cid, undefined, asOfDate, bid);

    const assets      = rows.filter(r => r.accountType === "asset");
    const liabilities = rows.filter(r => r.accountType === "liability");
    const equity      = rows.filter(r => r.accountType === "equity");

    const totalAssets      = assets.reduce((s, r) => s + r.balance, 0);
    const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0);
    const totalEquity      = equity.reduce((s, r) => s + r.balance, 0);

    res.json({
      asOfDate: asOfDate ?? new Date().toISOString().slice(0, 10),
      assets, liabilities, equity,
      totalAssets, totalLiabilities, totalEquity,
      totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── INCOME STATEMENT ─────────────────────────────────────────────────────────
router.get("/income-statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({}); return; }
    const bid = getBid(req);
    const { fromDate, toDate } = req.query as any;
    const rows = await getAccountBalances(req, cid, fromDate, toDate, bid);

    const revenues  = rows.filter(r => r.accountType === "revenue");
    const expenses  = rows.filter(r => r.accountType === "expense");

    // Revenue: credit increases revenue (credit > debit = positive revenue)
    const totalRevenue  = revenues.reduce((s, r) => s + (r.totalCredit - r.totalDebit), 0);
    const totalExpenses = expenses.reduce((s, r) => s + (r.totalDebit - r.totalCredit), 0);
    const netIncome     = totalRevenue - totalExpenses;

    res.json({
      fromDate: fromDate ?? "",
      toDate:   toDate   ?? new Date().toISOString().slice(0, 10),
      revenues, expenses,
      totalRevenue, totalExpenses, netIncome,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ACCOUNT STATEMENT (Ledger) ───────────────────────────────────────────────
router.get("/account-statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const bid = getBid(req);
    const { accountId, fromDate, toDate } = req.query as any;
    if (!accountId) { res.status(400).json({ error: "accountId مطلوب" }); return; }

    const entryFilters: any[] = [
      eq(journalEntriesTable.companyId, cid),
    ];
    pushBranchScope(req, entryFilters, journalEntriesTable.branchId, bid);
    if (fromDate) entryFilters.push(gte(journalEntriesTable.entryDate, fromDate));
    if (toDate)   entryFilters.push(lte(journalEntriesTable.entryDate, toDate));

    const rows = await db
      .select({
        lineId:      journalEntryLinesTable.id,
        entryId:     journalEntriesTable.id,
        entryType:   journalEntriesTable.entryType,
        docNumber:   journalEntriesTable.docNumber,
        entryDate:   journalEntriesTable.entryDate,
        description: sql<string>`COALESCE(${journalEntryLinesTable.description}, ${journalEntriesTable.description}, '')`,
        debit:       journalEntryLinesTable.debit,
        credit:      journalEntryLinesTable.credit,
        // sourceId = pk of the source document, if any. Resolved per entryType
        // by left-joining against the table that owns this journal entry.
        // Sales/purchase invoices keep `journal_entry_id` on the row, so we
        // map them straight back. Other entry types (returns, vouchers,
        // payroll, general, …) fall back to the JE itself on the frontend.
        salesInvoiceId:    salesInvoicesTable.id,
        purchaseInvoiceId: purchaseInvoicesTable.id,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .leftJoin(
        salesInvoicesTable,
        and(
          eq(salesInvoicesTable.journalEntryId, journalEntriesTable.id),
          eq(salesInvoicesTable.companyId, cid),
        ),
      )
      .leftJoin(
        purchaseInvoicesTable,
        and(
          eq(purchaseInvoicesTable.journalEntryId, journalEntriesTable.id),
          eq(purchaseInvoicesTable.companyId, cid),
        ),
      )
      .where(and(
        eq(journalEntryLinesTable.accountId, Number(accountId)),
        ...entryFilters,
      ))
      .orderBy(asc(journalEntriesTable.entryDate));

    // Add running balance
    let runningBalance = 0;
    const withBalance = rows.map(r => {
      const d = Number(r.debit  || 0);
      const c = Number(r.credit || 0);
      runningBalance += d - c;
      return { ...r, debit: d, credit: c, balance: runningBalance };
    });

    res.json(withBalance);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
