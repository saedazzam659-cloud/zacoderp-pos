import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { accountsTable, journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
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
async function getAccountBalances(req: Request, cid: number, fromDate?: string, toDate?: string, branchId?: number) {
  // Get all accounts for company
  const accounts = await db.select().from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)))
    .orderBy(asc(accountsTable.code));

  // Build date filter for journal entries (per-user branch scope is enforced
  // through pushBranchScope so a restricted user can only ever aggregate
  // balances over the journal entries of their linked branches).
  const entryFilters: any[] = [eq(journalEntriesTable.companyId, cid)];
  if (pushBranchScope(req, entryFilters, journalEntriesTable.branchId, branchId) === "deny") {
    return [] as any[];
  }
  if (fromDate) entryFilters.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate)   entryFilters.push(lte(journalEntriesTable.entryDate, toDate));

  // Get all entry lines with their account IDs
  const lines = await db
    .select({
      accountId: journalEntryLinesTable.accountId,
      debit:     sql<string>`SUM(${journalEntryLinesTable.debit})`,
      credit:    sql<string>`SUM(${journalEntryLinesTable.credit})`,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
    .where(and(...entryFilters))
    .groupBy(journalEntryLinesTable.accountId);

  const balMap = new Map<number, { debit: number; credit: number }>();
  for (const l of lines) {
    if (l.accountId) {
      balMap.set(l.accountId, { debit: Number(l.debit || 0), credit: Number(l.credit || 0) });
    }
  }

  return accounts.map(a => ({
    ...a,
    totalDebit:  balMap.get(a.id)?.debit  ?? 0,
    totalCredit: balMap.get(a.id)?.credit ?? 0,
    balance:     (balMap.get(a.id)?.debit ?? 0) - (balMap.get(a.id)?.credit ?? 0),
  }));
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
        docNumber:   journalEntriesTable.docNumber,
        entryDate:   journalEntriesTable.entryDate,
        description: sql<string>`COALESCE(${journalEntryLinesTable.description}, ${journalEntriesTable.description}, '')`,
        debit:       journalEntryLinesTable.debit,
        credit:      journalEntryLinesTable.credit,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
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
