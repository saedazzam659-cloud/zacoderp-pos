import { Router } from "express";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  branchesTable,
  contractingProjectsTable,
  db,
  employeesTable,
  fixedAssetsTable,
  itemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  purchaseInvoicesTable,
  purchaseReturnsTable,
  productionOrdersTable,
  salesInvoicesTable,
  salesReturnsTable,
  stockBalanceTable,
  warehousesTable,
} from "@workspace/db";
import { extractAuth, resolveCompanyId, branchScopeSpread } from "../middleware/auth.js";
import { ownDocumentFilter } from "../lib/documentVisibility.js";
import { canAccessModule, requirePermission } from "../middleware/permissions.js";

const router = Router();
router.use(extractAuth);
router.use(requirePermission("module_dashboards", "view"));

function parseDate(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? undefined : date;
}

function positiveId(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function currency(value: string | null | undefined): string {
  return value?.trim() || "غير محددة";
}

router.get("/overview", async (req: any, res): Promise<void> => {
  const cid = resolveCompanyId(req, req.query.companyId ? Number(req.query.companyId) : undefined);
  if (!cid) {
    res.status(400).json({ error: "الشركة غير محددة" });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const fromDate = req.query.fromDate === undefined ? `${today.slice(0, 8)}01` : parseDate(req.query.fromDate);
  const toDate = req.query.toDate === undefined ? today : parseDate(req.query.toDate);
  if (!fromDate || !toDate || fromDate > toDate) {
    res.status(400).json({ error: "نطاق التاريخ غير صالح" });
    return;
  }
  const span = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000;
  if (span > 366) {
    res.status(400).json({ error: "نطاق التاريخ لا يمكن أن يتجاوز 366 يومًا" });
    return;
  }
  const branchId = req.query.branchId === undefined || req.query.branchId === "" ? undefined : positiveId(req.query.branchId);
  const warehouseId = req.query.warehouseId === undefined || req.query.warehouseId === "" ? undefined : positiveId(req.query.warehouseId);
  if ((req.query.branchId && !branchId) || (req.query.warehouseId && !warehouseId)) {
    res.status(400).json({ error: "معرّف الفرع أو المستودع غير صالح" });
    return;
  }

  const user = req.authUser;
  const visibleModules = {
    sales: canAccessModule(user, "sales_reports", "view"),
    purchases: canAccessModule(user, "purchase_invoices", "view"),
    accounting: canAccessModule(user, "accounting_reports", "view"),
    inventory: canAccessModule(user, "inventory_reports", "view"),
    production: canAccessModule(user, "production", "view"),
    contracting: canAccessModule(user, "contracting", "view"),
    hr: canAccessModule(user, "hr_employees", "view"),
    fixedAssets: canAccessModule(user, "fixed_assets", "view"),
  };
  const branchScope = branchScopeSpread(req, branchesTable.id, branchId);
  const branchRows = await db.select({
    id: branchesTable.id,
    nameAr: branchesTable.nameAr,
    nameEn: branchesTable.nameEn,
  }).from(branchesTable).where(and(eq(branchesTable.companyId, cid), ...branchScope));

  const moduleData: Record<string, any> = {};

  if (visibleModules.sales) {
    const invoiceWhere = and(
      eq(salesInvoicesTable.companyId, cid),
      eq(salesInvoicesTable.status, "posted"),
      gte(salesInvoicesTable.invoiceDate, fromDate),
      lte(salesInvoicesTable.invoiceDate, toDate),
      ...ownDocumentFilter(req, "salesReportsOwn", salesInvoicesTable.createdById),
      ...branchScopeSpread(req, salesInvoicesTable.branchId, branchId),
    );
    const returnWhere = and(
      eq(salesReturnsTable.companyId, cid),
      eq(salesReturnsTable.status, "posted"),
      gte(salesReturnsTable.returnDate, fromDate),
      lte(salesReturnsTable.returnDate, toDate),
      ...ownDocumentFilter(req, "salesReportsOwn", salesReturnsTable.createdById),
      ...branchScopeSpread(req, salesReturnsTable.branchId, branchId),
    );
    const [invoices, returns, trend] = await Promise.all([
      db.select({
        currencyCode: salesInvoicesTable.currencyCode,
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${salesInvoicesTable.totalAmount}::numeric), 0)`,
      }).from(salesInvoicesTable).where(invoiceWhere).groupBy(salesInvoicesTable.currencyCode),
      db.select({
        currencyCode: salesReturnsTable.currencyCode,
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${salesReturnsTable.totalAmount}::numeric), 0)`,
      }).from(salesReturnsTable).where(returnWhere).groupBy(salesReturnsTable.currencyCode),
      db.select({
        date: salesInvoicesTable.invoiceDate,
        currencyCode: salesInvoicesTable.currencyCode,
        total: sql<string>`coalesce(sum(${salesInvoicesTable.totalAmount}::numeric), 0)`,
        count: sql<number>`count(*)::int`,
      }).from(salesInvoicesTable).where(invoiceWhere)
        .groupBy(salesInvoicesTable.invoiceDate, salesInvoicesTable.currencyCode)
        .orderBy(salesInvoicesTable.invoiceDate),
    ]);
    moduleData.sales = {
      invoicesByCurrency: invoices.map(row => ({ ...row, currencyCode: currency(row.currencyCode), total: Number(row.total) })),
      returnsByCurrency: returns.map(row => ({ ...row, currencyCode: currency(row.currencyCode), total: Number(row.total) })),
      trend: trend.map(row => ({ ...row, currencyCode: currency(row.currencyCode), total: Number(row.total) })),
      reportUrl: "/sales/reports",
    };
  }

  if (visibleModules.purchases) {
    const invoiceWhere = and(
      eq(purchaseInvoicesTable.companyId, cid),
      eq(purchaseInvoicesTable.status, "posted"),
      gte(purchaseInvoicesTable.invoiceDate, fromDate),
      lte(purchaseInvoicesTable.invoiceDate, toDate),
      ...ownDocumentFilter(req, "purchaseReportsOwn", purchaseInvoicesTable.createdById),
      ...branchScopeSpread(req, purchaseInvoicesTable.branchId, branchId),
    );
    const returnWhere = and(
      eq(purchaseReturnsTable.companyId, cid),
      eq(purchaseReturnsTable.status, "posted"),
      gte(purchaseReturnsTable.returnDate, fromDate),
      lte(purchaseReturnsTable.returnDate, toDate),
      ...ownDocumentFilter(req, "purchaseReportsOwn", purchaseReturnsTable.createdById),
      ...branchScopeSpread(req, purchaseReturnsTable.branchId, branchId),
    );
    const [invoices, returns, trend] = await Promise.all([
      db.select({
        currencyCode: purchaseInvoicesTable.currencyCode,
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}::numeric), 0)`,
      }).from(purchaseInvoicesTable).where(invoiceWhere).groupBy(purchaseInvoicesTable.currencyCode),
      db.select({
        currencyCode: purchaseReturnsTable.currencyCode,
        count: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${purchaseReturnsTable.totalAmount}::numeric), 0)`,
      }).from(purchaseReturnsTable).where(returnWhere).groupBy(purchaseReturnsTable.currencyCode),
      db.select({
        date: purchaseInvoicesTable.invoiceDate,
        currencyCode: purchaseInvoicesTable.currencyCode,
        total: sql<string>`coalesce(sum(${purchaseInvoicesTable.totalAmount}::numeric), 0)`,
        count: sql<number>`count(*)::int`,
      }).from(purchaseInvoicesTable).where(invoiceWhere)
        .groupBy(purchaseInvoicesTable.invoiceDate, purchaseInvoicesTable.currencyCode)
        .orderBy(purchaseInvoicesTable.invoiceDate),
    ]);
    moduleData.purchases = {
      invoicesByCurrency: invoices.map(row => ({ ...row, currencyCode: currency(row.currencyCode), total: Number(row.total) })),
      returnsByCurrency: returns.map(row => ({ ...row, currencyCode: currency(row.currencyCode), total: Number(row.total) })),
      trend: trend.map(row => ({ ...row, currencyCode: currency(row.currencyCode), total: Number(row.total) })),
      reportUrl: "/purchasing/reports",
    };
  }

  if (visibleModules.accounting) {
    const entryWhere = and(
      eq(journalEntriesTable.companyId, cid),
      eq(journalEntriesTable.status, "posted"),
      gte(journalEntriesTable.entryDate, fromDate),
      lte(journalEntriesTable.entryDate, toDate),
      ...branchScopeSpread(req, journalEntriesTable.branchId, branchId),
    );
    const [entries, totals] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(journalEntriesTable).where(entryWhere),
      db.select({
        currencyCode: journalEntriesTable.currency,
        debit: sql<string>`coalesce(sum(${journalEntryLinesTable.debit}::numeric), 0)`,
        credit: sql<string>`coalesce(sum(${journalEntryLinesTable.credit}::numeric), 0)`,
      }).from(journalEntriesTable)
        .innerJoin(journalEntryLinesTable, eq(journalEntryLinesTable.entryId, journalEntriesTable.id))
        .where(entryWhere)
        .groupBy(journalEntriesTable.currency),
    ]);
    moduleData.accounting = {
      postedEntries: entries[0]?.count ?? 0,
      totalsByCurrency: totals.map(row => ({
        currencyCode: currency(row.currencyCode),
        debit: Number(row.debit),
        credit: Number(row.credit),
      })),
      reportUrl: "/accounting/reports/trial-balance",
    };
  }

  let warehouseRows: Array<{ id: number; nameAr: string; nameEn: string | null; branchId: number | null }> = [];
  if (visibleModules.inventory) {
    const warehouseScope = branchScopeSpread(req, warehousesTable.branchId, branchId);
    const warehouseWhere = and(
      eq(warehousesTable.companyId, cid),
      ...(warehouseId ? [eq(warehousesTable.id, warehouseId)] : []),
      ...warehouseScope,
    );
    warehouseRows = await db.select({
      id: warehousesTable.id,
      nameAr: warehousesTable.nameAr,
      nameEn: warehousesTable.nameEn,
      branchId: warehousesTable.branchId,
    }).from(warehousesTable).where(warehouseWhere);

    const [itemsCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(itemsTable)
      .where(eq(itemsTable.companyId, cid));
    const stockRows = await db.select({
      itemId: stockBalanceTable.itemId,
      warehouseId: warehousesTable.id,
      warehouseNameAr: warehousesTable.nameAr,
      warehouseNameEn: warehousesTable.nameEn,
      qty: sql<string>`coalesce(sum(${stockBalanceTable.qty}::numeric), 0)`,
      value: sql<string>`coalesce(sum(${stockBalanceTable.qty}::numeric * ${stockBalanceTable.avgCost}::numeric), 0)`,
      reorderLevel: itemsTable.reorderLevel,
    }).from(stockBalanceTable)
      .innerJoin(warehousesTable, and(
        eq(warehousesTable.id, stockBalanceTable.warehouseId),
        eq(warehousesTable.companyId, cid),
      ))
      .innerJoin(itemsTable, and(
        eq(itemsTable.id, stockBalanceTable.itemId),
        eq(itemsTable.companyId, cid),
      ))
      .where(and(
        eq(stockBalanceTable.companyId, cid),
        ...(warehouseId ? [eq(warehousesTable.id, warehouseId)] : []),
        ...warehouseScope,
      ))
      .groupBy(stockBalanceTable.itemId, warehousesTable.id, warehousesTable.nameAr, warehousesTable.nameEn, itemsTable.reorderLevel);
    const byWarehouseMap = new Map<number, { warehouseId: number; nameAr: string; nameEn: string | null; qty: number; value: number }>();
    const itemQty = new Map<number, number>();
    for (const row of stockRows) {
      const existing = byWarehouseMap.get(row.warehouseId) ?? {
        warehouseId: row.warehouseId,
        nameAr: row.warehouseNameAr,
        nameEn: row.warehouseNameEn,
        qty: 0,
        value: 0,
      };
      existing.qty += Number(row.qty);
      existing.value += Number(row.value);
      byWarehouseMap.set(row.warehouseId, existing);
      itemQty.set(row.itemId, (itemQty.get(row.itemId) ?? 0) + Number(row.qty));
    }
    const lowStockItems = new Set(stockRows
      .filter(row => Number(row.reorderLevel ?? 0) > 0
        && (itemQty.get(row.itemId) ?? 0) < Number(row.reorderLevel ?? 0))
      .map(row => row.itemId));
    moduleData.inventory = {
      items: itemsCount?.count ?? 0,
      warehouses: warehouseRows.length,
      stockValue: Array.from(byWarehouseMap.values()).reduce((sum, row) => sum + row.value, 0),
      belowReorder: lowStockItems.size,
      byWarehouse: Array.from(byWarehouseMap.values()),
      reportUrl: "/inventory/reports",
    };
  }

  if (visibleModules.production) {
    const rows = await db.select({
      status: productionOrdersTable.status,
      count: sql<number>`count(*)::int`,
      produced: sql<string>`coalesce(sum(${productionOrdersTable.producedQty}::numeric), 0)`,
      waste: sql<string>`coalesce(sum(${productionOrdersTable.wasteQty}::numeric), 0)`,
    }).from(productionOrdersTable).where(and(
      eq(productionOrdersTable.companyId, cid),
      ...branchScopeSpread(req, productionOrdersTable.branchId, branchId),
    )).groupBy(productionOrdersTable.status);
    moduleData.production = {
      orders: rows.reduce((sum, row) => sum + row.count, 0),
      produced: rows.reduce((sum, row) => sum + Number(row.produced), 0),
      waste: rows.reduce((sum, row) => sum + Number(row.waste), 0),
      byStatus: rows.map(row => ({ status: row.status, count: row.count })),
      reportUrl: "/production",
    };
  }

  if (visibleModules.contracting) {
    const rows = await db.select({
      status: contractingProjectsTable.status,
      count: sql<number>`count(*)::int`,
    }).from(contractingProjectsTable).where(and(
      eq(contractingProjectsTable.companyId, cid),
      ...branchScopeSpread(req, contractingProjectsTable.branchId, branchId),
    )).groupBy(contractingProjectsTable.status);
    moduleData.contracting = {
      projects: rows.reduce((sum, row) => sum + row.count, 0),
      inProgress: rows.find(row => row.status === "in_progress")?.count ?? 0,
      completed: rows.find(row => row.status === "completed")?.count ?? 0,
      onHold: rows.find(row => row.status === "on_hold")?.count ?? 0,
      reportUrl: "/contracting",
    };
  }

  if (visibleModules.hr) {
    const rows = await db.select({
      status: employeesTable.status,
      count: sql<number>`count(*)::int`,
    }).from(employeesTable).where(and(
      eq(employeesTable.companyId, cid),
      ...branchScopeSpread(req, employeesTable.branchId, branchId),
    )).groupBy(employeesTable.status);
    moduleData.hr = {
      employees: rows.reduce((sum, row) => sum + row.count, 0),
      active: rows.find(row => row.status === "active")?.count ?? 0,
      inactive: rows.filter(row => row.status !== "active").reduce((sum, row) => sum + row.count, 0),
      reportUrl: "/hr/employees",
    };
  }

  if (visibleModules.fixedAssets) {
    const rows = await db.select({
      status: fixedAssetsTable.status,
      count: sql<number>`count(*)::int`,
    }).from(fixedAssetsTable).where(and(
      eq(fixedAssetsTable.companyId, cid),
      ...branchScopeSpread(req, fixedAssetsTable.branchId, branchId),
    )).groupBy(fixedAssetsTable.status);
    moduleData.fixedAssets = {
      assets: rows.reduce((sum, row) => sum + row.count, 0),
      active: rows.find(row => row.status === "active")?.count ?? 0,
      inMaintenance: rows.find(row => row.status === "in_maintenance")?.count ?? 0,
      reportUrl: "/fixed-assets",
    };
  }

  res.json({
    filters: { fromDate, toDate, branchId: branchId ?? null, warehouseId: warehouseId ?? null },
    options: {
      branches: branchRows,
      warehouses: warehouseRows,
    },
    visibleModules,
    modules: {
      sales: moduleData.sales ?? null,
      purchases: moduleData.purchases ?? null,
      accounting: moduleData.accounting ?? null,
      inventory: moduleData.inventory ?? null,
      production: moduleData.production ?? null,
      contracting: moduleData.contracting ?? null,
      hr: moduleData.hr ?? null,
      fixedAssets: moduleData.fixedAssets ?? null,
    },
  });
});

export default router;
