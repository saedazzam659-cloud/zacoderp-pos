import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("pending settlement sweep is automatic, bounded, and tenant-scoped", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  assert.match(source, /PENDING_SOURCE_SWEEP_MS = 60 \* 60_000/);
  assert.match(source, /startPendingResourceSettlementScheduler/);
  assert.match(source, /pendingSourceSettlement' = 'true'/);
  assert.match(source, /assertAllocationCapacity\(source\.amount, used, actualAmount\)/);
  assert.match(source, /productionPendingSourceSettlementsTable\.stageResourceCostId[\s\S]*?isNull\(productionPendingSourceSettlementsTable\.reversalJournalEntryId\)/);
});

test("completed-order settlement and reversal require isolated stock evidence", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const settlementStart = source.indexOf("async function settlePendingResourceEvidence");
  const settlementEnd = source.indexOf("export async function runPendingResourceSettlementSweep", settlementStart);
  const settlement = source.slice(settlementStart, settlementEnd);
  assert.match(settlement, /Math\.abs\(Number\(balance\.qty\) - Number\(order\.producedQty\)\) > 0\.0001/);
  assert.match(settlement, /laterStockMovement/);
  assert.match(settlement, /production_pending_source_settlement/);
  assert.match(source, /لا يمكن عكس التسوية: تغير رصيد المخزون بعد تعديل تكلفة البضاعة التامة/);
  assert.match(source, /reversePendingSourceSettlements\(tx, cid, order, todayIso, req, false\)/);
});

test("compact manufacturing exposes pending settlements without allowing a manual posting bypass", async () => {
  const server = await readFile(new URL("../src/routes/simple-manufacturing.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../../zatca-invoicing/src/pages/SimpleManufacturing.tsx", import.meta.url), "utf8");
  const list = await readFile(new URL("../../zatca-invoicing/src/pages/simple-manufacturing/SimpleList.tsx", import.meta.url), "utf8");
  assert.match(server, /router\.get\(\"\/orders\/pending-source-settlements\", view/);
  assert.match(server, /eq\(productionStageResourceCostsTable\.companyId, cid\)/);
  assert.match(server, /productionPendingSourceSettlementsTable\.status, \"posted\"/);
  assert.match(client, /useListManufacturingPendingSourceSettlements/);
  assert.match(client, /refetchInterval: 60_000/);
  assert.match(list, /تكلفة المبيعات التاريخية لا تتغير/);
  assert.match(list, /card-pending-source-settlements/);
});
