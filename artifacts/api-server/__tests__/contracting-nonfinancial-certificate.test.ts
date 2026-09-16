import { test } from "node:test";
import assert from "node:assert/strict";
import { isNonfinancialBoqCertificate } from "../src/lib/contracting-accounting-service.ts";

const base = { id: 1, projectId: 2, grossAmount: "40000", dueAmount: "0", vatAmount: "0", netAmount: "0", paidAmount: "0" };
test("a later zero-certification period can record execution despite previous cumulative gross", async () => {
  let queried = false;
  const tx = { execute: async () => { queried = true; return { rows: [{ physical_qty: "50", certified_value: "0" }] }; } };
  assert.equal(await isNonfinancialBoqCertificate(tx, 1, base), true);
  assert.equal(queried, true);
});
test("certified value and empty execution are not nonfinancial execution certificates", async () => {
  for (const row of [{ physical_qty: "50", certified_value: "10" }, { physical_qty: "0", certified_value: "0" }]) {
    assert.equal(await isNonfinancialBoqCertificate({ execute: async () => ({ rows: [row] }) }, 1, base), false);
  }
});
test("paid or financially due certificates cannot use the zero-journal path", async () => {
  const tx = { execute: async () => { throw Error("must not query"); } };
  assert.equal(await isNonfinancialBoqCertificate(tx, 1, { ...base, paidAmount: "1" }), false);
  assert.equal(await isNonfinancialBoqCertificate(tx, 1, { ...base, netAmount: "1" }), false);
});