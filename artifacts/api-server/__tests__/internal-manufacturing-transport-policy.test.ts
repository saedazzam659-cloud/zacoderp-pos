import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  accountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  productionCostAllocationsTable,
  productionEventsTable,
  productionOrdersTable,
  stockTransfersTable,
} from "@workspace/db";
import {
  INTERNAL_TRANSPORT_JOURNAL_WRITER,
  internalTransportAmount,
  lockInternalTransportMutation,
  listInternalDeliveryEvidence,
  linkPostedInternalTransport,
  postInternalTransportExpense,
  releaseInternalTransportSourceOwnership,
  resolveLegacyInternalTransportSource,
  reverseLateInternalTransportDeltas,
} from "../src/lib/internalManufacturingTransport.ts";

// This deliberately small Drizzle-shaped transaction records writes while
// exercising the real helper's lock/order/allocation paths. It is not a
// substitute DB: it makes accounting invariants cheap to test without a
// migration or a long-running server.
function txMock(selects: Map<any, any[]>) {
  const writes: Array<{ kind: string; table: any; values: any }> = [];
  const executed: any[] = [];
  const lockOrder: any[] = [];
  const read = (table: any) => {
    const chain: any = {
      where: () => chain, limit: () => chain,
      for: () => { lockOrder.push(table); return chain; }, orderBy: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve(selects.get(table)?.shift() ?? []).then(resolve, reject),
    };
    return chain;
  };
  const tx: any = {
    writes,
    executed,
    lockOrder,
    execute: async (statement: any) => { executed.push(statement); return []; },
    select: () => ({ from: (table: any) => read(table) }),
    insert: (table: any) => ({
      values(values: any) {
        writes.push({ kind: "insert", table, values });
        return { returning: async () => [{ id: 900 + writes.length, ...values }] };
      },
    }),
    update: (table: any) => ({
      set(values: any) {
        writes.push({ kind: "update", table, values });
        const chain: any = {
          where: () => chain,
          returning: async () => [{ id: 77, ...values }],
          then: (resolve: any, reject: any) => Promise.resolve().then(resolve, reject),
        };
        return chain;
      },
    }),
  };
  return tx;
}

const transfer = {
  id: 77, status: "posted", transferNumber: "TRN-77", transferDate: "2026-03-01",
  internalTransportAmount: "10.00", internalTransportJournalEntryId: 501,
  internalTransportExpenseAccountId: 11, internalTransportCounterpartAccountId: 12,
  productionOrderId: null,
};
const order = (id: number, issued = false) => ({
  id, status: "approved", branchId: 1, orderNumber: `MO-${id}`,
  issueJournalEntryId: issued ? 801 : null, wipAccountId: 31,
});
const authorizedReq = { authUser: { role: "superadmin" } };

test("actual helper posts a source expense as posted, exactly once", async () => {
  const tx = txMock(new Map([[accountsTable, [[
    { id: 11, accountType: "expense", isActive: true, isPosting: true },
    { id: 12, accountType: "liability", isActive: true, isPosting: true },
  ]]]]));
  const journals: any[] = [];
  const req: any = {
    [INTERNAL_TRANSPORT_JOURNAL_WRITER]: async (values: any) => {
      journals.push(values); return 501;
    },
  };
  assert.equal(await postInternalTransportExpense(
    tx, 1, { ...transfer, internalTransportJournalEntryId: null }, req, 1,
  ), 501);
  assert.equal(await postInternalTransportExpense(tx, 1, { ...transfer, internalTransportJournalEntryId: 501 }, req, 1), 501);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].status, "posted");
  assert.deepEqual(journals[0].lines.map((line: any) => [line.accountId, line.debit ?? 0, line.credit ?? 0]),
    [[11, 10, 0], [12, 0, 10]]);
});

test("actual link helper creates one source-owned allocation and is retry/zero-cost safe", async () => {
  const target = order(2);
  const tx = txMock(new Map([
    [productionOrdersTable, [[target], [target], [target], [target]]], // validate/lock twice
    [productionCostAllocationsTable, [[], [{ id: 901, orderId: 2, snapshotMeta: { internalTransportActive: true } }]]],
  ]));
  const first = await linkPostedInternalTransport(tx, 1, transfer, 2, authorizedReq, [1, 1]);
  assert.equal(first.idempotent, false);
  assert.equal(tx.writes.filter((x) => x.kind === "insert" && x.table === productionCostAllocationsTable).length, 1);
  const retry = await linkPostedInternalTransport(tx, 1, { ...transfer, productionOrderId: 2 }, 2, authorizedReq, [1, 1]);
  assert.equal(retry.idempotent, true);
  assert.equal(tx.writes.filter((x) => x.kind === "insert" && x.table === productionCostAllocationsTable).length, 1);

  const zeroTx = txMock(new Map([
    [productionOrdersTable, [[target], [target], [target], [target]]],
    [productionCostAllocationsTable, [[], []]],
  ]));
  const zero = { ...transfer, internalTransportAmount: "0", internalTransportJournalEntryId: null };
  assert.equal((await linkPostedInternalTransport(zeroTx, 1, zero, 2, authorizedReq, [1, 1])).allocation, null);
  assert.equal(zeroTx.writes.some((x) => x.table === productionCostAllocationsTable), false);
  assert.equal((await linkPostedInternalTransport(zeroTx, 1, { ...zero, productionOrderId: 2 }, 2, authorizedReq, [1, 1])).idempotent, true);
});

test("actual issued A→B→A relinks use the shared source/order lock path and only delta journals", async () => {
  const a = { id: 20, orderId: 1, allocatedAmount: "10", sourceAmount: "10", snapshotMeta: { internalTransportActive: true, transportIncludedInOriginalIssue: true } };
  const b = { id: 21, orderId: 2, allocatedAmount: "10", sourceAmount: "10", snapshotMeta: { internalTransportActive: true } };
  const journals: any[] = [];
  const req: any = { ...authorizedReq, [INTERNAL_TRANSPORT_JOURNAL_WRITER]: async (values: any) => { journals.push(values); return 100 + journals.length; } };
  const firstTx = txMock(new Map([
    [productionOrdersTable, [[order(2, true)], [order(1, true)], [order(2, true)]]],
    [productionCostAllocationsTable, [[a]]],
  ]));
  await linkPostedInternalTransport(firstTx, 1, { ...transfer, productionOrderId: 1 }, 2, req, [1, 1]);
  const secondTx = txMock(new Map([
    [productionOrdersTable, [[order(1, true)], [order(1, true)], [order(2, true)]]],
    [productionCostAllocationsTable, [[
      { ...a, allocatedAmount: "0", snapshotMeta: { internalTransportActive: false, transportDeltaJournalEntryIds: [101] } },
      { ...b, snapshotMeta: { internalTransportActive: true, transportDeltaJournalEntryIds: [102] } },
    ]]],
  ]));
  await linkPostedInternalTransport(secondTx, 1, { ...transfer, productionOrderId: 2 }, 1, req, [1, 1]);
  assert.equal(journals.length, 4);
  assert.deepEqual(journals.map((j) => j.entryType), [
    "internal_transport_reclassification_reversal",
    "internal_transport_reclassification",
    "internal_transport_reclassification_reversal",
    "internal_transport_reclassification",
  ]);
  // execute records both positive order advisory locks and the negative
  // transfer source lock; the real helper uses this order before allocations.
  assert.equal(firstTx.executed.length >= 3, true);
  assert.equal(secondTx.executed.length >= 3, true);
});

test("relink and lifecycle reversal invert every recorded delta exactly once", async () => {
  const journals: any[] = [];
  const allocationA = {
    id: 10, orderId: 1, allocatedAmount: "10", sourceAmount: "10",
    snapshotMeta: { internalTransportActive: true, transportDeltaJournalEntryIds: [101, 104] },
  };
  const allocationB = {
    id: 11, orderId: 1, allocatedAmount: "0", sourceAmount: "10",
    snapshotMeta: { internalTransportActive: false, transportDeltaJournalEntryIds: [102, 103] },
  };
  const tx = txMock(new Map([
    [productionCostAllocationsTable, [[allocationA, allocationB]]],
    [journalEntriesTable, [[{ status: "posted" }], [{ status: "posted" }], [{ status: "posted" }], [{ status: "posted" }]]],
    [journalEntryLinesTable, [
      [{ accountId: 31, debit: "10", credit: "0", description: "WIP" }, { accountId: 11, debit: "0", credit: "10", description: "expense" }],
      [{ accountId: 11, debit: "10", credit: "0", description: "expense" }, { accountId: 31, debit: "0", credit: "10", description: "WIP" }],
      [{ accountId: 31, debit: "10", credit: "0", description: "WIP" }, { accountId: 11, debit: "0", credit: "10", description: "expense" }],
      [{ accountId: 11, debit: "10", credit: "0", description: "expense" }, { accountId: 31, debit: "0", credit: "10", description: "WIP" }],
    ]],
  ]));
  const req: any = { [INTERNAL_TRANSPORT_JOURNAL_WRITER]: async (values: any) => { journals.push(values); return 200 + journals.length; } };
  await reverseLateInternalTransportDeltas(tx, 1, order(1, true), req);
  assert.equal(journals.length, 4); // every A→B→A delta is exactly inverted
  assert.deepEqual(journals[0].lines.map((x: any) => [x.debit, x.credit]), [[0, 10], [10, 0]]);
  const lifecycleWrite = tx.writes.find((x) => x.table === productionCostAllocationsTable && x.kind === "update");
  assert.deepEqual(Object.keys(lifecycleWrite!.values.snapshotMeta.lifecycleReversalJournalEntryIds).sort(), ["101", "104"]);
});

test("transport amount is monetary, non-negative, and never goods value", () => {
  assert.equal(internalTransportAmount("12.345"), 12.35);
  assert.equal(internalTransportAmount(null), 0);
  assert.throws(() => internalTransportAmount(-1), /موجباً أو صفراً/);
});

test("terminal lifecycle releases the source association without touching its expense", async () => {
  const tx = txMock(new Map([
    [productionCostAllocationsTable, [[{
      id: 10, orderId: 1, allocatedAmount: "10", sourceAmount: "10",
      snapshotMeta: { internalTransportActive: true },
    }]]],
  ]));
  await releaseInternalTransportSourceOwnership(tx, 1, 1);
  const allocationRelease = tx.writes.find((x) => x.table === productionCostAllocationsTable);
  assert.equal(allocationRelease?.values.allocatedAmount, "0");
  assert.equal(allocationRelease?.values.snapshotMeta.internalTransportActive, false);
  assert.equal(tx.writes.some((x) => x.table === stockTransfersTable), true);
  assert.equal(tx.writes.some((x) => x.table === journalEntriesTable), false);
});

test("route mutation entry acquires sorted order locks before the transfer row and rejects stale ownership", async () => {
  const linked = { ...transfer, productionOrderId: 2 };
  const tx = txMock(new Map([
    [stockTransfersTable, [[linked], [linked]]],
    [productionOrdersTable, [[order(1)], [order(2)]]],
  ]));
  await lockInternalTransportMutation(tx, 1, transfer.id, authorizedReq, 1);
  assert.deepEqual(tx.lockOrder, [productionOrdersTable, productionOrdersTable, stockTransfersTable]);
  const dialect = new PgDialect();
  assert.deepEqual(tx.executed.map((query: any) => dialect.sqlToQuery(query).params), [[1, 1], [1, 2], [1, -77]]);
  const stale = txMock(new Map([
    [stockTransfersTable, [[linked], [{ ...linked, productionOrderId: 3 }]]],
    [productionOrdersTable, [[order(1)], [order(2)]]],
  ]));
  await assert.rejects(lockInternalTransportMutation(stale, 1, transfer.id, authorizedReq, 1),
    (error: any) => error.status === 409);
  // Verify both actual route callers use the tested entry point rather than
  // taking a transfer row lock first. This is a caller-order regression guard.
  const source = readFileSync(new URL("../src/routes/inventory.ts", import.meta.url), "utf8");
  for (const suffix of ["/post", "/link-production-order"]) {
    const route = source.split(`router.post("/stock-transfers/:id${suffix}"`)[1].split("\nrouter.")[0];
    const beforeEntry = route.split("await lockInternalTransportMutation")[0];
    assert.ok(route.includes("await lockInternalTransportMutation"));
    assert.equal(beforeEntry.includes('.for("update")'), false);
  }
  const deletion = source.split('router.delete("/stock-transfers/:id"')[1].split("\nrouter.")[0];
  assert.ok(deletion.includes("db.transaction"));
  assert.ok(deletion.indexOf('.for("update")') < deletion.indexOf("await tx.delete"));
  assert.ok(deletion.indexOf("await transferWarehouses") < deletion.indexOf("await tx.delete"));
});

test("inventory-only users cannot change manufacturing ownership and old-order branch scope is checked", async () => {
  const linked = { ...transfer, productionOrderId: 2 };
  const denied = txMock(new Map([[stockTransfersTable, [[linked]]]]));
  await assert.rejects(lockInternalTransportMutation(denied, 1, transfer.id, {}, null),
    (error: any) => error.status === 403);
  const scopedReq = { authUser: { role: "user", branchIds: [1],
    permissions: { production: { post: true } } } };
  // Direct helper checks authorization before any mutation, including zero cost.
  await assert.rejects(linkPostedInternalTransport(denied, 1, { ...linked, internalTransportAmount: "0" }, null, {}, [1]),
    (error: any) => error.status === 403);
  const outOfScope = txMock(new Map([
    [stockTransfersTable, [[linked]]],
    [productionOrdersTable, [[{ ...order(2), branchId: 3 }]]],
  ]));
  await assert.rejects(lockInternalTransportMutation(outOfScope, 1, transfer.id, scopedReq, null),
    (error: any) => error.status === 403 && error.message.includes("الفرع"));
  assert.equal(outOfScope.lockOrder.includes(stockTransfersTable), false);
  assert.equal(denied.writes.length, 0);
});

test("delivery history includes released charges and zero-charge event evidence without active costs", async () => {
  const historical = { ...transfer, productionOrderId: 9, transferType: "manufacturing" };
  const zero = { ...historical, id: 78, internalTransportAmount: "0", productionOrderId: null };
  const tx = txMock(new Map([
    [productionCostAllocationsTable, [[{ sourceRecordId: 77, allocatedAmount: "0", snapshotMeta: { internalTransportActive: false } }]]],
    [productionEventsTable, [[{ payload: { transferId: 78 } }]]],
    [stockTransfersTable, [[historical, zero]]],
  ]));
  const rows = await listInternalDeliveryEvidence(tx, 1, 2, authorizedReq);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row: any) => row.associationState === "historical" && !row.active && row.allocatedAmount === "0.00"));
  assert.equal(rows[0].currentProductionOrderId, 9);
});

test("legacy combined stock JE proves transport expense without another source posting", async () => {
  const legacy = { ...transfer, internalTransportJournalEntryId: null, journalEntryId: 80 };
  const tx = txMock(new Map([
    [journalEntriesTable, [[{ id: 80, status: "posted", entryType: "stock_transfer" }]]],
    [journalEntryLinesTable, [[
      { accountId: 11, debit: "10", credit: "0", description: "مصروف تسليم داخلي (TRN-77)" },
      { accountId: 12, debit: "0", credit: "10", description: "مقابل تسليم داخلي (TRN-77)" },
      { accountId: 41, debit: "100", credit: "0", description: "استلام بالمخزن" },
      { accountId: 42, debit: "0", credit: "100", description: "صرف من المخزن" },
    ]]],
  ]));
  assert.equal(await postInternalTransportExpense(tx, 1, legacy, authorizedReq, 1), 80);
  assert.equal(tx.writes.length, 0);
  const unproven = txMock(new Map([
    [journalEntriesTable, [[{ id: 80, status: "posted", entryType: "stock_transfer" }]]],
    [journalEntryLinesTable, [[
      { accountId: 11, debit: "10", credit: "0", description: "unrelated debit" },
      { accountId: 12, debit: "0", credit: "10", description: "unrelated credit" },
    ]]],
  ]));
  await assert.rejects(resolveLegacyInternalTransportSource(unproven, 1, legacy),
    (error: any) => error.status === 409);
});

test("legacy column supplemental journal reverses once through the shared metadata engine", async () => {
  const legacyAllocation = {
    id: 2, sourceRecordId: 77, reclassificationJournalEntryId: 99,
    reversalJournalEntryId: null, snapshotMeta: {},
  };
  const tx = txMock(new Map([
    [productionCostAllocationsTable, [[legacyAllocation]]],
    [journalEntriesTable, [[{ status: "posted" }]]],
    [journalEntryLinesTable, [[
      { accountId: 31, debit: "10", credit: "0", description: "WIP", costCenter: "FACTORY" },
      { accountId: 11, debit: "0", credit: "10", description: "expense", costCenter: "FACTORY" },
    ]]],
  ]));
  const journals: any[] = [];
  const req = { ...authorizedReq, [INTERNAL_TRANSPORT_JOURNAL_WRITER]: async (values: any) => {
    journals.push(values); return 100;
  } };
  await reverseLateInternalTransportDeltas(tx, 1, order(1, true), req);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].lines[0].costCenter, "FACTORY");
  assert.equal(tx.writes[0].values.reversalJournalEntryId, 100);
  const retry = txMock(new Map([
    [productionCostAllocationsTable, [[{
      ...legacyAllocation, reversalJournalEntryId: 100,
      snapshotMeta: tx.writes[0].values.snapshotMeta,
    }]]],
  ]));
  await reverseLateInternalTransportDeltas(retry, 1, order(1, true), req);
  assert.equal(journals.length, 1);
});