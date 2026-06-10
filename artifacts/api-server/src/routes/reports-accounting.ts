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
  bankAccountsTable, cashBoxesTable,
} from "@workspace/db";
import { eq, and, sql, gte, lte, asc, desc, ne, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread } from "../middleware/auth.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { logAiUsage, requireAiFeature } from "../middleware/requireAiFeature.js";
import { AsyncLocalStorage } from "node:async_hooks";

const router = Router();
  // ─────────────────────────────────────────────────────────────────────────
  // Gemini-first transparent redirect (see notes in routes/ai.ts).
  // Re-binds OPENAI_BASE/KEY (declared elsewhere in this file) to a sentinel
  // "AI_PROXY" string and shadows the global fetch with a local one that
  // intercepts the sentinel URL, dispatches via aiChat, and returns a
  // Response-shaped object so existing r.ok/r.json()/r.text() callsites
  // continue to work unchanged. AsyncLocalStorage threads `req` through
  // so the feature-gate's logAiUsage counter still advances.
  // ─────────────────────────────────────────────────────────────────────────
  const __aiReqStore = new AsyncLocalStorage<any>();
  router.use((req, _res, next) => { __aiReqStore.run(req, () => next()); });

  const __nativeFetch = globalThis.fetch;
  async function fetch(input: any, init?: any): Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> {
    if (typeof input === "string" && input.startsWith("AI_PROXY")) {
      const body = (() => { try { return JSON.parse(init?.body ?? "{}"); } catch { return {}; } })();
      const result = await aiChat(body.messages ?? [], {
        json:      body.response_format?.type === "json_object",
        maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
        providers: ["gemini"],
    });
      const req = __aiReqStore.getStore();
      if (req) {
        try {
          await logAiUsage(req, result.ok
            ? { status: "allowed", provider: result.provider }
            : { status: "error",   meta: { reason: result.reason } });
        } catch { /* logging must never break the call */ }
      }
      if (!result.ok) {
        return { ok: false, status: 502, json: async () => ({ error: result.reason }), text: async () => result.reason };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: result.text } }] }),
        text: async () => result.text,
      };
    }
    return (__nativeFetch as any)(input, init);
  }
  
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
    // opening balances) whose period ends STRICTLY BEFORE fromDate.
    // Without the date bound a TB imported for a later period (e.g.
    // 2026-12-31) would be added to a 2025 trial balance opening, and
    // would also overlap with Source 3 (prior-period regular movements)
    // for any subsequent year — overstating opening on both counts.
    const tbWhere = fromDate
      ? and(
          eq(trialBalancesTable.companyId, cid),
          sql`${trialBalancesTable.periodEnd} < ${fromDate}`,
        )
      : eq(trialBalancesTable.companyId, cid);
    const [latestTb] = await db.select({ id: trialBalancesTable.id }).from(trialBalancesTable)
      .where(tbWhere)
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
    // column and are excluded from the Period column above (regardless
    // of date — periodFilters drop entryType='opening' wholesale). When
    // a `fromDate` is supplied we restrict to opening JEs dated ON OR
    // BEFORE it (`<=`). The inclusive bound is critical: users
    // routinely post the opening JE on the fiscal year's first day
    // (2025-01-01) and then run a trial balance starting that same
    // day; a strict `<` would drop the opening JE on its boundary,
    // making the opening column show zero. A future-dated opening JE
    // (e.g. 2026-01-01 entered while running a 2025 report) is still
    // correctly excluded.
    const openingJeFilters = [...baseFilters, eq(journalEntriesTable.entryType, "opening")];
    if (fromDate) openingJeFilters.push(sql`${journalEntriesTable.entryDate} <= ${fromDate}`);
    const openingJeMap = await aggregate(openingJeFilters);
    for (const [accountId, v] of openingJeMap) {
      const cur = openingMap.get(accountId) ?? { debit: 0, credit: 0 };
      openingMap.set(accountId, {
        debit:  cur.debit  + v.debit,
        credit: cur.credit + v.credit,
      });
    }
    // Source 3: prior-period REGULAR posted movements (sales, purchases,
    // vouchers, manual JEs, etc). Without this the opening balance for any
    // fiscal year after the first one would be frozen at the original
    // opening JE — i.e. closing balance of 2025 would NOT roll forward
    // into the 2026 opening balance. This is the IFRS-aligned
    // brought-forward semantic: the opening of period [from..to] is the
    // ledger balance as of (from − 1 day), regardless of how that balance
    // was built up. Excludes opening / trial_balance_adjustment so they
    // are not double-counted with Sources 1 and 2 above.
    if (fromDate) {
      const priorMovementFilters = [
        ...baseFilters,
        sql`${journalEntriesTable.entryDate} < ${fromDate}`,
        ne(journalEntriesTable.entryType, "opening"),
        ne(journalEntriesTable.entryType, "trial_balance_adjustment"),
      ];
      const priorMap = await aggregate(priorMovementFilters);
      for (const [accountId, v] of priorMap) {
        const cur = openingMap.get(accountId) ?? { debit: 0, credit: 0 };
        openingMap.set(accountId, {
          debit:  cur.debit  + v.debit,
          credit: cur.credit + v.credit,
        });
      }
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
        // Effective cost-centre per row. Many legacy/manual entries
        // never stamped `journal_entry_lines.cost_center`, but the
        // owning source document (sales/purchase invoice, receipt /
        // payment voucher) almost always carries one at the header.
        // We COALESCE in priority order so the column lights up for
        // every row that has *any* cost-centre tag anywhere in its
        // chain. Cast to text — the line column is text, the source
        // columns are text, and `cost_centers.id` is int (cast on the
        // join). Rows with no tag at any level still come back null.
        costCenterRaw: sql<string>`COALESCE(
          ${journalEntryLinesTable.costCenter},
          ${salesInvoicesTable.costCenter},
          ${purchaseInvoicesTable.costCenter},
          ${receiptVouchersTable.costCenter},
          ${paymentVouchersTable.costCenter}
        )`,
        costCenterId:     costCentersTable.id,
        costCenterCode:   costCentersTable.code,
        costCenterNameAr: costCentersTable.nameAr,
        costCenterNameEn: costCentersTable.nameEn,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
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
      // Resolve the effective cost-centre (line OR source document) into
      // its human-readable code/name. Has to come AFTER every source-doc
      // join above so the COALESCE expression sees their columns.
      //
      // The stored value can be EITHER the numeric id (system-generated
      // JEs — fa-journals, contracting, production all stringify the id)
      // OR the code (manual JEs from JournalEntryForm, which uses
      // `c.code` as the option value). We match on either by ORing the
      // two equality conditions — `code` is a TEXT column so the cast on
      // `id::text` keeps both sides comparable.
      .leftJoin(costCentersTable, and(
        eq(costCentersTable.companyId, cid),
        sql`(
          ${costCentersTable.id}::text = COALESCE(
            ${journalEntryLinesTable.costCenter},
            ${salesInvoicesTable.costCenter},
            ${purchaseInvoicesTable.costCenter},
            ${receiptVouchersTable.costCenter},
            ${paymentVouchersTable.costCenter}
          )
          OR ${costCentersTable.code} = COALESCE(
            ${journalEntryLinesTable.costCenter},
            ${salesInvoicesTable.costCenter},
            ${purchaseInvoicesTable.costCenter},
            ${receiptVouchersTable.costCenter},
            ${paymentVouchersTable.costCenter}
          )
        )`,
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

// ─── BANK CASH-FLOW (تحليل حركة البنك دفترياً) ───────────────────────────────
// Pure ADDITIVE report. Drives the numbers from the bank's GL account journal
// lines (book ledger) — NOT from the receipt/payment voucher tables — so the
// ending figure is GUARANTEED to equal the bank's book balance (rule:
// closing = opening + Σdebit − Σcredit over the same posted lines).
//
//   opening book balance
//   + deposits (debit side of the bank account)   ─ analysed by source
//   − uses of funds (credit side of the bank account) ─ analysed by use
//   = ending book balance  (matches the ledger exactly)
//
// Classification per journal entry that touches the bank:
//   1. entryType (strongest signal: sales_invoice/pos_sale, payroll_run, …)
//   2. voucher entity_type (customer / supplier) for receipt/payment vouchers
//   3. contra-account accountType (revenue / equity / expense / liability / …)
//   4. treasury contra (another bank/cash account) ⇒ internal transfer
// Only POSTED entries feed the report (same rule as every financial report).
type DepositBuckets = { sales: number; customers: number; partner: number; transfersIn: number; other: number; total: number };
type OutflowBuckets = { salaries: number; suppliers: number; serviceBills: number; transfersOut: number; other: number; total: number };
function emptyDeposits(): DepositBuckets { return { sales: 0, customers: 0, partner: 0, transfersIn: 0, other: 0, total: 0 }; }
function emptyOutflows(): OutflowBuckets { return { salaries: 0, suppliers: 0, serviceBills: 0, transfersOut: 0, other: 0, total: 0 }; }

router.get("/bank-cash-flow", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ banks: [], opening: 0, deposits: emptyDeposits(), outflows: emptyOutflows(), closing: 0, bookClosing: 0, monthly: [] }); return; }
    const bid = getBid(req);
    const { bankAccountId, fromDate, toDate } = req.query as any;
    const monthlyMode = String(req.query.monthly ?? "") === "true" || req.query.monthly === "1";

    // ── 1. Resolve the bank account(s) and their GL account ids ──────────────
    const bankConds: any[] = [eq(bankAccountsTable.companyId, cid)];
    if (bankAccountId) bankConds.push(eq(bankAccountsTable.id, Number(bankAccountId)));
    const banks = await db.select().from(bankAccountsTable).where(and(...bankConds)).orderBy(asc(bankAccountsTable.code));
    const bankGlAccountIds = banks.map(b => b.accountId).filter((x): x is number => typeof x === "number");

    // Treasury account set (all bank + cash-box GL accounts) — a contra line
    // pointing at one of these means the movement is an internal transfer.
    const [allBanks, allBoxes] = await Promise.all([
      db.select({ accountId: bankAccountsTable.accountId }).from(bankAccountsTable).where(eq(bankAccountsTable.companyId, cid)),
      db.select({ accountId: cashBoxesTable.accountId }).from(cashBoxesTable).where(eq(cashBoxesTable.companyId, cid)),
    ]);
    const treasurySet = new Set<number>();
    for (const r of [...allBanks, ...allBoxes]) if (typeof r.accountId === "number") treasurySet.add(r.accountId);

    const banksMeta = banks.map(b => ({ id: b.id, code: b.code, nameAr: b.nameAr, nameEn: b.nameEn, bankName: b.bankName, accountId: b.accountId }));
    if (bankGlAccountIds.length === 0) {
      res.json({ banks: banksMeta, opening: 0, deposits: emptyDeposits(), outflows: emptyOutflows(), closing: 0, bookClosing: 0, monthly: [] });
      return;
    }

    // ── 2. Opening book balance: every posted line on the bank GL account(s)
    //        strictly BEFORE fromDate (sum debit − credit). ───────────────────
    const openingFilters: any[] = [
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.status, "posted"),
      inArray(journalEntryLinesTable.accountId, bankGlAccountIds),
    ];
    if (pushBranchScope(req, openingFilters, journalEntriesTable.branchId, bid) === "deny") {
      res.json({ banks: banksMeta, opening: 0, deposits: emptyDeposits(), outflows: emptyOutflows(), closing: 0, bookClosing: 0, monthly: [] });
      return;
    }
    let opening = 0;
    if (fromDate) {
      const openFilters = [...openingFilters, sql`${journalEntriesTable.entryDate} < ${fromDate}`];
      const [o] = await db
        .select({
          debit:  sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}), 0)`,
          credit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.credit}), 0)`,
        })
        .from(journalEntryLinesTable)
        .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
        .where(and(...openFilters));
      opening = Number(o?.debit || 0) - Number(o?.credit || 0);
    }

    // ── 3. In-period bank lines (the movements to analyse). ──────────────────
    const periodFilters = [...openingFilters];
    if (fromDate) periodFilters.push(gte(journalEntriesTable.entryDate, fromDate));
    if (toDate)   periodFilters.push(lte(journalEntriesTable.entryDate, toDate));
    const bankLines = await db
      .select({
        entryId:   journalEntriesTable.id,
        entryType: journalEntriesTable.entryType,
        entryDate: journalEntriesTable.entryDate,
        debit:     journalEntryLinesTable.debit,
        credit:    journalEntryLinesTable.credit,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(...periodFilters))
      .orderBy(asc(journalEntriesTable.entryDate));

    const entryIds = Array.from(new Set(bankLines.map(l => l.entryId)));

    // ── 4. ALL lines of those entries (joined to accounts for the type), so we
    //        can (a) detect internal transfers by counting how many DISTINCT
    //        treasury accounts the entry touches and (b) classify by the
    //        NON-treasury counterpart account type. We must NOT exclude bank GL
    //        accounts here: in "all banks" mode both legs of a bank↔bank
    //        transfer live in bankGlAccountIds, and excluding them would erase
    //        the transfer signal and inflate the source/use buckets. Filtering
    //        out treasury lines (which include the bank's own line) when summing
    //        contra `types` keeps the classification counterpart-only.
    const contraByEntry = new Map<number, { types: Record<string, number>; treasuryIds: Set<number> }>();
    if (entryIds.length > 0) {
      const allLines = await db
        .select({
          entryId:     journalEntryLinesTable.entryId,
          accountId:   journalEntryLinesTable.accountId,
          accountType: accountsTable.accountType,
          debit:       journalEntryLinesTable.debit,
          credit:      journalEntryLinesTable.credit,
        })
        .from(journalEntryLinesTable)
        .innerJoin(accountsTable, eq(journalEntryLinesTable.accountId, accountsTable.id))
        .where(inArray(journalEntryLinesTable.entryId, entryIds));
      for (const c of allLines) {
        const amt = Math.abs(Number(c.debit || 0)) + Math.abs(Number(c.credit || 0));
        if (amt === 0) continue;
        let rec = contraByEntry.get(c.entryId);
        if (!rec) { rec = { types: {}, treasuryIds: new Set<number>() }; contraByEntry.set(c.entryId, rec); }
        if (c.accountId && treasurySet.has(c.accountId)) {
          rec.treasuryIds.add(c.accountId);          // treasury leg — drives transfer detection
        } else {
          rec.types[c.accountType] = (rec.types[c.accountType] ?? 0) + amt; // counterpart for source/use
        }
      }
    }

    // ── 5. Voucher entity types (customer / supplier / other). ───────────────
    const entityByEntry = new Map<number, string>();
    if (entryIds.length > 0) {
      const [rv, pv] = await Promise.all([
        db.select({ jid: receiptVouchersTable.journalEntryId, et: receiptVouchersTable.entityType })
          .from(receiptVouchersTable)
          .where(and(eq(receiptVouchersTable.companyId, cid), inArray(receiptVouchersTable.journalEntryId, entryIds))),
        db.select({ jid: paymentVouchersTable.journalEntryId, et: paymentVouchersTable.entityType })
          .from(paymentVouchersTable)
          .where(and(eq(paymentVouchersTable.companyId, cid), inArray(paymentVouchersTable.journalEntryId, entryIds))),
      ]);
      for (const r of [...rv, ...pv]) if (r.jid) entityByEntry.set(r.jid, r.et as string);
    }

    // Dominant contra account type for an entry (largest absolute amount).
    function dominantContraType(entryId: number): string | null {
      const rec = contraByEntry.get(entryId);
      if (!rec) return null;
      let best: string | null = null, bestAmt = -1;
      for (const [t, a] of Object.entries(rec.types)) if (a > bestAmt) { best = t; bestAmt = a; }
      return best;
    }
    function isTransfer(entryId: number): boolean {
      const rec = contraByEntry.get(entryId);
      if (!rec) return false;
      // An internal transfer moves money between treasuries, so the entry must
      // touch ≥2 DISTINCT treasury accounts (e.g. bank↔bank or bank↔cash). One
      // treasury account alone is a normal deposit/withdrawal, not a transfer.
      // This is mode-independent — it holds whether one bank or all banks are
      // selected, because it inspects every line of the entry, not just the
      // non-selected contra.
      return rec.treasuryIds.size >= 2;
    }

    function classifyDeposit(entryId: number, entryType: string | null): keyof Omit<DepositBuckets, "total"> {
      if (isTransfer(entryId)) return "transfersIn";
      const et = entryType ?? "";
      if (et === "sales_invoice" || et === "pos_sale") return "sales";
      const entity = entityByEntry.get(entryId);
      if ((et === "receipt" || et === "receipt_voucher") && entity === "customer") return "customers";
      const ct = dominantContraType(entryId);
      if (ct === "revenue") return "sales";
      if (ct === "equity")  return "partner";
      if (ct === "asset")   return "customers"; // receivable settlement
      return "other";
    }
    function classifyOutflow(entryId: number, entryType: string | null): keyof Omit<OutflowBuckets, "total"> {
      if (isTransfer(entryId)) return "transfersOut";
      const et = entryType ?? "";
      if (et === "payroll_run" || et === "eos_payment" || et === "employee_loan") return "salaries";
      const entity = entityByEntry.get(entryId);
      if ((et === "payment" || et === "payment_voucher") && entity === "supplier") return "suppliers";
      const ct = dominantContraType(entryId);
      if (ct === "expense")   return "serviceBills";
      if (ct === "liability") return "suppliers"; // payable settlement
      return "other";
    }

    // ── 6. Aggregate (overall + optional per-month buckets). ─────────────────
    const deposits = emptyDeposits();
    const outflows = emptyOutflows();
    const monthMap = new Map<string, { deposits: DepositBuckets; outflows: OutflowBuckets }>();
    for (const l of bankLines) {
      const debit  = Number(l.debit  || 0);
      const credit = Number(l.credit || 0);
      const ym = (l.entryDate || "").slice(0, 7);
      let mrec = monthMap.get(ym);
      if (!mrec && monthlyMode) { mrec = { deposits: emptyDeposits(), outflows: emptyOutflows() }; monthMap.set(ym, mrec); }
      if (debit > 0) {
        const cat = classifyDeposit(l.entryId, l.entryType);
        deposits[cat] += debit; deposits.total += debit;
        if (mrec) { mrec.deposits[cat] += debit; mrec.deposits.total += debit; }
      }
      if (credit > 0) {
        const cat = classifyOutflow(l.entryId, l.entryType);
        outflows[cat] += credit; outflows.total += credit;
        if (mrec) { mrec.outflows[cat] += credit; mrec.outflows.total += credit; }
      }
    }

    const closing = opening + deposits.total - outflows.total;

    // Independent book balance: every posted bank GL line up to (and including)
    // toDate, summed straight from the ledger WITHOUT going through the
    // classification loop. This is a genuine cross-check — if the aggregation
    // ever dropped or double-counted a line, `closing` would diverge from this
    // `bookClosing` and the on-screen reconciliation banner would flag it.
    const bookFilters = [...openingFilters];
    if (toDate) bookFilters.push(lte(journalEntriesTable.entryDate, toDate));
    const [bk] = await db
      .select({
        debit:  sql<string>`COALESCE(SUM(${journalEntryLinesTable.debit}), 0)`,
        credit: sql<string>`COALESCE(SUM(${journalEntryLinesTable.credit}), 0)`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
      .where(and(...bookFilters));
    const bookClosing = Number(bk?.debit || 0) - Number(bk?.credit || 0);

    // Monthly rows roll the opening forward: first month opens at the overall
    // opening, each subsequent month opens at the prior month's close.
    const monthly: any[] = [];
    if (monthlyMode && monthMap.size > 0) {
      const months = Array.from(monthMap.keys()).sort();
      let runOpen = opening;
      for (const m of months) {
        const rec = monthMap.get(m)!;
        const mClose = runOpen + rec.deposits.total - rec.outflows.total;
        monthly.push({ month: m, opening: runOpen, deposits: rec.deposits, outflows: rec.outflows, closing: mClose });
        runOpen = mClose;
      }
    }

    res.json({
      banks: banksMeta,
      opening,
      deposits,
      outflows,
      closing,
      bookClosing, // independently summed from the ledger — drives the reconciliation banner
      monthly: monthly,
    });
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
router.post("/forecast-income-statement", requireAiFeature("report_analyzer"), async (req, res) => {
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
    const OPENAI_BASE = "AI_PROXY";
    const OPENAI_KEY  = "AI_PROXY";

    let aiResult: any = null;
    if (isAIAvailable()) {
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
