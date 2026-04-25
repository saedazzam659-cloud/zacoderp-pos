import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  companiesTable,
  salesInvoicesTable,
  salesReturnsTable,
  purchaseInvoicesTable,
  purchaseReturnsTable,
  invoicesTable,
} from "@workspace/db";
import { eq, and, gte, lte } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// Bucket = { taxable base, VAT amount, document count } per rate category.
type Bucket = { base: number; vat: number; count: number };
const empty = (): Bucket => ({ base: 0, vat: 0, count: 0 });

// Classify a single document into standard / zero / exempt buckets using the
// header-level VAT amount. Matches the original classification rule so
// existing tenants see consistent numbers across the version bump.
function classify(rows: { base: number; vat: number }[]) {
  const std = empty(), zero = empty(), exempt = empty();
  for (const r of rows) {
    if (r.vat > 0)         { std.base    += r.base; std.vat    += r.vat; std.count++; }
    else if (r.base > 0)   { zero.base   += r.base; zero.vat   += 0;     zero.count++; }
    else                   { exempt.base += r.base; exempt.count++; }
  }
  const total: Bucket = {
    base:  std.base + zero.base + exempt.base,
    vat:   std.vat  + zero.vat,
    count: std.count + zero.count + exempt.count,
  };
  return { standardRated: std, zeroRated: zero, exempt, total };
}

// Strict YYYY-MM-DD validator. We refuse anything else so we never silently
// shift the period boundary because of a timezone offset on a full
// timestamp string. The four source tables all store dates as TEXT in this
// exact format so lexical comparison is correct.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// GET /api/reports/vat-declaration?from=YYYY-MM-DD&to=YYYY-MM-DD
// Aggregates output VAT (sales invoices − sales returns + legacy ZATCA
// invoices) and input VAT (purchase invoices − purchase returns) from the
// canonical accounting tables, all gated to status='posted' (or 'issued'
// for legacy ZATCA invoices). Drafts and cancelled docs are excluded.
router.get("/vat-declaration", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) { res.status(400).json({ error: "from و to مطلوبان (YYYY-MM-DD)" }); return; }
  if (!validIsoDate(from) || !validIsoDate(to)) {
    res.status(400).json({ error: "صيغة التاريخ غير صحيحة. الصيغة المطلوبة: YYYY-MM-DD" });
    return;
  }
  if (from > to) { res.status(400).json({ error: "تاريخ البداية يجب أن يسبق تاريخ النهاية" }); return; }

  const companyId = resolveCompanyId(req, undefined);
  if (!companyId) {
    // Superadmins see this when they hit the endpoint without a company
    // context; non-superadmins are auto-scoped by resolveCompanyId.
    res.status(400).json({
      error: "الشركة غير محددة. يرجى تمرير companyId في الاستعلام (?companyId=<id>) لاختيار الشركة المطلوبة.",
    });
    return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));

  // ─── Pull posted documents from all sources in parallel ────────────────
  // NOTE: branchId exists on the new tables but the report intentionally
  // aggregates across the whole company (matching how the VAT declaration
  // is filed at the legal-entity level).
  const [salesInv, salesRet, purchInv, purchRet, legacyInv] = await Promise.all([
    db.select().from(salesInvoicesTable).where(and(
      eq(salesInvoicesTable.companyId, companyId),
      eq(salesInvoicesTable.status, "posted"),
      gte(salesInvoicesTable.invoiceDate, from),
      lte(salesInvoicesTable.invoiceDate, to),
    )),
    db.select().from(salesReturnsTable).where(and(
      eq(salesReturnsTable.companyId, companyId),
      eq(salesReturnsTable.status, "posted"),
      gte(salesReturnsTable.returnDate, from),
      lte(salesReturnsTable.returnDate, to),
    )),
    db.select().from(purchaseInvoicesTable).where(and(
      eq(purchaseInvoicesTable.companyId, companyId),
      eq(purchaseInvoicesTable.status, "posted"),
      gte(purchaseInvoicesTable.invoiceDate, from),
      lte(purchaseInvoicesTable.invoiceDate, to),
    )),
    db.select().from(purchaseReturnsTable).where(and(
      eq(purchaseReturnsTable.companyId, companyId),
      eq(purchaseReturnsTable.status, "posted"),
      gte(purchaseReturnsTable.returnDate, from),
      lte(purchaseReturnsTable.returnDate, to),
    )),
    // Legacy ZATCA invoices table: kept as an ADDITIVE output-VAT source so
    // tenants that only use the legacy POST /api/invoices flow are not
    // dropped from the declaration. Its rows are independent of
    // sales_invoices (no foreign key, no shared id space) so additive
    // aggregation is safe — there is no de-dup key to use.
    db.select().from(invoicesTable).where(and(
      eq(invoicesTable.companyId, companyId),
      eq(invoicesTable.status, "issued"),
      gte(invoicesTable.issueDate, from),
      lte(invoicesTable.issueDate, to),
    )),
  ]);

  // Derive the taxable base for each document:
  //   • Sales / purchase INVOICES: base = subtotal − discountAmount
  //     (subtotal is the VAT-exclusive line-total sum per the insert
  //     helpers in sales.ts/purchasing.ts; using subtotal also avoids
  //     polluting the base with totalExpensesLoaded on purchase invoices.)
  //   • Sales / purchase RETURNS: base = totalAmount − vatAmount
  //     (returns store totalAmount as the VAT-inclusive grand total
  //     because lineTotal is VAT-inclusive in the form, so we subtract the
  //     header VAT to recover the taxable base.)
  //   • Legacy ZATCA invoices: base = subtotal − discountTotal (matches
  //     the original report's behaviour and the invoicesTable schema).
  const salesInvRows = salesInv.map(r => ({
    base: Math.max(0, Number(r.subtotal) - Number(r.discountAmount)),
    vat:  Number(r.vatAmount),
  }));
  const salesRetRows = salesRet.map(r => ({
    base: Math.max(0, Number(r.totalAmount) - Number(r.vatAmount)),
    vat:  Number(r.vatAmount),
  }));
  const purchInvRows = purchInv.map(r => ({
    base: Math.max(0, Number(r.subtotal) - Number(r.discountAmount)),
    vat:  Number(r.vatAmount),
  }));
  const purchRetRows = purchRet.map(r => ({
    base: Math.max(0, Number(r.totalAmount) - Number(r.vatAmount)),
    vat:  Number(r.vatAmount),
  }));
  const legacyRows = legacyInv.map(r => ({
    base: Math.max(0, Number(r.subtotal) - Number(r.discountTotal)),
    vat:  Number(r.vatTotal),
  }));

  // Combine sales invoices + legacy ZATCA invoices on the output side.
  const outputSales      = classify([...salesInvRows, ...legacyRows]);
  const outputReturnsCls = classify(salesRetRows);
  const inputPurch       = classify(purchInvRows);
  const inputReturnsCls  = classify(purchRetRows);

  // Net the returns out of each side: returns reduce both base and VAT.
  function net(invoices: ReturnType<typeof classify>, returns: ReturnType<typeof classify>) {
    const sub = (a: Bucket, b: Bucket): Bucket => ({
      base:  a.base - b.base,
      vat:   a.vat  - b.vat,
      count: a.count, // count reflects original invoices; returns reported separately
    });
    return {
      standardRated: sub(invoices.standardRated, returns.standardRated),
      zeroRated:     sub(invoices.zeroRated,     returns.zeroRated),
      exempt:        sub(invoices.exempt,        returns.exempt),
      total:         sub(invoices.total,         returns.total),
    };
  }

  const outputTax = net(outputSales, outputReturnsCls);
  const inputTax  = net(inputPurch,  inputReturnsCls);

  const netVat = outputTax.total.vat - inputTax.total.vat;

  // Discount disclosure on the sales side (sales_invoices + legacy).
  const discountTotal =
    salesInv.reduce((s, r) => s + Number(r.discountAmount), 0) +
    legacyInv.reduce((s, r) => s + Number(r.discountTotal), 0);

  // invoiceType (standard vs simplified) only exists on the legacy
  // invoicesTable; sales_invoices doesn't track it. We surface the legacy
  // split when present and report 0 for the new-table rows.
  let standardTypeCount = 0;
  let simplifiedTypeCount = 0;
  for (const inv of legacyInv) {
    if (inv.invoiceType === "standard")        standardTypeCount++;
    else if (inv.invoiceType === "simplified") simplifiedTypeCount++;
  }
  const invoiceBreakdown = {
    standardTypeCount,
    simplifiedTypeCount,
    totalCount: salesInv.length + legacyInv.length,
  };

  res.json({
    period: { from, to },
    company: company ? {
      nameAr:    company.nameAr,
      nameEn:    company.nameEn,
      vatNumber: company.vatNumber,
      crNumber:  company.crNumber,
      city:      company.city,
    } : null,
    outputTax,
    inputTax,
    // Per-side returns surfaced so the frontend can show the deducted
    // amount explicitly. Numbers here are POSITIVE; they have already been
    // subtracted from outputTax / inputTax above.
    returns: {
      sales:     outputReturnsCls.total,
      purchases: inputReturnsCls.total,
    },
    netVat,
    discountTotal,
    invoiceBreakdown,
  });
});

export default router;
