import { Router } from "express";
import { db } from "@workspace/db";
import {
  supplierGroupsTable, lettersOfCreditTable, lcExpensesTable,
  purchaseInvoicesTable, purchaseInvoiceLinesTable,
  purchaseReturnsTable, purchaseReturnLinesTable,
  supplierSettlementsTable, suppliersTable,
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
    const { docNumber, invoiceDate, supplierId, paymentType, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines } = req.body;
    if (!invoiceDate) { res.status(400).json({ error: "تاريخ الفاتورة مطلوب" }); return; }
    const [inv] = await db.insert(purchaseInvoicesTable).values({
      companyId: cid, docNumber: docNumber || null, invoiceDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      lcId: lcId ? Number(lcId) : null,
      distributionMethod: distributionMethod || "value",
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalExpensesLoaded: String(totalExpensesLoaded || "0"),
      totalAmount: String(totalAmount || "0"),
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
          qty: String(l.qty || "1"), weight: String(l.weight || "0"),
          unitPrice: String(l.unitPrice || "0"),
          discount: String(l.discount || "0"), vatRate: String(l.vatRate || "15"),
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
    const { docNumber, invoiceDate, supplierId, paymentType, currencyCode, exchangeRate,
            lcId, distributionMethod, subtotal, vatAmount, discountAmount, totalExpensesLoaded,
            totalAmount, notes, lines } = req.body;
    const [inv] = await db.update(purchaseInvoicesTable).set({
      docNumber: docNumber || null, invoiceDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paymentType: paymentType || "credit",
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      lcId: lcId ? Number(lcId) : null,
      distributionMethod: distributionMethod || "value",
      subtotal: String(subtotal || "0"), vatAmount: String(vatAmount || "0"),
      discountAmount: String(discountAmount || "0"),
      totalExpensesLoaded: String(totalExpensesLoaded || "0"),
      totalAmount: String(totalAmount || "0"),
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
            qty: String(l.qty || "1"), weight: String(l.weight || "0"),
            unitPrice: String(l.unitPrice || "0"),
            discount: String(l.discount || "0"), vatRate: String(l.vatRate || "15"),
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

    // Update stock balance for each stockable line (has itemId + warehouseId)
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const qty      = Number(line.qty);
      const cost     = Number(line.finalCost || line.unitPrice);
      const costUnit = qty > 0 ? cost / qty : Number(line.unitPrice);

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

    const [updated] = await db.update(purchaseInvoicesTable)
      .set({ status: "posted", updatedAt: new Date() })
      .where(eq(purchaseInvoicesTable.id, id))
      .returning();
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/purchase-invoices/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
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

router.post("/purchase-returns", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const { docNumber, returnDate, supplierId, invoiceId, currencyCode, exchangeRate,
            totalAmount, vatAmount, notes, lines } = req.body;
    if (!returnDate) { res.status(400).json({ error: "تاريخ المرتجع مطلوب" }); return; }
    const [ret] = await db.insert(purchaseReturnsTable).values({
      companyId: cid, docNumber: docNumber || null, returnDate,
      supplierId: supplierId ? Number(supplierId) : null,
      invoiceId: invoiceId ? Number(invoiceId) : null,
      currencyCode: currencyCode || "SAR",
      exchangeRate: String(exchangeRate || "1"),
      totalAmount: String(totalAmount || "0"),
      vatAmount: String(vatAmount || "0"),
      status: "draft", notes: notes || null,
    }).returning();
    if (lines?.length) {
      await db.insert(purchaseReturnLinesTable).values(
        lines.map((l: any) => ({
          returnId: ret.id, companyId: cid,
          itemId: l.itemId ? Number(l.itemId) : null,
          itemName: l.itemName, itemCode: l.itemCode || null, unit: l.unit || null,
          unitId: l.unitId ? Number(l.unitId) : null,
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

    // Decrease stock for each stockable return line
    for (const line of lines) {
      if (!line.itemId || !line.warehouseId) continue;
      const qty      = Number(line.qty);
      const costUnit = Number(line.unitPrice);

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

    const [updated] = await db.update(purchaseReturnsTable)
      .set({ status: "posted", updatedAt: new Date() })
      .where(eq(purchaseReturnsTable.id, id))
      .returning();
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/purchase-returns/:id", async (req, res) => {
  try {
    const cid = guard(req, res); if (!cid) return;
    const id = Number(req.params.id);
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

export default router;
