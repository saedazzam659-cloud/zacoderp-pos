import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable, salesReturnLinesTable,
  salesQuotationsTable, salesQuotationLinesTable,
  customerSettlementsTable, stockBalanceTable, stockLedgerTable,
  customersTable, cashBoxesTable, bankAccountsTable, warehousesTable,
  journalEntriesTable, journalEntryLinesTable,
  receiptVouchersTable, paymentVouchersTable,
  salesRepsTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId, pushBranchScope, branchScopeSpread, branchScopeFilter } from "../middleware/auth.js";
import { pathRbac } from "../middleware/permissions.js";
import { upsertBalance, getBalance, addStockLedgerEntry } from "../lib/stockHelpers.js";
import { createPostedPaymentVoucher, createPostedReceiptVoucher } from "../lib/cashVouchers.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";

// ─── Journal entry helper (mirrors purchasing.ts) ────────────────────────────
type JLine = { accountId: number | null; debit?: number; credit?: number; description?: string | null };
async function createJournalEntry(opts: {
  companyId: number;
  branchId?: number | null;
  date: string;
  description: string;
  docNumber?: string | null;
  entryType?: string;
  exchangeRate?: string | null;
  lines: JLine[];
}): Promise<number> {
  const cleanLines = opts.lines.filter(l => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0));
  if (cleanLines.length < 2) throw new Error("القيد المحاسبي يحتاج إلى طرفين على الأقل");
  const totalDebit  = cleanLines.reduce((s, l) => s + (l.debit  ?? 0), 0);
  const totalCredit = cleanLines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)}`);
  }
  const [entry] = await db.insert(journalEntriesTable).values({
    companyId: opts.companyId, branchId: opts.branchId ?? null,
    docNumber: opts.docNumber ?? null, entryDate: opts.date,
    currency: "SAR", exchangeRate: opts.exchangeRate ?? "1",
    description: opts.description, entryType: opts.entryType ?? "general",
    status: "posted",
  }).returning();
  await db.insert(journalEntryLinesTable).values(
    cleanLines.map((l, i) => ({
      entryId: entry.id, accountId: l.accountId!,
      debit: String((l.debit ?? 0).toFixed(2)),
      credit: String((l.credit ?? 0).toFixed(2)),
      description: l.description ?? opts.description, sortOrder: i,
    }))
  );
  return entry.id;
}

async function getCustomerAccountId(cid: number, customerId: number | null | undefined): Promise<number | null> {
  if (!customerId) return null;
  const [c] = await db.select().from(customersTable)
    .where(and(eq(customersTable.id, customerId), eq(customersTable.companyId, cid)));
  return c?.accountId ?? null;
}
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

/**
 * Resolve the rep's commission% (snapshot) and compute commissionAmount = totalAmount × pct/100.
 * Returns string "0" for the numeric fields (NEVER null — schema is NOT NULL with default "0").
 * Returns salesRepId=null when no rep / inactive rep / wrong company; in that case both numerics
 * are "0". For commissionType="collection" the snapshot pct is preserved but invoice-time
 * commissionAmount is "0" (collection commission is computed at receipt time from receipts).
 */
async function resolveRepCommission(
  cid: number,
  salesRepId: number | string | null | undefined,
  totalAmount: number | string | null | undefined,
): Promise<{ salesRepId: number | null; commissionPct: string; commissionAmount: string }> {
  const rid = salesRepId ? Number(salesRepId) : null;
  if (!rid) return { salesRepId: null, commissionPct: "0", commissionAmount: "0" };
  const [rep] = await db.select().from(salesRepsTable)
    .where(and(eq(salesRepsTable.id, rid), eq(salesRepsTable.companyId, cid)));
  // Drop attribution silently on missing/inactive rep — keeps numeric fields safe and
  // prevents "ghost" commissions from disabled reps.
  if (!rep || !rep.isActive) return { salesRepId: null, commissionPct: "0", commissionAmount: "0" };
  const pct = Number(rep.commissionPct ?? 0);
  if (rep.commissionType === "collection" || !pct) {
    return { salesRepId: rep.id, commissionPct: String(pct), commissionAmount: "0" };
  }
  const total = Number(totalAmount ?? 0);
  const commission = (total * pct) / 100;
  return {
    salesRepId: rep.id,
    commissionPct: String(pct),
    commissionAmount: commission.toFixed(2),
  };
}

/** Map a list of warehouse IDs (used by an invoice) to their {accountId, allowNegative, name}. */
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
  ["/sales-invoices",        "sales_invoices"],
  ["/sales-returns",         "sales_returns"],
  ["/sales-quotations",      "sales_quotations"],
  ["/customer-settlements",  "sales_invoices"],
]));

// Strict boolean parser for API boundary — accepts true|false (and "true"/"false") only.
// Anything else becomes false (the safe default for priceIncludesVat).
function asBool(v: any): boolean {
  if (v === true || v === "true") return true;
  if (v === false || v === "false" || v == null) return false;
  return false;
}

// Clamp document-level discount server-side: must be >= 0 and <= subtotal+vat.
// Also recompute totalAmount as gross - discount so the stored row is internally consistent.
function clampDiscountAndTotal(subtotal: any, vatAmount: any, discountAmount: any) {
  const sub  = Math.max(0, Number(subtotal)    || 0);
  const vat  = Math.max(0, Number(vatAmount)   || 0);
  const gross = sub + vat;
  const disc = Math.max(0, Math.min(gross, Number(discountAmount) || 0));
  const total = gross - disc;
  return {
    subtotal:       sub.toFixed(2),
    vatAmount:      vat.toFixed(2),
    discountAmount: disc.toFixed(2),
    totalAmount:    total.toFixed(2),
  };
}

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
  refType: string;       // "sales_invoice" | "sales_return" | "purchase_invoice" | "purchase_return"
  refId: number;
  journalEntryId?: number | null;
}) {
  const { companyId: cid, refType, refId, journalEntryId } = opts;

  // 1) Reverse stock_balance for any orphan ledger entries, then delete them
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

  // 2) Delete any cash/bank vouchers tied to this document
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

  // 3) Delete any journal entry tied to this document
  if (journalEntryId) {
    await db.delete(journalEntryLinesTable).where(eq(journalEntryLinesTable.entryId, journalEntryId));
    await db.delete(journalEntriesTable).where(and(
      eq(journalEntriesTable.id, journalEntryId),
      eq(journalEntriesTable.companyId, cid),
    ));
  }
}

async function getAvgCost(companyId: number, itemId: number, warehouseId: number): Promise<number> {
  const [bal] = await db.select().from(stockBalanceTable).where(and(
    eq(stockBalanceTable.companyId, companyId),
    eq(stockBalanceTable.itemId, itemId),
    eq(stockBalanceTable.warehouseId, warehouseId),
  ));
  return Number(bal?.avgCost ?? 0);
}

// ═══════════════════════════════════════════════
// SALES INVOICES
// ═══════════════════════════════════════════════
router.get("/sales-invoices", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(salesInvoicesTable)
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(salesInvoicesTable.invoiceDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/sales-invoices/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    const lines = await db.select().from(salesInvoiceLinesTable)
      .where(eq(salesInvoiceLinesTable.invoiceId, id))
      .orderBy(asc(salesInvoiceLinesTable.id));
    res.json({ ...inv, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

function mapInvoiceLine(l: any, invoiceId: number, cid: number) {
  return {
    invoiceId, companyId: cid,
    itemId:      l.itemId      ? Number(l.itemId)      : null,
    itemName:    l.itemName,
    itemCode:    l.itemCode    || null,
    unit:        l.unit        || null,
    unitId:      l.unitId      ? Number(l.unitId)      : null,
    conversionFactor: String(l.conversionFactor || "1"),
    warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
    qty:         String(l.qty       || "1"),
    unitPrice:   String(l.unitPrice || "0"),
    discount:    String(l.discount  || "0"),
    vatRate:     String(l.vatRate   || "15"),
    lineTotal:   String(l.lineTotal || "0"),
    notes:       l.notes || null,
  };
}

router.post("/sales-invoices", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, invoiceDate, customerId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId,
            posSessionId, salesRepId } = req.body;
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند البيع بنكياً" }); return; }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    // Snapshot the rep's commission % at save time so historical invoices keep
    // their commission even if the rep's % changes later.
    const repInfo = await resolveRepCommission(cid, salesRepId, totals.totalAmount);
    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      status: "draft", notes: notes || null,
      posSessionId: null, // set below after validation
      createdById:  req.authUser?.id ?? null,
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      salesRepId:         repInfo.salesRepId,
      commissionPct:      repInfo.commissionPct,
      commissionAmount:   repInfo.commissionAmount,
    }).returning();
    // Validate posSessionId belongs to the same company before linking — prevents cross-tenant pollution.
    if (posSessionId) {
      const sid = Number(posSessionId);
      const { posSessionsTable } = await import("@workspace/db");
      const [s] = await db.select({ id: posSessionsTable.id, companyId: posSessionsTable.companyId, status: posSessionsTable.status })
        .from(posSessionsTable).where(eq(posSessionsTable.id, sid));
      if (s && s.companyId === cid && s.status === "open") {
        await db.update(salesInvoicesTable).set({ posSessionId: sid })
          .where(eq(salesInvoicesTable.id, inv.id));
        inv.posSessionId = sid;
      }
    }
    if (lines?.length) {
      await db.insert(salesInvoiceLinesTable).values(lines.map((l: any) => mapInvoiceLine(l, inv.id, cid)));
    }
    res.status(201).json(inv);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/sales-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { docNumber, invoiceDate, customerId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId } = req.body;
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند البيع بنكياً" }); return; }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    // Only re-snapshot commission when the caller explicitly sent salesRepId
    // (so existing forms that don't know about reps don't wipe historical data).
    const hasRepKey = Object.prototype.hasOwnProperty.call(req.body ?? {}, "salesRepId");
    const repPatch = hasRepKey
      ? await (async () => {
          const r = await resolveRepCommission(cid, (req.body as any).salesRepId, totals.totalAmount);
          return { salesRepId: r.salesRepId, commissionPct: r.commissionPct, commissionAmount: r.commissionAmount };
        })()
      : {};
    const [inv] = await db.update(salesInvoicesTable).set({
      branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      notes: notes || null, updatedAt: new Date(),
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      ...repPatch,
    }).where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid))).returning();
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (lines !== undefined) {
      await db.delete(salesInvoiceLinesTable).where(eq(salesInvoiceLinesTable.invoiceId, id));
      if (lines.length) {
        await db.insert(salesInvoiceLinesTable).values(lines.map((l: any) => mapInvoiceLine(l, id, cid)));
      }
    }
    res.json(inv);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/sales-invoices/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") { res.status(400).json({ error: "الفاتورة مُرحَّلة مسبقاً" }); return; }

    const lines = await db.select().from(salesInvoiceLinesTable)
      .where(eq(salesInvoiceLinesTable.invoiceId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في الفاتورة" }); return; }

    // Guard: every stock-affecting (item-bearing) line must specify a warehouse.
    const noWh = lines.filter(l => l.itemId && !l.warehouseId);
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Load warehouse info (account + allow-negative) for every distinct warehouse used
    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // Validate stock availability first (qty * conversionFactor = base-unit qty)
    // Skip the check for warehouses that explicitly allow negative stock.
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const wh = whInfo[line.warehouseId];
      if (wh?.allowNegative) continue;
      const factor = Number(line.conversionFactor || "1") || 1;
      const qty = Number(line.qty) * factor;
      const cur = await getBalance(cid, line.itemId, line.warehouseId);
      if (cur < qty) {
        res.status(400).json({
          error: `رصيد الصنف "${line.itemName}" غير كافٍ في مخزن "${wh?.nameAr ?? line.warehouseId}" — المتاح ${cur} والمطلوب ${qty}. فعّل خاصية "السماح بالسالب" على المخزن إن كنت ترغب بتجاوز الرصيد.`,
        });
        return;
      }
    }

    // Decrease stock for each stockable line (in base units) + accumulate COGS per warehouse
    let totalCogs = 0;
    const cogsByWarehouse: Record<number, number> = {};
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor  = Number(line.conversionFactor || "1") || 1;
      const qty     = Number(line.qty) * factor;
      const avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);
      const lineCogs = qty * avgCost;
      totalCogs += lineCogs;
      cogsByWarehouse[line.warehouseId] = (cogsByWarehouse[line.warehouseId] ?? 0) + lineCogs;

      await upsertBalance(cid, line.itemId, line.warehouseId, -qty, avgCost);
      const newBal = await getBalance(cid, line.itemId, line.warehouseId);
      await addStockLedgerEntry({
        companyId:   cid,
        itemId:      line.itemId,
        warehouseId: line.warehouseId,
        txDate:      inv.invoiceDate,
        txType:      "sale",
        qty:         String(-qty),
        costPrice:   String(avgCost.toFixed(4)),
        totalCost:   String((-qty * avgCost).toFixed(2)),
        balanceQty:  String(newBal),
        refId:       id,
        refType:     "sales_invoice",
        notes:       line.notes ?? undefined,
      });
    }

    // ── Build journal entry ──
    // Dr Customer/Cash (= total = subtotal − discount + vat)
    // Dr Sales Discount (if any)
    // Dr COGS  (computed from avg cost × qty)
    //   Cr Sales Revenue (= subtotal, gross before discount)
    //   Cr VAT Output    (= vatAmount)
    //   Cr Inventory     (= total cost — credit reduces inventory asset)
    const mapSi = await loadMappings(cid, "sales_invoice");
    const salesAccId    = pickAccount(inv.salesAccountId,    mapSi("sales_invoice", "revenue"));
    const cogsAccId     = pickAccount(inv.cogsAccountId,     mapSi("sales_invoice", "cogs"));
    const taxAccId      = pickAccount(inv.taxAccountId,      mapSi("sales_invoice", "vat_output"));
    const discountAccId = pickAccount(inv.discountAccountId, mapSi("sales_invoice", "discount"));
    if (!salesAccId) { res.status(400).json({ error: "لم يتم تحديد حساب إيراد المبيعات (اضبطه من ربط القيود المحاسبية)" }); return; }
    if (!cogsAccId)  { res.status(400).json({ error: "لم يتم تحديد حساب تكلفة البضاعة المباعة (اضبطه من ربط القيود المحاسبية)" }); return; }
    // Inventory account is taken from each warehouse, not the invoice. Verify every used warehouse has one.
    const missingWh: string[] = [];
    for (const [widStr, amt] of Object.entries(cogsByWarehouse)) {
      if (amt <= 0) continue;
      const wid = Number(widStr);
      if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
    }
    if (missingWh.length) {
      res.status(400).json({ error: `لم يتم ربط حساب محاسبي للمخزن/المخازن التالية: ${missingWh.join("، ")}. اضبط حساب المخزون من شاشة المخازن.` });
      return;
    }

    const subtotalAmt = Number(inv.subtotal || 0);
    const vatAmt      = Number(inv.vatAmount || 0);
    const discountAmt = Number(inv.discountAmount || 0);
    const totalAmt    = Number(inv.totalAmount || 0);

    const partyAccountId =
      inv.paymentType === "cash" ? await getCashBoxAccountId(cid, inv.cashBoxId)
      : inv.paymentType === "bank" ? await getBankAccountAccountId(cid, (inv as any).bankAccountId)
      : await getCustomerAccountId(cid, inv.customerId);
    if (!partyAccountId) {
      res.status(400).json({ error:
        inv.paymentType === "cash" ? "الخزنة لا تحتوي على حساب محاسبي مرتبط"
        : inv.paymentType === "bank" ? "الحساب البنكي لا يحتوي على حساب محاسبي مرتبط"
        : "العميل لا يحتوي على حساب محاسبي مرتبط (حساب الذمم المدينة)" });
      return;
    }

    if (discountAmt > 0 && !discountAccId) {
      res.status(400).json({ error: "لم يتم تحديد حساب الخصم المسموح به (اضبطه من ربط القيود المحاسبية)" }); return;
    }
    if (vatAmt > 0 && !taxAccId) {
      res.status(400).json({ error: "لم يتم تحديد حساب ضريبة القيمة المضافة مخرجات (اضبطه من ربط القيود المحاسبية)" }); return;
    }

    const journalId = await createJournalEntry({
      companyId: cid,
      branchId: inv.branchId,
      date: inv.invoiceDate,
      docNumber: inv.docNumber,
      entryType: "sales_invoice",
      exchangeRate: inv.exchangeRate,
      description: `قيد فاتورة مبيعات رقم ${inv.docNumber || inv.id}`,
      lines: [
        // Debits
        { accountId: partyAccountId,        debit: totalAmt,    description: inv.paymentType === "cash" ? "تحصيل نقدي" : inv.paymentType === "bank" ? "تحصيل بنكي" : "ذمم العميل" },
        { accountId: discountAccId, debit: discountAmt, description: "خصم مسموح به" },
        { accountId: cogsAccId,     debit: totalCogs,   description: "تكلفة البضاعة المباعة" },
        // Credits
        { accountId: salesAccId,     credit: subtotalAmt, description: "إيراد المبيعات" },
        { accountId: taxAccId,       credit: vatAmt,      description: "ضريبة القيمة المضافة (مخرجات)" },
        // Inventory: one credit line per warehouse using its own GL account
        ...Object.entries(cogsByWarehouse)
          .filter(([, amt]) => amt > 0)
          .map(([widStr, amt]) => {
            const wid = Number(widStr);
            return {
              accountId: whInfo[wid]!.accountId!,
              credit: amt,
              description: `إنقاص المخزون — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
            };
          }),
      ],
    });

    const [updated] = await db.update(salesInvoicesTable)
      .set({ status: "posted", journalEntryId: journalId, updatedAt: new Date() })
      .where(eq(salesInvoicesTable.id, id))
      .returning();

    if (inv.paymentType === "cash" && inv.cashBoxId) {
      await createPostedReceiptVoucher({
        companyId: cid,
        branchId: inv.branchId,
        date: inv.invoiceDate,
        cashBoxId: inv.cashBoxId,
        paymentType: "cash",
        entityType: "customer",
        entityId: inv.customerId,
        amount: inv.totalAmount,
        exchangeRate: inv.exchangeRate,
        refType: "sales_invoice",
        refNumber: inv.docNumber || String(inv.id),
        description: `قبض نقدي للفاتورة رقم ${inv.docNumber || inv.id}`,
      });
    } else if (inv.paymentType === "bank" && (inv as any).bankAccountId) {
      await createPostedReceiptVoucher({
        companyId: cid,
        branchId: inv.branchId,
        date: inv.invoiceDate,
        bankAccountId: (inv as any).bankAccountId,
        paymentType: "bank",
        entityType: "customer",
        entityId: inv.customerId,
        amount: inv.totalAmount,
        exchangeRate: inv.exchangeRate,
        refType: "sales_invoice",
        refNumber: inv.docNumber || String(inv.id),
        description: `قبض بنكي للفاتورة رقم ${inv.docNumber || inv.id}`,
      });
    }

    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UNPOST sales invoice (فك الترحيل) ──────────────────────────────────────
router.patch("/sales-invoices/:id/unpost", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status !== "posted") { res.status(400).json({ error: "الفاتورة ليست مُرحَّلة" }); return; }

    // Reverse stock movements (sales reduced stock; unpost adds back)
    const ledger = await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "sales_invoice"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty); // negative for sale; subtracting it adds back
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
        eq(stockLedgerTable.refType, "sales_invoice"),
        eq(stockLedgerTable.refId, id),
      ));

    if (inv.journalEntryId) {
      await db.update(journalEntryLinesTable)
        .set({ debit: "0", credit: "0" })
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntryLinesTable)
        .where(eq(journalEntryLinesTable.entryId, inv.journalEntryId));
      await db.delete(journalEntriesTable)
        .where(and(eq(journalEntriesTable.id, inv.journalEntryId), eq(journalEntriesTable.companyId, cid)));
    }

    const [updated] = await db.update(salesInvoicesTable)
      .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
      .where(eq(salesInvoicesTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/sales-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف فاتورة مُرحَّلة. قم بإلغاء الترحيل أولاً ثم احذفها." });
      return;
    }
    // Block deletion when sales returns reference this invoice (FK has no cascade).
    const relatedReturns = await db.select({
      id: salesReturnsTable.id, docNumber: salesReturnsTable.docNumber,
    }).from(salesReturnsTable).where(and(
      eq(salesReturnsTable.companyId, cid),
      eq(salesReturnsTable.invoiceId, id),
    )).limit(5);
    if (relatedReturns.length) {
      const refs = relatedReturns.map(r => r.docNumber || `#${r.id}`).join("، ");
      res.status(409).json({ error: `لا يمكن حذف هذه الفاتورة لأنها مرتبطة بمرتجع/مرتجعات مبيعات: ${refs}. يرجى حذف المرتجع أولاً.` });
      return;
    }
    // Block deletion when a quotation was converted into this invoice
    // (sales_quotations.converted_invoice_id has no cascade either).
    const relatedQuotes = await db.select({
      id: salesQuotationsTable.id, docNumber: salesQuotationsTable.docNumber,
    }).from(salesQuotationsTable).where(and(
      eq(salesQuotationsTable.companyId, cid),
      eq(salesQuotationsTable.convertedInvoiceId, id),
    )).limit(5);
    if (relatedQuotes.length) {
      const refs = relatedQuotes.map(r => r.docNumber || `#${r.id}`).join("، ");
      res.status(409).json({ error: `لا يمكن حذف هذه الفاتورة لأنها ناتجة عن تحويل عرض/عروض أسعار: ${refs}. يرجى فك ربط العرض أولاً.` });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "sales_invoice", refId: id, journalEntryId: inv.journalEntryId });
    await db.delete(salesInvoicesTable).where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// SALES RETURNS
// ═══════════════════════════════════════════════
router.get("/sales-returns", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(salesReturnsTable)
      .where(and(
        eq(salesReturnsTable.companyId, cid),
        ...branchScopeSpread(req, salesReturnsTable.branchId, req.query.branchId),
      ))
      .orderBy(desc(salesReturnsTable.returnDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/sales-returns/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    const id = Number(req.params.id);
    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), cid ? eq(salesReturnsTable.companyId, cid) : sql`true`));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    const lines = await db.select().from(salesReturnLinesTable)
      .where(eq(salesReturnLinesTable.returnId, id))
      .orderBy(asc(salesReturnLinesTable.id));
    res.json({ ...ret, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/sales-returns", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, returnDate, customerId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند ردّ المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند ردّ المبلغ بنكياً" }); return; }
    const grossR    = (lines || []).reduce((s: number, l: any) => s + Number(l.lineTotal || 0), 0);
    const discR     = Math.max(0, Math.min(grossR, Number(discountAmount) || 0));
    const totalR    = grossR - discR;
    const [ret] = await db.insert(salesReturnsTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, returnDate,
      customerId: customerId ? Number(customerId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: totalR.toFixed(2),
      vatAmount: String(vatAmount || "0"),
      discountAmount: discR.toFixed(2),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      status: "draft", notes: notes || null,
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
    }).returning();
    if (lines?.length) {
      await db.insert(salesReturnLinesTable).values(
        lines.map((l: any) => ({
          returnId: ret.id, companyId: cid,
          itemId:   l.itemId   ? Number(l.itemId)   : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId:   l.unitId   ? Number(l.unitId)   : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"), unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || "15"),
          lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(ret);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/sales-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [existing] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    if (!existing) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (existing.status !== "draft") { res.status(400).json({ error: "لا يمكن تعديل مرتجع مُرحَّل. قم بفك الترحيل أولاً." }); return; }

    const { docNumber, returnDate, customerId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            totalAmount, vatAmount, discountAmount, notes, lines, priceIncludesVat,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند ردّ المبلغ نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند ردّ المبلغ بنكياً" }); return; }
    const grossR2 = (lines || []).reduce((s: number, l: any) => s + Number(l.lineTotal || 0), 0);
    const discR2  = Math.max(0, Math.min(grossR2, Number(discountAmount) || 0));
    const totalR2 = grossR2 - discR2;

    const [ret] = await db.update(salesReturnsTable).set({
      branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, returnDate,
      customerId: customerId ? Number(customerId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      bankAccountId: pType === "bank" && bankAccountId ? Number(bankAccountId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: totalR2.toFixed(2),
      vatAmount: String(vatAmount || "0"),
      discountAmount: discR2.toFixed(2),
      priceIncludesVat: priceIncludesVat === true || priceIncludesVat === "true",
      notes: notes || null,
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
      updatedAt: new Date(),
    }).where(eq(salesReturnsTable.id, id)).returning();

    await db.delete(salesReturnLinesTable).where(eq(salesReturnLinesTable.returnId, id));
    if (lines?.length) {
      await db.insert(salesReturnLinesTable).values(
        lines.map((l: any) => ({
          returnId: id, companyId: cid,
          itemId:   l.itemId   ? Number(l.itemId)   : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId:   l.unitId   ? Number(l.unitId)   : null,
          conversionFactor: String(l.conversionFactor || "1"),
          warehouseId: l.warehouseId ? Number(l.warehouseId) : null,
          qty: String(l.qty || "1"), unitPrice: String(l.unitPrice || "0"),
          discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
          vatRate: String(l.vatRate || "15"),
          lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
        }))
      );
    }
    res.json(ret);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/sales-returns/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") { res.status(400).json({ error: "المرتجع مُرحَّل مسبقاً" }); return; }

    const lines = await db.select().from(salesReturnLinesTable)
      .where(eq(salesReturnLinesTable.returnId, id));
    if (!lines.length) { res.status(400).json({ error: "لا توجد أصناف في المرتجع" }); return; }

    const noWh = lines.filter(l => l.itemId && !l.warehouseId);
    if (noWh.length) {
      res.status(400).json({ error: `لا يمكن الترحيل: الأصناف التالية بدون مخزن محدد — ${noWh.map(l => l.itemName).join("، ")}` });
      return;
    }

    // Load warehouse info for inventory account derivation
    const whInfo = await loadWarehouseInfo(cid, lines.map(l => l.warehouseId).filter(Boolean) as number[]);

    // Increase stock for each stockable return line (items coming back into inventory, in base units)
    let totalCogs = 0;
    const cogsByWarehouse: Record<number, number> = {};
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor  = Number(line.conversionFactor || "1") || 1;
      const qty     = Number(line.qty) * factor;
      const avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);
      // If item never existed in warehouse, fall back to the line's price as cost.
      // unitPrice is in the SELECTED unit, so divide by factor to get base-unit cost.
      const costUnit = avgCost > 0 ? avgCost : (Number(line.unitPrice) / factor);
      const lineCogs = qty * costUnit;
      totalCogs += lineCogs;
      cogsByWarehouse[line.warehouseId] = (cogsByWarehouse[line.warehouseId] ?? 0) + lineCogs;

      await upsertBalance(cid, line.itemId, line.warehouseId, qty, costUnit);
      const newBal = await getBalance(cid, line.itemId, line.warehouseId);
      await addStockLedgerEntry({
        companyId:   cid,
        itemId:      line.itemId,
        warehouseId: line.warehouseId,
        txDate:      ret.returnDate,
        txType:      "sales_return",
        qty:         String(qty),
        costPrice:   String(costUnit.toFixed(4)),
        totalCost:   String((qty * costUnit).toFixed(2)),
        balanceQty:  String(newBal),
        refId:       id,
        refType:     "sales_return",
        notes:       line.notes ?? undefined,
      });
    }

    // ── Build reversed journal entry ──
    // (Reverse of sales-invoice JE: customer becomes credit, sales/vat become debit, inventory becomes debit, COGS becomes credit)
    // If account FKs are missing on the return but a source invoice is linked, inherit them from the invoice.
    if (ret.invoiceId && (!ret.salesAccountId || !ret.cogsAccountId || !ret.taxAccountId || !ret.discountAccountId)) {
      const [srcInv] = await db.select().from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, ret.invoiceId), eq(salesInvoicesTable.companyId, cid)));
      if (srcInv) {
        const patch: any = {};
        if (!ret.salesAccountId     && srcInv.salesAccountId)     { patch.salesAccountId     = srcInv.salesAccountId;     ret.salesAccountId     = srcInv.salesAccountId; }
        if (!ret.cogsAccountId      && srcInv.cogsAccountId)      { patch.cogsAccountId      = srcInv.cogsAccountId;      ret.cogsAccountId      = srcInv.cogsAccountId; }
        if (!ret.taxAccountId       && srcInv.taxAccountId)       { patch.taxAccountId       = srcInv.taxAccountId;       ret.taxAccountId       = srcInv.taxAccountId; }
        if (!ret.discountAccountId  && srcInv.discountAccountId)  { patch.discountAccountId  = srcInv.discountAccountId;  ret.discountAccountId  = srcInv.discountAccountId; }
        if (Object.keys(patch).length) {
          await db.update(salesReturnsTable).set(patch).where(eq(salesReturnsTable.id, id));
        }
      }
    }
    const mapSr = await loadMappings(cid, "sales_return");
    const salesAccId    = pickAccount(ret.salesAccountId,    mapSr("sales_return", "revenue"));
    const cogsAccId     = pickAccount(ret.cogsAccountId,     mapSr("sales_return", "cogs"));
    const taxAccId      = pickAccount(ret.taxAccountId,      mapSr("sales_return", "vat_output"));
    if (!salesAccId) { res.status(400).json({ error: "لم يتم تحديد حساب إيراد المبيعات (اضبطه من ربط القيود المحاسبية)" }); return; }
    if (!cogsAccId)  { res.status(400).json({ error: "لم يتم تحديد حساب تكلفة البضاعة المباعة (اضبطه من ربط القيود المحاسبية)" }); return; }
    // Inventory account derived from warehouse — verify each used warehouse has one
    const missingWh: string[] = [];
    for (const [widStr, amt] of Object.entries(cogsByWarehouse)) {
      if (amt <= 0) continue;
      const wid = Number(widStr);
      if (!whInfo[wid]?.accountId) missingWh.push(whInfo[wid]?.nameAr ?? String(wid));
    }
    if (missingWh.length) {
      res.status(400).json({ error: `لم يتم ربط حساب محاسبي للمخزن/المخازن التالية: ${missingWh.join("، ")}.` });
      return;
    }

    const totalAmt    = Number(ret.totalAmount || 0);
    const vatAmt      = Number(ret.vatAmount || 0);
    const subtotalAmt = totalAmt - vatAmt; // returns table has no separate subtotal field

    const partyAccountId =
      ret.paymentType === "cash" ? await getCashBoxAccountId(cid, ret.cashBoxId)
      : ret.paymentType === "bank" ? await getBankAccountAccountId(cid, (ret as any).bankAccountId)
      : await getCustomerAccountId(cid, ret.customerId);
    if (!partyAccountId) {
      res.status(400).json({ error:
        ret.paymentType === "cash" ? "الخزنة لا تحتوي على حساب محاسبي مرتبط"
        : ret.paymentType === "bank" ? "الحساب البنكي لا يحتوي على حساب محاسبي مرتبط"
        : "العميل لا يحتوي على حساب محاسبي مرتبط" });
      return;
    }
    if (vatAmt > 0 && !taxAccId) {
      res.status(400).json({ error: "لم يتم تحديد حساب ضريبة القيمة المضافة مخرجات (اضبطه من ربط القيود المحاسبية)" }); return;
    }

    const journalId = await createJournalEntry({
      companyId: cid,
      branchId: ret.branchId,
      date: ret.returnDate,
      docNumber: ret.docNumber,
      entryType: "sales_return",
      exchangeRate: ret.exchangeRate,
      description: `قيد مرتجع مبيعات رقم ${ret.docNumber || ret.id}`,
      lines: [
        // Debits (reversed)
        { accountId: salesAccId,     debit: subtotalAmt, description: "تخفيض إيراد المبيعات (مرتجع)" },
        { accountId: taxAccId,       debit: vatAmt,      description: "تخفيض ضريبة المخرجات" },
        // Inventory: one debit line per warehouse using its own GL account
        ...Object.entries(cogsByWarehouse)
          .filter(([, amt]) => amt > 0)
          .map(([widStr, amt]) => {
            const wid = Number(widStr);
            return {
              accountId: whInfo[wid]!.accountId!,
              debit: amt,
              description: `زيادة المخزون (مرتجع) — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
            };
          }),
        // Credits (reversed)
        { accountId: partyAccountId,    credit: totalAmt,  description: ret.paymentType === "cash" ? "رد نقدي" : ret.paymentType === "bank" ? "رد بنكي" : "تخفيض ذمم العميل" },
        { accountId: ret.cogsAccountId, credit: totalCogs, description: "عكس تكلفة البضاعة المباعة" },
      ],
    });

    const [updated] = await db.update(salesReturnsTable)
      .set({ status: "posted", journalEntryId: journalId, updatedAt: new Date() })
      .where(eq(salesReturnsTable.id, id))
      .returning();

    if (ret.paymentType === "cash" && ret.cashBoxId) {
      await createPostedPaymentVoucher({
        companyId: cid,
        branchId: ret.branchId,
        date: ret.returnDate,
        cashBoxId: ret.cashBoxId,
        paymentType: "cash",
        entityType: "customer",
        entityId: ret.customerId,
        amount: ret.totalAmount,
        exchangeRate: ret.exchangeRate,
        refType: "sales_return",
        refNumber: ret.docNumber || String(ret.id),
        description: `رد نقدي لمرتجع المبيعات رقم ${ret.docNumber || ret.id}`,
      });
    } else if (ret.paymentType === "bank" && (ret as any).bankAccountId) {
      await createPostedPaymentVoucher({
        companyId: cid,
        branchId: ret.branchId,
        date: ret.returnDate,
        bankAccountId: (ret as any).bankAccountId,
        paymentType: "bank",
        entityType: "customer",
        entityId: ret.customerId,
        amount: ret.totalAmount,
        exchangeRate: ret.exchangeRate,
        refType: "sales_return",
        refNumber: ret.docNumber || String(ret.id),
        description: `رد بنكي لمرتجع المبيعات رقم ${ret.docNumber || ret.id}`,
      });
    }

    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UNPOST sales return (فك الترحيل) ───────────────────────────────────────
router.patch("/sales-returns/:id/unpost", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status !== "posted") { res.status(400).json({ error: "المرتجع ليس مُرحَّلاً" }); return; }

    const ledger = await db.select().from(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "sales_return"),
        eq(stockLedgerTable.refId, id),
      ));
    for (const row of ledger) {
      const qty = Number(row.qty); // positive on return; subtracting removes the addition
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
        eq(stockLedgerTable.refType, "sales_return"),
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

    const [updated] = await db.update(salesReturnsTable)
      .set({ status: "draft", journalEntryId: null, updatedAt: new Date() })
      .where(eq(salesReturnsTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/sales-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [ret] = await db.select().from(salesReturnsTable)
      .where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    if (!ret) { res.status(404).json({ error: "المرتجع غير موجود" }); return; }
    if (ret.status === "posted") {
      res.status(400).json({ error: "لا يمكن حذف مرتجع مُرحَّل. قم بإلغاء الترحيل أولاً ثم احذفه." });
      return;
    }
    await cleanupDocArtifacts({ companyId: cid, refType: "sales_return", refId: id, journalEntryId: (ret as any).journalEntryId });
    await db.delete(salesReturnsTable).where(and(eq(salesReturnsTable.id, id), eq(salesReturnsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// SALES QUOTATIONS (Price Quotations)
// ═══════════════════════════════════════════════
router.get("/sales-quotations", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(salesQuotationsTable)
      .where(eq(salesQuotationsTable.companyId, cid))
      .orderBy(desc(salesQuotationsTable.quotationDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/sales-quotations/:id", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.status(401).json({ error: "غير مصرح" }); return; }
    const id = Number(req.params.id);
    const [q] = await db.select().from(salesQuotationsTable)
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    const lines = await db.select().from(salesQuotationLinesTable)
      .where(eq(salesQuotationLinesTable.quotationId, id))
      .orderBy(asc(salesQuotationLinesTable.id));
    res.json({ ...q, lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

function mapQuotationLine(l: any, quotationId: number, cid: number) {
  return {
    quotationId, companyId: cid,
    itemId:    l.itemId   ? Number(l.itemId)   : null,
    itemName:  l.itemName,
    itemCode:  l.itemCode || null,
    unit:      l.unit     || null,
    unitId:    l.unitId   ? Number(l.unitId)   : null,
    qty:       String(l.qty       || "1"),
    unitPrice: String(l.unitPrice || "0"),
    discount:  String(l.discount  || "0"),
    vatRate:   String(l.vatRate   || "15"),
    lineTotal: String(l.lineTotal || "0"),
    notes:     l.notes || null,
  };
}

router.post("/sales-quotations", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, quotationDate, validUntil, customerId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines } = req.body;
    if (!quotationDate) { res.status(400).json({ error: "تاريخ العرض مطلوب" }); return; }
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    const [q] = await db.insert(salesQuotationsTable).values({
      companyId: cid, docNumber: docNumber || null, quotationDate,
      validUntil: validUntil || null,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      status: "draft", notes: notes || null,
    }).returning();
    if (lines?.length) {
      await db.insert(salesQuotationLinesTable).values(lines.map((l: any) => mapQuotationLine(l, q.id, cid)));
    }
    res.status(201).json(q);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/sales-quotations/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { docNumber, quotationDate, validUntil, customerId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, priceIncludesVat, notes, lines } = req.body;
    const totals = clampDiscountAndTotal(subtotal, vatAmount, discountAmount);
    const [q] = await db.update(salesQuotationsTable).set({
      docNumber: docNumber || null, quotationDate,
      validUntil: validUntil || null,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: totals.subtotal, vatAmount: totals.vatAmount,
      discountAmount: totals.discountAmount,
      totalAmount: totals.totalAmount,
      priceIncludesVat: asBool(priceIncludesVat),
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid))).returning();
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    if (lines !== undefined) {
      await db.delete(salesQuotationLinesTable).where(eq(salesQuotationLinesTable.quotationId, id));
      if (lines.length) {
        await db.insert(salesQuotationLinesTable).values(lines.map((l: any) => mapQuotationLine(l, id, cid)));
      }
    }
    res.json(q);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/sales-quotations/:id/status", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!["draft","sent","accepted","rejected","converted"].includes(status)) {
      res.status(400).json({ error: "حالة غير صالحة" }); return;
    }
    if (status === "converted") {
      res.status(400).json({ error: "استخدم مسار التحويل لإصدار الفاتورة" }); return;
    }
    const [current] = await db.select().from(salesQuotationsTable)
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    if (!current) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    const allowed: Record<string, string[]> = {
      draft:     ["sent", "accepted", "rejected"],
      sent:      ["accepted", "rejected"],
      accepted:  [],
      rejected:  [],
      converted: [],
    };
    if (!allowed[current.status ?? "draft"]?.includes(status)) {
      res.status(400).json({ error: `لا يمكن الانتقال من ${current.status} إلى ${status}` });
      return;
    }
    const [row] = await db.update(salesQuotationsTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Convert quotation → sales invoice (draft)
router.post("/sales-quotations/:id/convert", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [q] = await db.select().from(salesQuotationsTable)
      .where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    if (!q) { res.status(404).json({ error: "العرض غير موجود" }); return; }
    if (q.convertedInvoiceId) { res.status(400).json({ error: "تم التحويل مسبقاً" }); return; }
    if (q.status !== "accepted") {
      res.status(400).json({ error: "يجب قبول العرض قبل التحويل لفاتورة" }); return;
    }

    const lines = await db.select().from(salesQuotationLinesTable)
      .where(eq(salesQuotationLinesTable.quotationId, id));

    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId: cid, docNumber: null, invoiceDate: new Date().toISOString().slice(0,10),
      customerId: q.customerId, paymentType: "credit",
      currencyCode: q.currencyCode, exchangeRate: q.exchangeRate,
      subtotal: q.subtotal, vatAmount: q.vatAmount,
      discountAmount: q.discountAmount, totalAmount: q.totalAmount,
      priceIncludesVat: q.priceIncludesVat,
      status: "draft", notes: `محوّل من عرض السعر ${q.docNumber ?? `SQ-${q.id}`}`,
    }).returning();

    if (lines.length) {
      await db.insert(salesInvoiceLinesTable).values(lines.map(l => ({
        invoiceId: inv.id, companyId: cid,
        itemId: l.itemId, itemName: l.itemName, itemCode: l.itemCode,
        unit: l.unit, unitId: l.unitId, warehouseId: null,
        qty: l.qty, unitPrice: l.unitPrice, discount: l.discount,
        vatRate: l.vatRate, lineTotal: l.lineTotal, notes: l.notes,
      })));
    }

    await db.update(salesQuotationsTable)
      .set({ status: "converted", convertedInvoiceId: inv.id, updatedAt: new Date() })
      .where(eq(salesQuotationsTable.id, id));

    res.json({ quotation: q, invoice: inv });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/sales-quotations/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(salesQuotationsTable).where(and(eq(salesQuotationsTable.id, id), eq(salesQuotationsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// CUSTOMER SETTLEMENTS
// ═══════════════════════════════════════════════
router.get("/customer-settlements", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(customerSettlementsTable)
      .where(eq(customerSettlementsTable.companyId, cid))
      .orderBy(desc(customerSettlementsTable.settlementDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/customer-settlements", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, settlementDate, customerId, paymentMethod, accountId,
            amount, currencyCode, exchangeRate, notes } = req.body;
    if (!settlementDate || !amount) {
      res.status(400).json({ error: "التاريخ والمبلغ مطلوبان" }); return;
    }
    const [row] = await db.insert(customerSettlementsTable).values({
      companyId: cid, docNumber: docNumber || null, settlementDate,
      customerId: customerId ? Number(customerId) : null,
      paymentMethod: paymentMethod || "bank",
      accountId: accountId ? Number(accountId) : null,
      amount: String(amount), currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      status: "draft", notes: notes || null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/customer-settlements/:id/post", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [row] = await db.update(customerSettlementsTable)
      .set({ status: "posted", updatedAt: new Date() })
      .where(and(eq(customerSettlementsTable.id, id), eq(customerSettlementsTable.companyId, cid)))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/customer-settlements/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(customerSettlementsTable).where(and(eq(customerSettlementsTable.id, id), eq(customerSettlementsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// ZATCA — Submit a sales invoice for clearance/reporting
// Validates the invoice against ZATCA-style rules and records the result.
// Approved → zatcaStatus="approved", uuid generated.
// Rejected → zatcaStatus="rejected", errorMessages JSON array.
// ═══════════════════════════════════════════════════════════════════
router.post("/sales-invoices/:id/zatca-submit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const [inv] = await db.select().from(salesInvoicesTable)
      .where(and(eq(salesInvoicesTable.id, id), eq(salesInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }

    const lines = await db.select().from(salesInvoiceLinesTable)
      .where(eq(salesInvoiceLinesTable.invoiceId, id));

    // Tenant-scoped customer lookup: must belong to same company
    const customer = inv.customerId
      ? (await db.select().from(customersTable).where(and(
          eq(customersTable.id, inv.customerId),
          eq(customersTable.companyId, cid),
        )))[0]
      : null;

    // ─── ZATCA-style validation rules ────────────────────────────────────
    const errors: { code: string; message: string; field?: string }[] = [];
    const warnings: { code: string; message: string }[] = [];

    if (inv.status !== "posted") {
      errors.push({ code: "BR-KSA-DRAFT", message: "لا يمكن إرسال فاتورة في حالة مسودة (draft) إلى الزكاة. يجب ترحيل الفاتورة أولاً." });
    }
    if (!lines.length) {
      errors.push({ code: "BR-KSA-LINES", message: "الفاتورة لا تحتوي على أي بنود. يجب إضافة بند واحد على الأقل." });
    }
    if (Number(inv.totalAmount || 0) <= 0) {
      errors.push({ code: "BR-KSA-AMOUNT", message: "إجمالي الفاتورة يجب أن يكون أكبر من صفر." });
    }

    // VAT consistency: subtotal * 0.15 should ≈ vatAmount (within 0.5 SAR tolerance)
    const subtotalNet = Number(inv.subtotal || 0) - Number(inv.discountAmount || 0);
    const expectedVat = Math.round(subtotalNet * 0.15 * 100) / 100;
    const declaredVat = Number(inv.vatAmount || 0);
    if (Math.abs(expectedVat - declaredVat) > 0.5) {
      errors.push({
        code: "BR-KSA-VAT-CALC",
        message: `قيمة ضريبة القيمة المضافة غير متطابقة. المتوقع ${expectedVat.toFixed(2)} ريال (15% من الصافي ${subtotalNet.toFixed(2)})، ولكن المسجل في الفاتورة ${declaredVat.toFixed(2)} ريال.`,
      });
    }

    // Customer rules — if total > 1000 SAR a customer is required for B2B clearance flow
    if (Number(inv.totalAmount || 0) >= 1000 && !customer) {
      errors.push({ code: "BR-KSA-CUSTOMER", message: "الفواتير التي يبلغ إجماليها 1000 ريال أو أكثر تتطلب تحديد العميل (فاتورة ضريبية)." });
    }
    // If customer exists and has VAT (B2B), require valid 15-digit VAT and address
    if (customer?.vatNumber) {
      const vat = String(customer.vatNumber).replace(/\D/g, "");
      if (vat.length !== 15 || !vat.startsWith("3") || !vat.endsWith("3")) {
        errors.push({ code: "BR-KSA-CUST-VAT", message: `الرقم الضريبي للعميل (${customer.vatNumber}) غير صحيح. يجب أن يتكوّن من 15 رقماً يبدأ وينتهي بالرقم 3.` });
      }
      if (!customer.city || !customer.street || !customer.buildingNumber || !customer.postalCode) {
        errors.push({
          code: "BR-KSA-CUST-ADDR",
          message: "العنوان الوطني للعميل (المدينة، الشارع، رقم المبنى، الرمز البريدي) مطلوب للفاتورة الضريبية المعيارية (B2B).",
        });
      }
    }

    // Warnings (non-blocking)
    if (lines.some((l: any) => !l.itemCode)) {
      warnings.push({ code: "WARN-ITEM-CODE", message: "بعض البنود لا تحتوي على كود الصنف. يُفضّل تحديد الكود لكل بند." });
    }
    if (!inv.docNumber) {
      warnings.push({ code: "WARN-DOC-NUM", message: "رقم المستند غير محدد. سيتم استخدام المعرّف التلقائي." });
    }

    const now = new Date();
    if (errors.length > 0) {
      await db.update(salesInvoicesTable).set({
        zatcaStatus: "rejected",
        zatcaSubmittedAt: now,
        zatcaUuid: null,                // clear any prior approval UUID
        zatcaResponseCode: "400",
        zatcaErrorMessages: JSON.stringify(errors),
        zatcaWarningMessages: warnings.length ? JSON.stringify(warnings) : null,
        zatcaAiSuggestion: null,        // reset cached AI explanation
        updatedAt: now,
      }).where(eq(salesInvoicesTable.id, id));
      res.json({ status: "rejected", errors, warnings });
      return;
    }

    // Approved — generate a UUID
    const uuid = `ZATCA-${cid}-${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    await db.update(salesInvoicesTable).set({
      zatcaStatus: "approved",
      zatcaSubmittedAt: now,
      zatcaUuid: uuid,
      zatcaResponseCode: "200",
      zatcaErrorMessages: null,
      zatcaWarningMessages: warnings.length ? JSON.stringify(warnings) : null,
      zatcaAiSuggestion: null,
      updatedAt: now,
    }).where(eq(salesInvoicesTable.id, id));
    res.json({ status: "approved", uuid, warnings });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ZATCA — Bridge view: list sales invoices joined with customer name
// for the Customer/Sales ↔ ZATCA bridge screen.
// ═══════════════════════════════════════════════════════════════════
router.get("/sales-invoices-zatca-bridge", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const bidRaw = req.query.branchId;
    const bid = (bidRaw === undefined || bidRaw === null || bidRaw === "")
      ? undefined
      : (Number.isFinite(Number(bidRaw)) && Number(bidRaw) > 0 ? Number(bidRaw) : undefined);
    const rows = await db.select({
      id:                   salesInvoicesTable.id,
      docNumber:            salesInvoicesTable.docNumber,
      invoiceDate:          salesInvoicesTable.invoiceDate,
      customerId:           salesInvoicesTable.customerId,
      customerNameAr:       customersTable.nameAr,
      customerVatNumber:    customersTable.vatNumber,
      totalAmount:          salesInvoicesTable.totalAmount,
      vatAmount:            salesInvoicesTable.vatAmount,
      status:               salesInvoicesTable.status,
      zatcaStatus:          salesInvoicesTable.zatcaStatus,
      zatcaSubmittedAt:     salesInvoicesTable.zatcaSubmittedAt,
      zatcaUuid:            salesInvoicesTable.zatcaUuid,
      zatcaErrorMessages:   salesInvoicesTable.zatcaErrorMessages,
      zatcaWarningMessages: salesInvoicesTable.zatcaWarningMessages,
      zatcaResponseCode:    salesInvoicesTable.zatcaResponseCode,
    })
      .from(salesInvoicesTable)
      // Tenant-scoped join: only join customers in the SAME company
      .leftJoin(customersTable, and(
        eq(salesInvoicesTable.customerId, customersTable.id),
        eq(customersTable.companyId, cid),
      ))
      .where(and(
        eq(salesInvoicesTable.companyId, cid),
        ...branchScopeSpread(req, salesInvoicesTable.branchId, bid),
      ))
      .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
