import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type BatchStatus = "expired" | "expiring_soon" | "active" | "no_expiry";
export const UNATTRIBUTED_BATCH = "__unattributed__";
export const NO_EXPIRY = "__no_expiry__";

export function businessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function batchStatus(expiry: string | null, today: string, nearDays: number): {
  status: BatchStatus; daysToExpiry: number | null;
} {
  if (!expiry) return { status: "no_expiry", daysToExpiry: null };
  const daysToExpiry = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return {
    daysToExpiry,
    status: daysToExpiry < 0 ? "expired" : daysToExpiry <= nearDays ? "expiring_soon" : "active",
  };
}

// A negative ledger row, including a reversal of an inbound row, is an
// issue; a positive row, including a reversal of an outbound row, is a receipt.
// Never pair rows by refId or infer a missing batch from a document.
export function signedBatchQuantities(qties: readonly (number | string)[]) {
  const receivedQty = qties.reduce<number>((n, qty) => n + Math.max(0, Number(qty)), 0);
  const issuedQty = qties.reduce<number>((n, qty) => n + Math.max(0, -Number(qty)), 0);
  return { receivedQty, issuedQty, remainingQty: receivedQty - issuedQty };
}

export interface BatchFilters {
  itemId?: number;
  brandId?: number;
  warehouseId?: number;
  batch?: string;
  expiryFrom?: string;
  expiryTo?: string;
  status?: BatchStatus;
  /** Exclude depleted and negative ledger buckets; omitted means include history. */
  onHandOnly?: boolean;
  nearDays: number;
  today: string;
  page: number;
  pageSize: number;
}

const list = (result: any): any[] => result.rows ?? result;

// Both the item detail and the cross-item report consume this exact grouped
// stock-ledger query. No tx_type filter: every signed movement counts once.
export async function queryBatchGroups(companyId: number, filters: BatchFilters, executor: any = db) {
  const where = [
    sql`l.company_id = ${companyId}`,
    filters.itemId != null ? sql`l.item_id = ${filters.itemId}` : sql`true`,
    filters.brandId != null ? sql`EXISTS (
      SELECT 1 FROM item_brands ib
      WHERE ib.company_id = ${companyId}
        AND ib.item_id = l.item_id
        AND ib.brand_id = ${filters.brandId}
    )` : sql`true`,
    filters.warehouseId != null ? sql`l.warehouse_id = ${filters.warehouseId}` : sql`true`,
  ];
  const grouped = sql`
    WITH grouped AS (
      SELECT l.item_id AS "itemId", l.warehouse_id AS "warehouseId",
        l.batch_number AS "batchNumber", l.expiry_date AS "expiryDate",
        coalesce(sum(l.qty) FILTER (WHERE l.qty > 0), 0) AS "receivedQty",
        coalesce(-sum(l.qty) FILTER (WHERE l.qty < 0), 0) AS "issuedQty",
        coalesce(sum(l.qty), 0) AS "remainingQty",
        coalesce(sum(l.qty * l.cost_price) FILTER (WHERE l.qty > 0)
          / nullif(sum(l.qty) FILTER (WHERE l.qty > 0), 0), 0) AS "avgCost",
        min(l.tx_date) AS "firstSeen", max(l.tx_date) AS "lastSeen"
      FROM stock_ledger l
      WHERE ${sql.join(where, sql` AND `)}
      GROUP BY l.item_id, l.warehouse_id, l.batch_number, l.expiry_date
    ), filtered AS (
      SELECT g.*, i.code AS "itemCode", i.name_ar AS "itemNameAr",
        i.name_en AS "itemNameEn", w.name_ar AS "warehouseAr", w.name_en AS "warehouseEn",
        CASE WHEN g."expiryDate" IS NULL THEN 'no_expiry'
          WHEN g."expiryDate" < ${filters.today}::date THEN 'expired'
          WHEN g."expiryDate" <= (${filters.today}::date + ${filters.nearDays}::integer) THEN 'expiring_soon'
          ELSE 'active' END AS status,
        (g."expiryDate" - ${filters.today}::date) AS "daysToExpiry"
      FROM grouped g
      JOIN items i ON i.id = g."itemId" AND i.company_id = ${companyId}
      JOIN warehouses w ON w.id = g."warehouseId" AND w.company_id = ${companyId}
      WHERE ${filters.batch === UNATTRIBUTED_BATCH ? sql`g."batchNumber" IS NULL` :
        filters.batch !== undefined ? sql`g."batchNumber" = ${filters.batch}` : sql`true`}
        AND ${filters.expiryFrom ? sql`g."expiryDate" >= ${filters.expiryFrom}::date` : sql`true`}
        AND ${filters.expiryTo ? sql`g."expiryDate" <= ${filters.expiryTo}::date` : sql`true`}
        AND ${filters.onHandOnly ? sql`g."remainingQty" > 0` : sql`true`}
    )
  `;
  const statusFilter = filters.status ? sql`WHERE status = ${filters.status}` : sql``;
  const summary = list(await executor.execute(sql`
    ${grouped}
    SELECT count(*)::integer AS total,
      coalesce(sum("receivedQty"), 0) AS "totalReceivedQty",
      coalesce(sum("issuedQty"), 0) AS "totalIssuedQty",
      coalesce(sum("remainingQty"), 0) AS "totalRemainingQty",
      count(*) FILTER (WHERE status = 'expired')::integer AS "expiredCount",
      count(*) FILTER (WHERE status = 'expiring_soon')::integer AS "expiringSoonCount",
      count(*) FILTER (WHERE status = 'active')::integer AS "activeCount",
      count(*) FILTER (WHERE status = 'no_expiry')::integer AS "noExpiryCount"
    FROM filtered ${statusFilter}
  `))[0];
  const rows = list(await executor.execute(sql`
    ${grouped}
    SELECT * FROM filtered ${statusFilter}
    ORDER BY "expiryDate" ASC NULLS LAST, "itemId", "warehouseId", "batchNumber" ASC NULLS LAST
    ${filters.pageSize === 0 ? sql`` : sql`LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}`}
  `)).map(r => ({
    itemId: Number(r.itemId),
    item: { id: Number(r.itemId), code: r.itemCode, nameAr: r.itemNameAr, nameEn: r.itemNameEn },
    warehouseId: Number(r.warehouseId),
    warehouse: { id: Number(r.warehouseId), nameAr: r.warehouseAr, nameEn: r.warehouseEn },
    batchNumber: r.batchNumber, expiryDate: r.expiryDate,
    receivedQty: Number(r.receivedQty), issuedQty: Number(r.issuedQty),
    remainingQty: Number(r.remainingQty), avgCost: Number(r.avgCost),
    firstSeen: r.firstSeen, lastSeen: r.lastSeen,
    daysToExpiry: r.daysToExpiry == null ? null : Number(r.daysToExpiry),
    status: r.status as BatchStatus,
  }));
  const total = Number(summary.total);
  return {
    rows, total, page: filters.page, pageSize: filters.pageSize,
    pageCount: filters.pageSize === 0 ? 1 : Math.max(1, Math.ceil(total / filters.pageSize)),
    summary: {
      totalBatches: total,
      totalReceivedQty: Number(summary.totalReceivedQty),
      totalIssuedQty: Number(summary.totalIssuedQty),
      totalRemainingQty: Number(summary.totalRemainingQty),
      expiredCount: Number(summary.expiredCount),
      expiringSoonCount: Number(summary.expiringSoonCount),
      activeCount: Number(summary.activeCount),
      noExpiryCount: Number(summary.noExpiryCount),
    },
  };
}

export async function queryBatchMovements(companyId: number, identity: {
  itemId: number; warehouseId: number; batch: string; expiryDate: string;
}, page: number, pageSize: number, executor: any = db) {
  const criteria = sql`company_id = ${companyId}
    AND item_id = ${identity.itemId} AND warehouse_id = ${identity.warehouseId}
    AND ${identity.batch === UNATTRIBUTED_BATCH ? sql`batch_number IS NULL` : sql`batch_number = ${identity.batch}`}
    AND ${identity.expiryDate === NO_EXPIRY ? sql`expiry_date IS NULL` : sql`expiry_date = ${identity.expiryDate}::date`}`;
  const [{ total }] = list(await executor.execute(sql`SELECT count(*)::integer AS total FROM stock_ledger WHERE ${criteria}`));
  const rows = list(await executor.execute(sql`
    SELECT id, tx_date AS "txDate", tx_type AS "txType", qty, cost_price AS "costPrice",
      total_cost AS "totalCost", balance_qty AS "balanceQty", ref_id AS "refId",
      ref_type AS "refType", source_line_id AS "sourceLineId",
      batch_number AS "batchNumber", expiry_date AS "expiryDate", notes,
      created_at AS "createdAt"
    FROM stock_ledger WHERE ${criteria}
    ORDER BY tx_date DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `)).map(r => ({
    ...r, id: Number(r.id), qty: Number(r.qty),
    receivedQty: Math.max(0, Number(r.qty)), issuedQty: Math.max(0, -Number(r.qty)),
    costPrice: Number(r.costPrice), totalCost: Number(r.totalCost), balanceQty: Number(r.balanceQty),
  }));
  return { rows, total: Number(total), page, pageSize, pageCount: Math.max(1, Math.ceil(Number(total) / pageSize)) };
}