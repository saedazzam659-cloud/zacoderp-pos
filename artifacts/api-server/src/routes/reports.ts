import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { invoicesTable, companiesTable } from "@workspace/db";
import { eq, and, gte, lte } from "drizzle-orm";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);
// Hard auth gate — extractAuth alone is non-blocking; this rejects anonymous
// access to tenant report endpoints (e.g. /api/reports/vat-declaration) with
// 401 instead of letting them reach the handler with an undefined company.
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!(req as any).authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

// GET /api/reports/vat-declaration?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/vat-declaration", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };

  if (!from || !to) {
    res.status(400).json({ error: "from و to مطلوبان (YYYY-MM-DD)" });
    return;
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);
  toDate.setHours(23, 59, 59, 999);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    res.status(400).json({ error: "تاريخ غير صالح" });
    return;
  }

  const companyId = resolveCompanyId(req, undefined);

  const [company] = companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, companyId))
    : [];

  // NOTE: ZATCA `invoicesTable` has no branchId column, so this report
  // intentionally aggregates across all branches. See audit-branch-filter.cjs
  // ALLOWLIST entry for VATDeclaration.tsx for the rationale.
  const invoices = companyId
    ? await db.select().from(invoicesTable).where(
        and(
          eq(invoicesTable.companyId, companyId),
          eq(invoicesTable.status, "issued"),
          gte(invoicesTable.issueDate, fromDate.toISOString().slice(0, 10)),
          lte(invoicesTable.issueDate, toDate.toISOString().slice(0, 10)),
        )
      )
    : [];

  // Classify invoices
  let stdBase = 0, stdVat = 0, stdCount = 0;
  let zeroBase = 0, zeroVat = 0, zeroCount = 0;
  let exemptBase = 0, exemptCount = 0;
  let standardTypeCount = 0, simplifiedTypeCount = 0;
  let discountTotal = 0;

  for (const inv of invoices) {
    const base = Number(inv.subtotal) - Number(inv.discountTotal);
    const vat  = Number(inv.vatTotal);
    const disc = Number(inv.discountTotal);
    discountTotal += disc;

    if (inv.invoiceType === "standard") standardTypeCount++;
    else if (inv.invoiceType === "simplified") simplifiedTypeCount++;

    if (vat > 0) {
      // Standard rated (15%)
      stdBase  += base;
      stdVat   += vat;
      stdCount++;
    } else if (base > 0 && vat === 0) {
      // Zero rated
      zeroBase  += base;
      zeroVat   += 0;
      zeroCount++;
    } else {
      // Exempt or zero-value
      exemptBase += base;
      exemptCount++;
    }
  }

  const totalSalesBase = stdBase + zeroBase + exemptBase;
  const totalSalesVat  = stdVat;
  const totalCount     = invoices.length;

  res.json({
    period: { from, to },
    company: company ? {
      nameAr:    company.nameAr,
      nameEn:    company.nameEn,
      vatNumber: company.vatNumber,
      crNumber:  company.crNumber,
      city:      company.city,
    } : null,
    outputTax: {
      standardRated: { base: stdBase,    vat: stdVat,  count: stdCount  },
      zeroRated:     { base: zeroBase,   vat: zeroVat, count: zeroCount },
      exempt:        { base: exemptBase, vat: 0,       count: exemptCount },
      total:         { base: totalSalesBase, vat: totalSalesVat, count: totalCount },
    },
    // Input tax not tracked (no purchase invoices in system)
    inputTax: {
      standardRated: { base: 0, vat: 0 },
      zeroRated:     { base: 0, vat: 0 },
      exempt:        { base: 0, vat: 0 },
      total:         { base: 0, vat: 0 },
    },
    netVat:        totalSalesVat,  // output - input (input=0)
    discountTotal,
    invoiceBreakdown: {
      standardTypeCount,
      simplifiedTypeCount,
      totalCount,
    },
  });
});

export default router;
