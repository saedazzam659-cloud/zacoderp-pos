import { Router } from "express";
import { db } from "@workspace/db";
import { resolvePostingStatus } from "../lib/postingStatus.js";
import {
  supplierGroupsTable, lettersOfCreditTable, lcExpensesTable,
  purchaseInvoicesTable, purchaseInvoiceLinesTable,
  purchaseOrdersTable, purchaseOrderLinesTable,
  purchaseReturnsTable, purchaseReturnLinesTable,
  supplierSettlementsTable, suppliersTable,
  cashBoxesTable, bankAccountsTable, journalEntriesTable, journalEntryLinesTable,
  stockBalanceTable, stockLedgerTable, warehousesTable,
  receiptVouchersTable, paymentVouchersTable,
  currenciesTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql, inArray } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeFilter, branchScopeSpread } from "../middleware/auth.js";
import { pathRbac, requireAdminRole } from "../middleware/permissions.js";
import { upsertBalance, getBalance, addStockLedgerEntry } from "../lib/stockHelpers.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";
import { nextSequenceNumber } from "../lib/sequences.js";
import { assertWritableForDate } from "../lib/periodGuard.js";
import { goodsReceiptsTable } from "@workspace/db";
import { getReceivingClearingAccountId } from "./goodsReceipts.js";

// ─── Journal entry helper ────────────────────────────────────────────────────
type JLine = { accountId: number | null; debit?: number; credit?: number; description?: string | null; costCenter?: string | null };

async function createJournalEntry(opts: {
  companyId: number;
  branchId?: number | null;
  date: string;
  description: string;
  docNumber?: string | null;
  entryType?: string;
  exchangeRate?: string | null;
  // Header-level cost-center code applied to every line that doesn't
  // explicitly set its own. Lets a single field on the source document
  // (purchase invoice, purchase return, …) tag the entire JE.
  costCenter?: string | null;
  lines: JLine[];
}): Promise<number> {
  // Filter out lines with zero amount or no account
  const cleanLines = opts.lines.filter(l => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0));
  if (cleanLines.length < 2) throw new Error("القيد المحاسبي يحتاج إلى طرفين على الأقل");

  const totalDebit  = cleanLines.reduce((s, l) => s + (l.debit  ?? 0), 0);
  const totalCredit = cleanLines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)}`);
  }

  // Period guard: never let a source document (PO, GRN settlement, return, …)
  // post a journal entry into a soft/hard-closed fiscal period.
  const writability = await assertWritableForDate(opts.companyId, opts.date);
  if (!writability.ok) {
    const err: any = new Error(writability.reason);
    err.status = 423;
    throw err;
  }
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId:    opts.companyId,
    branchId:     opts.branchId ?? null,
    docNumber:    opts.docNumber ?? null,
    entryDate:    opts.date,
    currency:     "SAR",
    exchangeRate: opts.exchangeRate ?? "1",
    description:  opts.description,
    entryType:    opts.entryType ?? "general",
    status:       await resolvePostingStatus(opts.companyId, "purchase"),
    periodId:     writability.period?.id ?? null,
  }).returning();

  await db.insert(journalEntryLinesTable).values(
    cleanLines.map((l, i) => ({
      entryId:     entry.id,
      accountId:   l.accountId!,
      debit:       String((l.debit  ?? 0).toFixed(2)),
      credit:      String((l.credit ?? 0).toFixed(2)),
      description: l.description ?? opts.description,
      sortOrder:   i,
      // Persist cost-center code (text) so cost-center reports pick it up.
      // Per-line override wins; header-level value applies otherwise.
      costCenter:  l.costCenter ?? opts.costCenter ?? null,
    }))
  );
  return entry.id;
}

// Resolve cash-box account
async function getCashBoxAccountId(cid: number, cashBoxId: number | null | undefined): Promise<number | null> {
  if (!cashBoxId) return null;
  const [cb] = await db.select().from(cashBoxesTable)
    .where(and(eq(cashBoxesTable.id, cashBoxId), eq(cashBoxesTable.companyId, cid)));
  return cb?.accountId ?? null;
}
async function getBankAccountAccountId(cid: number, bankAccountId: number | null | undefined): Promise<number | null> {
  if (!bankAccountId) return null;
  const [ba] = await db.select().from(bankAccountsTable)
    .where(and(eq(bankAccountsTable.id, bankAccountId), eq(bankAccountsTable.companyId, cid)));
  return ba?.accountId ?? null;
}
async function getSupplierAccountId(cid: number, supplierId: number | null | undefined): Promise<number | null> {
  if (!supplierId) return null;
  const [s] = await db.select().from(suppliersTable)
    .where(and(eq(suppliersTable.id, supplierId), eq(suppliersTable.companyId, cid)));
  return s?.accountId ?? null;
}

/** Map a list of warehouse IDs to their {accountId, allowNegative, name}. */
async function loadWarehouseInfo(cid: number, ids: number[]): Promise<Record<number, { accountId: number | null; allowNegative: boolean; nameAr: string | null }>> {
  const out: Record<number, any> = {};
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  for (const wid of uniq) {
    const [w] = await db.select().from(warehousesTable)
      .where(and(eq(warehousesTable.id, wid), eq(warehousesTable.companyId, cid)));
    out[wid] = { accountId: w?.accountId ?? null, allowNegative: !!w?.allowNegative, nameAr: w?.nameAr ?? null };
  }
  return out;
}

const router = Router();
router.use(extractAuth);
router.use(pathRbac([
  ["/purchase-invoices",      "purchase_invoices"],
  ["/purchase-orders",        "purchase_invoices"],
  ["/purchase-returns",       "purchase_returns"],
  ["/supplier-settlements",   "purchase_invoices"],
  ["/letters-of-credit",      "purchase_invoices"],
  ["/supplier-groups",        "suppliers"],
]));

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
}

// Cleanup any orphan stock movements / vouchers / journal entries tied to a draft document
// (defensive: a draft normally has none, but past bugs may have left orphans behind).
async function cleanupDocArtifacts(opts: {
  companyId: number;
  refType: string;
  refId: number;
  journalEntryId?: number | null;
}) {
  const { companyId: cid, refType, refId, journalEntryId } = opts;

  const ledger = await db.select().from(stockLedgerTable).where(and(
    eq(stockLedgerTable.companyId, cid),
    eq(stockLedgerTable.refType, refType),
    eq(stockLedgerTable.refId,   refId),
  ));
  for (const row of ledger) {
    const qty = Number(row.qty);
    const [bal] = await db.select().from(stockBalanceTable).where(and(
      eq(stockBalanceTable.companyId,   cid),
      eq(stockBalanceTable.itemId,      row.itemId),
      eq(stockBalanceTable.warehouseId, row.warehouseId),
    ));
    if (bal) {
      await db.update(stockBalanceTable)
        .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
        .where(eq(stockBalanceTable.id, bal.id));
    }
  }
  if (ledger.length) {
    await db.delete(stockLedgerTable).where(and(
      eq(stockLedgerTable.companyId, cid),
      eq(stockLedgerTable.refType, refType),
      eq(stockLedgerTable.refId,   refId),
    ));
  }

  // Vouchers reference docs via refType + refNumber (text); the post handler
  // sets refNumber to inv.docNumber || String(inv.id), so try both.
  const refNum = (opts as any).refNumber as string | null | undefined;
  const candidates = [String(refId), refNum].filter(Boolean) as string[];
  for (const rn of candidates) {
    await db.delete(receiptVouchersTable).where(and(
      eq(receiptVouchersTable.companyId, cid),
      eq(receiptVouchersTable.refType, refType),
      eq(receiptVouchersTable.refNumber, rn),
    ));
    await db.delete(paymentVouchersTable).where(and(
      eq(paymentVouchersTable.companyId, cid),
      eq(paymentVouchersTable.refType, refType),
      eq(paymentVouchersTable.refNumber, rn),
    ));
  }

  if (journalEntryId) {
    await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, journalEntryId));
    await db.delete(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, journalEntryId),
      eq(journalEntriesTable.companyId, cid),
    ));
  }
}

// ═══════════════════════════════════════════════
// SUPPLIER GROUPS
// ═══════════════════════════════════════════════
router.get("/supplier-groups", async (req, res) => {
  try {
    const cid = getCid(req);
    const rows = cid
      ? await db.select().from(supplierGroupsTable)
          .where(eq(supplierGroupsTable.companyId, cid))
          .orderBy(asc(supplierGroupsTable.code))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/supplier-groups", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { code, nameAr, nameEn, discountPercent, notes, isActive } = req.body;
    if (!code || !nameAr) { res.status(400).json({ error: "الكود والاسم مطلوبان" }); return; }
    const [row] = await db.insert(supplierGroupsTable).values({
      companyId: cid, code, nameAr, nameEn: nameEn || null,
      discountPercent: discountPercent || "0", notes: notes || null,
      isActive: isActive ?? true,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/supplier-groups/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { code, nameAr, nameEn, discountPercent, notes, isActive } = req.body;
    const [row] = await db.update(supplierGroupsTable).set({
      code, nameAr, nameEn: nameEn || null,
      discountPercent: discountPercent || "0", notes: notes || null, isActive,
    }).where(and(eq(supplierGroupsTable.id, id), eq(supplierGroupsTable.companyId, cid))).returning();
    if (!row) { res.status(404).json({ error: "المجموعة غير موجودة" }); return; }
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/supplier-groups/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(supplierGroupsTable).where(and(eq(supplierGroupsTable.id, id), eq(supplierGroupsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// LETTERS OF CREDIT
// ═══════════════════════════════════════════════
// ─── LC base-currency conversion helper (IAS 21 historical-rate) ───────
// The company's "functional currency" (base) is whichever currency row
// has isDefault=true. All LC totals/expenses are converted into this
// currency for comparison and posting. The historical rate is the one
// stored on the LC/expense at create time — it does NOT re-translate
// when the spot rate changes later.
async function getBaseCurrencyCode(cid: number): Promise<string> {
  const rows = await db.select().from(currenciesTable)
    .where(eq(currenciesTable.companyId, cid));
  return rows.find(c => c.isDefault)?.code ?? rows[0]?.code ?? "SAR";
}
function enrichLcRow(lc: any, expenses: any[], baseCurrency: string) {
  const lcRate    = Number(lc.exchangeRate ?? "1") || 1;
  const totalAmt  = Number(lc.totalAmount  ?? "0") || 0;
  const totalBase = totalAmt * lcRate;

  const expEnriched = expenses.map((e) => {
    const r = Number(e.exchangeRate ?? "1") || 1;
    const a = Number(e.amount       ?? "0") || 0;
    return { ...e, amountBase: (a * r).toFixed(2) };
  });
  const totalExpensesBase = expEnriched.reduce((s, e) => s + Number(e.amountBase), 0);
  // "Remaining" = unused LC capacity = LC face value (in base) minus the
  // goods portion already drawn down by POSTED purchase invoices
  // (`usedAmount`, maintained by recomputeLcUsage).
  // It is NOT `totalBase - expenses` — expenses are loaded on top of goods,
  // not deducted from the LC commitment to the supplier.
  const usedBase          = Number(lc.usedAmount ?? "0") || 0;
  const remainingBase     = Math.max(0, totalBase - usedBase);
  return {
    ...lc,
    totalAmountBase:    totalBase.toFixed(2),
    expenses:           expEnriched,
    totalExpensesBase:  totalExpensesBase.toFixed(2),
    remainingBase:      remainingBase.toFixed(2),
    baseCurrency,
  };
}

router.get("/letters-of-credit", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const baseCurrency = await getBaseCurrencyCode(cid);
    const lcs = await db.select().from(lettersOfCreditTable)
      .where(eq(lettersOfCreditTable.companyId, cid))
      .orderBy(desc(lettersOfCreditTable.lcDate));
    if (lcs.length === 0) { res.json([]); return; }
    const expensesAll = await db.select().from(lcExpensesTable)
      .where(eq(lcExpensesTable.companyId, cid));
    const byLc = new Map<number, any[]>();
    for (const e of expensesAll) {
      const arr = byLc.get(e.lcId) ?? [];
      arr.push(e); byLc.set(e.lcId, arr);
    }
    res.json(lcs.map(lc => enrichLcRow(lc, byLc.get(lc.id) ?? [], baseCurrency)));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// NOTE: This route MUST be declared BEFORE `/letters-of-credit/:id` —
// Express matches in registration order and `:id` would otherwise swallow
// `/statement` as id="statement" and return 404.
// ─── LC Statement (تقرير كشف حساب الاعتمادات) ─────────────────────────
//   GET /letters-of-credit/statement
//     ?from=YYYY-MM-DD          (filter by lcDate ≥ from)
//     ?to=YYYY-MM-DD            (filter by lcDate ≤ to)
//     ?supplierId=NN            (only LCs for this supplier)
//     ?status=open|partial|closed
// Returns one row per LC with full details + per-expense breakdown +
// every linked posted purchase invoice, all converted to base currency
// for grand-totals. Also includes top-level summary KPIs.
router.get("/letters-of-credit/statement", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json({ rows: [], summary: null, baseCurrency: "SAR" }); return; }
    const { from, to, supplierId, status } = req.query as Record<string, string>;
    const baseCurrency = await getBaseCurrencyCode(cid);

    const conds: any[] = [eq(lettersOfCreditTable.companyId, cid)];
    if (from)       conds.push(sql`${lettersOfCreditTable.lcDate} >= ${from}`);
    if (to)         conds.push(sql`${lettersOfCreditTable.lcDate} <= ${to}`);
    if (supplierId) conds.push(eq(lettersOfCreditTable.supplierId, Number(supplierId)));
    if (status && ["open","partial","closed"].includes(status)) {
      conds.push(eq(lettersOfCreditTable.status, status as any));
    }

    const lcs = await db.select().from(lettersOfCreditTable)
      .where(and(...conds))
      .orderBy(desc(lettersOfCreditTable.lcDate), desc(lettersOfCreditTable.id));

    if (lcs.length === 0) {
      res.json({ rows: [], summary: { count: 0, totalBase: 0, expensesBase: 0, usedBase: 0, remainingBase: 0 }, baseCurrency });
      return;
    }

    const lcIds = lcs.map(l => l.id);
    const supplierIds = Array.from(new Set(lcs.map(l => l.supplierId).filter((v): v is number => v != null)));

    const [allExpenses, allInvoices, allSuppliers, allBanks, allCashBoxes, allTransferEntries] = await Promise.all([
      db.select().from(lcExpensesTable)
        .where(and(eq(lcExpensesTable.companyId, cid), inArray(lcExpensesTable.lcId, lcIds))),
      db.select({
          id:          purchaseInvoicesTable.id,
          lcId:        purchaseInvoicesTable.lcId,
          docNumber:   purchaseInvoicesTable.docNumber,
          invoiceDate: purchaseInvoicesTable.invoiceDate,
          totalAmount: purchaseInvoicesTable.totalAmount,
          vatAmount:   purchaseInvoicesTable.vatAmount,
          totalExpensesLoaded: purchaseInvoicesTable.totalExpensesLoaded,
          currencyCode: purchaseInvoicesTable.currencyCode,
          exchangeRate: purchaseInvoicesTable.exchangeRate,
          status:      purchaseInvoicesTable.status,
          supplierId:  purchaseInvoicesTable.supplierId,
        })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.companyId, cid),
          inArray(purchaseInvoicesTable.lcId, lcIds),
        ))
        .orderBy(asc(purchaseInvoicesTable.invoiceDate)),
      supplierIds.length
        ? db.select({ id: suppliersTable.id, nameAr: suppliersTable.nameAr, nameEn: suppliersTable.nameEn })
            .from(suppliersTable)
            .where(and(eq(suppliersTable.companyId, cid), inArray(suppliersTable.id, supplierIds)))
        : Promise.resolve([] as any[]),
      // Bank accounts → keyed by their GL accountId so we can map
      // a journal-entry-line's accountId back to "this is bank X".
      db.select({ id: bankAccountsTable.id, accountId: bankAccountsTable.accountId,
                  nameAr: bankAccountsTable.nameAr, nameEn: bankAccountsTable.nameEn,
                  bankName: bankAccountsTable.bankName })
        .from(bankAccountsTable)
        .where(eq(bankAccountsTable.companyId, cid)),
      db.select({ id: cashBoxesTable.id, accountId: cashBoxesTable.accountId,
                  nameAr: cashBoxesTable.nameAr, nameEn: cashBoxesTable.nameEn })
        .from(cashBoxesTable)
        .where(eq(cashBoxesTable.companyId, cid)),
      // LC funding / expense-payment journal entries — tagged in their
      // description with [LC#<id>] and optionally [LCE#<expenseId>] by the
      // LC funding mutation. We pull every such entry for this company,
      // then filter in JS by the LC ids we actually need.
      db.select({
          id:          journalEntriesTable.id,
          entryDate:   journalEntriesTable.entryDate,
          description: journalEntriesTable.description,
          entryType:   journalEntriesTable.entryType,
          currency:    journalEntriesTable.currency,
        })
        .from(journalEntriesTable)
        .where(and(
          eq(journalEntriesTable.companyId, cid),
          inArray(journalEntriesTable.entryType, ["lc_funding", "lc_expense_payment"]),
        )),
    ]);

    // ─── Resolve source bank/cash for each LC funding & expense payment ──
    // Map GL accountId → { type, name } so a JE-line's accountId tells us
    // which bank or cash-box was the source side of the transfer.
    const sourceByAccount = new Map<number, { type: "bank" | "cash"; nameAr: string | null; nameEn: string | null; bankName?: string | null }>();
    for (const b of allBanks) {
      if (b.accountId) sourceByAccount.set(b.accountId, { type: "bank", nameAr: b.nameAr, nameEn: b.nameEn, bankName: b.bankName });
    }
    for (const c of allCashBoxes) {
      if (c.accountId) sourceByAccount.set(c.accountId, { type: "cash", nameAr: c.nameAr, nameEn: c.nameEn });
    }

    // Filter JEs whose description tag points at one of our LC ids, then
    // batch-load the credit-side line(s) to find the source accountId.
    const lcIdSet = new Set(lcIds);
    type Tagged = { lcId: number; expenseId: number | null; entryId: number; entryDate: string; description: string | null };
    const tagged: Tagged[] = [];
    for (const j of allTransferEntries) {
      const m = /\[LC#(\d+)\]/.exec(j.description ?? "");
      if (!m) continue;
      const lcId = Number(m[1]);
      if (!lcIdSet.has(lcId)) continue;
      const me = /\[LCE#(\d+)\]/.exec(j.description ?? "");
      tagged.push({ lcId, expenseId: me ? Number(me[1]) : null, entryId: j.id, entryDate: j.entryDate, description: j.description });
    }
    let lineRows: { entryId: number; accountId: number | null; credit: any; debit: any }[] = [];
    if (tagged.length > 0) {
      lineRows = await db.select({
          entryId:   journalEntryLinesTable.entryId,
          accountId: journalEntryLinesTable.accountId,
          credit:    journalEntryLinesTable.credit,
          debit:     journalEntryLinesTable.debit,
        })
        .from(journalEntryLinesTable)
        .where(inArray(journalEntryLinesTable.entryId, tagged.map(t => t.entryId)));
    }
    const linesByEntry = new Map<number, typeof lineRows>();
    for (const l of lineRows) {
      const arr = linesByEntry.get(l.entryId) ?? [];
      arr.push(l); linesByEntry.set(l.entryId, arr);
    }

    type Transfer = {
      entryId: number; date: string;
      amount: number;
      sourceType: "bank" | "cash" | null;
      sourceNameAr: string | null;
      sourceNameEn: string | null;
      sourceBankName: string | null;
    };
    const transfersByLc       = new Map<number, Transfer[]>();
    const transfersByExpense  = new Map<number, Transfer[]>();
    for (const t of tagged) {
      const lines = linesByEntry.get(t.entryId) ?? [];
      // Source = the line whose accountId matches a bank or cash GL
      // (typically the credit side of the funding/payment entry).
      let src: typeof lineRows[number] | undefined;
      let srcInfo: ReturnType<typeof sourceByAccount.get> | undefined;
      for (const ln of lines) {
        if (ln.accountId == null) continue;
        const info = sourceByAccount.get(ln.accountId);
        if (info) { src = ln; srcInfo = info; break; }
      }
      const amount = src ? Number(src.credit ?? 0) || Number(src.debit ?? 0) : 0;
      const transfer: Transfer = {
        entryId: t.entryId,
        date:    t.entryDate,
        amount,
        sourceType:     srcInfo?.type ?? null,
        sourceNameAr:   srcInfo?.nameAr ?? null,
        sourceNameEn:   srcInfo?.nameEn ?? null,
        sourceBankName: srcInfo?.bankName ?? null,
      };
      if (t.expenseId != null) {
        const arr = transfersByExpense.get(t.expenseId) ?? [];
        arr.push(transfer); transfersByExpense.set(t.expenseId, arr);
      } else {
        const arr = transfersByLc.get(t.lcId) ?? [];
        arr.push(transfer); transfersByLc.set(t.lcId, arr);
      }
    }

    const expByLc = new Map<number, any[]>();
    for (const e of allExpenses) {
      const arr = expByLc.get(e.lcId) ?? [];
      arr.push(e); expByLc.set(e.lcId, arr);
    }
    const invByLc = new Map<number, any[]>();
    for (const i of allInvoices) {
      if (i.lcId == null) continue;
      const arr = invByLc.get(i.lcId) ?? [];
      arr.push(i); invByLc.set(i.lcId, arr);
    }
    const supMap = new Map(allSuppliers.map(s => [s.id, s]));

    const rows = lcs.map(lc => {
      const enriched: any = enrichLcRow(lc, expByLc.get(lc.id) ?? [], baseCurrency);
      // Attach per-expense funding source(s) onto each enriched expense row.
      enriched.expenses = (enriched.expenses ?? []).map((e: any) => ({
        ...e,
        fundingTransfers: transfersByExpense.get(e.id) ?? [],
      }));
      const invs = invByLc.get(lc.id) ?? [];
      const invoiceRows = invs.map(i => {
        const total    = Number(i.totalAmount         || 0);
        const vat      = Number(i.vatAmount           || 0);
        const expLoad  = Number(i.totalExpensesLoaded || 0);
        const goodsInv = total - expLoad;
        const rate     = Number(i.exchangeRate || "1") || 1;
        return {
          ...i,
          totalBase:        +(total    * rate).toFixed(2),
          vatBase:          +(vat      * rate).toFixed(2),
          expensesLoadedBase: +(expLoad  * rate).toFixed(2),
          goodsBase:        +(goodsInv * rate).toFixed(2),
        };
      });
      const usedBase     = invoiceRows
        .filter(i => i.status === "posted")
        .reduce((s, i) => s + i.goodsBase, 0);
      const supplier = lc.supplierId ? supMap.get(lc.supplierId) ?? null : null;
      return {
        ...enriched,
        supplierNameAr: supplier?.nameAr ?? null,
        supplierNameEn: supplier?.nameEn ?? null,
        invoices:       invoiceRows,
        invoiceCount:   invoiceRows.length,
        usedBaseFromInvoices: +usedBase.toFixed(2),
        // LC-value funding transfers (target=settlement, no expense tag).
        fundingTransfers: transfersByLc.get(lc.id) ?? [],
      };
    });

    const summary = {
      count:         rows.length,
      totalBase:     +rows.reduce((s, r) => s + Number(r.totalAmountBase   || 0), 0).toFixed(2),
      expensesBase:  +rows.reduce((s, r) => s + Number(r.totalExpensesBase || 0), 0).toFixed(2),
      usedBase:      +rows.reduce((s, r) => s + Number(r.usedAmount        || 0), 0).toFixed(2),
      remainingBase: +rows.reduce((s, r) => s + Number(r.remainingBase     || 0), 0).toFixed(2),
      invoiceCount:  rows.reduce((s, r) => s + r.invoiceCount, 0),
    };

    res.json({ rows, summary, baseCurrency });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [lc] = await db.select().from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    const expenses = await db.select().from(lcExpensesTable)
      .where(eq(lcExpensesTable.lcId, id));
    const baseCurrency = await getBaseCurrencyCode(cid);
    res.json(enrichLcRow(lc, expenses, baseCurrency));
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/letters-of-credit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { lcNumber, lcDate, supplierId, bankName, currencyCode, exchangeRate,
            totalAmount, settlementAccountId, notes, expenses } = req.body;
    if (!lcNumber || !lcDate || !totalAmount) {
      res.status(400).json({ error: "رقم الاعتماد والتاريخ والقيمة مطلوبة" }); return;
    }
    const [lc] = await db.insert(lettersOfCreditTable).values({
      companyId: cid, lcNumber, lcDate,
      supplierId: supplierId ? Number(supplierId) : null,
      bankName: bankName || null, currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate ?? "1"),
      totalAmount: String(totalAmount), usedAmount: "0",
      settlementAccountId: settlementAccountId ? Number(settlementAccountId) : null,
      status: "open", notes: notes || null,
    }).returning();
    if (expenses?.length) {
      const baseCur = await getBaseCurrencyCode(cid);
      await db.insert(lcExpensesTable).values(
        expenses.map((e: any) => {
          const cur = e.currencyCode || "SAR";
          // Defensive: same-currency rows must always have rate=1
          const rate = cur === baseCur ? "1" : String(e.exchangeRate ?? "1");
          return {
            lcId: lc.id, companyId: cid,
            expenseType: e.expenseType, accountId: e.accountId ? Number(e.accountId) : null,
            amount: String(e.amount), currencyCode: cur,
            exchangeRate: rate,
            notes: e.notes || null,
          };
        })
      );
    }
    res.status(201).json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Guard: closed LCs are sealed. Editing any field — including expense
    // lines, settlement account, or amount — would silently invalidate
    // already-posted journal entries that referenced the prior state.
    // Admins must explicitly reopen the LC first (PATCH .../reopen).
    const [existing] = await db.select({ status: lettersOfCreditTable.status })
      .from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    if (existing.status === "closed") {
      res.status(409).json({
        error: "لا يمكن تعديل اعتماد مغلق. أعد فتحه أولاً ثم عدّله، أو أنشئ قيد تسوية يدوي إذا كان التعديل محاسبياً.",
      });
      return;
    }
    const { lcNumber, lcDate, supplierId, bankName, currencyCode, exchangeRate,
            totalAmount, settlementAccountId, notes, expenses } = req.body;
    const [lc] = await db.update(lettersOfCreditTable).set({
      lcNumber, lcDate,
      supplierId: supplierId ? Number(supplierId) : null,
      bankName: bankName || null, currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate ?? "1"),
      totalAmount: String(totalAmount),
      settlementAccountId: settlementAccountId ? Number(settlementAccountId) : null,
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid))).returning();
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    if (expenses !== undefined) {
      await db.delete(lcExpensesTable).where(eq(lcExpensesTable.lcId, id));
      if (expenses.length) {
        const baseCur = await getBaseCurrencyCode(cid);
        await db.insert(lcExpensesTable).values(
          expenses.map((e: any) => {
            const cur = e.currencyCode || "SAR";
            const rate = cur === baseCur ? "1" : String(e.exchangeRate ?? "1");
            return {
              lcId: id, companyId: cid,
              expenseType: e.expenseType, accountId: e.accountId ? Number(e.accountId) : null,
              amount: String(e.amount), currencyCode: cur,
              exchangeRate: rate,
              notes: e.notes || null,
            };
          })
        );
      }
    }
    res.json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// Append a SINGLE expense to an existing LC.
// Used by the standalone "Add LC Expense" screen so users can record
// expenses incrementally as procedures complete (shipping → customs →
// insurance, etc.) without reopening the full LC edit dialog every time.
// Returns the created expense row. Blocks when the LC is closed.
router.post("/letters-of-credit/:id/expenses", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [lc] = await db.select({
      id: lettersOfCreditTable.id,
      status: lettersOfCreditTable.status,
      currencyCode: lettersOfCreditTable.currencyCode,
    }).from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    if (lc.status === "closed") {
      res.status(409).json({ error: "لا يمكن إضافة مصروف لاعتماد مغلق. أعد فتحه أولاً." });
      return;
    }
    const { expenseType, accountId, amount, currencyCode, exchangeRate, notes } = req.body ?? {};
    if (!expenseType || !(Number(amount) > 0)) {
      res.status(400).json({ error: "نوع المصروف والمبلغ مطلوبان" }); return;
    }
    // Validate accountId belongs to this company and is a posting account
    if (accountId) {
      const { accountsTable } = await import("@workspace/db");
      const [acc] = await db.select({
        id: accountsTable.id, isPosting: accountsTable.isPosting,
      }).from(accountsTable)
        .where(and(eq(accountsTable.id, Number(accountId)), eq(accountsTable.companyId, cid)));
      if (!acc) { res.status(400).json({ error: "حساب المصروف غير صالح" }); return; }
      if (!acc.isPosting) { res.status(400).json({ error: "حساب المصروف يجب أن يكون حساب ترحيل" }); return; }
    }
    // Defensive guard: if the expense currency equals the company base
    // currency, force exchangeRate = 1. Prevents clients that mistakenly
    // inherit the LC's foreign rate from inflating amountBase = amount × rate
    // (which has previously caused expenses to be double-counted in totals).
    const baseCurrency = await getBaseCurrencyCode(cid);
    const expCur = currencyCode || lc.currencyCode || baseCurrency;
    const expRate = expCur === baseCurrency ? "1" : String(exchangeRate ?? "1");
    const [created] = await db.insert(lcExpensesTable).values({
      lcId: id, companyId: cid,
      expenseType: String(expenseType),
      accountId: accountId ? Number(accountId) : null,
      amount: String(amount),
      currencyCode: expCur,
      exchangeRate: expRate,
      notes: notes || null,
    }).returning();
    res.status(201).json(created);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Guard: closed LCs cannot be deleted either. Admin must reopen first.
    const [existing] = await db.select({ status: lettersOfCreditTable.status })
      .from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (existing?.status === "closed") {
      res.status(409).json({
        error: "لا يمكن حذف اعتماد مغلق. أعد فتحه أولاً ثم احذفه.",
      });
      return;
    }
    // Guard: purchase_invoices.lc_id is a non-cascading FK. Block delete if
    // any invoice still references this LC and surface a clear, localized
    // message instead of a generic "Failed query" from the FK violation.
    const linked = await db.select({
      id: purchaseInvoicesTable.id,
      docNumber: purchaseInvoicesTable.docNumber,
      status: purchaseInvoicesTable.status,
    }).from(purchaseInvoicesTable).where(and(
      eq(purchaseInvoicesTable.companyId, cid),
      eq(purchaseInvoicesTable.lcId, id),
    ));
    if (linked.length > 0) {
      const sample = linked.slice(0, 5).map(r => r.docNumber ?? `#${r.id}`).join(", ");
      const more = linked.length > 5 ? ` +${linked.length - 5}` : "";
      res.status(409).json({
        error: `لا يمكن حذف هذا الاعتماد — مرتبط بـ ${linked.length} فاتورة شراء (${sample}${more}). أزل الربط من الفواتير أولاً، أو احذف/الغِ الفواتير، ثم أعد المحاولة.`,
      });
      return;
    }
    // lc_expenses cascades automatically via FK onDelete: "cascade".
    await db.delete(lettersOfCreditTable).where(and(
      eq(lettersOfCreditTable.id, id),
      eq(lettersOfCreditTable.companyId, cid),
    ));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── Recompute LC usage from posted purchase invoices ──────────────────────
// Sums the GOODS portion (totalAmount - vatAmount - totalExpensesLoaded,
// converted to LC base via the invoice's exchangeRate) of every POSTED
// purchase invoice linked to this LC. Then auto-derives the status:
//   used == 0                 → open
//   0 < used < totalBase      → partial
//   used >= totalBase         → closed
// Status is NOT changed when the LC was manually closed/reopened by an
// admin AND the auto-rule wouldn't change it back to "closed" — manual
// override always wins for the closed→reopen transition since the user
// explicitly took action.
async function recomputeLcUsage(cid: number, lcId: number): Promise<void> {
  const [lc] = await db.select().from(lettersOfCreditTable)
    .where(and(eq(lettersOfCreditTable.id, lcId), eq(lettersOfCreditTable.companyId, cid)));
  if (!lc) return;

  const invoices = await db.select().from(purchaseInvoicesTable).where(and(
    eq(purchaseInvoicesTable.companyId, cid),
    eq(purchaseInvoicesTable.lcId, lcId),
    eq(purchaseInvoicesTable.status, "posted"),
  ));

  // Goods portion in LC base currency. Each invoice carries its own
  // exchangeRate which converts the invoice amount to the company base
  // currency (same base as the LC's totalAmountBase).
  let usedBase = 0;
  for (const inv of invoices) {
    const total       = Number(inv.totalAmount         || 0);
    const expLoaded   = Number(inv.totalExpensesLoaded || 0);
    // Mirror the JE credit posted to the LC settlement account
    // (see post handler — `goodsPortion = totalAmount - expensesLoaded`),
    // so usedAmount tracks the actual LC settlement clearing.
    const goodsInvCur = total - expLoaded;
    const rate        = Number(inv.exchangeRate || "1") || 1;
    usedBase += goodsInvCur * rate;
  }

  const lcRate    = Number(lc.exchangeRate || "1") || 1;
  const totalBase = (Number(lc.totalAmount || 0) || 0) * lcRate;

  let status: "open" | "partial" | "closed" = "open";
  if (usedBase >= totalBase - 0.01 && totalBase > 0) status = "closed";
  else if (usedBase > 0.01) status = "partial";

  await db.update(lettersOfCreditTable).set({
    usedAmount: usedBase.toFixed(2),
    status,
    updatedAt: new Date(),
  }).where(eq(lettersOfCreditTable.id, lcId));
}

// ─── Manual LC close / reopen (admin override) ───────────────────────────
router.patch("/letters-of-credit/:id/close", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [lc] = await db.update(lettersOfCreditTable)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)))
      .returning();
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    res.json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/letters-of-credit/:id/reopen", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // Reopen falls back to the auto-derived status (open or partial) so the
    // user does not get stuck with a stale "closed" state right after reopen.
    await db.update(lettersOfCreditTable)
      .set({ status: "open", updatedAt: new Date() })
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    await recomputeLcUsage(cid, id);
    const [lc] = await db.select().from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    res.json(lc);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE INVOICES
// ═══════════════════════════════════════════════
router.get("/purchase-invoices", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(purchaseInvoicesTable)
      .where(and(
        eq(purchaseInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, purchaseInvoicesTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(purchaseInvoicesTable.invoiceDate));

    // Enrich each invoice with its latest linked payment voucher so the
    // listing can show a "paid via cash/bank" badge in the side row. We
    // pull all linked vouchers for this tenant in a single query and
    // group in memory — cheap, and avoids N+1 even for large tenants.
    const ids = rows.map(r => r.id);
    if (ids.length === 0) { res.json(rows); return; }
    const { paymentVouchersTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const links = await db.select({
      voucherId:         paymentVouchersTable.id,
      code:              paymentVouchersTable.code,
      paymentType:       paymentVouchersTable.paymentType,
      amount:            paymentVouchersTable.amount,
      status:            paymentVouchersTable.status,
      date:              paymentVouchersTable.date,
      purchaseInvoiceId: paymentVouchersTable.purchaseInvoiceId,
    }).from(paymentVouchersTable).where(and(
      eq(paymentVouchersTable.companyId, cid),
      inArray(paymentVouchersTable.purchaseInvoiceId, ids),
      // Only POSTED vouchers turn an invoice into "paid". Drafts stay
      // invisible in the listing badge — otherwise we would mislead the
      // user that an invoice is settled when in reality the voucher is
      // still being edited.
      eq(paymentVouchersTable.status, "posted"),
    ));
    // Group by invoice; deterministic tiebreaker: latest date, then
    // highest voucherId, so the badge never flickers between rows that
    // share the same date.
    const byInvoice = new Map<number, typeof links>();
    for (const l of links) {
      if (!l.purchaseInvoiceId) continue;
      const arr = byInvoice.get(l.purchaseInvoiceId) ?? [];
      arr.push(l);
      byInvoice.set(l.purchaseInvoiceId, arr);
    }
    const enriched = rows.map(r => {
      const arr = byInvoice.get(r.id) ?? [];
      const sorted = [...arr].sort((a, b) => {
        const dateCmp = String(b.date).localeCompare(String(a.date));
        if (dateCmp !== 0) return dateCmp;
        return b.voucherId - a.voucherId;
      });
      const top = sorted[0];
      return {
        ...r,
        paymentSettlement: top ? {
          voucherId:   top.voucherId,
          code:        top.code,
          paymentType: top.paymentType,
          amount:      top.amount,
          status:      top.status,
          date:        top.date,
        } : null,
      };
    });
    res.json(enriched);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    const lines = await db.select().from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.invoiceId, id))
      .orderBy(asc(purchaseInvoiceLinesTable.id));
    res.json({ ...inv, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-invoices", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, supplierInvoiceNumber, invoiceDate, supplierId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId, costCenter } = req.body;
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return; }
    if (pType === "credit" && !supplierId) { res.status(400).json({ error: "يجب اختيار المورد عند الدفع الآجل" }); return; }

    // Pull the next number from the central sequence engine when the client
    // didn't supply one. Falls back to null (legacy) if no active sequence
    // is bound to "purchase_invoice".
    let resolvedDocNumber: string | null = (docNumber && String(docNumber).trim()) || null;
    if (!resolvedDocNumber) {
      try {
        resolvedDocNumber = await nextSequenceNumber(cid, "purchase_invoice", {
          userId:   (req as any).authUser?.id ?? null,
          refTable: "purchase_invoices",
          branchId: branchId ? Number(branchId) : null,
        });
      } catch (seqErr: any) {
        res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم الفاتورة" });
        return;
      }
    }

    const [inv] = await db.insert(purchaseInvoicesTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber, supplierInvoiceNumber: supplierInvoiceNumber || null, invoiceDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      lcId: lcId ? Number(lcId) : null,
      distributionMethod: distributionMethod || "value",
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalExpensesLoaded: String(totalExpensesLoaded || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      costCenter:         costCenter ? String(costCenter).trim() || null : null,
      status: "draft", notes: notes || null,
    }).returning();
    if (lines?.length) {
      await db.insert(purchaseInvoiceLinesTable).values(
        lines.map((l: any) => ({
          invoiceId: inv.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null,
          unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          qty: String(l.qty || "1"),
          freeQty: String(l.freeQty || "0"),
          weight: String(l.weight || "0"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))), vatRate: String(l.vatRate || "15"),
          lineTotal: String(l.lineTotal || "0"),
          expenseShare: String(l.expenseShare || "0"),
          finalCost: String(l.finalCost || "0"),
          accountId: l.accountId ? Number(l.accountId) : null,
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(inv);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // POSTED-DOC LOCK — same rule as sales: a posted purchase invoice is
    // immutable until an admin explicitly unposts it.
    const [existing] = await db.select({ status: purchaseInvoicesTable.status })
      .from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (existing.status === "posted") {
      res.status(409).json({ error: "لا يمكن تعديل فاتورة مُرحَّلة. قم بفك الترحيل أولاً." });
      return;
    }
    // docNumber is intentionally not destructured — immutable on edit.
    const { supplierInvoiceNumber, invoiceDate, supplierId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId, costCenter } = req.body;
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return; }
    if (pType === "credit" && !supplierId) { res.status(400).json({ error: "يجب اختيار المورد عند الدفع الآجل" }); return; }
    // docNumber is intentionally omitted — once assigned, it is immutable.
    const [inv] = await db.update(purchaseInvoicesTable).set({
      branchId: branchId ? Number(branchId) : null,
      supplierInvoiceNumber: supplierInvoiceNumber || null, invoiceDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      lcId: lcId ? Number(lcId) : null,
      distributionMethod: distributionMethod || "value",
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalExpensesLoaded: String(totalExpensesLoaded || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      costCenter:         costCenter ? String(costCenter).trim() || null : null,
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid))).returning();
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (lines !== undefined) {
      await db.delete(purchaseInvoiceLinesTable).where(eq(purchaseInvoiceLinesTable.invoiceId, id));
      if (lines.length) {
        await db.insert(purchaseInvoiceLinesTable).values(
          lines.map((l: any) => ({
            invoiceId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null,
            unit: l.unit || null,
            unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            qty: String(l.qty || "1"),
            freeQty: String(l.freeQty || "0"),
            weight: String(l.weight || "0"),
            unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))), vatRate: String(l.vatRate || "15"),
            lineTotal: String(l.lineTotal || "0"),
            expenseShare: String(l.expenseShare || "0"),
            finalCost: String(l.finalCost || "0"),
            accountId: l.accountId ? Number(l.accountId) : null,
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
            notes: l.notes || null,
          }))
        );
      }
    }
    res.json(inv);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/purchase-invoices/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") { res.status(400).json({ error: "الفاتورة مُرحَّلة مسبقاً" }); return; }

    const lines = await db.select().from(purchaseInvoiceLinesTable)
      .where(eq(purchaseInvoiceLinesTable.invoiceId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في الفاتورة" }); return; }

    const noWh = lines.filter(l => l.itemId && !l.warehouseId);
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Load warehouse info for inventory account derivation
    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // When this invoice was created from a Goods Receipt Note (GRN), the
    // stock movement already happened at GRN-post time. Skip the stock
    // loop entirely so we don't double-count, and DEBIT Receiving Clearing
    // (instead of Inventory) so it nets out against the GRN's credit to
    // that same clearing account.
    const grnSourced = !!(inv as any).sourceGrnId;

    // Update stock balance for each stockable line (in base units), accumulate inventory debit per warehouse
    const inventoryByWarehouse: Record<number, number> = {};
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor   = Number(line.conversionFactor || "1") || 1;
      // Stock receives paid qty + free qty (supplier bonus units), but the
      // cost paid (finalCost) covers only the paid qty — so free units land
      // in inventory at zero marginal cost, lowering the weighted avg cost.
      // Example: buy 10 @ 100 + 2 free ⇒ 12 units for 1000 ⇒ 83.33 avg.
      const qty      = (Number(line.qty) + Number(line.freeQty || 0)) * factor;
      const cost     = Number(line.finalCost || line.unitPrice);
      const costUnit = qty > 0 ? cost / qty : Number(line.unitPrice) / factor;
      inventoryByWarehouse[line.warehouseId] = (inventoryByWarehouse[line.warehouseId] ?? 0) + cost;

      if (grnSourced) continue;

      await upsertBalance(cid, line.itemId, line.warehouseId, qty, costUnit);
      const newBal = await getBalance(cid, line.itemId, line.warehouseId);
      await addStockLedgerEntry({
        companyId:   cid,
        itemId:      line.itemId,
        warehouseId: line.warehouseId,
        txDate:      inv.invoiceDate,
        txType:      "purchase",
        qty:         String(qty),
        costPrice:   String(costUnit.toFixed(4)),
        totalCost:   String(cost.toFixed(2)),
        balanceQty:  String(newBal),
        refId:       id,
        refType:     "purchase_invoice",
        notes:       line.notes ?? undefined,
      });
    }

    // ── Create journal entry (قيد محاسبي) ──────────────────────────
    // Dr Inventory  = landed cost (goods + loaded LC expenses - discount, i.e. totalAmount - vat + discount)
    // Dr VAT Input  = vatAmount
    // Cr Supplier/Cash   = totalAmount
    // Cr Discount Earned = discountAmount
    // This formula balances even when LC expenses are loaded onto the invoice.
    const vatAmount      = Number(inv.vatAmount      || 0);
    const discountAmount = Number(inv.discountAmount || 0);
    const totalAmount    = Number(inv.totalAmount    || 0);
    const inventoryDebit = totalAmount - vatAmount + discountAmount;

    // Fallback to accounting mappings when per-invoice accounts are not set
    const mapPi = await loadMappings(cid, "purchase_invoice");
    const taxAccId      = pickAccount(inv.taxAccountId,      mapPi("purchase_invoice", "vat_input"));
    const discountAccId = pickAccount(inv.discountAccountId, mapPi("purchase_invoice", "discount"));

    // ─── LC-linked invoice: replace counterparty credit ──────────────────
    // When an invoice is tied to a Letter of Credit, the supplier was
    // already paid through the LC margin / bank transfer. So the credit
    // side becomes:
    //   Cr LC settlement account  (goods value, pre-tax, pre-expenses)
    //   Cr each LC expense account (proportional to its share)
    // This zeros-out the LC asset balance as goods are received and
    // properly reverses the expense clearing entries created on payment.
    let lcRow: any = null;
    let lcExpenseRows: any[] = [];
    if (inv.lcId) {
      const [lcr] = await db.select().from(lettersOfCreditTable)
        .where(and(eq(lettersOfCreditTable.id, inv.lcId), eq(lettersOfCreditTable.companyId, cid)));
      if (!lcr) throw new Error("الاعتماد المستندي المرتبط بالفاتورة غير موجود");
      lcRow = lcr;
      lcExpenseRows = await db.select().from(lcExpensesTable)
        .where(eq(lcExpensesTable.lcId, inv.lcId));
    }

    const counterpartyAccountId = inv.lcId
      ? (lcRow?.settlementAccountId ?? null)
      : inv.paymentType === "cash" ? await getCashBoxAccountId(cid, inv.cashBoxId)
      : inv.paymentType === "bank" ? await getBankAccountAccountId(cid, (inv as any).bankAccountId)
      : await getSupplierAccountId(cid, inv.supplierId);

    const missing: string[] = [];
    if (vatAmount > 0 && !taxAccId) missing.push("حساب الضرائب (مدخلات)");
    if (discountAmount > 0 && !discountAccId) missing.push("حساب الخصم المكتسب");
    if (!counterpartyAccountId) missing.push(
      inv.lcId          ? "حساب تسوية الاعتماد المستندي (يُضبط من شاشة الاعتمادات)"
      : inv.paymentType === "cash" ? "حساب الخزنة"
      : inv.paymentType === "bank" ? "الحساب البنكي"
      : "حساب المورد",
    );
    // Validate per-expense clearing accounts when posting an LC-linked invoice
    if (inv.lcId) {
      const missingExp = lcExpenseRows.filter(e => Number(e.amount) > 0 && !e.accountId)
        .map(e => e.expenseType || "—");
      if (missingExp.length) missing.push(`حساب مصروف الاعتماد لـ: ${missingExp.join("، ")}`);
    }

    // GRN-sourced invoices DEBIT Receiving Clearing instead of Inventory.
    // For non-GRN invoices, derive Inventory from each warehouse's account.
    let clearingAccId: number | null = null;
    if (grnSourced) {
      clearingAccId = await getReceivingClearingAccountId(cid);
      if (!clearingAccId) missing.push("حساب وسيط الاستلام");
    } else {
      const missingWh: string[] = [];
      for (const [widStr, amt] of Object.entries(inventoryByWarehouse)) {
        if (amt <= 0) continue;
        const wid = Number(widStr);
        if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
      }
      if (missingWh.length) missing.push(`حساب المخزون لـ: ${missingWh.join("، ")}`);
    }
    if (missing.length) {
      throw new Error(`يجب تحديد الحسابات التالية قبل الترحيل: ${missing.join("، ")}`);
    }

    // Distribute landed-cost adjustment (LC expenses - discount on goods) proportionally over the warehouses,
    // so the per-warehouse inventory debits sum to inventoryDebit instead of just goods cost.
    const goodsCostTotal = Object.values(inventoryByWarehouse).reduce((s, v) => s + v, 0);
    const inventoryDebitByWh: Record<number, number> = {};
    if (goodsCostTotal > 0) {
      const ratio = inventoryDebit / goodsCostTotal;
      for (const [widStr, amt] of Object.entries(inventoryByWarehouse)) {
        inventoryDebitByWh[Number(widStr)] = amt * ratio;
      }
      // Fix rounding drift on the last warehouse so debits exactly balance
      const sum = Object.values(inventoryDebitByWh).reduce((s, v) => s + v, 0);
      const drift = inventoryDebit - sum;
      if (Math.abs(drift) > 0.001) {
        const lastKey = Object.keys(inventoryDebitByWh).pop();
        if (lastKey) inventoryDebitByWh[Number(lastKey)] += drift;
      }
    }

    const desc = `قيد فاتورة مشتريات رقم ${inv.docNumber || inv.id}`;
    const debitLines: JLine[] = grnSourced
      ? [{ accountId: clearingAccId!, debit: inventoryDebit, description: "تسوية وسيط استلام البضاعة" }]
      : Object.entries(inventoryDebitByWh)
          .filter(([, amt]) => amt > 0)
          .map(([widStr, amt]) => {
            const wid = Number(widStr);
            return {
              accountId: whInfo[wid]!.accountId!,
              debit: amt,
              description: `قيمة البضاعة — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
            };
          });
    // Build credit lines. For LC-linked invoices, split the credit:
    //   - Goods portion → LC settlement account (clears the LC asset)
    //   - Expenses portion → each LC expense's clearing account
    //     (proportional to the original expense amounts; in invoice currency
    //     so the entry stays balanced)
    const expensesLoaded = Number(inv.totalExpensesLoaded || 0);
    // Credits must sum to (totalAmount + discountAmount) to balance debits
    // (= inventoryDebit + vatAmount). We credit `expensesLoaded` to the LC
    // expense clearing accounts and `discountAmount` to discount-earned, so
    // the LC settlement account absorbs the rest:
    //   goodsPortion = totalAmount - expensesLoaded
    // This is the slice of the invoice the LC actually paid on behalf of the
    // buyer (goods value plus any VAT charged by the foreign supplier — for
    // typical KSA imports the supplier VAT is zero and this collapses to pure
    // goods value). Using the same value for `recomputeLcUsage` keeps the LC
    // settlement account perfectly zero when the LC is fully drawn.
    const goodsPortion = totalAmount - expensesLoaded;
    // Guard: invoice carries loaded expenses but the LC has no expense rows
    // to credit against → JE would be unbalanced. Block with a clear message.
    if (expensesLoaded > 0 && lcExpenseRows.length === 0) {
      return res.status(400).json({
        error: "هذه الفاتورة تحتوي مصاريف اعتماد محمّلة (totalExpensesLoaded > 0) لكن الاعتماد المستندي لا يتضمن أي بنود مصاريف. أضف بنود المصاريف للاعتماد قبل الترحيل.",
      });
    }
    const creditLines: JLine[] = [];
    if (inv.lcId) {
      // Cr LC settlement account (goods portion)
      creditLines.push({
        accountId: counterpartyAccountId,
        credit: goodsPortion,
        description: `تسوية اعتماد مستندي رقم ${lcRow?.lcNumber ?? inv.lcId}`,
      });
      // Cr each LC expense's clearing account, proportional to its share
      const totalExpOrig = lcExpenseRows.reduce(
        (s, e) => s + (Number(e.amount) || 0) * (Number(e.exchangeRate) || 1),
        0,
      );
      if (expensesLoaded > 0 && totalExpOrig > 0) {
        let runningSum = 0;
        const expCredits = lcExpenseRows.map((e, idx) => {
          const baseAmt = (Number(e.amount) || 0) * (Number(e.exchangeRate) || 1);
          const share   = baseAmt / totalExpOrig;
          let portion   = +(expensesLoaded * share).toFixed(2);
          // Drift fix on last row so credits sum exactly to expensesLoaded
          if (idx === lcExpenseRows.length - 1) portion = +(expensesLoaded - runningSum).toFixed(2);
          runningSum += portion;
          return { accountId: e.accountId as number, credit: portion, description: `تسوية مصروف اعتماد — ${e.expenseType ?? ""}` };
        }).filter(l => l.credit > 0);
        creditLines.push(...expCredits);
      }
      creditLines.push({ accountId: discountAccId, credit: discountAmount, description: "خصم مكتسب" });
    } else {
      creditLines.push(
        { accountId: counterpartyAccountId,  credit: totalAmount,    description: inv.paymentType === "cash" ? "صرف نقدي" : inv.paymentType === "bank" ? "صرف بنكي" : "مستحقات المورد" },
        { accountId: discountAccId,          credit: discountAmount, description: "خصم مكتسب" },
      );
    }

    const journalId = await createJournalEntry({
      companyId:    cid,
      branchId:     inv.branchId,
      date:         inv.invoiceDate,
      docNumber:    inv.docNumber,
      description:  desc,
      entryType:    "purchase_invoice",
      exchangeRate: inv.exchangeRate,
      // Header-level cost center tags every JE line for cost-center reports.
      costCenter:   (inv as any).costCenter ?? null,
      lines: [
        ...debitLines,
        { accountId: taxAccId, debit: vatAmount, description: "ضريبة القيمة المضافة" },
        ...creditLines,
      ],
    });

    const [updated] = await db.update(purchaseInvoicesTable)
      .set({ status: "posted", journalEntryId: journalId, updatedAt: new Date() })
      .where(eq(purchaseInvoicesTable.id, id))
      .returning();

    // Auto-update LC usedAmount + status based on this newly-posted invoice
    if (inv.lcId) await recomputeLcUsage(cid, inv.lcId);

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── UNPOST purchase invoice (فك الترحيل) ───────────────────────────────────
// Reverses stock movements, zeroes-out the journal entry lines (audit trail),
// then deletes the JE and sets the invoice back to draft.
router.patch("/purchase-invoices/:id/unpost", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status !== "posted") { res.status(400).json({ error: "الفاتورة ليست مُرحَّلة" }); return; }

    // GRN-sourced invoices never touched stock (the GRN did), so there's
    // nothing in the stock ledger under refType=purchase_invoice for them
    // — the loop below is a safe no-op in that case but we short-circuit
    // to make the intent obvious.
    const grnSourced = !!(inv as any).sourceGrnId;

    // ── Reverse stock movements (delete ledger rows + decrement balances) ──
    const ledger = grnSourced ? [] : await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "purchase_invoice"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty);
      // Reverse: subtract the qty that was added (cost stays at current avg)
      const [bal] = await db.select().from(stockBalanceTable)
        .where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, row.itemId),
          eq(stockBalanceTable.warehouseId, row.warehouseId),
        ));
      if (bal) {
        await db.update(stockBalanceTable)
          .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
          .where(eq(stockBalanceTable.id, bal.id));
      }
    }
    if (!grnSourced) {
      await db.delete(stockLedgerTable)
        .where(and(
          eq(stockLedgerTable.companyId, cid),
          eq(stockLedgerTable.refType, "purchase_invoice"),
          eq(stockLedgerTable.refId, id),
        ));
    }

    // ── Zero-out the JE lines, then delete the JE ──
    if (inv.journalEntryId) {
      await db.update(journalEntryLinesTable)
        .set({ debit: "0", credit: "0" })
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, inv.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    const [updated] = await db.update(purchaseInvoicesTable)
      .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
      .where(eq(purchaseInvoicesTable.id, id))
      .returning();

    // Reverse LC consumption when an LC-linked invoice is unposted
    if (inv.lcId) await recomputeLcUsage(cid, inv.lcId);

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف فاتورة مُرحَّلة. قم بإلغاء الترحيل أولاً ثم احذفها." });
      return;
    }
    // Block deletion when purchase returns reference this invoice (FK has no
    // cascade). Tell the user clearly which returns to remove first.
    const relatedReturns = await db.select({
      id: purchaseReturnsTable.id, docNumber: purchaseReturnsTable.docNumber,
    }).from(purchaseReturnsTable).where(and(
      eq(purchaseReturnsTable.companyId, cid),
      eq(purchaseReturnsTable.invoiceId, id),
    )).limit(5);
    if (relatedReturns.length) {
      const refs = relatedReturns.map(r => r.docNumber || `#${r.id}`).join("، ");
      res.status(409).json({ error: `لا يمكن حذف هذه الفاتورة لأنها مرتبطة بمرتجع/مرتجعات مشتريات: ${refs}. يرجى حذف المرتجع أولاً.` });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "purchase_invoice", refId: id, journalEntryId: (inv as any).journalEntryId });

    // If this draft invoice was created from a GRN, restore the GRN to
    // posted (un-link it) so the user can re-issue an invoice or unpost
    // the GRN itself. Without this, a deleted draft would leave the GRN
    // permanently stuck in "invoiced" status.
    const grnId = (inv as any).sourceGrnId as number | null | undefined;
    if (grnId) {
      await db.update(goodsReceiptsTable)
        .set({ status: "posted", linkedInvoiceId: null, updatedAt: new Date() })
        .where(and(eq(goodsReceiptsTable.id, grnId), eq(goodsReceiptsTable.companyId, cid)));
    }

    // If this invoice was created by converting a purchase order, snap that
    // PO back to "confirmed" and clear its convertedInvoiceId so it doesn't
    // dangle pointing at a non-existent invoice. Without this fix the source
    // PO is stuck in "converted" forever (status badge shows "محوّلة") even
    // though no real invoice exists, blocking unconfirm / re-convert.
    const sourcePOs = await db.select({ id: purchaseOrdersTable.id })
      .from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.companyId, cid),
        eq(purchaseOrdersTable.convertedInvoiceId, id),
      ));
    if (sourcePOs.length) {
      await db.update(purchaseOrdersTable)
        .set({ status: "confirmed", convertedInvoiceId: null, updatedAt: new Date() })
        .where(and(
          eq(purchaseOrdersTable.companyId, cid),
          eq(purchaseOrdersTable.convertedInvoiceId, id),
        ));
    }

    await db.delete(purchaseInvoicesTable).where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    res.json({ ok: true, restoredPurchaseOrderIds: sourcePOs.map(p => p.id) });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// One-shot self-heal endpoint: scans for purchase orders stuck in
// status="converted" whose convertedInvoiceId no longer points to a real
// purchase invoice (the invoice was deleted before the fix above shipped),
// and snaps them back to "confirmed". Idempotent — safe to call repeatedly.
router.post("/purchase-orders/heal-orphan-converted", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const candidates = await db.select({
      id: purchaseOrdersTable.id,
      convertedInvoiceId: purchaseOrdersTable.convertedInvoiceId,
    }).from(purchaseOrdersTable).where(and(
      eq(purchaseOrdersTable.companyId, cid),
      eq(purchaseOrdersTable.status, "converted"),
    ));
    const orphanIds: number[] = [];
    for (const po of candidates) {
      if (!po.convertedInvoiceId) { orphanIds.push(po.id); continue; }
      const [inv] = await db.select({ id: purchaseInvoicesTable.id })
        .from(purchaseInvoicesTable)
        .where(and(
          eq(purchaseInvoicesTable.id, po.convertedInvoiceId),
          eq(purchaseInvoicesTable.companyId, cid),
        ));
      if (!inv) orphanIds.push(po.id);
    }
    if (orphanIds.length) {
      await db.update(purchaseOrdersTable)
        .set({ status: "confirmed", convertedInvoiceId: null, updatedAt: new Date() })
        .where(and(
          eq(purchaseOrdersTable.companyId, cid),
          inArray(purchaseOrdersTable.id, orphanIds),
        ));
    }
    res.json({ healed: orphanIds.length, orderIds: orphanIds });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE ORDERS — operational, FINANCE-FREE
// ═══════════════════════════════════════════════
// Purchase orders mirror purchase invoices for items / supplier / branch /
// totals but are intentionally INERT financially:
//   • POST / PUT / PATCH (status) / DELETE never write a journal entry, never
//     move stock, never settle a supplier balance, never create a voucher.
//   • Only POST /purchase-orders/:id/convert spawns a DRAFT purchase invoice
//     (which still needs to be posted separately to incur any finance impact).
//   • Status flow: draft → confirmed | cancelled, then confirmed → converted
//     (only via /convert; the status PATCH refuses "converted" directly).
//   • Once converted or cancelled, the order is locked against PUT/DELETE.
router.get("/purchase-orders", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }

    // Auto-heal orphan "converted" rows: any PO whose convertedInvoiceId is
    // NULL or points to a deleted purchase invoice gets snapped back to
    // "confirmed" before the listing is returned. Cheap, idempotent — no
    // user action required, fixes legacy rows on first page load.
    const stuck = await db.select({
      id: purchaseOrdersTable.id,
      convertedInvoiceId: purchaseOrdersTable.convertedInvoiceId,
    }).from(purchaseOrdersTable).where(and(
      eq(purchaseOrdersTable.companyId, cid),
      eq(purchaseOrdersTable.status, "converted"),
    ));
    if (stuck.length) {
      const refIds = Array.from(new Set(stuck.map(s => s.convertedInvoiceId).filter((v): v is number => v != null)));
      const liveInvIds = new Set<number>();
      if (refIds.length) {
        const live = await db.select({ id: purchaseInvoicesTable.id })
          .from(purchaseInvoicesTable)
          .where(and(
            eq(purchaseInvoicesTable.companyId, cid),
            inArray(purchaseInvoicesTable.id, refIds),
          ));
        live.forEach(r => liveInvIds.add(r.id));
      }
      const orphanIds = stuck
        .filter(s => s.convertedInvoiceId == null || !liveInvIds.has(s.convertedInvoiceId))
        .map(s => s.id);
      if (orphanIds.length) {
        await db.update(purchaseOrdersTable)
          .set({ status: "confirmed", convertedInvoiceId: null, updatedAt: new Date() })
          .where(and(
            eq(purchaseOrdersTable.companyId, cid),
            inArray(purchaseOrdersTable.id, orphanIds),
          ));
      }
    }

    const rows = await db.select().from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.companyId, cid),
        ...branchScopeSpread(req, purchaseOrdersTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(purchaseOrdersTable.orderDate));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/purchase-orders/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [ord] = await db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!ord) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    const lines = await db.select().from(purchaseOrderLinesTable)
      .where(eq(purchaseOrderLinesTable.orderId, id))
      .orderBy(asc(purchaseOrderLinesTable.id));
    res.json({ ...ord, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-orders", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, supplierInvoiceNumber, orderDate, expectedDeliveryDate,
            supplierId, branchId, paymentType, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount,
            notes, lines, priceIncludesVat } = req.body;
    if (!orderDate)  { res.status(400).json({ error: "تاريخ الأمر مطلوب" }); return; }
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد" }); return; }

    let resolvedDocNumber: string | null = (docNumber && String(docNumber).trim()) || null;
    if (!resolvedDocNumber) {
      try {
        resolvedDocNumber = await nextSequenceNumber(cid, "purchase_order", {
          userId:   (req as any).authUser?.id ?? null,
          refTable: "purchase_orders",
          branchId: branchId ? Number(branchId) : null,
        });
      } catch (seqErr: any) {
        res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم الأمر" });
        return;
      }
    }

    const [ord] = await db.insert(purchaseOrdersTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      orderDate,
      expectedDeliveryDate: expectedDeliveryDate || null,
      supplierId: Number(supplierId),
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      status: "draft",
      notes: notes || null,
    }).returning();
    if (lines?.length) {
      await db.insert(purchaseOrderLinesTable).values(
        lines.map((l: any) => ({
          orderId: ord.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null,
          unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          qty: String(l.qty || "1"),
          freeQty: String(l.freeQty || "0"),
          weight: String(l.weight || "0"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || "15"),
          lineTotal: String(l.lineTotal || "0"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(ord);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/purchase-orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select({ status: purchaseOrdersTable.status })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    if (existing.status === "converted" || existing.status === "cancelled") {
      res.status(409).json({ error: "لا يمكن تعديل أمر شراء محوّل أو ملغي" });
      return;
    }
    // docNumber is intentionally not destructured — immutable on edit.
    const { supplierInvoiceNumber, orderDate, expectedDeliveryDate,
            supplierId, branchId, paymentType, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount,
            notes, lines, priceIncludesVat } = req.body;
    if (!orderDate)  { res.status(400).json({ error: "تاريخ الأمر مطلوب" }); return; }
    if (!supplierId) { res.status(400).json({ error: "يجب اختيار المورد" }); return; }
    const [ord] = await db.update(purchaseOrdersTable).set({
      branchId: branchId ? Number(branchId) : null,
      supplierInvoiceNumber: supplierInvoiceNumber || null,
      orderDate,
      expectedDeliveryDate: expectedDeliveryDate || null,
      supplierId: Number(supplierId),
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid))).returning();
    if (!ord) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    if (lines !== undefined) {
      await db.delete(purchaseOrderLinesTable).where(eq(purchaseOrderLinesTable.orderId, id));
      if (lines.length) {
        await db.insert(purchaseOrderLinesTable).values(
          lines.map((l: any) => ({
            orderId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null,
            unit: l.unit || null,
            unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            qty: String(l.qty || "1"),
            freeQty: String(l.freeQty || "0"),
            weight: String(l.weight || "0"),
            unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            vatRate: String(l.vatRate || "15"),
            lineTotal: String(l.lineTotal || "0"),
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
            notes: l.notes || null,
          }))
        );
      }
    }
    res.json(ord);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/purchase-orders/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { status } = req.body as { status?: string };
    // The /convert endpoint is the ONLY way to land in "converted". This
    // PATCH is for user-driven workflow transitions (confirm / cancel).
    const allowed = ["draft", "confirmed", "cancelled"] as const;
    if (!status || !allowed.includes(status as any)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }
    const [existing] = await db.select({ status: purchaseOrdersTable.status })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    if (existing.status === "converted") {
      res.status(409).json({ error: "تم تحويل الأمر إلى فاتورة بالفعل" }); return;
    }
    const [ord] = await db.update(purchaseOrdersTable)
      .set({ status: status as any, updatedAt: new Date() })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)))
      .returning();
    res.json(ord);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-orders/:id/convert", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ord] = await db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!ord) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    if (ord.status !== "confirmed") {
      res.status(409).json({ error: "يجب تأكيد الأمر قبل تحويله إلى فاتورة" }); return;
    }
    if (ord.convertedInvoiceId) {
      res.status(409).json({ error: "تم تحويل الأمر إلى فاتورة بالفعل" }); return;
    }
    const lines = await db.select().from(purchaseOrderLinesTable)
      .where(and(
        eq(purchaseOrderLinesTable.orderId, id),
        eq(purchaseOrderLinesTable.companyId, cid),
      ))
      .orderBy(asc(purchaseOrderLinesTable.id));

    // Issue a NEW invoice docNumber from the purchase_invoice sequence
    // (independent counter — orders and invoices have separate sequences).
    let invDocNumber: string | null = null;
    try {
      invDocNumber = await nextSequenceNumber(cid, "purchase_invoice", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "purchase_invoices",
        branchId: ord.branchId ?? null,
      });
    } catch { invDocNumber = null; }

    const pType = ord.paymentType || "credit";

    // Currency conversion: when the PO is in a foreign currency, materialise
    // the resulting purchase invoice in the company's BASE currency by
    // multiplying every monetary field by the PO's exchange rate. The
    // resulting invoice carries currencyCode=base / exchangeRate=1 so all
    // downstream reports, JEs, and totals show base-currency values
    // (e.g. PO 100 USD × 3.75 ⇒ invoice subtotal 375 SAR).
    const baseCurrency = await getBaseCurrencyCode(cid);
    const fxRate = Number(ord.exchangeRate ?? "1") || 1;
    const isForeign = !!ord.currencyCode && ord.currencyCode !== baseCurrency && fxRate !== 1;
    const conv = (v: any): string => {
      const n = Number(v ?? "0");
      if (!isForeign) return String(v ?? "0");
      // Round to 4 dp on line-level fields, 2 dp on totals — but use a single
      // rounding here (4 dp) and let the form's display format handle the rest.
      return (n * fxRate).toFixed(4);
    };

    const [inv] = await db.insert(purchaseInvoicesTable).values({
      companyId: cid,
      branchId: ord.branchId ?? null,
      docNumber: invDocNumber,
      supplierInvoiceNumber: ord.supplierInvoiceNumber ?? null,
      invoiceDate: ord.orderDate,
      supplierId: ord.supplierId,
      // Carry the payment-type intent over but DO NOT auto-pick cash/bank
      // accounts here — those are operator choices made when posting.
      paymentType: pType,
      cashBoxId: null,
      bankAccountId: null,
      currencyCode: isForeign ? baseCurrency : ord.currencyCode,
      exchangeRate: isForeign ? "1" : ord.exchangeRate,
      lcId: null,
      distributionMethod: "value",
      subtotal: conv(ord.subtotal),
      vatAmount: conv(ord.vatAmount),
      discountAmount: conv(ord.discountAmount),
      totalExpensesLoaded: "0",
      totalAmount: conv(ord.totalAmount),
      priceIncludesVat: ord.priceIncludesVat,
      status: "draft",
      notes: isForeign
        ? [ord.notes, `(محوَّل من أمر شراء بعملة ${ord.currencyCode} بسعر صرف ${fxRate} ⇒ ${baseCurrency})`].filter(Boolean).join("\n")
        : ord.notes,
    }).returning();
    if (lines.length) {
      await db.insert(purchaseInvoiceLinesTable).values(
        lines.map(l => ({
          invoiceId: inv.id, companyId: cid,
          itemId: l.itemId, itemName: l.itemName, itemCode: l.itemCode,
          unit: l.unit, unitId: l.unitId,
          conversionFactor: l.conversionFactor ?? "1",
          qty: l.qty, freeQty: l.freeQty ?? "0", weight: l.weight ?? "0",
          unitPrice: conv(l.unitPrice),
          discount: conv(l.discount ?? "0"),
          vatRate: l.vatRate ?? "15",
          lineTotal: conv(l.lineTotal),
          expenseShare: "0",
          finalCost: "0",
          accountId: null,
          warehouseId: l.warehouseId,
          notes: l.notes,
        }))
      );
    }

    await db.update(purchaseOrdersTable)
      .set({ status: "converted", convertedInvoiceId: inv.id, updatedAt: new Date() })
      .where(eq(purchaseOrdersTable.id, id));

    res.status(201).json({ orderId: id, invoiceId: inv.id, invoice: inv });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/purchase-orders/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ord] = await db.select({ status: purchaseOrdersTable.status })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid)));
    if (!ord) { res.status(404).json({ error: "أمر الشراء غير موجود" }); return; }
    // Mirror PUT/edit lock: orders that are no longer in a mutable state
    // (converted to an invoice, or explicitly cancelled) cannot be deleted.
    // Cancelled rows stay around as an audit trail of the cancellation.
    if (ord.status === "converted") {
      res.status(409).json({ error: "لا يمكن حذف أمر شراء محوّل إلى فاتورة" });
      return;
    }
    if (ord.status === "cancelled") {
      res.status(409).json({ error: "لا يمكن حذف أمر شراء ملغي" });
      return;
    }
    await db.delete(purchaseOrderLinesTable).where(eq(purchaseOrderLinesTable.orderId, id));
    await db.delete(purchaseOrdersTable).where(and(
      eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.companyId, cid),
    ));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE RETURNS
// ═══════════════════════════════════════════════
router.get("/purchase-returns", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(purchaseReturnsTable)
      .where(and(
        eq(purchaseReturnsTable.companyId, cid),
        ...branchScopeSpread(req, purchaseReturnsTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(purchaseReturnsTable.returnDate));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.get("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    const id = Number(req.params.id);
    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), cid ? eq(purchaseReturnsTable.companyId, cid) : sql`true`));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    const lines = await db.select().from(purchaseReturnLinesTable)
      .where(eq(purchaseReturnLinesTable.returnId, id))
      .orderBy(asc(purchaseReturnLinesTable.id));
    res.json({ ...ret, lines });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/purchase-returns", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, supplierInvoiceNumber, returnDate, supplierId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId,
            currencyCode, exchangeRate, totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند استرداد المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند استرداد المبلغ بنكياً" }); return; }
    if (pType === "credit" && !supplierId) { res.status(400).json({ error: "يجب اختيار المورد عند تسوية المرتجع على الحساب" }); return; }
    // Central sequence engine is authoritative when an active sequence
    // exists for "purchase_return"; otherwise fall back to client-supplied
    // value or null. Server allocation is atomic so concurrent submits
    // can never persist the same number.
    let resolvedDocNumber: string | null;
    try {
      const fromSeq = await nextSequenceNumber(cid, "purchase_return", {
        userId:   (req as any).authUser?.id ?? null,
        refTable: "purchase_returns",
        branchId: branchId ? Number(branchId) : null,
      });
      resolvedDocNumber = fromSeq ?? ((docNumber && String(docNumber).trim()) || null);
    } catch (seqErr: any) {
      res.status(400).json({ error: seqErr?.message ?? "تعذر توليد رقم المرتجع" });
      return;
    }
    const [ret] = await db.insert(purchaseReturnsTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: resolvedDocNumber, supplierInvoiceNumber: supplierInvoiceNumber || null, returnDate,
      supplierId: supplierId ? Number(supplierId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: String(totalAmount || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      status: "draft", notes: notes || null,
    }).returning();
    if (lines?.length) {
      await db.insert(purchaseReturnLinesTable).values(
        lines.map((l: any) => ({
          returnId: ret.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"),
          freeQty: String(l.freeQty || "0"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || "15"),
          lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(ret);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.put("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    // docNumber is intentionally not destructured — immutable on edit.
    const { supplierInvoiceNumber, returnDate, supplierId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId,
            currencyCode, exchangeRate, totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId } = req.body;
    const [existing] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (existing.status === "posted") { res.status(400).json({ error: "لا يمكن تعديل مرتجع مُرحَّل. قم بفك الترحيل أولاً." }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند استرداد المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند استرداد المبلغ بنكياً" }); return; }
    if (pType === "credit" && !supplierId) { res.status(400).json({ error: "يجب اختيار المورد عند تسوية المرتجع على الحساب" }); return; }
    // docNumber is intentionally omitted — once assigned, it is immutable.
    const [ret] = await db.update(purchaseReturnsTable).set({
      branchId: branchId ? Number(branchId) : null,
      supplierInvoiceNumber: supplierInvoiceNumber || null, returnDate,
      supplierId: supplierId ? Number(supplierId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: String(totalAmount || "0"),
      vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid))).returning();
    if (lines !== undefined) {
      await db.delete(purchaseReturnLinesTable).where(eq(purchaseReturnLinesTable.returnId, id));
      if (lines.length) {
        await db.insert(purchaseReturnLinesTable).values(
          lines.map((l: any) => ({
            returnId: id, companyId: cid,
            itemId: l.itemId ? Number(l.itemId) : null,
            itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
            unitId: l.unitId ? Number(l.unitId) : null,
            conversionFactor: String(l.conversionFactor || "1"),
            warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
            qty: String(l.qty || "1"),
            freeQty: String(l.freeQty || "0"),
            unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            vatRate: String(l.vatRate || "15"),
            lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
          }))
        );
      }
    }
    res.json(ret);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/purchase-returns/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") { res.status(400).json({ error: "المرتجع مُرحَّل مسبقاً" }); return; }

    const lines = await db.select().from(purchaseReturnLinesTable)
      .where(eq(purchaseReturnLinesTable.returnId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في المرتجع" }); return; }

    const noWh = lines.filter(l => l.itemId && !l.warehouseId);
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Load warehouse info (account + allow-negative)
    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // Validate stock availability first — purchase returns ship goods OUT to the supplier
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const wh = whInfo[line.warehouseId];
      if (wh?.allowNegative) continue;
      const factor = Number(line.conversionFactor || "1") || 1;
      // Returning paid qty + free qty back to supplier — both leave stock.
      const qty = (Number(line.qty) + Number(line.freeQty || 0)) * factor;
      const cur = await getBalance(cid, line.itemId, line.warehouseId);
      if (cur < qty) {
        res.status(400).json({
          error: `رصيد الصنف "${line.itemName}" غير كافٍ في مخزن "${wh?.nameAr ?? line.warehouseId}" — المتاح ${cur} والمطلوب ${qty}. فعّل خاصية "السماح بالسالب" على المخزن إن كنت ترغب بتجاوز الرصيد.`,
        });
        return;
      }
    }

    // Decrease stock for each stockable return line (in base units), accumulate per-warehouse credits
    const inventoryByWarehouse: Record<number, number> = {};
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor   = Number(line.conversionFactor || "1") || 1;
      // Inventory credit covers BOTH paid and free units leaving the warehouse.
      // Cost-per-unit for the JE is derived from the paid line value spread
      // across the full physical quantity (paid + free) — same averaging
      // principle as the purchase-invoice posting that received them.
      const paidQty  = Number(line.qty) * factor;
      const freeQ    = Number(line.freeQty || 0) * factor;
      const qty      = paidQty + freeQ;
      const lineDisc = Math.max(0, Math.min(100, Number((line as any).discount) || 0));
      const paidLineValue = Number(line.unitPrice) * Number(line.qty) * (1 - lineDisc / 100);
      const costUnit = qty > 0 ? paidLineValue / qty : 0;
      inventoryByWarehouse[line.warehouseId] = (inventoryByWarehouse[line.warehouseId] ?? 0) + qty * costUnit;

      await upsertBalance(cid, line.itemId, line.warehouseId, -qty, costUnit);
      const newBal = await getBalance(cid, line.itemId, line.warehouseId);
      await addStockLedgerEntry({
        companyId:   cid,
        itemId:      line.itemId,
        warehouseId: line.warehouseId,
        txDate:      ret.returnDate,
        txType:      "purchase_return",
        qty:         String(-qty),
        costPrice:   String(costUnit.toFixed(4)),
        totalCost:   String((-qty * costUnit).toFixed(2)),
        balanceQty:  String(newBal),
        refId:       id,
        refType:     "purchase_return",
        notes:       line.notes ?? undefined,
      });
    }

    // ── Create journal entry (قيد محاسبي) — reverse of purchase invoice ──
    // Dr Supplier/Cash    = totalAmount  (we get the money/credit back)
    // Dr Discount Earned  = discountAmount (reverse the discount)
    // Cr Inventory        = subtotal     (goods leaving stock)
    // Cr VAT Input        = vatAmount    (reverse the input VAT)
    const totalAmount    = Number(ret.totalAmount    || 0);
    const vatAmount      = Number(ret.vatAmount      || 0);
    const discountAmount = Number((ret as any).discountAmount || 0);
    const subtotal       = totalAmount - vatAmount + discountAmount;

    const mapPr = await loadMappings(cid, "purchase_return");
    const taxAccId      = pickAccount((ret as any).taxAccountId,      mapPr("purchase_return", "vat_input"));
    const discountAccId = pickAccount((ret as any).discountAccountId, mapPr("purchase_return", "discount"));

    const counterpartyAccountId =
      ret.paymentType === "cash" ? await getCashBoxAccountId(cid, ret.cashBoxId)
      : ret.paymentType === "bank" ? await getBankAccountAccountId(cid, (ret as any).bankAccountId)
      : await getSupplierAccountId(cid, ret.supplierId);

    const missing: string[] = [];
    if (vatAmount > 0 && !taxAccId) missing.push("حساب الضرائب (مدخلات)");
    if (discountAmount > 0 && !discountAccId) missing.push("حساب الخصم المكتسب");
    if (!counterpartyAccountId) missing.push(ret.paymentType === "cash" ? "حساب الخزنة" : ret.paymentType === "bank" ? "الحساب البنكي" : "حساب المورد");
    // Inventory account derived from warehouse — verify each used warehouse has one
    const missingWh: string[] = [];
    for (const [widStr, amt] of Object.entries(inventoryByWarehouse)) {
      if (amt <= 0) continue;
      const wid = Number(widStr);
      if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
    }
    if (missingWh.length) missing.push(`حساب المخزون لـ: ${missingWh.join("، ")}`);
    if (missing.length) {
      throw new Error(`يجب تحديد الحسابات التالية قبل الترحيل: ${missing.join("، ")}`);
    }

    // Scale per-warehouse credits so they sum to the JE subtotal (handles rounding/discount differences)
    const goodsCostTotal = Object.values(inventoryByWarehouse).reduce((s, v) => s + v, 0);
    const inventoryCreditByWh: Record<number, number> = {};
    if (goodsCostTotal > 0) {
      const ratio = subtotal / goodsCostTotal;
      for (const [widStr, amt] of Object.entries(inventoryByWarehouse)) {
        inventoryCreditByWh[Number(widStr)] = amt * ratio;
      }
      const sum = Object.values(inventoryCreditByWh).reduce((s, v) => s + v, 0);
      const drift = subtotal - sum;
      if (Math.abs(drift) > 0.001) {
        const lastKey = Object.keys(inventoryCreditByWh).pop();
        if (lastKey) inventoryCreditByWh[Number(lastKey)] += drift;
      }
    }

    const desc = `قيد مرتجع مشتريات رقم ${ret.docNumber || ret.id}`;
    const journalId = await createJournalEntry({
      companyId:    cid,
      branchId:     ret.branchId,
      date:         ret.returnDate,
      docNumber:    ret.docNumber,
      description:  desc,
      entryType:    "purchase_return",
      exchangeRate: ret.exchangeRate,
      // Inherit cost center from the original invoice when set so the
      // return tags the same CC as the purchase it reverses.
      costCenter:   (ret as any).costCenter ?? null,
      lines: [
        { accountId: counterpartyAccountId,           debit:  totalAmount,    description: ret.paymentType === "cash" ? "استرداد نقدي" : ret.paymentType === "bank" ? "استرداد بنكي" : "تخفيض رصيد المورد" },
        { accountId: discountAccId,                   debit:  discountAmount, description: "إلغاء خصم مكتسب" },
        // Inventory: one credit line per warehouse using its own GL account
        ...Object.entries(inventoryCreditByWh)
          .filter(([, amt]) => amt > 0)
          .map(([widStr, amt]) => {
            const wid = Number(widStr);
            return {
              accountId: whInfo[wid]!.accountId!,
              credit: amt,
              description: `ارتجاع البضاعة — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
            };
          }),
        { accountId: (ret as any).taxAccountId,       credit: vatAmount,      description: "إلغاء ضريبة القيمة المضافة" },
      ],
    });

    const [updated] = await db.update(purchaseReturnsTable)
      .set({ status: "posted", journalEntryId: journalId, updatedAt: new Date() })
      .where(eq(purchaseReturnsTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ─── UNPOST purchase return (فك الترحيل) ────────────────────────────────────
router.patch("/purchase-returns/:id/unpost", requireAdminRole, async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status !== "posted") { res.status(400).json({ error: "المرتجع ليس مُرحَّلاً" }); return; }

    // Reverse stock movements (returns reduce stock; unposting adds it back)
    const ledger = await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "purchase_return"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty);
      const [bal] = await db.select().from(stockBalanceTable)
        .where(and(
          eq(stockBalanceTable.companyId, cid),
          eq(stockBalanceTable.itemId, row.itemId),
          eq(stockBalanceTable.warehouseId, row.warehouseId),
        ));
      if (bal) {
        await db.update(stockBalanceTable)
          .set({ qty: String(Number(bal.qty) - qty), updatedAt: new Date() })
          .where(eq(stockBalanceTable.id, bal.id));
      }
    }
    await db.delete(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "purchase_return"),
        eq(stockLedgerTable.refId, id),
      ));

    if (ret.journalEntryId) {
      await db.update(journalEntryLinesTable)
        .set({ debit: "0", credit: "0" })
        .where(eq(journalEntryLinesTable.entryId, ret.journalEntryId));
      await db.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, ret.journalEntryId));
      await db.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, ret.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    const [updated] = await db.update(purchaseReturnsTable)
      .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
      .where(eq(purchaseReturnsTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ret] = await db.select().from(purchaseReturnsTable)
      .where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف مرتجع مُرحَّل. قم بإلغاء الترحيل أولاً ثم احذفه." });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "purchase_return", refId: id, journalEntryId: (ret as any).journalEntryId });
    await db.delete(purchaseReturnsTable).where(and(eq(purchaseReturnsTable.id, id), eq(purchaseReturnsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// SUPPLIER SETTLEMENTS
// ═══════════════════════════════════════════════
router.get("/supplier-settlements", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(supplierSettlementsTable)
      .where(eq(supplierSettlementsTable.companyId, cid))
      .orderBy(desc(supplierSettlementsTable.settlementDate));
    res.json(rows);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.post("/supplier-settlements", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, settlementDate, supplierId, paymentMethod, accountId,
            amount, currencyCode, exchangeRate, notes } = req.body;
    if (!settlementDate || !amount) {
      res.status(400).json({ error: "التاريخ والمبلغ مطلوبان" }); return;
    }
    const [row] = await db.insert(supplierSettlementsTable).values({
      companyId: cid, docNumber: docNumber || null, settlementDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paymentMethod: paymentMethod || "bank",
      accountId: accountId ? Number(accountId) : null,
      amount: String(amount), currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      status: "draft", notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.patch("/supplier-settlements/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(supplierSettlementsTable)
      .set({ status: "posted", updatedAt: new Date() })
      .where(and(eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

router.delete("/supplier-settlements/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(supplierSettlementsTable).where(and(eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ── AI-generated journal entry for a Letter of Credit ───────────────────
router.post("/letters-of-credit/:id/ai-journal", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const save = !!req.body?.save;

    const [lc] = await db.select().from(lettersOfCreditTable)
      .where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    const expenses = await db.select().from(lcExpensesTable).where(eq(lcExpensesTable.lcId, id));

    let supplierName = "—", supplierAccountId: number | null = null;
    if (lc.supplierId) {
      const [s] = await db.select().from(suppliersTable)
        .where(and(eq(suppliersTable.id, lc.supplierId), eq(suppliersTable.companyId, cid)));
      supplierName = s?.nameAr ?? "—";
      supplierAccountId = s?.accountId ?? null;
    }

    const { accountsTable } = await import("@workspace/db");
    const dbAccounts = await db.select().from(accountsTable)
      .where(and(eq(accountsTable.companyId, cid), eq(accountsTable.isActive, true)));
    const postable = dbAccounts.filter(a => a.isPosting !== false);
    if (postable.length < 2) { res.status(400).json({ error: "شجرة الحسابات غير مهيأة" }); return; }

    const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!OPENAI_BASE || !OPENAI_KEY) { res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" }); return; }

    // Convert all amounts to the company's base/functional currency (IAS 21).
    // The journal entry MUST be posted in the base currency only; the original
    // foreign-currency values are kept as informational context for the AI.
    const baseCurrency = await getBaseCurrencyCode(cid);
    const lcRate       = Number(lc.exchangeRate ?? "1") || 1;
    const lcTotalBase  = +(Number(lc.totalAmount ?? 0) * lcRate).toFixed(2);
    const expensesBase = expenses.map(e => {
      const r = Number(e.exchangeRate ?? "1") || 1;
      const a = Number(e.amount       ?? "0") || 0;
      return { ...e, amountBase: +(a * r).toFixed(2), rate: r };
    });

    const accountList = postable.slice(0, 400).map(a =>
      `- id=${a.id} | ${a.code} | ${a.nameAr} | ${a.accountType}`
    ).join("\n");
    const expList = expensesBase.length
      ? expensesBase.map((e, i) =>
          `  ${i + 1}) ${e.expenseType || "—"} — ${Number(e.amount || 0)} ${e.currencyCode || baseCurrency} × ${e.rate} = ${e.amountBase} ${baseCurrency}${e.accountId ? ` (حساب مقترح id=${e.accountId})` : ""}`
        ).join("\n")
      : "  (لا توجد مصاريف مسجلة)";

    const prompt = `أنت محاسب سعودي خبير. مطلوب إنشاء قيد محاسبي متوازن (debit = credit) يعكس فتح اعتماد مستندي وتسجيل مصاريف الاستيراد المرتبطة به.

⚠️ مهم جداً: العملة الأساسية للشركة هي ${baseCurrency}. كل المبالغ في القيد يجب أن تكون بالعملة الأساسية ${baseCurrency} بعد التحويل بسعر الصرف. لا تستخدم المبالغ الأصلية بالعملة الأجنبية. (وفق IAS 21)

بيانات الاعتماد:
- رقم الاعتماد: ${lc.lcNumber}
- التاريخ: ${lc.lcDate}
- المورد: ${supplierName}${supplierAccountId ? ` (حساب مورد id=${supplierAccountId})` : ""}
- البنك: ${lc.bankName || "—"}
- العملة الأصلية: ${lc.currencyCode}
- سعر الصرف: ${lcRate}  (1 ${lc.currencyCode} = ${lcRate} ${baseCurrency})
- قيمة الاعتماد الأصلية: ${Number(lc.totalAmount)} ${lc.currencyCode}
- قيمة الاعتماد بالعملة الأساسية: ${lcTotalBase} ${baseCurrency}  ← استخدم هذه القيمة في القيد

مصاريف الاستيراد (الأرقام بعد علامة "=" هي القيم بالعملة الأساسية ${baseCurrency} وهي التي تُستخدم في القيد):
${expList}

إجمالي المصاريف بالعملة الأساسية: ${expensesBase.reduce((s, e) => s + e.amountBase, 0).toFixed(2)} ${baseCurrency}

شجرة الحسابات المتاحة (استخدم id الرقمي فقط):
${accountList}

المبادئ المحاسبية لفتح الاعتماد المستندي:
1) عند فتح الاعتماد: مدين "اعتمادات مستندية" أو "بضاعة بالطريق" بقيمة الاعتماد بالعملة الأساسية، دائن "البنك" أو "هامش اعتماد" بنفس القيمة.
2) كل مصروف استيراد: مدين الحساب المحدد له (أو حساب "مصاريف استيراد") بقيمة المصروف بالعملة الأساسية، دائن "البنك" أو "الموردون" بنفس القيمة.
3) اختر أنسب حساب موجود فعلياً في القائمة؛ لا تخترع أرقاماً.
4) يجب أن يكون مجموع المدين = مجموع الدائن بالضبط، وكلها بالعملة الأساسية ${baseCurrency}.

أرجع JSON فقط بالشكل التالي (بدون أي نص قبله أو بعده):
{
  "description": "<وصف عربي مختصر للقيد>",
  "lines": [
    {"accountId": <id>, "debit": <رقم>, "credit": 0, "description": "<وصف مختصر>"},
    {"accountId": <id>, "debit": 0, "credit": <رقم>, "description": "<وصف مختصر>"}
  ],
  "reasoning": "<شرح موجز بالعربية لاختيار الحسابات>"
}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    let aiRes: Response;
    try {
      aiRes = await fetch(`${OPENAI_BASE.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "أنت محاسب سعودي. أعد JSON صالحاً فقط بدون أي نص إضافي." },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      const msg = e?.name === "AbortError" ? "انتهت مهلة الذكاء الاصطناعي" : "تعذّر الاتصال بالذكاء الاصطناعي";
      res.status(502).json({ error: msg }); return;
    }
    clearTimeout(timer);
    if (!aiRes.ok) { res.status(502).json({ error: "فشل الاتصال بالذكاء الاصطناعي" }); return; }

    const data = await aiRes.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch {}

    const rawLines: any[] = Array.isArray(parsed.lines) ? parsed.lines : [];
    const accMap = new Map(postable.map(a => [a.id, a]));
    const linesValidated = rawLines
      .map(l => ({
        accountId: Number(l.accountId) || null,
        debit:  Math.max(0, Number(l.debit  || 0)),
        credit: Math.max(0, Number(l.credit || 0)),
        description: String(l.description || "").slice(0, 200),
      }))
      .filter(l => l.accountId && accMap.has(l.accountId) && (l.debit > 0 || l.credit > 0));

    if (linesValidated.length < 2) {
      res.status(422).json({ error: "الذكاء الاصطناعي لم يُنتج قيداً صالحاً", raw: parsed }); return;
    }
    const totalDebit  = linesValidated.reduce((s, l) => s + l.debit,  0);
    const totalCredit = linesValidated.reduce((s, l) => s + l.credit, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(422).json({ error: `القيد غير متوازن: ${totalDebit.toFixed(2)} ≠ ${totalCredit.toFixed(2)}`, preview: { lines: linesValidated } });
      return;
    }

    const linesOut = linesValidated.map(l => {
      const a = accMap.get(l.accountId!)!;
      return { ...l, accountCode: a.code, accountNameAr: a.nameAr };
    });
    const description = String(parsed.description || `قيد اعتماد مستندي ${lc.lcNumber}`).slice(0, 300);
    const reasoning = String(parsed.reasoning || "").slice(0, 1000);

    if (!save) {
      res.json({ preview: true, description, reasoning, lines: linesOut, totalDebit, totalCredit });
      return;
    }

    const entryId = await createJournalEntry({
      companyId: cid,
      date: lc.lcDate,
      description,
      docNumber: `LC-${lc.lcNumber}`,
      entryType: "general",
      exchangeRate: "1",
      lines: linesValidated.map(l => ({
        accountId: l.accountId,
        debit:  l.debit,
        credit: l.credit,
        description: l.description,
      })),
    });
    res.json({ saved: true, entryId, description, reasoning, lines: linesOut, totalDebit, totalCredit });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

// ── AI explanation for Letters of Credit ───────────────────────────────
router.post("/letters-of-credit/ai-explain", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const lc = req.body?.lc ?? {};
    const expenses: any[] = Array.isArray(req.body?.expenses) ? req.body.expenses : [];
    const supplierName = String(req.body?.supplierName ?? "—");

    const OPENAI_BASE = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const OPENAI_KEY  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!OPENAI_BASE || !OPENAI_KEY) {
      res.status(500).json({ error: "خدمة الذكاء الاصطناعي غير مهيأة" });
      return;
    }

    const totalAmt = Number(lc.totalAmount || 0);
    const totalExp = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
    const remaining = totalAmt - totalExp;
    const expList = expenses.length
      ? expenses.map((e, i) => `  ${i + 1}) ${e.expenseType || "—"} — ${Number(e.amount || 0)} ${e.currencyCode || "SAR"}`).join("\n")
      : "  (لا توجد مصاريف مسجلة)";

    const prompt = `أنت خبير في التمويل التجاري والاعتمادات المستندية (Letter of Credit) في المملكة العربية السعودية.
اشرح للمستخدم هذا الاعتماد المستندي بلغة عربية واضحة وبسيطة، ثم قدّم توصيات عملية.

بيانات الاعتماد:
- رقم الاعتماد: ${lc.lcNumber || "—"}
- التاريخ: ${lc.lcDate || "—"}
- المورد: ${supplierName}
- البنك: ${lc.bankName || "—"}
- العملة: ${lc.currencyCode || "SAR"}
- قيمة الاعتماد: ${totalAmt}
- إجمالي المصاريف المسجلة: ${totalExp}
- المتبقي: ${remaining}
- ملاحظات: ${lc.notes || "—"}

مصاريف الاستيراد المرتبطة:
${expList}

أرجع JSON فقط بالشكل:
{
  "summary": "<فقرة قصيرة 2-3 أسطر تشرح ما هو الاعتماد المستندي بشكل عام>",
  "currentState": "<تحليل مختصر للحالة الحالية لهذا الاعتماد — مفتوح/مستخدم جزئياً/مغلق وما الذي يعنيه ذلك>",
  "expensesInsight": "<ملاحظات على توزيع المصاريف وما قد يكون ناقصاً (شحن/جمارك/تأمين/رسوم بنكية)>",
  "recommendations": ["<توصية عملية 1>", "<توصية عملية 2>", "<توصية عملية 3>"]
}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let aiRes: Response;
    try {
      aiRes = await fetch(`${OPENAI_BASE.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "أنت مستشار تمويل تجاري. أعد JSON صالحاً فقط بالعربية." },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      const msg = e?.name === "AbortError" ? "انتهت مهلة الذكاء الاصطناعي" : "تعذّر الاتصال بالذكاء الاصطناعي";
      res.status(502).json({ error: msg });
      return;
    }
    clearTimeout(timer);
    if (!aiRes.ok) { res.status(502).json({ error: "فشل الاتصال بالذكاء الاصطناعي" }); return; }

    const data = await aiRes.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch {}

    res.json({
      summary: String(parsed.summary || "").slice(0, 2000),
      currentState: String(parsed.currentState || "").slice(0, 2000),
      expensesInsight: String(parsed.expensesInsight || "").slice(0, 2000),
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 8).map((r: any) => String(r).slice(0, 500))
        : [],
    });
  } catch (e: any) { res.status(e?.status ?? 500).json({ error: e.message }); }
});

export default router;
