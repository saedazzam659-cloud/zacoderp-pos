import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable, salesReturnLinesTable,
  salesQuotationsTable, salesQuotationLinesTable,
  customerSettlementsTable, stockBalanceTable, stockLedgerTable,
  customersTable, cashBoxesTable,
  journalEntriesTable, journalEntryLinesTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { upsertBalance, getBalance, addStockLedgerEntry } from "../lib/stockHelpers.js";
import { createPostedPaymentVoucher, createPostedReceiptVoucher } from "../lib/cashVouchers.js";

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

const router = Router();
router.use(extractAuth);

function guard(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.authUser?.companyId ?? undefined);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}
function getCid(req: any): number | undefined {
  return resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
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
      .where(eq(salesInvoicesTable.companyId, cid))
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
    const { docNumber, invoiceDate, customerId, branchId, paymentType, cashBoxId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId } = req.body;
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      status: "draft", notes: notes || null,
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
    }).returning();
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
    const { docNumber, invoiceDate, customerId, branchId, paymentType, cashBoxId, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId } = req.body;
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند البيع نقداً" }); return; }
    const [inv] = await db.update(salesInvoicesTable).set({
      branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      notes: notes || null, updatedAt: new Date(),
      cogsAccountId:      cogsAccountId      ? Number(cogsAccountId)      : null,
      inventoryAccountId: inventoryAccountId ? Number(inventoryAccountId) : null,
      salesAccountId:     salesAccountId     ? Number(salesAccountId)     : null,
      taxAccountId:       taxAccountId       ? Number(taxAccountId)       : null,
      discountAccountId:  discountAccountId  ? Number(discountAccountId)  : null,
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

    // Validate stock availability first (qty * conversionFactor = base-unit qty)
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor = Number(line.conversionFactor || "1") || 1;
      const qty = Number(line.qty) * factor;
      const cur = await getBalance(cid, line.itemId, line.warehouseId);
      if (cur < qty) {
        res.status(400).json({
          error: `رصيد الصنف "${line.itemName}" غير كافٍ — المتاح ${cur} والمطلوب ${qty}`,
        });
        return;
      }
    }

    // Decrease stock for each stockable line (in base units) + accumulate COGS
    let totalCogs = 0;
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor  = Number(line.conversionFactor || "1") || 1;
      const qty     = Number(line.qty) * factor;
      const avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);
      totalCogs += qty * avgCost;

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
    if (!inv.salesAccountId)     { res.status(400).json({ error: "اختر حساب إيراد المبيعات قبل الترحيل" }); return; }
    if (!inv.cogsAccountId)      { res.status(400).json({ error: "اختر حساب تكلفة البضاعة المباعة قبل الترحيل" }); return; }
    if (!inv.inventoryAccountId) { res.status(400).json({ error: "اختر حساب المخزون قبل الترحيل" }); return; }

    const subtotalAmt = Number(inv.subtotal || 0);
    const vatAmt      = Number(inv.vatAmount || 0);
    const discountAmt = Number(inv.discountAmount || 0);
    const totalAmt    = Number(inv.totalAmount || 0);

    const partyAccountId = inv.paymentType === "cash"
      ? await getCashBoxAccountId(cid, inv.cashBoxId)
      : await getCustomerAccountId(cid, inv.customerId);
    if (!partyAccountId) {
      res.status(400).json({ error: inv.paymentType === "cash"
        ? "الخزنة لا تحتوي على حساب محاسبي مرتبط"
        : "العميل لا يحتوي على حساب محاسبي مرتبط (حساب الذمم المدينة)" });
      return;
    }

    if (discountAmt > 0 && !inv.discountAccountId) {
      res.status(400).json({ error: "اختر حساب الخصم المسموح به (يوجد خصم على الفاتورة)" }); return;
    }
    if (vatAmt > 0 && !inv.taxAccountId) {
      res.status(400).json({ error: "اختر حساب ضريبة القيمة المضافة (مخرجات)" }); return;
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
        { accountId: partyAccountId,        debit: totalAmt,    description: inv.paymentType === "cash" ? "تحصيل نقدي" : "ذمم العميل" },
        { accountId: inv.discountAccountId, debit: discountAmt, description: "خصم مسموح به" },
        { accountId: inv.cogsAccountId,     debit: totalCogs,   description: "تكلفة البضاعة المباعة" },
        // Credits
        { accountId: inv.salesAccountId,     credit: subtotalAmt, description: "إيراد المبيعات" },
        { accountId: inv.taxAccountId,       credit: vatAmt,      description: "ضريبة القيمة المضافة (مخرجات)" },
        { accountId: inv.inventoryAccountId, credit: totalCogs,   description: "إنقاص المخزون" },
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
      .where(eq(salesReturnsTable.companyId, cid))
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
    const { docNumber, returnDate, customerId, branchId, invoiceId, paymentType, cashBoxId, currencyCode, exchangeRate,
            totalAmount, vatAmount, notes, lines,
            cogsAccountId, inventoryAccountId, salesAccountId, taxAccountId, discountAccountId } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    const pType = paymentType || "credit";
    if (pType === "cash" && !cashBoxId) { res.status(400).json({ error: "يجب اختيار الخزنة عند ردّ المبلغ نقداً" }); return; }
    const [ret] = await db.insert(salesReturnsTable).values({
      companyId: cid, branchId: branchId ? Number(branchId) : null,
      docNumber: docNumber || null, returnDate,
      customerId: customerId ? Number(customerId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      paymentType: pType,
      cashBoxId: pType === "cash" && cashBoxId ? Number(cashBoxId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: String(totalAmount || "0"),
      vatAmount: String(vatAmount || "0"),
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
          vatRate: String(l.vatRate || "15"),
          lineTotal: String(l.lineTotal || "0"), notes: l.notes || null,
        }))
      );
    }
    res.status(201).json(ret);
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

    // Increase stock for each stockable return line (items coming back into inventory, in base units)
    let totalCogs = 0;
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const factor  = Number(line.conversionFactor || "1") || 1;
      const qty     = Number(line.qty) * factor;
      const avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);
      // If item never existed in warehouse, fall back to the line's price as cost.
      // unitPrice is in the SELECTED unit, so divide by factor to get base-unit cost.
      const costUnit = avgCost > 0 ? avgCost : (Number(line.unitPrice) / factor);
      totalCogs += qty * costUnit;

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
    if (ret.invoiceId && (!ret.salesAccountId || !ret.cogsAccountId || !ret.inventoryAccountId || !ret.taxAccountId || !ret.discountAccountId)) {
      const [srcInv] = await db.select().from(salesInvoicesTable)
        .where(and(eq(salesInvoicesTable.id, ret.invoiceId), eq(salesInvoicesTable.companyId, cid)));
      if (srcInv) {
        const patch: any = {};
        if (!ret.salesAccountId     && srcInv.salesAccountId)     { patch.salesAccountId     = srcInv.salesAccountId;     ret.salesAccountId     = srcInv.salesAccountId; }
        if (!ret.cogsAccountId      && srcInv.cogsAccountId)      { patch.cogsAccountId      = srcInv.cogsAccountId;      ret.cogsAccountId      = srcInv.cogsAccountId; }
        if (!ret.inventoryAccountId && srcInv.inventoryAccountId) { patch.inventoryAccountId = srcInv.inventoryAccountId; ret.inventoryAccountId = srcInv.inventoryAccountId; }
        if (!ret.taxAccountId       && srcInv.taxAccountId)       { patch.taxAccountId       = srcInv.taxAccountId;       ret.taxAccountId       = srcInv.taxAccountId; }
        if (!ret.discountAccountId  && srcInv.discountAccountId)  { patch.discountAccountId  = srcInv.discountAccountId;  ret.discountAccountId  = srcInv.discountAccountId; }
        if (Object.keys(patch).length) {
          await db.update(salesReturnsTable).set(patch).where(eq(salesReturnsTable.id, id));
        }
      }
    }
    if (!ret.salesAccountId)     { res.status(400).json({ error: "اختر حساب إيراد المبيعات قبل الترحيل" }); return; }
    if (!ret.cogsAccountId)      { res.status(400).json({ error: "اختر حساب تكلفة البضاعة المباعة قبل الترحيل" }); return; }
    if (!ret.inventoryAccountId) { res.status(400).json({ error: "اختر حساب المخزون قبل الترحيل" }); return; }

    const totalAmt    = Number(ret.totalAmount || 0);
    const vatAmt      = Number(ret.vatAmount || 0);
    const subtotalAmt = totalAmt - vatAmt; // returns table has no separate subtotal field

    const partyAccountId = ret.paymentType === "cash"
      ? await getCashBoxAccountId(cid, ret.cashBoxId)
      : await getCustomerAccountId(cid, ret.customerId);
    if (!partyAccountId) {
      res.status(400).json({ error: ret.paymentType === "cash"
        ? "الخزنة لا تحتوي على حساب محاسبي مرتبط"
        : "العميل لا يحتوي على حساب محاسبي مرتبط" });
      return;
    }
    if (vatAmt > 0 && !ret.taxAccountId) {
      res.status(400).json({ error: "اختر حساب ضريبة القيمة المضافة (مخرجات)" }); return;
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
        { accountId: ret.salesAccountId,     debit: subtotalAmt, description: "تخفيض إيراد المبيعات (مرتجع)" },
        { accountId: ret.taxAccountId,       debit: vatAmt,      description: "تخفيض ضريبة المخرجات" },
        { accountId: ret.inventoryAccountId, debit: totalCogs,   description: "زيادة المخزون (مرتجع)" },
        // Credits (reversed)
        { accountId: partyAccountId,    credit: totalAmt,  description: ret.paymentType === "cash" ? "رد نقدي" : "تخفيض ذمم العميل" },
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
            subtotal, vatAmount, discountAmount, totalAmount, notes, lines } = req.body;
    if (!quotationDate) { res.status(400).json({ error: "تاريخ العرض مطلوب" }); return; }
    const [q] = await db.insert(salesQuotationsTable).values({
      companyId: cid, docNumber: docNumber || null, quotationDate,
      validUntil: validUntil || null,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
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
            subtotal, vatAmount, discountAmount, totalAmount, notes, lines } = req.body;
    const [q] = await db.update(salesQuotationsTable).set({
      docNumber: docNumber || null, quotationDate,
      validUntil: validUntil || null,
      customerId: customerId ? Number(customerId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
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

export default router;
