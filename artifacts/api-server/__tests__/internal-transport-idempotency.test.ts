import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const transport = fs.readFileSync(
  new URL("../src/lib/internalManufacturingTransport.ts", import.meta.url),
  "utf8",
);

test("internal transport relink checks the locked allocation before late WIP JE", () => {
  const allocationRead = transport.indexOf("const allocations = await tx.select().from(productionCostAllocationsTable)");
  const lockRead = transport.indexOf('.for("update")', allocationRead);
  const idempotencyGuard = transport.indexOf("if (internalTransportLinkIsIdempotent(", lockRead);
  const lateJe = transport.indexOf("transportDeltaJournal(", idempotencyGuard);
  assert.ok(allocationRead >= 0, "link must read source allocations");
  assert.ok(lockRead > allocationRead, "source allocations must be locked");
  assert.ok(idempotencyGuard > lockRead, "idempotency guard must follow the locked allocation read");
  assert.ok(lateJe > idempotencyGuard, "late journal must follow the idempotency guard");
  assert.match(
    transport,
    /if \(internalTransportLinkIsIdempotent\([\s\S]*?return \{ transfer, allocation: previous, reclassificationJournalEntryId: null, idempotent: true \}/,
    "same-order retry must return without another JE",
  );
});

test("late transport fallback document number is unique per transfer", () => {
  assert.match(
    transport,
    /docNumber:\s*`\$\{order\.orderNumber\}-TRN-\$\{transfer\.id\}`/,
  );
});