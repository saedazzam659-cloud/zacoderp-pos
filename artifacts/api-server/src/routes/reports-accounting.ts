import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  accountsTable, journalEntriesTable, journalEntryLinesTable,
  salesInvoicesTable, salesReturnsTable,
  purchaseInvoicesTable, purchaseReturnsTable,
  receiptVouchersTable, paymentVouchersTable,
  goodsReceiptsTable, goodsDeliveriesTable,
  contractingProgressBillsTable,
  fixedAssetsTable, faDepreciationRunsTable, faDisposalsTable,
  payrollRunsTable,
  costCentersTable,
  trialBalancesTable, trialBalanceDetailsTable,
  salesOrdersTable, salesQuotationsTable,
  purchaseOrdersTable,
  maintenanceOrdersTable,
} from "@workspace/db";
import { eq, and, sql, gte, lte, asc, desc, ne, inArray } from "drizzle-orm";
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
// Parse a `costCenterId` query value that may be:
//   • a single id ("3"), • a CSV of ids ("3,7,12"), • "all" / "" / undefined
// → empty list. Returns the list of cost-center ids as STRINGS so they can
// be matched against the text `journal_entry_lines.cost_center` column.
// An empty array means "no cost-center scope".
export function parseCostCenterIds(raw: any): string[] {
  if (raw === undefined || raw === null || raw === "" || raw === "all") return [];
  const parts = String(raw).split(",").map(s => s.trim()).filter(Boolean);
  const ids = parts.map(p => Number(p)).filter(n => Number.isFinite(n) && n > 0);
  return ids.map(n => String(n));
}

// Resolve the picked cost-center IDs into the **set of tokens** to match
// against the text `journal_entry_lines.cost_center` column. Different
// modules historically wrote different things into that column:
//   • the JE form (and most modern flows) writes the cost-center CODE
//     (e.g. "CC-0002") because the dropdown uses `code` as its value;
//   • some legacy paths write the numeric ID as a string ("3");
//   • a few imports may write the Arabic/English name.
// To keep the filter robust for all of those, we look the picked ids up
// in `cost_centers`, then return [...idStrings, ...codes]. The line-level
// filter then becomes `inArray(cost_center, tokens)` which matches every
// representation in use today. Empty input → empty token list (caller
// treats that as "no cost-center scope").
async function resolveCostCenterTokens(cid: number, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const numericIds = ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (!numericIds.length) return [];
  const rows = await db.select({ id: costCentersTable.id, code: costCentersTable.code })
    .from(costCentersTable)
    .where(and(eq(costCentersTable.companyId, cid), inArray(costCentersTable.id, numericIds)));
  const tokens = new Set<string>();
  for (const n of numericIds) tokens.add(String(n));
  for (const r of rows) if (r.code) tokens.add(r.code);
  return Array.from(tokens);
}

async function getAccountBalances(req: Request, cid: number, fromDate?: string, toDate?: string, branchId?: number, openingFromTrialBalance = false, costCenterIds: string[] = []) {
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
  // Cost-center filter (when supplied) is applied at the LINE level — the
  // `cost_center` column lives on `journal_entry_lines`, stored as text
  // (we stringify the numeric id), so an exact-string match is correct.
  async function aggregate(filters: any[]) {
    const lineFilters: any[] = [...filters];
    if (costCenterIds.length === 1) {
      lineFilters.push(eq(journalEntryLinesTable.costCenter, costCenterIds[0]));
    } else if (costCenterIds.length > 1) {
      lineFilters.push(inArray(journalEntryLinesTable.costCenter, costCenterIds));
    }
    const rows = await db
      .select({
        accountId: journalEntryLinesTable.accountId,
        debit:     sql<string>`SUM(${journalEntryLinesTable.debit})`,
        credit:    sql<string>`SUM(${journalEntryLinesTable.credit})`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(...lineFilters))
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

// ─── OPENING BALANCES SNAPSHOT ────────────────────────────────────────────────
// Purpose-built for the Opening Balances screen's "Export Current" button.
// Aggregates ALL journal-entry lines (POSTED *and* DRAFT) for entries dated
// on or before `asOfDate`, scoped to the company. Unlike trial-balance this
// intentionally:
//   • Includes DRAFT entries — the user is exporting their own opening JE
//     to inspect/edit it, and that JE may still be in draft status.
//   • Does NOT apply branch scoping — opening JEs are inherently
//     company-wide and many legacy ones were saved with branch_id=NULL,
//     which a strict equality filter would exclude.
// Returns one row per active account with a single signed `balance`
// (debit − credit) so the client can place it on the right side of the sheet.
router.get("/opening-balances-snapshot", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const { asOfDate } = req.query as any;
    const accounts = await db.select({
      id: accountsTable.id,
    }).from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));

    const filters: any[] = [eq(journalEntriesTable.companyId, cid)];
    if (asOfDate) filters.push(lte(journalEntriesTable.entryDate, asOfDate));

    const rows = await db.select({
      accountId: journalEntryLinesTable.accountId,
      debit:     sql<string>`SUM(${journalEntryLinesTable.debit})`,
      credit:    sql<string>`SUM(${journalEntryLinesTable.credit})`,
    })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(...filters))
      .groupBy(journalEntryLinesTable.accountId);

    const map = new Map<number, { debit: number; credit: number }>();
    for (const r of rows) {
      if (r.accountId) {
        map.set(r.accountId, { debit: Number(r.debit || 0), credit: Number(r.credit || 0) });
      }
    }
    res.json(accounts.map(a => {
      const v = map.get(a.id) ?? { debit: 0, credit: 0 };
      return { accountId: a.id, debit: v.debit, credit: v.credit, balance: v.debit - v.credit };
    }));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

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
    const { fromDate, toDate, costCenterId } = req.query as any;
    const ccIds = parseCostCenterIds(costCenterId);
    const ccTokens = await resolveCostCenterTokens(cid, ccIds);
    const rows = await getAccountBalances(req, cid, fromDate, toDate, bid, false, ccTokens);

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
    const { accountId, fromDate, toDate, costCenterId } = req.query as any;
    if (!accountId) { res.status(400).json({ error: "accountId مطلوب" }); return; }
    // Optional cost-center scope. The column lives on
    // `journal_entry_lines` and is stored as text (we stringify the
    // numeric id when posting), so an exact-string match is correct.
    // Multi-value support: `costCenterId` may be a CSV ("3,7,12") or
    // a single id; both reduce to the same `inArray` line filter below.
    const ccIds = parseCostCenterIds(costCenterId);
    const ccTokens = await resolveCostCenterTokens(cid, ccIds);
    const ccLineFilter = ccTokens.length === 1
      ? [eq(journalEntryLinesTable.costCenter, ccTokens[0])]
      : ccTokens.length > 1
      ? [inArray(journalEntryLinesTable.costCenter, ccTokens)]
      : [];

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
      prevFilters.push(...ccLineFilter);
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
        // Each module (sales, purchasing, cash, contracting, FA, payroll,
        // inventory) keeps a back-reference to its posted JE on the source
        // row, so we just LEFT JOIN those tables and expose the IDs. The
        // frontend (`sourceLinkFor()`) maps each entryType+id pair to the
        // matching detail or list page; entry types we don't recognise
        // (general, manual, opening, closing, …) safely fall back to the
        // JE detail page.
        salesInvoiceId:           salesInvoicesTable.id,
        salesReturnId:            salesReturnsTable.id,
        purchaseInvoiceId:        purchaseInvoicesTable.id,
        purchaseReturnId:         purchaseReturnsTable.id,
        receiptVoucherId:         receiptVouchersTable.id,
        paymentVoucherId:         paymentVouchersTable.id,
        goodsReceiptId:           goodsReceiptsTable.id,
        goodsDeliveryId:          goodsDeliveriesTable.id,
        contractingProgressBillId:contractingProgressBillsTable.id,
        fixedAssetId:             fixedAssetsTable.id,
        faDepreciationRunId:      faDepreciationRunsTable.id,
        faDisposalId:             faDisposalsTable.id,
        payrollRunId:             payrollRunsTable.id,
        // Per-line cost center. The line stores the id as text (we
        // stringify on post), so we LEFT JOIN cost_centers via a CAST
        // to surface the human-readable code + name. Rows with no
        // cost-center tag come back with all three fields null.
        costCenterRaw:    journalEntryLinesTable.costCenter,
        costCenterId:     costCentersTable.id,
        costCenterCode:   costCentersTable.code,
        costCenterNameAr: costCentersTable.nameAr,
        costCenterNameEn: costCentersTable.nameEn,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .leftJoin(costCentersTable, and(
        eq(costCentersTable.companyId, cid),
        sql`${costCentersTable.id}::text = ${journalEntryLinesTable.costCenter}`,
      ))
      .leftJoin(salesInvoicesTable, and(
        eq(salesInvoicesTable.journalEntryId, journalEntriesTable.id),
        eq(salesInvoicesTable.companyId, cid),
      ))
      .leftJoin(salesReturnsTable, and(
        eq(salesReturnsTable.journalEntryId, journalEntriesTable.id),
        eq(salesReturnsTable.companyId, cid),
      ))
      .leftJoin(purchaseInvoicesTable, and(
        eq(purchaseInvoicesTable.journalEntryId, journalEntriesTable.id),
        eq(purchaseInvoicesTable.companyId, cid),
      ))
      .leftJoin(purchaseReturnsTable, and(
        eq(purchaseReturnsTable.journalEntryId, journalEntriesTable.id),
        eq(purchaseReturnsTable.companyId, cid),
      ))
      .leftJoin(receiptVouchersTable, and(
        eq(receiptVouchersTable.journalEntryId, journalEntriesTable.id),
        eq(receiptVouchersTable.companyId, cid),
      ))
      .leftJoin(paymentVouchersTable, and(
        eq(paymentVouchersTable.journalEntryId, journalEntriesTable.id),
        eq(paymentVouchersTable.companyId, cid),
      ))
      .leftJoin(goodsReceiptsTable, and(
        eq(goodsReceiptsTable.journalEntryId, journalEntriesTable.id),
        eq(goodsReceiptsTable.companyId, cid),
      ))
      .leftJoin(goodsDeliveriesTable, and(
        eq(goodsDeliveriesTable.journalEntryId, journalEntriesTable.id),
        eq(goodsDeliveriesTable.companyId, cid),
      ))
      .leftJoin(contractingProgressBillsTable, and(
        eq(contractingProgressBillsTable.journalEntryId, journalEntriesTable.id),
        eq(contractingProgressBillsTable.companyId, cid),
      ))
      .leftJoin(fixedAssetsTable, and(
        eq(fixedAssetsTable.journalEntryId, journalEntriesTable.id),
        eq(fixedAssetsTable.companyId, cid),
      ))
      .leftJoin(faDepreciationRunsTable, and(
        eq(faDepreciationRunsTable.journalEntryId, journalEntriesTable.id),
        eq(faDepreciationRunsTable.companyId, cid),
      ))
      .leftJoin(faDisposalsTable, and(
        eq(faDisposalsTable.journalEntryId, journalEntriesTable.id),
        eq(faDisposalsTable.companyId, cid),
      ))
      .leftJoin(payrollRunsTable, and(
        eq(payrollRunsTable.postedJournalId, journalEntriesTable.id),
        eq(payrollRunsTable.companyId, cid),
      ))
      .where(and(
        eq(journalEntryLinesTable.accountId, Number(accountId)),
        ...entryFilters,
        ...ccLineFilter,
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

// ─── AI FORECAST INCOME STATEMENT ─────────────────────────────────────────────
// Builds a multi-year predictive Income Statement using the company's last 3
// years of posted actuals + open commitments (sales orders/quotations,
// purchase orders, maintenance orders). Calls OpenAI to produce three
// scenarios (optimistic / realistic / conservative) plus AI insights.
//
// Heuristic fallback is used whenever the AI service is not configured or
// the AI call fails — the report is always returned, never a 5xx.
router.post("/forecast-income-statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
    const bid = getBid(req);
    const horizon = Math.max(1, Math.min(10, Number((req.body as any)?.horizonYears) || 3));

    // ── 1. Pull last 3 calendar years of posted actuals (annual P&L) ──
    const today = new Date();
    const currentYear = today.getFullYear();
    const histYears = [currentYear - 3, currentYear - 2, currentYear - 1];

    const historical: Array<{ year: number; revenue: number; expenses: number; netIncome: number }> = [];
    for (const y of histYears) {
      const from = `${y}-01-01`;
      const to   = `${y}-12-31`;
      const rows = await getAccountBalances(req, cid, from, to, bid, false, []);
      const revenue  = rows.filter(r => r.accountType === "revenue")
        .reduce((s, r) => s + (r.totalCredit - r.totalDebit), 0);
      const expenses = rows.filter(r => r.accountType === "expense")
        .reduce((s, r) => s + (r.totalDebit - r.totalCredit), 0);
      historical.push({ year: y, revenue, expenses, netIncome: revenue - expenses });
    }

    // ── 2. Year-to-date current year (informational) ──
    const ytdRows = await getAccountBalances(req, cid, `${currentYear}-01-01`, today.toISOString().slice(0, 10), bid, false, []);
    const ytdRevenue  = ytdRows.filter(r => r.accountType === "revenue").reduce((s, r) => s + (r.totalCredit - r.totalDebit), 0);
    const ytdExpenses = ytdRows.filter(r => r.accountType === "expense").reduce((s, r) => s + (r.totalDebit - r.totalCredit), 0);

    // ── 3. Open commitments (forward-looking pipeline) ──
    const branchScope = (table: any) => {
      const arr: any[] = [];
      pushBranchScope(req, arr, table.branchId, bid);
      return arr;
    };
    const sumOf = async (table: any, col: any, statusCol: any, statuses: string[], hasBranch = true) => {
      const filters: any[] = [eq(table.companyId, cid), inArray(statusCol, statuses)];
      if (hasBranch) filters.push(...branchScope(table));
      const [r] = await db.select({ total: sql<string>`COALESCE(SUM(${col}), 0)`, n: sql<string>`COUNT(*)` })
        .from(table).where(and(...filters));
      return { total: Number(r?.total || 0), count: Number(r?.n || 0) };
    };

    const pendingSalesOrders   = await sumOf(salesOrdersTable,    salesOrdersTable.totalAmount,    salesOrdersTable.status,    ["draft", "confirmed"], true);
    // sales_quotations has no `branch_id` column. To avoid leaking
    // company-wide quotation pipeline to branch-restricted users, we
    // only include quotations when the caller can view all branches.
    const u = (req as any).authUser;
    const canSeeAllQuotations = !u || u.role === "superadmin" || u.viewAllBranches === true;
    const openQuotations = canSeeAllQuotations
      ? await sumOf(salesQuotationsTable, salesQuotationsTable.totalAmount, salesQuotationsTable.status, ["sent", "accepted"], false)
      : { total: 0, count: 0 };
    const openPurchaseOrders   = await sumOf(purchaseOrdersTable,  purchaseOrdersTable.totalAmount,  purchaseOrdersTable.status,  ["draft", "confirmed"], true);
    const openMaintenanceOrders = await sumOf(maintenanceOrdersTable, maintenanceOrdersTable.totalCost, maintenanceOrdersTable.status, ["draft", "scheduled", "in_progress"], true);

    const commitments = {
      pendingSalesOrders, openQuotations, openPurchaseOrders, openMaintenanceOrders,
      ytdRevenue, ytdExpenses,
    };

    // ── 4. Heuristic baseline (used as fallback + given to AI as anchor) ──
    const lastYear = historical[historical.length - 1];
    const validYears = historical.filter(h => h.revenue > 0 || h.expenses > 0);
    const avgRevGrowth = (() => {
      if (validYears.length < 2) return 0.05;
      const ratios: number[] = [];
      for (let i = 1; i < validYears.length; i++) {
        const a = validYears[i - 1].revenue, b = validYears[i].revenue;
        if (a > 0) ratios.push((b - a) / a);
      }
      if (!ratios.length) return 0.05;
      return ratios.reduce((s, r) => s + r, 0) / ratios.length;
    })();
    const avgExpGrowth = (() => {
      if (validYears.length < 2) return 0.04;
      const ratios: number[] = [];
      for (let i = 1; i < validYears.length; i++) {
        const a = validYears[i - 1].expenses, b = validYears[i].expenses;
        if (a > 0) ratios.push((b - a) / a);
      }
      if (!ratios.length) return 0.04;
      return ratios.reduce((s, r) => s + r, 0) / ratios.length;
    })();

    const baseRev = lastYear?.revenue  > 0 ? lastYear.revenue  : Math.max(ytdRevenue,  0);
    const baseExp = lastYear?.expenses > 0 ? lastYear.expenses : Math.max(ytdExpenses, 0);

    function projectScenario(revGrowth: number, expGrowth: number) {
      const out: Array<{ year: number; revenue: number; expenses: number; netIncome: number; growthPct: number }> = [];
      let r = baseRev, e = baseExp;
      for (let i = 1; i <= horizon; i++) {
        r = r * (1 + revGrowth);
        e = e * (1 + expGrowth);
        out.push({
          year: currentYear + i,
          revenue: Math.round(r * 100) / 100,
          expenses: Math.round(e * 100) / 100,
          netIncome: Math.round((r - e) * 100) / 100,
          growthPct: Math.round(revGrowth * 1000) / 10,
        });
      }
      return out;
    }

    const fallback = {
      optimistic:   projectScenario(Math.max(avgRevGrowth + 0.05, 0.10), Math.max(avgExpGrowth, 0.03)),
      realistic:    projectScenario(avgRevGrowth, avgExpGrowth),
      conservative: projectScenario(Math.min(avgRevGrowth - 0.03, 0.01), Math.max(avgExpGrowth + 0.02, 0.05)),
    };

    // ── 5. AI call (gracefully degrades to heuristic) ──
    const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    let aiResult: any = null;
    if (OPENAI_BASE && OPENAI_KEY) {
      const sys = "أنت محلل مالي خبير. مهمتك بناء قائمة دخل تقديرية متعددة السنوات بناءً على بيانات فعلية وارتباطات قائمة. ترد بـ JSON صالح فقط.";
      const user = `بناءً على البيانات المالية التالية لشركة، ولّد توقعات لـ ${horizon} سنوات قادمة بثلاث سيناريوهات (متفائل / واقعي / متحفظ).

البيانات الفعلية لآخر 3 سنوات (بالريال السعودي):
${JSON.stringify(historical, null, 2)}

البيانات الجارية للسنة الحالية (${currentYear}) حتى اليوم:
- الإيرادات: ${ytdRevenue}
- المصروفات: ${ytdExpenses}

الارتباطات القائمة (بايبلاين مفتوح):
- أوامر بيع غير محولة لفواتير: ${pendingSalesOrders.count} بإجمالي ${pendingSalesOrders.total} ريال
- عروض أسعار سارية: ${openQuotations.count} بإجمالي ${openQuotations.total} ريال
- أوامر شراء مفتوحة: ${openPurchaseOrders.count} بإجمالي ${openPurchaseOrders.total} ريال
- أوامر صيانة مجدولة/قيد التنفيذ: ${openMaintenanceOrders.count} بإجمالي ${openMaintenanceOrders.total} ريال

أعد JSON بهذا الشكل بالضبط:
{
  "scenarios": {
    "optimistic":   [{ "year": ${currentYear + 1}, "revenue": 0, "expenses": 0, "netIncome": 0, "growthPct": 0 }],
    "realistic":    [{ "year": ${currentYear + 1}, "revenue": 0, "expenses": 0, "netIncome": 0, "growthPct": 0 }],
    "conservative": [{ "year": ${currentYear + 1}, "revenue": 0, "expenses": 0, "netIncome": 0, "growthPct": 0 }]
  },
  "insights": [
    "ملاحظة 1 بالعربية حول الاتجاه أو المخاطر",
    "توصية 2 قابلة للتنفيذ"
  ],
  "summary": "ملخص تحليلي بالعربية في 2-3 جمل"
}

كل سيناريو يجب أن يحتوي ${horizon} عناصر (سنة لكل عنصر) متتالية بدءاً من ${currentYear + 1}. الأرقام بالريال السعودي. growthPct = نسبة نمو الإيرادات مقارنة بالسنة السابقة.`;

      try {
        const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: "gpt-5.4",
            max_completion_tokens: 4096,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user",   content: user },
            ],
          }),
        });
        if (r.ok) {
          const data: any = await r.json();
          const content = data?.choices?.[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(content);
          if (parsed?.scenarios?.optimistic && parsed?.scenarios?.realistic && parsed?.scenarios?.conservative) {
            aiResult = parsed;
          }
        } else {
          (req as any).log?.warn?.({ status: r.status }, "AI forecast call failed");
        }
      } catch (e: any) {
        (req as any).log?.warn?.({ err: e?.message }, "AI forecast call error");
      }
    }

    const scenarios = aiResult?.scenarios ?? fallback;
    const insights = Array.isArray(aiResult?.insights) ? aiResult.insights : [];
    const summary  = typeof aiResult?.summary === "string" ? aiResult.summary : "";

    res.json({
      generatedAt: new Date().toISOString(),
      currentYear,
      horizonYears: horizon,
      historical,
      ytd: { year: currentYear, revenue: ytdRevenue, expenses: ytdExpenses, netIncome: ytdRevenue - ytdExpenses },
      commitments,
      scenarios,
      insights,
      summary,
      aiUsed: !!aiResult,
    });
  } catch (e: any) {
    (req as any).log?.error?.({ err: e?.message }, "forecast-income-statement failed");
    res.status(500).json({ error: e.message });
  }
});

export default router;
