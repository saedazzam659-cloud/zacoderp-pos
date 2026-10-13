import { Router, type Request } from "express";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db, customersTable, salesInvoicesTable, salesInvoiceLinesTable,
  salesReturnsTable, salesReturnLinesTable, salesRepsTable, warehousesTable,
} from "@workspace/db";
import { extractAuth, pushBranchScope, resolveCompanyId } from "../middleware/auth.js";
import { requireAdditionalOperationalReport } from "../middleware/permissions.js";
import { ownDocumentFilter } from "../lib/documentVisibility.js";

const router = Router();
const REPORT_IDS = [
  "sales_by_representative", "sales_discounts", "inactive_customers",
  "sales_by_warehouse", "invoice_status", "returns_detail",
] as const;
type ReportId = typeof REPORT_IDS[number];

const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
const number = (v: unknown) => {
  const n = Number(text(v));
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const n = (v: unknown) => Number(v || 0);
function company(req: Request) {
  return resolveCompanyId(req, number((req.query as any).companyId));
}

function invoiceFilters(req: Request, companyId: number, posted = true, query: Record<string, unknown> = req.query as any) {
  const q = query as any;
  const f: any[] = [eq(salesInvoicesTable.companyId, companyId)];
  f.push(...ownDocumentFilter(req, "salesReportsOwn", salesInvoicesTable.createdById));
  if (posted) f.push(eq(salesInvoicesTable.status, "posted"));
  else if (text(q.status)) f.push(eq(salesInvoicesTable.status, text(q.status)! as any));
  if (text(q.fromDate)) f.push(gte(salesInvoicesTable.invoiceDate, text(q.fromDate)!));
  if (text(q.toDate)) f.push(lte(salesInvoicesTable.invoiceDate, text(q.toDate)!));
  if (number(q.customerId)) f.push(eq(salesInvoicesTable.customerId, number(q.customerId)!));
  if (number(q.salesRepId)) f.push(eq(salesInvoicesTable.salesRepId, number(q.salesRepId)!));
  pushBranchScope(req, f, salesInvoicesTable.branchId, q.branchId);
  return f;
}
function lineFilters(req: Request, f: any[]) {
  const q = req.query as any;
  if (number(q.itemId)) f.push(eq(salesInvoiceLinesTable.itemId, number(q.itemId)!));
  if (number(q.warehouseId)) f.push(eq(salesInvoiceLinesTable.warehouseId, number(q.warehouseId)!));
}
function asNumbers<T extends Record<string, any>>(row: T, fields: string[]) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fields.includes(k) ? n(v) : v]));
}

async function reportData(id: ReportId, req: Request, cid: number): Promise<{ rows: object[]; limitations?: string[] }> {
  const q = req.query as any;
  if (id === "invoice_status") {
    const f = invoiceFilters(req, cid, false);
    const rows = await db.select({
      invoiceId: salesInvoicesTable.id, documentNumber: salesInvoicesTable.docNumber,
      invoiceDate: salesInvoicesTable.invoiceDate, customerId: salesInvoicesTable.customerId,
      customerName: customersTable.nameAr, value: salesInvoicesTable.totalAmount,
      status: salesInvoicesTable.status, createdById: salesInvoicesTable.createdById,
      source: salesInvoicesTable.sourceChannel, currencyCode: salesInvoicesTable.currencyCode,
    }).from(salesInvoicesTable).leftJoin(customersTable, eq(customersTable.id, salesInvoicesTable.customerId))
      .where(and(...f)).orderBy(asc(salesInvoicesTable.invoiceDate), asc(salesInvoicesTable.id));
    return { rows: rows.map(r => asNumbers(r, ["value"])) };
  }
  if (id === "sales_discounts") {
    const f = invoiceFilters(req, cid);
    const lf = [...f]; lineFilters(req, lf);
    const rows = await db.select({
      invoiceId: salesInvoicesTable.id, documentNumber: salesInvoicesTable.docNumber,
      invoiceDate: salesInvoicesTable.invoiceDate, customerId: salesInvoicesTable.customerId,
      customerName: customersTable.nameAr, headerDiscount: salesInvoicesTable.discountAmount,
      currencyCode: salesInvoicesTable.currencyCode,
      lineDiscount: sql<string>`coalesce(sum(${salesInvoiceLinesTable.discountAmount}), 0)`,
      value: salesInvoicesTable.totalAmount,
    }).from(salesInvoicesTable)
      .leftJoin(customersTable, eq(customersTable.id, salesInvoicesTable.customerId))
      .leftJoin(salesInvoiceLinesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
      .where(and(...lf)).groupBy(salesInvoicesTable.id, customersTable.nameAr)
      .orderBy(asc(salesInvoicesTable.invoiceDate));
    return {
      rows: rows.map(r => asNumbers(r, ["headerDiscount", "lineDiscount", "value"])),
      limitations: ["خصم رأس الفاتورة منفصل عن خصومات السطور ولا يُوزّع على الأصناف."],
    };
  }
  if (id === "sales_by_warehouse") {
    const f = invoiceFilters(req, cid); const lf = [...f]; lineFilters(req, lf);
    const rows = await db.select({
      warehouseId: salesInvoiceLinesTable.warehouseId,
      warehouseName: warehousesTable.nameAr,
      invoiceCount: sql<string>`count(distinct ${salesInvoicesTable.id})`,
      quantity: sql<string>`coalesce(sum(${salesInvoiceLinesTable.qty}),0)`,
      sales: sql<string>`coalesce(sum(${salesInvoiceLinesTable.lineTotal}),0)`,
      currencyCode: salesInvoicesTable.currencyCode,
    }).from(salesInvoiceLinesTable).innerJoin(salesInvoicesTable, eq(salesInvoicesTable.id, salesInvoiceLinesTable.invoiceId))
      .leftJoin(warehousesTable, eq(warehousesTable.id, salesInvoiceLinesTable.warehouseId))
      .where(and(...lf)).groupBy(salesInvoiceLinesTable.warehouseId, warehousesTable.nameAr, salesInvoicesTable.currencyCode);
    return {
      rows: rows.map(r => ({ ...asNumbers(r, ["invoiceCount", "quantity", "sales"]), warehouseName: r.warehouseId == null ? "غير منسوب / بدون مستودع" : r.warehouseName })),
      limitations: ["الإجماليات مبنية على سطور الفواتير؛ لا يُوزّع خصم رأس الفاتورة ولا تُطرح المرتجعات هنا. كل عملة معروضة منفصلة."],
    };
  }
  if (id === "inactive_customers") {
    const period = invoiceFilters(req, cid);
    const historical = invoiceFilters(req, cid, true, { ...q, fromDate: undefined, toDate: text(q.toDate) });
    const active = await db.select({ customerId: salesInvoicesTable.customerId }).from(salesInvoicesTable)
      .where(and(...period, sql`${salesInvoicesTable.customerId} IS NOT NULL`)).groupBy(salesInvoicesTable.customerId);
    const activeIds = active.map(x => x.customerId).filter((x): x is number => x != null);
    const f: any[] = [eq(customersTable.companyId, cid)];
    if (activeIds.length) f.push(sql`not ${inArray(customersTable.id, activeIds)}`);
    if (number(q.customerId)) f.push(eq(customersTable.id, number(q.customerId)!));
    const history = await db.select({
      customerId: salesInvoicesTable.customerId,
      lastInvoiceDate: sql<string>`max(${salesInvoicesTable.invoiceDate})`,
      lastInvoiceValue: sql<string>`(array_agg(${salesInvoicesTable.totalAmount} order by ${salesInvoicesTable.invoiceDate} desc, ${salesInvoicesTable.id} desc))[1]`,
      currencyCode: sql<string>`(array_agg(${salesInvoicesTable.currencyCode} order by ${salesInvoicesTable.invoiceDate} desc, ${salesInvoicesTable.id} desc))[1]`,
    }).from(salesInvoicesTable).where(and(...historical, sql`${salesInvoicesTable.customerId} IS NOT NULL`))
      .groupBy(salesInvoicesTable.customerId);
    const byId = new Map(history.map(x => [x.customerId, x]));
    const customers = await db.select({ customerId: customersTable.id, customerName: customersTable.nameAr })
      .from(customersTable).where(and(...f));
    return { rows: customers.map(c => ({ ...c, ...(byId.get(c.customerId) ? asNumbers(byId.get(c.customerId)!, ["lastInvoiceValue"]) : { lastInvoiceDate: null, lastInvoiceValue: 0, currencyCode: null }) })) };
  }
  if (id === "returns_detail") {
    const f: any[] = [eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.status, "posted")];
    f.push(...ownDocumentFilter(req, "salesReportsOwn", salesReturnsTable.createdById));
    if (text(q.fromDate)) f.push(gte(salesReturnsTable.returnDate, text(q.fromDate)!));
    if (text(q.toDate)) f.push(lte(salesReturnsTable.returnDate, text(q.toDate)!));
    if (number(q.customerId)) f.push(eq(salesReturnsTable.customerId, number(q.customerId)!));
    pushBranchScope(req, f, salesReturnsTable.branchId, q.branchId);
    const lf: any[] = [...f]; if (number(q.itemId)) lf.push(eq(salesReturnLinesTable.itemId, number(q.itemId)!)); if (number(q.warehouseId)) lf.push(eq(salesReturnLinesTable.warehouseId, number(q.warehouseId)!));
    const rows = await db.select({
      returnId: salesReturnsTable.id, documentNumber: salesReturnsTable.docNumber, returnDate: salesReturnsTable.returnDate,
      customerId: salesReturnsTable.customerId, customerName: customersTable.nameAr, originalInvoiceId: salesReturnsTable.invoiceId,
      originalDocumentNumber: salesInvoicesTable.docNumber, itemId: salesReturnLinesTable.itemId,
      itemName: salesReturnLinesTable.itemName, warehouseId: salesReturnLinesTable.warehouseId,
      currencyCode: salesReturnsTable.currencyCode,
      quantity: salesReturnLinesTable.qty, lineValue: salesReturnLinesTable.lineTotal,
      notes: salesReturnLinesTable.notes, headerNotes: salesReturnsTable.notes,
    }).from(salesReturnsTable).innerJoin(salesReturnLinesTable, eq(salesReturnLinesTable.returnId, salesReturnsTable.id))
      .leftJoin(customersTable, eq(customersTable.id, salesReturnsTable.customerId))
      .leftJoin(salesInvoicesTable, eq(salesInvoicesTable.id, salesReturnsTable.invoiceId)).where(and(...lf))
      .orderBy(asc(salesReturnsTable.returnDate), asc(salesReturnsTable.id));
    return { rows: rows.map(r => asNumbers(r, ["quantity", "lineValue"])) };
  }
  const f = invoiceFilters(req, cid);
  const lineConditions: any[] = [];
  lineFilters(req, lineConditions);
  if (lineConditions.length) {
    const matches = await db.select({ invoiceId: salesInvoiceLinesTable.invoiceId })
      .from(salesInvoiceLinesTable).where(and(...lineConditions)).groupBy(salesInvoiceLinesTable.invoiceId);
    if (!matches.length) return { rows: [] };
    f.push(inArray(salesInvoicesTable.id, matches.map(row => row.invoiceId)));
  }
  const invoices = await db.select({
    salesRepId: salesInvoicesTable.salesRepId,
    representative: salesRepsTable.nameAr, currencyCode: salesInvoicesTable.currencyCode,
    invoiceCount: sql<string>`count(distinct ${salesInvoicesTable.id})`,
    customerCount: sql<string>`count(distinct ${salesInvoicesTable.customerId})`,
    sales: sql<string>`coalesce(sum(${salesInvoicesTable.subtotal}),0)`,
    discounts: sql<string>`coalesce(sum(${salesInvoicesTable.discountAmount}),0)`,
  }).from(salesInvoicesTable).leftJoin(salesRepsTable, eq(salesRepsTable.id, salesInvoicesTable.salesRepId))
    .where(and(...f))
    .groupBy(salesInvoicesTable.salesRepId, salesRepsTable.nameAr, salesInvoicesTable.currencyCode);
  const returnFilters: any[] = [eq(salesReturnsTable.companyId, cid), eq(salesReturnsTable.status, "posted")];
  if (text(q.fromDate)) returnFilters.push(gte(salesReturnsTable.returnDate, text(q.fromDate)!));
  if (text(q.toDate)) returnFilters.push(lte(salesReturnsTable.returnDate, text(q.toDate)!));
  if (number(q.customerId)) returnFilters.push(eq(salesReturnsTable.customerId, number(q.customerId)!));
  if (number(q.salesRepId)) returnFilters.push(eq(salesReturnsTable.salesRepId, number(q.salesRepId)!));
  pushBranchScope(req, returnFilters, salesReturnsTable.branchId, q.branchId);
  const returns = await db.select({
    salesRepId: salesReturnsTable.salesRepId,
    currencyCode: salesReturnsTable.currencyCode,
    returns: sql<string>`sum(${salesReturnsTable.totalAmount})`,
  })
    .from(salesReturnsTable).where(and(...returnFilters,
    )).groupBy(salesReturnsTable.salesRepId, salesReturnsTable.currencyCode);
  const byRep = new Map<string, number>();
  returns.forEach(r => byRep.set(`${r.salesRepId ?? "unassigned"}|${r.currencyCode ?? "غير محددة"}`, n(r.returns)));
  const grouped = new Map<string, any>();
  invoices.forEach(r => {
    const currencyCode = r.currencyCode ?? "غير محددة";
    const key = `${r.salesRepId ?? "unassigned"}|${currencyCode}`;
    const x = grouped.get(key) ?? { salesRepId: r.salesRepId, representative: r.representative ?? "بدون مندوب", currencyCode, invoiceCount: 0, customerCount: 0, sales: 0, discounts: 0 };
    x.invoiceCount += n(r.invoiceCount);
    x.customerCount += n(r.customerCount);
    x.sales += n(r.sales);
    x.discounts += n(r.discounts);
    grouped.set(key, x);
  });
  for (const [key] of byRep) {
    if (!grouped.has(key)) {
      const [repId, currencyCode] = key.split("|");
      grouped.set(key, { salesRepId: repId === "unassigned" ? null : Number(repId), representative: "لا توجد مبيعات في الفترة", currencyCode, invoiceCount: 0, customerCount: 0, sales: 0, discounts: 0 });
    }
  }
  return { rows: [...grouped.entries()].map(([key, row]) => {
    const returned = byRep.get(key) ?? 0;
    return { ...row, returns: returned, net: row.sales - row.discounts - returned };
  }) };
}

router.use(extractAuth);
router.get("/:reportId", (req, res, next) => {
  const id = String(req.params.reportId);
  if (!(REPORT_IDS as readonly string[]).includes(id)) { res.status(404).json({ error: "التقرير غير موجود" }); return; }
  return requireAdditionalOperationalReport("sales", id)(req, res, next);
}, async (req, res) => {
  const id = String(req.params.reportId) as ReportId; const cid = company(req);
  if (!cid) { res.status(400).json({ error: "companyId غير صالح" }); return; }
  try { res.json({ reportId: id, ...(await reportData(id, req, cid)) }); }
  catch (error: any) { req.log?.error?.({ err: error }, "additional sales report failed"); res.status(500).json({ error: "تعذر تحميل التقرير" }); }
});
export default router;