import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const inventory = fs.readFileSync(
  new URL("../src/routes/inventory.ts", import.meta.url),
  "utf8",
);

test("internal transport relink checks the locked allocation before late WIP JE", () => {
  const linkStart = inventory.indexOf("async function linkTransferToProductionOrder");
  const linkEnd = inventory.indexOf('router.patch("/transfers/:id/production-order"', linkStart);
  assert.ok(linkStart >= 0 && linkEnd > linkStart);
  const link = inventory.slice(linkStart, linkEnd);
  const allocationRead = link.indexOf("const [existingAllocation]");
  const lateJe = link.indexOf("reclassifyLateInternalTransport");
  assert.ok(allocationRead >= 0, "link must read the source allocation");
  assert.ok(lateJe > allocationRead, "late JE must follow the idempotency guard");
  assert.match(
    link,
    /existingAllocation\.orderId === orderId[\s\S]*?return tr;/,
    "same-order retry must return without another JE",
  );
});

test("late transport fallback document number is unique per transfer", () => {
  assert.match(
    inventory,
    /\?\? `\$\{order\.orderNumber\}-TRN-\$\{transfer\.id\}`/,
  );
});