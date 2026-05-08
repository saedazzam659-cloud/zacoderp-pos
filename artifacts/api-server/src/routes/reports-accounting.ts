import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { accountsTable, journalEntriesTable, journalEntryLinesTable, salesInvoicesTable, purchaseInvoicesTable, trialBalancesTable, trialBalanceDetailsTable } from "@workspace/db";
import { eq, and, sql, gte, lte, asc, desc, ne } from "drizzle-orm";
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
async function getAccountBalances(req: Request, cid: number, fromDate?: string, toDate?: string, branchId?: number, openingFromTrialBalance = false) {
  // Get all accounts for company
  const accounts = await db.select().from(accountsTable)
    .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)))
    .orderBy(asc(accountsTable.code));

  // Per-user branch scope. If the caller has zero allowed branches
  // we short-circuit to an empty array (no rows to aggregate).
  // CRITICAL: only `posted` entries feed financial reports. Draft entries
  // are work-in-progress and must NOT affect trial balance, balance sheet,
  // income statement, or any account-level aggregation. Unposting an entry
  // (status: posted → draft) instantly removes its impact from all reports.
  const baseFilters: any[] = [
    eq(journalEntriesTable.companyId, cid),
    eq(journalEntriesTable.status, "posted"),
  ];
  if (pushBranchScope(req, baseFilters, journalEntriesTable.branchId, branchId) === "deny") {
    return [] as any[];
  }

  // Period filters: only entries inside [fromDate..toDate]
  const periodFilters = [...baseFilters];
  if (fromDate) periodFilters.push(gte(journalEntriesTable.entryDate, fromDate));
  if (toDate)   periodFilters.push(lte(journalEntriesTable.entryDate, toDate));
  // When opening is sourced from the imported trial balance / opening
  // JEs, exclude both `trial_balance_adjustment` AND `opening` JEs
  // from the period column to avoid double-counting (those entries
  // feed the Opening column, not the Period column).
  if (openingFromTrialBalance) {
    periodFilters.push(ne(journalEntriesTable.entryType, "trial_balance_adjustment"));
    periodFilters.push(ne(journalEntriesTable.entryType, "opening"));
  }

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

  // Opening balance:
  //  • If `openingFromTrialBalance` is true → pull from the latest
  //    imported trial balance (`trial_balance_details`). This matches
  //    the user-facing semantic where the Excel-imported opening
  //    balances populate the Opening column and only system-generated
  //    JEs flow into the Period column.
  //  • Otherwise (legacy callers like balance-sheet/income-statement)
  //    → opening = sum of every JE strictly before `fromDate`.
  let openingMap: Map<number, { debit: number; credit: number }>;
  if (openingFromTrialBalance) {
    openingMap = new Map();
    // Source 1: latest imported trial balance details (Excel-imported
    // opening balances).
    const [latestTb] = await db.select({ id: trialBalancesTable.id }).from(trialBalancesTable)
      .where(eq(trialBalancesTable.companyId, cid))
      .orderBy(desc(trialBalancesTable.periodEnd), desc(trialBalancesTable.createdAt))
      .limit(1);
    if (latestTb) {
      const tbRows = await db.select({
        accountId: trialBalanceDetailsTable.accountId,
        debit:     trialBalanceDetailsTable.debit,
        credit:    trialBalanceDetailsTable.credit,
      }).from(trialBalanceDetailsTable)
        .where(eq(trialBalanceDetailsTable.trialBalanceId, latestTb.id));
      for (const r of tbRows) {
        if (r.accountId) {
          const cur = openingMap.get(r.accountId) ?? { debit: 0, credit: 0 };
          openingMap.set(r.accountId, {
            debit:  cur.debit  + Number(r.debit  || 0),
            credit: cur.credit + Number(r.credit || 0),
          });
        }
      }
    }
    // Source 2: journal entries flagged as opening (entryType='opening').
    // These are opening-balance JEs entered directly through the JE
    // workflow (not via the TB Excel import). They feed the Opening
    // column and are excluded from the Period column above.
    const openingJeFilters = [...baseFilters, eq(journalEntriesTable.entryType, "opening")];
    const openingJeMap = await aggregate(openingJeFilters);
    for (const [accountId, v] of openingJeMap) {
      const cur = openingMap.get(accountId) ?? { debit: 0, credit: 0 };
      openingMap.set(accountId, {
        debit:  cur.debit  + v.debit,
        credit: cur.credit + v.credit,
      });
    }
  } else if (fromDate) {
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
    // For TB-imported opening, preserve the raw debit/credit values
    // exactly as imported (typically only one side is non-zero per
    // account). For legacy date-based opening, collapse to a single
    // signed side so each account shows only debit OR credit.
    const openingDebit  = openingFromTrialBalance ? op.debit  : (openingBalance > 0 ?  openingBalance : 0);
    const openingCredit = openingFromTrialBalance ? op.credit : (openingBalance < 0 ? -openingBalance : 0);
    return {
      ...a,
      // Period movements (kept under the original names for callers)
      totalDebit:  pe.debit,
      totalCredit: pe.credit,
      balance,
      openingDebit,
      openingCredit,
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
    const rows = await getAccountBalances(req, cid, fromDate, toDate, bid, true);
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
    if (!cid) { res.json({ previousBalance: 0, previousDebit: 0, previousCredit: 0, rows: [] }); return; }
    const bid = getBid(req);
    const { accountId, fromDate, toDate } = req.query as any;
    if (!accountId) { res.status(400).json({ error: "accountId مطلوب" }); return; }

    // ── Previous balance (رصيد ما قبل) ──────────────────────────────
    // SAP-style "brought-forward" balance: sum every JE line for this
    // account strictly BEFORE `fromDate` (no entry-type exclusions —
    // includes opening JEs, trial-balance adjustments, and every prior
    // movement). Initializes the running balance so the in-period
    // movements continue from the historical position.
    let previousDebit = 0;
    let previousCredit = 0;
    if (fromDate) {
      const prevFilters: any[] = [
        eq(journalEntriesTable.companyId, cid),
        eq(journalEntriesTable.status, "posted"),
      ];
      pushBranchScope(req, prevFilters, journalEntriesTable.branchId, bid);
      prevFilters.push(sql`${journalEntriesTable.entryDate} < ${fromDate}`);
      const [prev] = await db
        .select({
          debit:  sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}), 0)`,
          credit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.credit}), 0)`,
        })
        .from(journalEntryLinesTable)
        .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
        .where(and(eq(journalEntryLinesTable.accountId, Number(accountId)), ...prevFilters));
      previousDebit  = Number(prev?.debit  || 0);
      previousCredit = Number(prev?.credit || 0);
    }
    const previousBalance = previousDebit - previousCredit;

    const entryFilters: any[] = [
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.status, "posted"),
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

    // Running balance starts from the historical previous balance
    // (SAP-style brought-forward) so the in-period movements continue
    // from the correct opening position rather than from zero.
    let runningBalance = previousBalance;
    const withBalance = rows.map(r => {
      const d = Number(r.debit  || 0);
      const c = Number(r.credit || 0);
      runningBalance += d - c;
      return { ...r, debit: d, credit: c, balance: runningBalance };
    });

    res.json({ previousBalance, previousDebit, previousCredit, rows: withBalance });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
