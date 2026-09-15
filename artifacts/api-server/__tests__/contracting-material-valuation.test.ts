import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateContractingPicks,
  idempotencyFingerprint,
  legacyInventoryQuantity,
} from "../src/lib/contracting-accounting-service.ts";
import {
  addRational,
  multiplyRational,
  parseExactDecimal,
} from "../src/lib/unitConversion.ts";
import { materialMovementCost } from "../src/lib/contracting-accounting-math.ts";

function layer(
  batchNumber: string | null,
  expiryDate: string | null,
  remaining: string,
  unitCost: string,
  inboundDate = "2026-01-01",
) {
  return {
    batchNumber,
    expiryDate,
    remaining: Number(remaining),
    remainingRaw: remaining,
    inboundQty: Number(remaining),
    inboundQtyRaw: remaining,
    inboundCost: Number(remaining) * Number(unitCost),
    inboundCostRaw: `${Number(remaining) * Number(unitCost)}`,
    earliestInDate: inboundDate,
  };
}

test("contracting FIFO/FEFO plans preserve layer cost and partial demand", () => {
  const fifo = allocateContractingPicks([
    layer("FIFO-OLD", "2027-12-01", "2", "10"),
    layer("FIFO-NEW", "2027-01-01", "3", "12", "2026-02-01"),
  ], parseExactDecimal("4"), "2026-03-01");
  assert.deepEqual(fifo.map((pick) => [pick.batchNumber, pick.takeQty.numerator.toString()]), [
    ["FIFO-OLD", "2"],
    ["FIFO-NEW", "2"],
  ]);
  const fifoCost = fifo.reduce(
    (sum, pick) => addRational(sum, multiplyRational(pick.takeQty, pick.costPrice)),
    parseExactDecimal("0"),
  );
  assert.deepEqual(fifoCost, parseExactDecimal("44"));

  // FEFO ordering is supplied by readBatchRemaining's SQL order; the picker
  // must consume that order and split the request rather than recomputing WAC.
  const fefo = allocateContractingPicks([
    layer("FEFO-NEAREST", "2026-04-01", "1", "20"),
    layer("FEFO-LATER", "2026-09-01", "2", "30"),
  ], parseExactDecimal("1.5"), "2026-03-01");
  assert.deepEqual(fefo.map((pick) => [pick.batchNumber, pick.takeQty.numerator.toString()]), [
    ["FEFO-NEAREST", "1"],
    ["FEFO-LATER", "1"],
  ]);
});

test("explicit null expiry is a distinct lot identity and expired stock cannot cover demand", () => {
  const unexpiredNullExpiry = allocateContractingPicks([
    layer("LOT-A", "2027-08-01", "4", "9"),
    layer("LOT-A", null, "2", "8"),
  ], parseExactDecimal("1"), "2026-03-01", "LOT-A", null);
  assert.equal(unexpiredNullExpiry.length, 1);
  assert.equal(unexpiredNullExpiry[0].batchNumber, "LOT-A");
  assert.equal(unexpiredNullExpiry[0].expiryDate, null);

  assert.throws(
    () => allocateContractingPicks([
      layer("EXPIRED", "2025-12-31", "4", "9"),
    ], parseExactDecimal("1"), "2026-03-01"),
    /غير منتهية الصلاحية لا تكفي/,
  );
});

test("partial return cost cap, replay key behavior, and legacy precision boundary remain explicit", () => {
  const partial = materialMovementCost({
    direction: "return",
    qtyBase: 2,
    unitCost: "12.50",
    sourceQtyBase: 5,
    alreadyReturnedBase: 1,
  });
  assert.deepEqual(partial, { ok: true, qtyBase: 2, unitCost: 12.5, totalCost: 25 });
  assert.equal(materialMovementCost({
    direction: "return",
    qtyBase: 5,
    unitCost: "12.50",
    sourceQtyBase: 5,
    alreadyReturnedBase: 1,
  }).ok, false);

  const posted = new Map<string, string>();
  const postOnce = (key: string, payload: string) => {
    const fingerprint = idempotencyFingerprint({ payload });
    const previous = posted.get(key);
    if (previous && previous !== fingerprint) throw new Error("idempotency conflict");
    if (previous) return "replayed";
    posted.set(key, fingerprint);
    return "posted";
  };
  assert.equal(postOnce("material-1", "qty=1"), "posted");
  assert.equal(postOnce("material-1", "qty=1"), "replayed");
  assert.throws(() => postOnce("material-1", "qty=2"), /idempotency conflict/);

  assert.equal(legacyInventoryQuantity(parseExactDecimal("1.2345")), "1.2345");
  assert.throws(
    () => legacyInventoryQuantity(parseExactDecimal("1.23456")),
    /4 منازل عشرية/,
  );
});