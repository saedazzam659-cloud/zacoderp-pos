import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { GetDashboardSummaryQueryParams, GetRecentInvoicesQueryParams, GetMonthlyStatsQueryParams } from "@workspace/api-zod";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";

const router = Router();
router.use(extractAuth);

router.get("/summary", async (req, res) => {
  const params = GetDashboardSummaryQueryParams.safeParse(req.query);
  const rawCompanyId = params.success ? params.data.companyId : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);

  const allInvoices = companyId
    ? await db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId))
    : await db.select().from(invoicesTable);

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  let totalVat = 0, totalRevenue = 0, thisMonthRevenue = 0, thisMonthVat = 0;
  let draftCount = 0, issuedCount = 0, cancelledCount = 0;
  let standardCount = 0, simplifiedCount = 0;

  for (const inv of allInvoices) {
    if (inv.status === "draft") draftCount++;
    else if (inv.status === "issued") issuedCount++;
    else if (inv.status === "cancelled") cancelledCount++;
    if (inv.invoiceType === "standard") standardCount++;
    else if (inv.invoiceType === "simplified") simplifiedCount++;

    if (inv.status === "issued") {
      totalVat += Number(inv.vatTotal);
      totalRevenue += Number(inv.grandTotal);
      const invDate = new Date(inv.issueDate);
      if (invDate.getMonth() === thisMonth && invDate.getFullYear() === thisYear) {
        thisMonthRevenue += Number(inv.grandTotal);
        thisMonthVat += Number(inv.vatTotal);
      }
    }
  }

  res.json({
    totalInvoices: allInvoices.length,
    draftCount, issuedCount, cancelledCount,
    totalVat, totalRevenue,
    standardCount, simplifiedCount,
    thisMonthRevenue, thisMonthVat,
  });
});

router.get("/recent-invoices", async (req, res) => {
  const params = GetRecentInvoicesQueryParams.safeParse(req.query);
  const rawCompanyId = params.success ? params.data.companyId : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);
  const limit = (params.success ? params.data.limit : undefined) ?? 10;

  const query = companyId
    ? db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId)).orderBy(desc(invoicesTable.createdAt)).limit(limit)
    : db.select().from(invoicesTable).orderBy(desc(invoicesTable.createdAt)).limit(limit);

  const invoices = await query;
  res.json(invoices.map(inv => ({ ...inv, lineItems: [], company: null, customer: null })));
});

router.get("/monthly-stats", async (req, res) => {
  const params = GetMonthlyStatsQueryParams.safeParse(req.query);
  const rawCompanyId = params.success ? params.data.companyId : undefined;
  const companyId = resolveCompanyId(req, rawCompanyId);
  const year = (params.success ? params.data.year : undefined) ?? new Date().getFullYear();

  const allInvoices = companyId
    ? await db.select().from(invoicesTable).where(eq(invoicesTable.companyId, companyId))
    : await db.select().from(invoicesTable);

  const monthNames = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const stats: Record<number, { invoiceCount: number; revenue: number; vatAmount: number }> = {};
  for (let m = 0; m < 12; m++) stats[m] = { invoiceCount: 0, revenue: 0, vatAmount: 0 };

  for (const inv of allInvoices) {
    const d = new Date(inv.issueDate);
    if (d.getFullYear() === year) {
      const m = d.getMonth();
      stats[m].invoiceCount++;
      if (inv.status === "issued") {
        stats[m].revenue += Number(inv.grandTotal);
        stats[m].vatAmount += Number(inv.vatTotal);
      }
    }
  }

  res.json(Object.entries(stats).map(([m, s]) => ({
    month: monthNames[Number(m)],
    year,
    invoiceCount: s.invoiceCount,
    revenue: s.revenue,
    vatAmount: s.vatAmount,
  })));
});

export default router;
