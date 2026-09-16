import { test } from "node:test";
import assert from "node:assert/strict";
import { recertifyBoqBill } from "../src/lib/contracting-boq-recertification.js";

// Test the real certification function without touching any database.
function scenario(currentQty: number, priorQty = 0, priorDate = "2026-01-01", direction = "outgoing") {
  const bill = {
    id: 20, companyId: 1, projectId: 2, direction,
    ownerContractId: direction === "outgoing" ? 3 : null,
    subcontractorContractId: direction === "incoming" ? 4 : null,
    billDate: "2026-02-01",
  };
  const boq = {
    id: 9, companyId: 1, projectId: 2,
    direction: direction === "outgoing" ? "owner" : "subcontract",
    ownerContractId: bill.ownerContractId,
    subcontractorContractId: bill.subcontractorContractId,
    quantity: "100", unitPrice: "10", unit: "m3",
  };
  const line = { id: 8, currentQty: String(currentQty), changeOrderId: null, changeOrderSubcontractId: null };
  const results: unknown[][] = [
    [{ line, boq }],
    [boq],
    priorQty ? [{
      billId: 10, billDate: priorDate,
      line: { currentQty: String(priorQty), currentValue: String(priorQty * 10) },
    }] : [],
  ];
  const updates: Record<string, unknown>[] = [];
  const events: string[] = [];
  const tx = {
    async execute() { events.push("contract-lock"); return { rows: [{ id: 3 }] }; },
    select() {
      events.push("read");
      const result = results.shift();
      assert.ok(result, "unexpected extra query");
      const builder: any = {
        then(resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      for (const method of ["from", "innerJoin", "where", "orderBy", "for"]) builder[method] = () => builder;
      return builder;
    },
    update() {
      return { set(value: Record<string, unknown>) {
        updates.push(value);
        return { async where() {} };
      } };
    },
  };
  return { bill, tx, updates, events };
}

test("approval recalculates BOQ snapshots from current certified quantities", async () => {
  const s = scenario(40, 60);
  await recertifyBoqBill(s.tx, 1, s.bill as any);
  assert.equal(s.events[0], "contract-lock");
  assert.equal(s.updates.length, 1);
  assert.equal(s.updates[0].previousQty, "60.0000");
  assert.equal(s.updates[0].cumulativeQty, "100.0000");
  assert.equal(s.updates[0].currentValue, "400.00");
});

test("a second 60-unit draft cannot certify after the first 60 of a 100-unit contract", async () => {
  const first = scenario(60);
  await recertifyBoqBill(first.tx, 1, first.bill as any);
  const second = scenario(60, 60);
  await assert.rejects(
    recertifyBoqBill(second.tx, 1, second.bill as any),
    (error: any) => error.status === 409,
  );
  assert.equal(second.updates.length, 0);
});

test("backdated drafts cannot replace later certified chronology", async () => {
  const s = scenario(10, 20, "2026-03-01");
  await assert.rejects(
    recertifyBoqBill(s.tx, 1, s.bill as any),
    (error: any) => error.status === 409 && /التاريخ/.test(error.message),
  );
  assert.equal(s.updates.length, 0);
});

test("subcontract certification uses its own BOQ terms", async () => {
  const s = scenario(20, 30, "2026-01-01", "incoming");
  await recertifyBoqBill(s.tx, 1, s.bill as any);
  assert.equal(s.updates[0].cumulativeQty, "50.0000");
  assert.equal(s.updates[0].currentValue, "200.00");
});