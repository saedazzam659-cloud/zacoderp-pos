import { Router, type Request, type Response, type NextFunction } from "express";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, purchaseInvoicesTable, purchaseInvoiceLinesTable, purchaseReturnsTable,
  purchaseReturnLinesTable, suppliersTable, itemsTable, accountsTable } from "@workspace/db";
import { extractAuth, pushBranchScope, resolveCompanyId } from "../middleware/auth.js";
import { requireAdditionalOperationalReport } from "../middleware/permissions.js";
import { ownDocumentFilter } from "../lib/documentVisibility.js";

const IDS = new Set([
  "purchase_analysis", "purchase_cost_summary", "purchase_price_history",
  "purchase_discounts", "inactive_suppliers", "purchases_by_location",
  "invoice_status", "payment_methods", "item_movement", "returns_detail", "direct_expense_purchases",
]);
const router = Router();
router.use(extractAuth);

const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown) => { const n = Number(str(v)); return Number.isInteger(n) && n > 0 ? n : undefined; };
const n = (v: unknown) => Number(v || 0);
const period = (date: string, grain: string) => {
  if (grain === "week") { const d = new Date(`${date}T00:00:00Z`); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - day + 1); return d.toISOString().slice(0, 10); }
  if (grain === "month") return date.slice(0, 7);
  if (grain === "quarter") return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
  if (grain === "year") return date.slice(0, 4);
  return date;
};

async function invoiceRows(req: Request, cid: number, postedOnly: boolean) {
  const q: any = req.query;
  const conditions: any[] = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoiceLinesTable.companyId, cid)];
  conditions.push(...ownDocumentFilter(req, "purchaseReportsOwn", purchaseInvoicesTable.createdById));
  if (postedOnly) conditions.push(eq(purchaseInvoicesTable.status, "posted"));
  if (str(q.fromDate)) conditions.push(gte(purchaseInvoicesTable.invoiceDate, str(q.fromDate)!));
  if (str(q.toDate)) conditions.push(lte(purchaseInvoicesTable.invoiceDate, str(q.toDate)!));
  if (num(q.supplierId)) conditions.push(eq(purchaseInvoicesTable.supplierId, num(q.supplierId)!));
  if (num(q.itemId)) conditions.push(eq(purchaseInvoiceLinesTable.itemId, num(q.itemId)!));
  if (num(q.warehouseId)) conditions.push(eq(purchaseInvoiceLinesTable.warehouseId, num(q.warehouseId)!));
  if (str(q.paymentType)) conditions.push(eq(purchaseInvoicesTable.paymentType, str(q.paymentType)!));
  if (str(q.status)) conditions.push(eq(purchaseInvoicesTable.status, str(q.status)! as any));
  if (num(q.itemGroupId)) conditions.push(eq(itemsTable.groupId, num(q.itemGroupId)!));
  pushBranchScope(req, conditions, purchaseInvoicesTable.branchId, q.branchId);
  return db.select({
    invoiceId: purchaseInvoicesTable.id, date: purchaseInvoicesTable.invoiceDate,
    docNumber: purchaseInvoicesTable.docNumber, invoiceStatus: purchaseInvoicesTable.status,
    branchId: purchaseInvoicesTable.branchId, supplierId: purchaseInvoicesTable.supplierId,
    supplierName: suppliersTable.nameAr, paymentType: purchaseInvoicesTable.paymentType,
    currencyCode: purchaseInvoicesTable.currencyCode, exchangeRate: purchaseInvoicesTable.exchangeRate,
    headerDiscount: purchaseInvoicesTable.discountAmount, headerVat: purchaseInvoicesTable.vatAmount,
    totalAmount: purchaseInvoicesTable.totalAmount,
     notes: purchaseInvoicesTable.notes, lineType: (purchaseInvoiceLinesTable as any).lineType,
     accountId: purchaseInvoiceLinesTable.accountId, accountCode: accountsTable.code, accountName: accountsTable.nameAr,
     itemId: purchaseInvoiceLinesTable.itemId,
    itemName: purchaseInvoiceLinesTable.itemName, itemCode: purchaseInvoiceLinesTable.itemCode,
    itemGroupId: itemsTable.groupId, warehouseId: purchaseInvoiceLinesTable.warehouseId,
    qty: purchaseInvoiceLinesTable.qty, freeQty: purchaseInvoiceLinesTable.freeQty,
    unitPrice: purchaseInvoiceLinesTable.unitPrice, finalCost: purchaseInvoiceLinesTable.finalCost,
    lineDiscountPercent: purchaseInvoiceLinesTable.discount, lineDiscountAmount: purchaseInvoiceLinesTable.discountAmount,
    lineTotal: purchaseInvoiceLinesTable.lineTotal, vatRate: purchaseInvoiceLinesTable.vatRate,
    lineNotes: purchaseInvoiceLinesTable.notes,
  }).from(purchaseInvoiceLinesTable)
    .innerJoin(purchaseInvoicesTable, eq(purchaseInvoiceLinesTable.invoiceId, purchaseInvoicesTable.id))
    .leftJoin(suppliersTable, eq(purchaseInvoicesTable.supplierId, suppliersTable.id))
     .leftJoin(accountsTable, and(eq(purchaseInvoiceLinesTable.accountId, accountsTable.id), eq(accountsTable.companyId, cid)))
    .leftJoin(itemsTable, eq(purchaseInvoiceLinesTable.itemId, itemsTable.id))
    .where(and(...conditions))
    .orderBy(asc(purchaseInvoicesTable.invoiceDate), asc(purchaseInvoicesTable.id));
}

async function returnRows(req: Request, cid: number) {
  const q: any = req.query;
  const conditions: any[] = [eq(purchaseReturnsTable.companyId, cid), eq(purchaseReturnLinesTable.companyId, cid), eq(purchaseReturnsTable.status, "posted")];
  conditions.push(...ownDocumentFilter(req, "purchaseReportsOwn", purchaseReturnsTable.createdById));
  if (str(q.fromDate)) conditions.push(gte(purchaseReturnsTable.returnDate, str(q.fromDate)!));
  if (str(q.toDate)) conditions.push(lte(purchaseReturnsTable.returnDate, str(q.toDate)!));
  if (num(q.supplierId)) conditions.push(eq(purchaseReturnsTable.supplierId, num(q.supplierId)!));
  if (num(q.itemId)) conditions.push(eq(purchaseReturnLinesTable.itemId, num(q.itemId)!));
  if (num(q.warehouseId)) conditions.push(eq(purchaseReturnLinesTable.warehouseId, num(q.warehouseId)!));
  if (num(q.itemGroupId)) conditions.push(eq(itemsTable.groupId, num(q.itemGroupId)!));
  pushBranchScope(req, conditions, purchaseReturnsTable.branchId, q.branchId);
  return db.select({
    returnId: purchaseReturnsTable.id, date: purchaseReturnsTable.returnDate, docNumber: purchaseReturnsTable.docNumber,
    headerTotal: purchaseReturnsTable.totalAmount, currencyCode: purchaseReturnsTable.currencyCode,
    invoiceId: purchaseReturnsTable.invoiceId, branchId: purchaseReturnsTable.branchId, supplierId: purchaseReturnsTable.supplierId,
     supplierName: suppliersTable.nameAr, notes: purchaseReturnsTable.notes,
     lineType: (purchaseReturnLinesTable as any).lineType, accountId: (purchaseReturnLinesTable as any).accountId,
     sourceInvoiceLineId: (purchaseReturnLinesTable as any).sourceInvoiceLineId,
     accountCode: accountsTable.code, accountName: accountsTable.nameAr, itemId: purchaseReturnLinesTable.itemId,
    itemName: purchaseReturnLinesTable.itemName, itemCode: purchaseReturnLinesTable.itemCode,
    warehouseId: purchaseReturnLinesTable.warehouseId, qty: purchaseReturnLinesTable.qty,
    unitPrice: purchaseReturnLinesTable.unitPrice, discount: purchaseReturnLinesTable.discount,
    discountAmount: purchaseReturnLinesTable.discountAmount, lineTotal: purchaseReturnLinesTable.lineTotal,
    lineNotes: purchaseReturnLinesTable.notes,
  }).from(purchaseReturnLinesTable).innerJoin(purchaseReturnsTable, eq(purchaseReturnLinesTable.returnId, purchaseReturnsTable.id))
    .leftJoin(suppliersTable, eq(purchaseReturnsTable.supplierId, suppliersTable.id))
     .leftJoin(accountsTable, and(eq((purchaseReturnLinesTable as any).accountId, accountsTable.id), eq(accountsTable.companyId, cid)))
    .leftJoin(itemsTable, eq(purchaseReturnLinesTable.itemId, itemsTable.id)).where(and(...conditions))
    .orderBy(asc(purchaseReturnsTable.returnDate), asc(purchaseReturnsTable.id));
}

function guard(req: Request, res: Response, next: NextFunction) {
  if (!IDS.has(String(req.params.reportId))) { res.status(404).json({ error: "معرف تقرير غير صالح" }); return; }
  next();
}
router.get("/:reportId", guard, (req, res, next) => requireAdditionalOperationalReport("purchases", String(req.params.reportId))(req, res, next), async (req, res) => {
  const cid = resolveCompanyId(req, num(req.query.companyId));
  if (!cid) { res.status(400).json({ error: "companyId مطلوب" }); return; }
  const id = req.params.reportId, q: any = req.query;
  const limitations: string[] = [];
  try {
    if (id === "direct_expense_purchases") {
      const conditions: any[] = [
        eq(purchaseInvoicesTable.companyId, cid),
        eq(purchaseInvoiceLinesTable.companyId, cid),
        eq((purchaseInvoiceLinesTable as any).lineType, "direct_expense"),
        eq(purchaseInvoicesTable.status, "posted"),
      ];
      conditions.push(...ownDocumentFilter(req, "purchaseReportsOwn", purchaseInvoicesTable.createdById));
      if (str(q.fromDate)) conditions.push(gte(purchaseInvoicesTable.invoiceDate, str(q.fromDate)!));
      if (str(q.toDate)) conditions.push(lte(purchaseInvoicesTable.invoiceDate, str(q.toDate)!));
      if (num(q.supplierId)) conditions.push(eq(purchaseInvoicesTable.supplierId, num(q.supplierId)!));
      if (num(q.accountId)) conditions.push(eq(purchaseInvoiceLinesTable.accountId, num(q.accountId)!));
      if (str(q.paymentType)) conditions.push(eq(purchaseInvoicesTable.paymentType, str(q.paymentType)!));
      pushBranchScope(req, conditions, purchaseInvoicesTable.branchId, q.branchId);
      const rows = await db.select({
        invoiceId: purchaseInvoicesTable.id,
        date: purchaseInvoicesTable.invoiceDate,
        docNumber: purchaseInvoicesTable.docNumber,
        supplierId: purchaseInvoicesTable.supplierId,
        supplierName: suppliersTable.nameAr,
        branchId: purchaseInvoicesTable.branchId,
        paymentType: purchaseInvoicesTable.paymentType,
        currencyCode: purchaseInvoicesTable.currencyCode,
        accountId: purchaseInvoiceLinesTable.accountId,
        accountCode: accountsTable.code,
        accountName: accountsTable.nameAr,
        description: purchaseInvoiceLinesTable.itemName,
        quantity: purchaseInvoiceLinesTable.qty,
        unitPrice: purchaseInvoiceLinesTable.unitPrice,
        discountPercent: purchaseInvoiceLinesTable.discount,
        discountAmount: purchaseInvoiceLinesTable.discountAmount,
        vatRate: purchaseInvoiceLinesTable.vatRate,
        lineTotal: purchaseInvoiceLinesTable.lineTotal,
        notes: purchaseInvoiceLinesTable.notes,
      }).from(purchaseInvoiceLinesTable)
        .innerJoin(purchaseInvoicesTable, eq(purchaseInvoiceLinesTable.invoiceId, purchaseInvoicesTable.id))
        .leftJoin(suppliersTable, and(eq(purchaseInvoicesTable.supplierId, suppliersTable.id), eq(suppliersTable.companyId, cid)))
        .leftJoin(accountsTable, and(eq(purchaseInvoiceLinesTable.accountId, accountsTable.id), eq(accountsTable.companyId, cid)))
        .where(and(...conditions))
        .orderBy(asc(purchaseInvoicesTable.invoiceDate), asc(purchaseInvoicesTable.id), asc(purchaseInvoiceLinesTable.id));
      return res.json({ reportId: id, rows });
    }
    if (id === "invoice_status") {
      const rows = await invoiceRows(req, cid, false);
      const seen = new Map<number, any>();
       for (const r of rows) if (!seen.has(r.invoiceId)) seen.set(r.invoiceId, { invoiceId: r.invoiceId, date: r.date, docNumber: r.docNumber, status: r.invoiceStatus, supplierId: r.supplierId, supplierName: r.supplierName, paymentType: r.paymentType, currencyCode: r.currencyCode, totalAmount: n(r.totalAmount), branchId: r.branchId, notes: r.notes });
      return res.json({ reportId: id, rows: [...seen.values()] });
    }
    if (id === "inactive_suppliers") {
      const all = await db.select({ id: suppliersTable.id, name: suppliersTable.nameAr }).from(suppliersTable).where(eq(suppliersTable.companyId, cid));
      const rows = await invoiceRows(req, cid, true), active = new Set(rows.map(r => r.supplierId));
      const historyFilters: any[] = [eq(purchaseInvoicesTable.companyId, cid), eq(purchaseInvoicesTable.status, "posted")];
       historyFilters.push(...ownDocumentFilter(req, "purchaseReportsOwn", purchaseInvoicesTable.createdById));
      if (str(q.toDate)) historyFilters.push(lte(purchaseInvoicesTable.invoiceDate, str(q.toDate)!));
      if (num(q.supplierId)) historyFilters.push(eq(purchaseInvoicesTable.supplierId, num(q.supplierId)!));
      pushBranchScope(req, historyFilters, purchaseInvoicesTable.branchId, q.branchId);
       const historical = await db.select({ supplierId: purchaseInvoicesTable.supplierId, date: purchaseInvoicesTable.invoiceDate, value: purchaseInvoicesTable.totalAmount, currencyCode: purchaseInvoicesTable.currencyCode }).from(purchaseInvoicesTable).where(and(...historyFilters));
      const latest = new Map<number, any>(); for (const r of historical) if (r.supplierId && (!latest.has(r.supplierId) || r.date > latest.get(r.supplierId).date)) latest.set(r.supplierId, r);
       return res.json({ reportId: id, rows: all.filter(s => !active.has(s.id)).map(s => {
         const last = latest.get(s.id);
         return { supplierId: s.id, supplierName: s.name, lastDate: last?.date ?? null, lastValue: n(last?.value), currencyCode: last?.currencyCode ?? null };
       }) });
    }
    const rows = await invoiceRows(req, cid, true);
       if (id === "purchase_price_history") return res.json({ reportId: id, rows: rows.filter(r => r.lineType !== "direct_expense").map(r => ({ invoiceId: r.invoiceId, date: r.date, docNumber: r.docNumber, itemId: r.itemId, itemName: r.itemName, supplierId: r.supplierId, supplierName: r.supplierName, unitPrice: n(r.unitPrice), quantity: n(r.qty), currencyCode: r.currencyCode })) , limitations });
    if (id === "purchase_discounts") {
      const seen = new Set<number>();
      const discountRows: any[] = [];
      for (const r of rows.filter(r => r.lineType !== "direct_expense")) {
        if (!seen.has(r.invoiceId)) {
          seen.add(r.invoiceId);
          discountRows.push({ recordType: "خصم على مستوى الفاتورة", invoiceId: r.invoiceId, date: r.date, docNumber: r.docNumber, currencyCode: r.currencyCode, headerDiscount: n(r.headerDiscount), itemId: null, lineDiscountPercent: null, lineDiscountAmount: 0 });
        }
        discountRows.push({ recordType: "خصم على مستوى السطر", invoiceId: r.invoiceId, date: r.date, docNumber: r.docNumber, currencyCode: r.currencyCode, headerDiscount: 0, itemId: r.itemId, lineDiscountPercent: n(r.lineDiscountPercent), lineDiscountAmount: n(r.lineDiscountAmount) });
      }
      return res.json({ reportId: id, rows: discountRows, limitations });
    }
    if (id === "purchase_cost_summary") {
      const m = new Map<string, any>();
      for (const r of rows) {
        const currencyCode = r.currencyCode || "غير محددة";
        const k = `${r.itemId ?? r.itemName}|${currencyCode}`;
        const x = m.get(k) || { itemId: r.itemId, itemName: r.itemName, currencyCode, quantity: 0, value: 0, weightedPriceTotal: 0, pricedQuantity: 0, prices: [] };
        const p = n(r.finalCost ?? r.unitPrice), qty = n(r.qty);
        x.quantity += qty + n(r.freeQty);
        x.value += p * qty;
        x.weightedPriceTotal += p * qty;
        x.pricedQuantity += qty;
        x.prices.push(p);
        m.set(k, x);
      }
      limitations.push("تم تجميع كل عملة على حدة دون تحويل. السعر مبني على finalCost المحفوظ أو unitPrice عند غيابه.");
      return res.json({ reportId: id, rows: [...m.values()].map(x => ({
        itemId: x.itemId, itemName: x.itemName, currencyCode: x.currencyCode, quantity: x.quantity, value: x.value,
        lastPrice: x.prices.at(-1) ?? 0,
        averagePrice: x.pricedQuantity ? x.weightedPriceTotal / x.pricedQuantity : 0,
        minPrice: Math.min(...x.prices), maxPrice: Math.max(...x.prices),
      })), limitations });
    }
    if (id === "purchase_analysis") {
      const m = new Map<string, any>(), grain = str(q.groupBy) || "month";
      for (const r of rows) {
        const periodLabel = period(r.date, grain), currencyCode = r.currencyCode || "غير محددة", k = `${periodLabel}|${currencyCode}`;
        const x = m.get(k) || { period: periodLabel, currencyCode, invoiceCount: 0, invoiceTotal: 0, headerDiscount: 0, headerVat: 0, lineGross: 0, lineDiscount: 0, lineNet: 0, _ids: new Set<number>() };
        x.lineGross += n(r.qty) * n(r.unitPrice);
        x.lineDiscount += n(r.lineDiscountAmount);
        x.lineNet += n(r.lineTotal);
        if (!x._ids.has(r.invoiceId)) {
          x._ids.add(r.invoiceId);
          x.invoiceTotal += n(r.totalAmount);
          x.headerDiscount += n(r.headerDiscount);
          x.headerVat += n(r.headerVat);
        }
        m.set(k, x);
      }
      const returns = await returnRows(req, cid), returned = new Map<string, Set<number>>();
      for (const r of returns) {
        const periodLabel = period(r.date, grain), currencyCode = r.currencyCode || "غير محددة", k = `${periodLabel}|${currencyCode}`;
        const x = m.get(k) || { period: periodLabel, currencyCode, invoiceCount: 0, invoiceTotal: 0, headerDiscount: 0, headerVat: 0, lineGross: 0, lineDiscount: 0, lineNet: 0, _ids: new Set<number>() };
        const ids = returned.get(k) ?? new Set<number>();
        if (!ids.has(r.returnId)) {
          ids.add(r.returnId);
          x.postedReturnTotal = (x.postedReturnTotal || 0) + n(r.headerTotal);
        }
        returned.set(k, ids);
        x.postedReturnLineValue = (x.postedReturnLineValue || 0) + n(r.lineTotal);
        m.set(k, x);
      }
      const analysisLimitations = ["يُعرض إجمالي المستند كاملاً إذا طابق المستند أحد فلاتر الأصناف؛ لا تُوزّع خصومات رأس الفاتورة على السطور."];
      return res.json({ reportId: id, limitations: analysisLimitations, rows: [...m.values()].map(x => ({
        ...x, invoiceCount: x._ids.size, postedReturnTotal: x.postedReturnTotal || 0,
        postedReturnLineValue: x.postedReturnLineValue || 0,
        netInvoiceTotal: x.invoiceTotal - (x.postedReturnTotal || 0), _ids: undefined,
      })) });
    }
    if (id === "purchases_by_location") { const m = new Map<string, any>(); for (const r of rows.filter(r => r.lineType !== "direct_expense")) { const currencyCode = r.currencyCode || "غير محددة"; const k = `${r.branchId ?? "unattributed"}:${r.warehouseId ?? "unattributed"}:${currencyCode}`, x = m.get(k) || { branchId: r.branchId, warehouseId: r.warehouseId, currencyCode, quantity: 0, value: 0 }; x.quantity += n(r.qty); x.value += n(r.lineTotal); m.set(k, x); } return res.json({ reportId: id, rows: [...m.values()] }); }
    if (id === "payment_methods") {
      const m = new Map<string, any>(), seen = new Set<number>();
      for (const r of rows) {
        const paymentType = r.paymentType || "غير محددة", currencyCode = r.currencyCode || "غير محددة";
        const key = `${paymentType}|${currencyCode}`;
        const x = m.get(key) || { paymentType, currencyCode, invoiceCount: 0, invoiceValue: 0 };
        if (!seen.has(r.invoiceId)) {
          x.invoiceCount++;
          x.invoiceValue += n(r.totalAmount);
          seen.add(r.invoiceId);
        }
        m.set(key, x);
      }
      limitations.push("المبالغ تمثل إجمالي قيمة الفواتير حسب طريقة الدفع المسجلة، وليست مبالغ مسددة؛ لا توجد مطابقة تسويات هنا.");
      return res.json({ reportId: id, rows: [...m.values()], limitations });
    }
    if (id === "item_movement") { const ret = await returnRows(req, cid), m = new Map<string, any>(); for (const r of rows.filter(r => r.lineType !== "direct_expense")) { const currencyCode = r.currencyCode || "غير محددة", key = `${r.itemId}|${currencyCode}`; const x=m.get(key)||{itemId:r.itemId,itemName:r.itemName,currencyCode,operations:0,grossQuantity:0,netQuantity:0,grossValue:0,netValue:0}; x.operations++; x.grossQuantity+=n(r.qty); x.netQuantity+=n(r.qty); x.grossValue+=n(r.lineTotal); x.netValue+=n(r.lineTotal); m.set(key,x); } for(const r of ret.filter(r => r.lineType !== "direct_expense")){const currencyCode = r.currencyCode || "غير محددة", key = `${r.itemId}|${currencyCode}`; const x=m.get(key)||{itemId:r.itemId,itemName:r.itemName,currencyCode,operations:0,grossQuantity:0,netQuantity:0,grossValue:0,netValue:0}; x.operations++;x.netQuantity-=n(r.qty);x.netValue-=n(r.lineTotal);m.set(key,x);} return res.json({reportId:id,rows:[...m.values()]}); }
    if (id === "returns_detail") {
      const seen = new Set<number>();
      const detailRows = (await returnRows(req, cid)).map(r => {
        const first = !seen.has(r.returnId);
        seen.add(r.returnId);
        return { ...r, headerTotal: first ? n(r.headerTotal) : null };
      });
      return res.json({ reportId: id, rows: detailRows });
    }
    return res.json({ reportId: id, rows: [] });
  } catch (e) { return res.status(500).json({ error: "تعذر إنشاء التقرير" }); }
});
export default router;