import test from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  batchStatus, businessDate, validDateOnly, signedBatchQuantities,
  queryBatchGroups, queryBatchMovements, UNATTRIBUTED_BATCH, NO_EXPIRY,
} from "../src/lib/batchReport.ts";

test("signed ledger entries include all movement types and reversals once", () => {
  // purchase, production receipt, sale, return, transfer out/in,
  // adjustment, reversal of a receipt and reversal of an issue.
  assert.deepEqual(signedBatchQuantities(["10", "4", "-3", "2", "-5", "5", "-1", "-4", "3"]), {
    receivedQty: 24, issuedQty: 13, remainingQty: 11,
  });
});

test("expiry boundaries are date-only in the Saudi business zone", () => {
  assert.equal(businessDate(new Date("2026-01-01T22:30:00Z")), "2026-01-02");
  assert.deepEqual(batchStatus("2026-01-01", "2026-01-02", 30), { status: "expired", daysToExpiry: -1 });
  assert.deepEqual(batchStatus("2026-01-02", "2026-01-02", 30), { status: "expiring_soon", daysToExpiry: 0 });
  assert.deepEqual(batchStatus("2026-02-01", "2026-01-02", 30), { status: "expiring_soon", daysToExpiry: 30 });
  assert.deepEqual(batchStatus("2026-02-02", "2026-01-02", 30), { status: "active", daysToExpiry: 31 });
  assert.deepEqual(batchStatus(null, "2026-01-02", 30), { status: "no_expiry", daysToExpiry: null });
  assert.equal(validDateOnly("2026-02-30"), false);
});

const dialect = new PgDialect();

test("group report applies tenant, item, warehouse, expiry and status to both total and rows", async () => {
  const calls: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const executor = {
    execute: async (statement: any) => {
      const compiled = dialect.sqlToQuery(statement);
      calls.push(compiled);
      return { rows: calls.length === 1 ? [{
        total: 1, totalReceivedQty: "10", totalIssuedQty: "4", totalRemainingQty: "6",
        expiredCount: 0, expiringSoonCount: 1, activeCount: 0, noExpiryCount: 0,
      }] : [{
        itemId: 42, warehouseId: 7, itemCode: "SKU", itemNameAr: "صنف",
        itemNameEn: "Item", warehouseAr: "مخزن", warehouseEn: "Warehouse",
        batchNumber: "B", expiryDate: "2026-01-05",
        receivedQty: "10", issuedQty: "4", remainingQty: "6", avgCost: "8",
        firstSeen: "2026-01-01", lastSeen: "2026-01-02",
        daysToExpiry: 3, status: "expiring_soon",
      }] };
    },
  };
  const report = await queryBatchGroups(19, {
    itemId: 42, warehouseId: 7, batch: "B", expiryFrom: "2026-01-01",
    expiryTo: "2026-01-31", status: "expiring_soon",
    onHandOnly: true, nearDays: 30, today: "2026-01-02", page: 2, pageSize: 25,
  }, executor);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].remainingQty, 6);
  assert.equal(report.summary.totalReceivedQty, 10);
  assert.equal(report.pageCount, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /l\.company_id =/);
    assert.match(call.sql, /i\.company_id =/);
    assert.match(call.sql, /w\.company_id =/);
    assert.match(call.sql, /l\.item_id =/);
    assert.match(call.sql, /l\.warehouse_id =/);
    assert.match(call.sql, /g\."expiryDate" >=/);
    assert.match(call.sql, /g\."expiryDate" <=/);
    assert.match(call.sql, /g\."remainingQty" > 0/);
    assert.match(call.sql, /WHERE status =/);
    assert.ok(call.params.includes(19));
    assert.ok(call.params.includes(42));
    assert.ok(call.params.includes(7));
  }
  assert.match(calls[1].sql, /LIMIT .* OFFSET/);
  assert.ok(calls[1].params.includes(25));
});

test("brand filter scopes batch totals and rows to linked items", async () => {
  const calls: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const executor = {
    execute: async (statement: any) => {
      calls.push(dialect.sqlToQuery(statement));
      return { rows: calls.length === 1 ? [{
        total: 0, totalReceivedQty: "0", totalIssuedQty: "0", totalRemainingQty: "0",
        expiredCount: 0, expiringSoonCount: 0, activeCount: 0, noExpiryCount: 0,
      }] : [] };
    },
  };
  const report = await queryBatchGroups(19, {
    brandId: 77, nearDays: 30, today: "2026-01-02", page: 1, pageSize: 25,
  }, executor);
  assert.equal(report.total, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /EXISTS \(\s*SELECT 1 FROM item_brands ib/);
    assert.match(call.sql, /ib\.company_id =/);
    assert.match(call.sql, /ib\.item_id = l\.item_id/);
    assert.match(call.sql, /ib\.brand_id =/);
    assert.ok(call.params.includes(19));
    assert.ok(call.params.includes(77));
  }
});

test("omitting onHandOnly preserves depleted history in item and default reports", async () => {
  const calls: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const executor = {
    execute: async (statement: any) => {
      calls.push(dialect.sqlToQuery(statement));
      return { rows: calls.length === 1 ? [{
        total: 1, totalReceivedQty: "10", totalIssuedQty: "10", totalRemainingQty: "0",
        expiredCount: 1, expiringSoonCount: 0, activeCount: 0, noExpiryCount: 0,
      }] : [{
        itemId: 42, warehouseId: 7, itemCode: "SKU", itemNameAr: "صنف",
        itemNameEn: null, warehouseAr: "مخزن", warehouseEn: null,
        batchNumber: "B", expiryDate: "2025-01-01",
        receivedQty: "10", issuedQty: "10", remainingQty: "0", avgCost: "8",
        firstSeen: "2025-01-01", lastSeen: "2025-01-02",
        daysToExpiry: -1, status: "expired",
      }] };
    },
  };
  const report = await queryBatchGroups(19, {
    nearDays: 30, today: "2025-01-02", page: 1, pageSize: 25,
  }, executor);
  assert.equal(report.rows[0].remainingQty, 0);
  assert.equal(report.summary.expiredCount, 1);
  assert.ok(calls.every(call => !call.sql.includes('g."remainingQty" > 0')));
  assert.ok(calls.every(call => !call.sql.includes("item_brands")));
});

test("drilldown selects exact null bucket, tenant and expiry, with one ledger row per id", async () => {
  const calls: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const executor = {
    execute: async (statement: any) => {
      calls.push(dialect.sqlToQuery(statement));
      return { rows: calls.length === 1 ? [{ total: 1 }] : [{
        id: 101, qty: "-2", costPrice: "4", totalCost: "-8", balanceQty: "3",
        batchNumber: null, expiryDate: null,
      }] };
    },
  };
  const report = await queryBatchMovements(19, {
    itemId: 42, warehouseId: 7, batch: UNATTRIBUTED_BATCH, expiryDate: NO_EXPIRY,
  }, 1, 25, executor);
  assert.equal(report.rows[0].issuedQty, 2);
  assert.equal(report.rows[0].receivedQty, 0);
  assert.equal(report.total, 1);
  for (const call of calls) {
    assert.match(call.sql, /company_id =/);
    assert.match(call.sql, /batch_number IS NULL/);
    assert.match(call.sql, /expiry_date IS NULL/);
    assert.ok(call.params.includes(19));
  }
  assert.match(calls[1].sql, /FROM stock_ledger WHERE/);
  assert.doesNotMatch(calls[1].sql, /JOIN/);
});