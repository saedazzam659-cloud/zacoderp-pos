import { Router } from "express";
import { db } from "@workspace/db";
import {
  supplierGroupsTable, lettersOfCreditTable, lcExpensesTable,
  purchaseInvoicesTable, purchaseInvoiceLinesTable,
  purchaseReturnsTable, purchaseReturnLinesTable,
  supplierSettlementsTable, suppliersTable,
  cashBoxesTable, bankAccountsTable, journalEntriesTable, journalEntryLinesTable,
  stockBalanceTable, stockLedgerTable, warehousesTable,
  receiptVouchersTable, paymentVouchersTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { pathRbac } from "../middleware/permissions.js";
import { upsertBalance, getBalance, addStockLedgerEntry } from "../lib/stockHelpers.js";
import { createPostedPaymentVoucher, createPostedReceiptVoucher } from "../lib/cashVouchers.js";
import { loadMappings, pickAccount } from "../lib/accountingMappings.js";

// ─── Journal entry helper ────────────────────────────────────────────────────
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
  // Filter out lines with zero amount or no account
  const cleanLines = opts.lines.filter(l => l.accountId && ((l.debit ?? 0) > 0 || (l.credit ?? 0) > 0));
  if (cleanLines.length < 2) throw new Error("القيد المحاسبي يحتاج إلى طرفين على الأقل");

  const totalDebit  = cleanLines.reduce((s, l) => s + (l.debit  ?? 0), 0);
  const totalCredit = cleanLines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ≠ دائن ${totalCredit.toFixed(2)}`);
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
    status:       "posted",
  }).returning();

  await db.insert(journalEntryLinesTable).values(
    cleanLines.map((l, i) => ({
      entryId:     entry.id,
      accountId:   l.accountId!,
      debit:       String((l.debit  ?? 0).toFixed(2)),
      credit:      String((l.credit ?? 0).toFixed(2)),
      description: l.description ?? opts.description,
      sortOrder:   i,
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/supplier-groups/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(supplierGroupsTable).where(and(eq(supplierGroupsTable.id, id), eq(supplierGroupsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// LETTERS OF CREDIT
// ═══════════════════════════════════════════════
router.get("/letters-of-credit", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const lcs = await db.select().from(lettersOfCreditTable)
      .where(eq(lettersOfCreditTable.companyId, cid))
      .orderBy(desc(lettersOfCreditTable.lcDate));
    res.json(lcs);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
    res.json({ ...lc, expenses });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/letters-of-credit", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { lcNumber, lcDate, supplierId, bankName, currencyCode, totalAmount, notes, expenses } = req.body;
    if (!lcNumber || !lcDate || !totalAmount) {
      res.status(400).json({ error: "رقم الاعتماد والتاريخ والقيمة مطلوبة" }); return;
    }
    const [lc] = await db.insert(lettersOfCreditTable).values({
      companyId: cid, lcNumber, lcDate,
      supplierId: supplierId ? Number(supplierId) : null,
      bankName: bankName || null, currencyCode: currencyCode || "SAR",
      totalAmount: String(totalAmount), usedAmount: "0",
      status: "open", notes: notes || null,
    }).returning();
    if (expenses?.length) {
      await db.insert(lcExpensesTable).values(
        expenses.map((e: any) => ({
          lcId: lc.id, companyId: cid,
          expenseType: e.expenseType, accountId: e.accountId ? Number(e.accountId) : null,
          amount: String(e.amount), currencyCode: e.currencyCode || "SAR",
          notes: e.notes || null,
        }))
      );
    }
    res.status(201).json(lc);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { lcNumber, lcDate, supplierId, bankName, currencyCode, totalAmount, notes, expenses } = req.body;
    const [lc] = await db.update(lettersOfCreditTable).set({
      lcNumber, lcDate,
      supplierId: supplierId ? Number(supplierId) : null,
      bankName: bankName || null, currencyCode: currencyCode || "SAR",
      totalAmount: String(totalAmount),
      notes: notes || null, updatedAt: new Date(),
    }).where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid))).returning();
    if (!lc) { res.status(404).json({ error: "الاعتماد غير موجود" }); return; }
    if (expenses !== undefined) {
      await db.delete(lcExpensesTable).where(eq(lcExpensesTable.lcId, id));
      if (expenses.length) {
        await db.insert(lcExpensesTable).values(
          expenses.map((e: any) => ({
            lcId: id, companyId: cid,
            expenseType: e.expenseType, accountId: e.accountId ? Number(e.accountId) : null,
            amount: String(e.amount), currencyCode: e.currencyCode || "SAR",
            notes: e.notes || null,
          }))
        );
      }
    }
    res.json(lc);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/letters-of-credit/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(lettersOfCreditTable).where(and(eq(lettersOfCreditTable.id, id), eq(lettersOfCreditTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE INVOICES
// ═══════════════════════════════════════════════
router.get("/purchase-invoices", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(purchaseInvoicesTable)
      .where(eq(purchaseInvoicesTable.companyId, cid))
      .orderBy(desc(purchaseInvoicesTable.invoiceDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/purchase-invoices", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, supplierInvoiceNumber, invoiceDate, supplierId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId } = req.body;
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return; }
    if (pType === "credit" && !supplierId) { res.status(400).json({ error: "يجب اختيار المورد عند الدفع الآجل" }); return; }
    const [inv] = await db.insert(purchaseInvoicesTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, supplierInvoiceNumber: supplierInvoiceNumber || null, invoiceDate,
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
          qty: String(l.qty || "1"), weight: String(l.weight || "0"),
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { docNumber, supplierInvoiceNumber, invoiceDate, supplierId, branchId, paymentType, cashBoxId, bankAccountId, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines, priceIncludesVat,
            inventoryAccountId, taxAccountId, discountAccountId } = req.body;
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند الدفع نقداً" }); return; }
    if (pType === "bank" && !bankAccountId) { res.status(400).json({ error: "يجب اختيار الحساب البنكي عند الدفع بنكياً" }); return; }
    if (pType === "credit" && !supplierId) { res.status(400).json({ error: "يجب اختيار المورد عند الدفع الآجل" }); return; }
    const [inv] = await db.update(purchaseInvoicesTable).set({
      branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, supplierInvoiceNumber: supplierInvoiceNumber || null, invoiceDate,
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
            qty: String(l.qty || "1"), weight: String(l.weight || "0"),
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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

    // Update stock balance for each stockable line (in base units), accumulate inventory debit per warehouse
    const inventoryByWarehouse: Record<number, number> = {};
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor   = Number(line.conversionFactor || "1") || 1;
      const qty      = Number(line.qty) * factor;
      const cost     = Number(line.finalCost || line.unitPrice);
      const costUnit = qty > 0 ? cost / qty : Number(line.unitPrice) / factor;
      inventoryByWarehouse[line.warehouseId] = (inventoryByWarehouse[line.warehouseId] ?? 0) + cost;

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

    const counterpartyAccountId =
      inv.paymentType === "cash" ? await getCashBoxAccountId(cid, inv.cashBoxId)
      : inv.paymentType === "bank" ? await getBankAccountAccountId(cid, (inv as any).bankAccountId)
      : await getSupplierAccountId(cid, inv.supplierId);

    const missing: string[] = [];
    if (vatAmount > 0 && !taxAccId) missing.push("حساب الضرائب (مدخلات)");
    if (discountAmount > 0 && !discountAccId) missing.push("حساب الخصم المكتسب");
    if (!counterpartyAccountId) missing.push(inv.paymentType === "cash" ? "حساب الخزنة" : inv.paymentType === "bank" ? "الحساب البنكي" : "حساب المورد");
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
    const journalId = await createJournalEntry({
      companyId:    cid,
      branchId:     inv.branchId,
      date:         inv.invoiceDate,
      docNumber:    inv.docNumber,
      description:  desc,
      entryType:    "purchase_invoice",
      exchangeRate: inv.exchangeRate,
      lines: [
        // Inventory: one debit line per warehouse using its own GL account
        ...Object.entries(inventoryDebitByWh)
          .filter(([, amt]) => amt > 0)
          .map(([widStr, amt]) => {
            const wid = Number(widStr);
            return {
              accountId: whInfo[wid]!.accountId!,
              debit: amt,
              description: `قيمة البضاعة — ${whInfo[wid]?.nameAr ?? "مخزن"}`,
            };
          }),
        { accountId: taxAccId,               debit:  vatAmount,      description: "ضريبة القيمة المضافة" },
        { accountId: counterpartyAccountId,  credit: totalAmount,    description: inv.paymentType === "cash" ? "صرف نقدي" : inv.paymentType === "bank" ? "صرف بنكي" : "مستحقات المورد" },
        { accountId: discountAccId,          credit: discountAmount, description: "خصم مكتسب" },
      ],
    });

    const [updated] = await db.update(purchaseInvoicesTable)
      .set({ status: "posted", journalEntryId: journalId, updatedAt: new Date() })
      .where(eq(purchaseInvoicesTable.id, id))
      .returning();

    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UNPOST purchase invoice (فك الترحيل) ───────────────────────────────────
// Reverses stock movements, zeroes-out the journal entry lines (audit trail),
// then deletes the JE and sets the invoice back to draft.
router.patch("/purchase-invoices/:id/unpost", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);

    const [inv] = await db.select().from(purchaseInvoicesTable)
      .where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    if (!inv) { res.status(404).json({ error: "الفاتورة غير موجودة" }); return; }
    if (inv.status !== "posted") { res.status(400).json({ error: "الفاتورة ليست مُرحَّلة" }); return; }

    // ── Reverse stock movements (delete ledger rows + decrement balances) ──
    const ledger = await db.select().from(stockLedgerTable)
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
    await db.delete(stockLedgerTable)
      .where(and(
        eq(stockLedgerTable.companyId, cid),
        eq(stockLedgerTable.refType, "purchase_invoice"),
        eq(stockLedgerTable.refId, id),
      ));

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

    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
    await db.delete(purchaseInvoicesTable).where(and(eq(purchaseInvoicesTable.id, id), eq(purchaseInvoicesTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════
// PURCHASE RETURNS
// ═══════════════════════════════════════════════
router.get("/purchase-returns", async (req, res) => {
  try {
    const cid = getCid(req);
    if (!cid) { res.json([]); return; }
    const rows = await db.select().from(purchaseReturnsTable)
      .where(eq(purchaseReturnsTable.companyId, cid))
      .orderBy(desc(purchaseReturnsTable.returnDate));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
    const [ret] = await db.insert(purchaseReturnsTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, supplierInvoiceNumber: supplierInvoiceNumber || null, returnDate,
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

router.put("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    const { docNumber, supplierInvoiceNumber, returnDate, supplierId, branchId, invoiceId, paymentType, cashBoxId, bankAccountId,
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
    const [ret] = await db.update(purchaseReturnsTable).set({
      branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || existing.docNumber, supplierInvoiceNumber: supplierInvoiceNumber || null, returnDate,
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
            qty: String(l.qty || "1"), unitPrice: String(l.unitPrice || "0"),
            discount: String(Math.max(0, Math.min(100, Number(l.discount) || 0))),
            vatRate: String(l.vatRate || "15"),
            lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
          }))
        );
      }
    }
    res.json(ret);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
      const qty = Number(line.qty) * factor;
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
      const qty      = Number(line.qty) * factor;
      const lineDisc = Math.max(0, Math.min(100, Number((line as any).discount) || 0));
      const costUnit = (Number(line.unitPrice) * (1 - lineDisc / 100)) / factor;
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── UNPOST purchase return (فك الترحيل) ────────────────────────────────────
router.patch("/purchase-returns/:id/unpost", async (req, res) => {
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/supplier-settlements/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
    await db.delete(supplierSettlementsTable).where(and(eq(supplierSettlementsTable.id, id), eq(supplierSettlementsTable.companyId, cid)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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

    const accountList = postable.slice(0, 400).map(a =>
      `- id=${a.id} | ${a.code} | ${a.nameAr} | ${a.accountType}`
    ).join("\n");
    const expList = expenses.length
      ? expenses.map((e, i) => `  ${i + 1}) ${e.expenseType || "—"} — ${Number(e.amount || 0)} ${e.currencyCode || "SAR"}${e.accountId ? ` (حساب مقترح id=${e.accountId})` : ""}`).join("\n")
      : "  (لا توجد مصاريف مسجلة)";

    const prompt = `أنت محاسب سعودي خبير. مطلوب إنشاء قيد محاسبي متوازن (debit = credit) يعكس فتح اعتماد مستندي وتسجيل مصاريف الاستيراد المرتبطة به.

بيانات الاعتماد:
- رقم الاعتماد: ${lc.lcNumber}
- التاريخ: ${lc.lcDate}
- المورد: ${supplierName}${supplierAccountId ? ` (حساب مورد id=${supplierAccountId})` : ""}
- البنك: ${lc.bankName || "—"}
- العملة: ${lc.currencyCode}
- قيمة الاعتماد: ${Number(lc.totalAmount)}

مصاريف الاستيراد:
${expList}

شجرة الحسابات المتاحة (استخدم id الرقمي فقط):
${accountList}

المبادئ المحاسبية لفتح الاعتماد المستندي:
1) عند فتح الاعتماد: مدين "اعتمادات مستندية" أو "بضاعة بالطريق" بقيمة الاعتماد، دائن "البنك" أو "هامش اعتماد" بنفس القيمة.
2) كل مصروف استيراد: مدين الحساب المحدد له (أو حساب "مصاريف استيراد") بقيمة المصروف، دائن "البنك" أو "الموردون" بنفس القيمة.
3) اختر أنسب حساب موجود فعلياً في القائمة؛ لا تخترع أرقاماً.
4) يجب أن يكون مجموع المدين = مجموع الدائن بالضبط.

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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
