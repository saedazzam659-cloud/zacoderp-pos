import { Router } from "express";
import { db } from "@workspace/db";
import {
  invoicesTable,
  salesInvoicesTable, salesInvoiceLinesTable, salesReturnsTable,
  receiptVouchersTable,
  customersTable,
  itemsTable, stockBalanceTable,
  branchesTable,
  posSessionsTable,
  notificationsTable, notificationReadsTable, notificationDismissalsTable,
} from "@workspace/db";
import { and, eq, desc, sql, gte, lte, inArray, isNull, or, ne } from "drizzle-orm";
import { GetDashboardSummaryQueryParams, GetRecentInvoicesQueryParams, GetMonthlyStatsQueryParams } from "@workspace/api-zod";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";

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

router.get("/recent-invoices", requirePermission("dashboard_recent_invoices", "view"), async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/overview?date=YYYY-MM-DD&branchId=N
//
// One-shot integrated dashboard payload powering the home page. Built on the
// MODERN sales tables (salesInvoicesTable + receiptVouchersTable) — separate
// from `/summary` which still serves the legacy invoicesTable for backwards
// compat with `useGetDashboardSummary`. Multi-tenant: every query is scoped
// by companyId; branch scope honors the user's permission via branchScopeSpread.
// All money aggregates count POSTED invoices only (matches reports semantics).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/overview", async (req: any, res) => {
  try {
    if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
    const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
    if (!cid) { res.json(emptyOverview()); return; }

    const bidRaw = req.query.branchId;
    const bid = (bidRaw === undefined || bidRaw === null || bidRaw === "")
      ? undefined
      : (Number.isFinite(Number(bidRaw)) ? Number(bidRaw) : undefined);

    // Strict YYYY-MM-DD validation — reject malformed dates with 400 to avoid
    // silently producing Invalid Date and downstream 500s.
    const todayRaw = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(todayRaw)) {
      res.status(400).json({ error: "تنسيق التاريخ غير صحيح. استخدم YYYY-MM-DD." });
      return;
    }
    const todayDate = new Date(todayRaw + "T00:00:00Z");
    if (isNaN(todayDate.getTime())) {
      res.status(400).json({ error: "تاريخ غير صالح." });
      return;
    }
    const today = todayRaw;
    const weekStart = new Date(todayDate); weekStart.setUTCDate(weekStart.getUTCDate() - 6);
    const monthStart = new Date(todayDate); monthStart.setUTCDate(1);
    const last30Start = new Date(todayDate); last30Start.setUTCDate(last30Start.getUTCDate() - 29);
    const last12mStart = new Date(todayDate); last12mStart.setUTCMonth(last12mStart.getUTCMonth() - 11); last12mStart.setUTCDate(1);

    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const weekStartStr  = fmt(weekStart);
    const monthStartStr = fmt(monthStart);
    const last30Str     = fmt(last30Start);
    const last12mStr    = fmt(last12mStart);

    const branchScope = branchScopeSpread(req, salesInvoicesTable.branchId, bid);
    const userId = Number(req.authUser?.id) || null;

    // ── 1. KPI rollups via SQL aggregates (posted only).
    // One round-trip per period using FILTER(WHERE …) inside a single query
    // would be ideal but Drizzle's `.where()` already pre-filters; cheaper to
    // run 3 narrowly-filtered selects in parallel.
    const baseWhere = (fromStr: string, toStr: string) =>
      and(
        eq(salesInvoicesTable.companyId, cid),
        eq(salesInvoicesTable.status, "posted"),
        gte(salesInvoicesTable.invoiceDate, fromStr),
        lte(salesInvoicesTable.invoiceDate, toStr),
        ...branchScope,
      );

    const [todayAgg, weekAgg, monthAgg, todayInvCount, monthAvg, todayCashAgg] = await Promise.all([
      db.select({
        net:   sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
        count: sql<string>`COUNT(*)`,
      }).from(salesInvoicesTable).where(baseWhere(today, today)),
      db.select({
        net:   sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
        count: sql<string>`COUNT(*)`,
      }).from(salesInvoicesTable).where(baseWhere(weekStartStr, today)),
      db.select({
        net:   sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
        count: sql<string>`COUNT(*)`,
      }).from(salesInvoicesTable).where(baseWhere(monthStartStr, today)),
      // Total invoice count today across ALL statuses (for "draft + posted" visibility)
      db.select({ count: sql<string>`COUNT(*)` })
        .from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.companyId, cid),
          eq(salesInvoicesTable.invoiceDate, today),
          ...branchScope,
        )),
      // Avg invoice this month (posted only)
      db.select({
        avg: sql<string>`COALESCE(AVG(${salesInvoicesTable.totalAmount}::numeric), 0)`,
      }).from(salesInvoicesTable).where(baseWhere(monthStartStr, today)),
      // Cash collected today (posted receipt vouchers, customers only)
      db.select({
        amount: sql<string>`COALESCE(SUM(${receiptVouchersTable.amount}::numeric), 0)`,
        count:  sql<string>`COUNT(*)`,
      }).from(receiptVouchersTable).where(and(
        eq(receiptVouchersTable.companyId, cid),
        eq(receiptVouchersTable.date, today),
        eq(receiptVouchersTable.status, "posted"),
        eq(receiptVouchersTable.entityType, "customer"),
        ...branchScopeSpread(req, receiptVouchersTable.branchId, bid),
      )),
    ]);

    // ── 2. Top customer + top item this month (posted only, scoped)
    const [topCustomerRows, topItemRows] = await Promise.all([
      db.select({
        customerId: salesInvoicesTable.customerId,
        total:      sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
      })
        .from(salesInvoicesTable)
        .where(baseWhere(monthStartStr, today))
        .groupBy(salesInvoicesTable.customerId)
        .orderBy(desc(sql`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`))
        .limit(1),
      db.select({
        itemId:    salesInvoiceLinesTable.itemId,
        itemName:  salesInvoiceLinesTable.itemName,
        total:     sql<string>`COALESCE(SUM(${salesInvoiceLinesTable.lineTotal}::numeric), 0)`,
        qty:       sql<string>`COALESCE(SUM(${salesInvoiceLinesTable.qty}::numeric), 0)`,
      })
        .from(salesInvoiceLinesTable)
        .innerJoin(salesInvoicesTable, eq(salesInvoiceLinesTable.invoiceId, salesInvoicesTable.id))
        .where(baseWhere(monthStartStr, today))
        .groupBy(salesInvoiceLinesTable.itemId, salesInvoiceLinesTable.itemName)
        .orderBy(desc(sql`COALESCE(SUM(${salesInvoiceLinesTable.lineTotal}::numeric), 0)`))
        .limit(1),
    ]);

    // SECURITY: scope customer name lookup by companyId so a poisoned FK can't
    // leak another tenant's customer name into our KPI tile.
    let topCustomerName: { ar: string | null; en: string | null } = { ar: null, en: null };
    if (topCustomerRows[0]?.customerId) {
      const c = await db.select({ nameAr: customersTable.nameAr, nameEn: customersTable.nameEn })
        .from(customersTable)
        .where(and(eq(customersTable.companyId, cid), eq(customersTable.id, topCustomerRows[0].customerId)))
        .limit(1);
      if (c[0]) topCustomerName = { ar: c[0].nameAr, en: c[0].nameEn };
    }

    // ── 3. Sales over the last 30 days (posted only)
    const sales30dRows = await db.select({
      date:  salesInvoicesTable.invoiceDate,
      total: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
      count: sql<string>`COUNT(*)`,
    })
      .from(salesInvoicesTable)
      .where(baseWhere(last30Str, today))
      .groupBy(salesInvoicesTable.invoiceDate)
      .orderBy(salesInvoicesTable.invoiceDate);

    // Fill missing days with zero so the line chart is continuous
    const sales30dMap = new Map(sales30dRows.map(r => [r.date, r]));
    const sales30d: Array<{ date: string; total: number; count: number }> = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(last30Start); d.setUTCDate(d.getUTCDate() + i);
      const key = fmt(d);
      const r = sales30dMap.get(key);
      sales30d.push({
        date:  key,
        total: r ? Number(r.total) : 0,
        count: r ? Number(r.count) : 0,
      });
    }

    // ── 4. Payment-mix (today, posted)
    const paymentMixRows = await db.select({
      paymentType: salesInvoicesTable.paymentType,
      total: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
      count: sql<string>`COUNT(*)`,
    })
      .from(salesInvoicesTable)
      .where(baseWhere(today, today))
      .groupBy(salesInvoicesTable.paymentType);
    const paymentMix = paymentMixRows.map(r => ({
      paymentType: r.paymentType,
      total: Number(r.total),
      count: Number(r.count),
    }));

    // ── 5. By branch (today, posted) — only branches the user can see
    const byBranchRows = await db.select({
      branchId: salesInvoicesTable.branchId,
      total: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
      count: sql<string>`COUNT(*)`,
    })
      .from(salesInvoicesTable)
      .where(baseWhere(today, today))
      .groupBy(salesInvoicesTable.branchId)
      .orderBy(desc(sql`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`));
    const branchIds = byBranchRows.map(r => r.branchId).filter((x): x is number => !!x);
    const branchNames = branchIds.length
      ? await db.select({ id: branchesTable.id, nameAr: branchesTable.nameAr, nameEn: branchesTable.nameEn })
          .from(branchesTable)
          .where(and(eq(branchesTable.companyId, cid), inArray(branchesTable.id, branchIds)))
      : [];
    const bmap = new Map(branchNames.map(b => [b.id, b]));
    const byBranch = byBranchRows.map(r => {
      const b = r.branchId ? bmap.get(r.branchId) : null;
      return {
        branchId:    r.branchId,
        branchNameAr: b?.nameAr ?? "—",
        branchNameEn: b?.nameEn ?? null,
        total: Number(r.total),
        count: Number(r.count),
      };
    });

    // ── 6. Monthly trend (last 12 months, posted)
    const monthly12mRows = await db.select({
      month: sql<string>`TO_CHAR(${salesInvoicesTable.invoiceDate}::date, 'YYYY-MM')`,
      total: sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
      count: sql<string>`COUNT(*)`,
    })
      .from(salesInvoicesTable)
      .where(baseWhere(last12mStr, today))
      .groupBy(sql`TO_CHAR(${salesInvoicesTable.invoiceDate}::date, 'YYYY-MM')`)
      .orderBy(sql`TO_CHAR(${salesInvoicesTable.invoiceDate}::date, 'YYYY-MM')`);
    const monthly12mMap = new Map(monthly12mRows.map(r => [r.month, r]));
    const monthly12m: Array<{ month: string; total: number; count: number }> = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(last12mStart); d.setUTCMonth(d.getUTCMonth() + i);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const r = monthly12mMap.get(key);
      monthly12m.push({
        month: key,
        total: r ? Number(r.total) : 0,
        count: r ? Number(r.count) : 0,
      });
    }

    // ── 7. Alerts & Priorities (counts + small samples)
    const [zatcaPendingAgg, lowStockAgg, openSessionsAgg, unreadNotifsAgg] = await Promise.all([
      // Pending/rejected ZATCA submissions (posted invoices that haven't cleared)
      db.select({ count: sql<string>`COUNT(*)` })
        .from(salesInvoicesTable)
        .where(and(
          eq(salesInvoicesTable.companyId, cid),
          eq(salesInvoicesTable.status, "posted"),
          or(
            eq(salesInvoicesTable.zatcaStatus, "pending"),
            eq(salesInvoicesTable.zatcaStatus, "rejected"),
            isNull(salesInvoicesTable.zatcaStatus),
          ),
          ...branchScope,
        )),
      // Items at or below reorder level (qty ≤ reorder, reorder > 0)
      db.select({ count: sql<string>`COUNT(DISTINCT ${itemsTable.id})` })
        .from(itemsTable)
        .leftJoin(stockBalanceTable, and(
          eq(stockBalanceTable.itemId, itemsTable.id),
          eq(stockBalanceTable.companyId, cid),
        ))
        .where(and(
          eq(itemsTable.companyId, cid),
          eq(itemsTable.status, "active"),
          sql`${itemsTable.reorderLevel}::numeric > 0`,
          sql`COALESCE(${stockBalanceTable.qty}::numeric, 0) <= ${itemsTable.reorderLevel}::numeric`,
        )),
      // Open POS sessions (yours + colleagues') — branch-scoped per user grants
      db.select({ count: sql<string>`COUNT(*)` })
        .from(posSessionsTable)
        .where(and(
          eq(posSessionsTable.companyId, cid),
          eq(posSessionsTable.status, "open"),
          ...branchScopeSpread(req, posSessionsTable.branchId, bid),
        )),
      // Unread notifications for THIS user (excluding dismissed)
      userId
        ? db.select({ count: sql<string>`COUNT(*)` })
            .from(notificationsTable)
            .leftJoin(notificationReadsTable, and(
              eq(notificationReadsTable.notificationId, notificationsTable.id),
              eq(notificationReadsTable.userId, userId),
            ))
            .leftJoin(notificationDismissalsTable, and(
              eq(notificationDismissalsTable.notificationId, notificationsTable.id),
              eq(notificationDismissalsTable.userId, userId),
            ))
            .where(and(
              eq(notificationsTable.companyId, cid),
              isNull(notificationReadsTable.notificationId),
              isNull(notificationDismissalsTable.notificationId),
              or(
                eq(notificationsTable.userId, userId),
                isNull(notificationsTable.userId),
              ),
            ))
        : Promise.resolve([{ count: "0" }]),
    ]);

    // Small sample lists (top 5 each) for the alerts panel
    const [lowStockSample, openSessionsSample] = await Promise.all([
      db.select({
        itemId:       itemsTable.id,
        code:         itemsTable.code,
        nameAr:       itemsTable.nameAr,
        nameEn:       itemsTable.nameEn,
        reorderLevel: itemsTable.reorderLevel,
        currentQty:   sql<string>`COALESCE(SUM(${stockBalanceTable.qty}::numeric), 0)`,
      })
        .from(itemsTable)
        .leftJoin(stockBalanceTable, and(
          eq(stockBalanceTable.itemId, itemsTable.id),
          eq(stockBalanceTable.companyId, cid),
        ))
        .where(and(
          eq(itemsTable.companyId, cid),
          eq(itemsTable.status, "active"),
          sql`${itemsTable.reorderLevel}::numeric > 0`,
        ))
        .groupBy(itemsTable.id, itemsTable.code, itemsTable.nameAr, itemsTable.nameEn, itemsTable.reorderLevel)
        .having(sql`COALESCE(SUM(${stockBalanceTable.qty}::numeric), 0) <= ${itemsTable.reorderLevel}::numeric`)
        .limit(5),
      db.select({
        id:          posSessionsTable.id,
        userId:      posSessionsTable.userId,
        branchId:    posSessionsTable.branchId,
        openedAt:    posSessionsTable.openedAt,
        openingCash: posSessionsTable.openingCash,
      })
        .from(posSessionsTable)
        .where(and(
          eq(posSessionsTable.companyId, cid),
          eq(posSessionsTable.status, "open"),
          ...branchScopeSpread(req, posSessionsTable.branchId, bid),
        ))
        .orderBy(desc(posSessionsTable.openedAt))
        .limit(5),
    ]);

    // ── 8. My Day — current user's personal panel (posted today only)
    const [myTodayAgg, myDraftsCount, myRecentInvoices] = await Promise.all([
      userId
        ? db.select({
            net:   sql<string>`COALESCE(SUM(${salesInvoicesTable.totalAmount}::numeric), 0)`,
            count: sql<string>`COUNT(*)`,
          }).from(salesInvoicesTable).where(and(
            eq(salesInvoicesTable.companyId, cid),
            eq(salesInvoicesTable.status, "posted"),
            eq(salesInvoicesTable.invoiceDate, today),
            eq(salesInvoicesTable.createdById, userId),
            ...branchScope,
          ))
        : Promise.resolve([{ net: "0", count: "0" }]),
      userId
        ? db.select({ count: sql<string>`COUNT(*)` })
            .from(salesInvoicesTable)
            .where(and(
              eq(salesInvoicesTable.companyId, cid),
              eq(salesInvoicesTable.status, "draft"),
              eq(salesInvoicesTable.createdById, userId),
              ...branchScope,
            ))
        : Promise.resolve([{ count: "0" }]),
      userId
        ? db.select({
            id:          salesInvoicesTable.id,
            docNumber:   salesInvoicesTable.docNumber,
            invoiceDate: salesInvoicesTable.invoiceDate,
            status:      salesInvoicesTable.status,
            totalAmount: salesInvoicesTable.totalAmount,
            customerId:  salesInvoicesTable.customerId,
          })
            .from(salesInvoicesTable)
            .where(and(
              eq(salesInvoicesTable.companyId, cid),
              eq(salesInvoicesTable.createdById, userId),
              ...branchScope,
            ))
            .orderBy(desc(salesInvoicesTable.createdAt))
            .limit(5)
        : Promise.resolve([]),
    ]);

    res.json({
      date: today,
      kpis: {
        todayNetSales:      Number(todayAgg[0]?.net   ?? 0),
        todayInvoiceCount:  Number(todayInvCount[0]?.count ?? 0),
        todayPostedCount:   Number(todayAgg[0]?.count ?? 0),
        weekNetSales:       Number(weekAgg[0]?.net    ?? 0),
        weekInvoiceCount:   Number(weekAgg[0]?.count  ?? 0),
        monthNetSales:      Number(monthAgg[0]?.net   ?? 0),
        monthInvoiceCount:  Number(monthAgg[0]?.count ?? 0),
        avgInvoiceMonth:    Number(monthAvg[0]?.avg   ?? 0),
        cashCollectedToday: Number(todayCashAgg[0]?.amount ?? 0),
        cashReceiptsCount:  Number(todayCashAgg[0]?.count  ?? 0),
        topCustomer: topCustomerRows[0] ? {
          customerId: topCustomerRows[0].customerId,
          nameAr:     topCustomerName.ar ?? "عميل نقدي",
          nameEn:     topCustomerName.en ?? "Cash Customer",
          total:      Number(topCustomerRows[0].total),
        } : null,
        topItem: topItemRows[0] ? {
          itemId: topItemRows[0].itemId,
          name:   topItemRows[0].itemName,
          total:  Number(topItemRows[0].total),
          qty:    Number(topItemRows[0].qty),
        } : null,
      },
      charts: { sales30d, paymentMix, byBranch, monthly12m },
      alerts: {
        zatcaPendingCount:      Number(zatcaPendingAgg[0]?.count ?? 0),
        lowStockCount:          Number(lowStockAgg[0]?.count     ?? 0),
        openPosSessionsCount:   Number(openSessionsAgg[0]?.count ?? 0),
        unreadNotificationsCount: Number(unreadNotifsAgg[0]?.count ?? 0),
        lowStockSample: lowStockSample.map(r => ({
          itemId:       r.itemId,
          code:         r.code,
          nameAr:       r.nameAr,
          nameEn:       r.nameEn,
          reorderLevel: Number(r.reorderLevel),
          currentQty:   Number(r.currentQty),
        })),
        openSessionsSample: openSessionsSample.map(s => ({
          id: s.id, userId: s.userId, branchId: s.branchId,
          openedAt: s.openedAt, openingCash: Number(s.openingCash),
        })),
      },
      myDay: {
        userId,
        myTodayNetSales:     Number(myTodayAgg[0]?.net    ?? 0),
        myTodayInvoiceCount: Number(myTodayAgg[0]?.count  ?? 0),
        myDraftsCount:       Number(myDraftsCount[0]?.count ?? 0),
        myRecentInvoices:    myRecentInvoices.map(r => ({
          id:          r.id,
          docNumber:   r.docNumber,
          invoiceDate: r.invoiceDate,
          status:      r.status,
          totalAmount: Number(r.totalAmount),
          customerId:  r.customerId,
        })),
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function emptyOverview() {
  return {
    date: new Date().toISOString().slice(0, 10),
    kpis: {
      todayNetSales: 0, todayInvoiceCount: 0, todayPostedCount: 0,
      weekNetSales:  0, weekInvoiceCount:  0,
      monthNetSales: 0, monthInvoiceCount: 0,
      avgInvoiceMonth: 0,
      cashCollectedToday: 0, cashReceiptsCount: 0,
      topCustomer: null, topItem: null,
    },
    charts: { sales30d: [], paymentMix: [], byBranch: [], monthly12m: [] },
    alerts: {
      zatcaPendingCount: 0, lowStockCount: 0, openPosSessionsCount: 0,
      unreadNotificationsCount: 0,
      lowStockSample: [], openSessionsSample: [],
    },
    myDay: {
      userId: null,
      myTodayNetSales: 0, myTodayInvoiceCount: 0, myDraftsCount: 0,
      myRecentInvoices: [],
    },
  };
}

export default router;
