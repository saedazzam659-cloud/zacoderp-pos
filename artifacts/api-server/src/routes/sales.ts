import { Router } from "express";
import { db } from "@workspace/db";
import {
  salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable, salesReturnLinesTable,
  salesQuotationsTable, salesQuotationLinesTable,
  customerSettlementsTable, stockBalanceTable,
} from "@workspace/db";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { upsertBalance, getBalance, addStockLedgerEntry } from "../lib/stockHelpers.js";

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
    const { docNumber, invoiceDate, customerId, paymentType, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, notes, lines } = req.body;
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    const [inv] = await db.insert(salesInvoicesTable).values({
      companyId: cid, docNumber: docNumber || null, invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      status: "draft", notes: notes || null,
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
    const { docNumber, invoiceDate, customerId, paymentType, currencyCode, exchangeRate,
            subtotal, vatAmount, discountAmount, totalAmount, notes, lines } = req.body;
    const [inv] = await db.update(salesInvoicesTable).set({
      docNumber: docNumber || null, invoiceDate,
      customerId: customerId ? Number(customerId) : null,
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalAmount: String(totalAmount || "0"),
      notes: notes || null, updatedAt: new Date(),
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

    // Validate stock availability first
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const qty = Number(line.qty);
      const cur = await getBalance(cid, line.itemId, line.warehouseId);
      if (cur < qty) {
        res.status(400).json({
          error: `رصيد الصنف "${line.itemName}" غير كافٍ — المتاح ${cur} والمطلوب ${qty}`,
        });
        return;
      }
    }

    // Decrease stock for each stockable line
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const qty     = Number(line.qty);
      const avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);

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

    const [updated] = await db.update(salesInvoicesTable)
      .set({ status: "posted", updatedAt: new Date() })
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
    const { docNumber, returnDate, customerId, invoiceId, currencyCode, exchangeRate,
            totalAmount, vatAmount, notes, lines } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    const [ret] = await db.insert(salesReturnsTable).values({
      companyId: cid, docNumber: docNumber || null, returnDate,
      customerId: customerId ? Number(customerId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: String(totalAmount || "0"),
      vatAmount: String(vatAmount || "0"),
      status: "draft", notes: notes || null,
    }).returning();
    if (lines?.length) {
      await db.insert(salesReturnLinesTable).values(
        lines.map((l: any) => ({
          returnId: ret.id, companyId: cid,
          itemId:   l.itemId   ? Number(l.itemId)   : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId:   l.unitId   ? Number(l.unitId)   : null,
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

    // Increase stock for each stockable return line (items coming back into inventory)
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const qty     = Number(line.qty);
      const avgCost = await getAvgCost(cid, line.itemId, line.warehouseId);
      // If item never existed in warehouse, fall back to the line's price as cost
      const costUnit = avgCost > 0 ? avgCost : Number(line.unitPrice);

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

    const [updated] = await db.update(salesReturnsTable)
      .set({ status: "posted", updatedAt: new Date() })
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
