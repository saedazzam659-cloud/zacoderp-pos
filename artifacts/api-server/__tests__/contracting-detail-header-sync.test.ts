import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { certifyBillAmounts } from "../src/lib/contracting-accounting-service.ts";
import { calculateAdvanceRecoveryCents } from "../src/lib/contracting-accounting-math.ts";

function scenario(current: string, prior = "0", priorRetention = "0", persist = true) {
  let written: any = null;
  const dialect = new PgDialect();
  const tx: any = {
    select: () => ({ from: () => ({ where: async () => [{ id: 1, projectId: 2 }] }) }),
    execute: async (statement: any) => {
      const query = dialect.sqlToQuery(statement).sql;
      if (/COUNT\(\*\) AS line_count/.test(query)) return { rows: [{ line_count: 1, current_value: current }] };
      if (/prior_gross/.test(query)) return { rows: [{ prior_gross: prior, prior_retention: priorRetention }] };
      if (/SUM\(CASE WHEN price_includes_vat/.test(query)) return { rows: [{ value: "0" }] };
      return { rows: [{ id: 1, value: "100000", vat_percent: "15.00", price_includes_vat: false, contract_type: "main" }] };
    },
    update: () => ({ set: (value: any) => { written = value; return { where: async () => [] }; } }),
  };
  const bill = { id: 2, projectId: 2, direction: "outgoing", ownerContractId: 1,
    billDate: "2026-09-16", grossAmount: "0", retentionEnabled: true,
    retentionPercent: "5", retentionCapPercent: "100", vatPercent: "15" };
  return { run: () => certifyBillAmounts(tx, 18, bill, { persist, lock: persist }), written: () => written };
}
test("saved certified lines replace stale zero header with period retention, VAT and net", async () => {
  const s = scenario("8000");
  const result = await s.run();
  assert.equal(result.grossAmount, "8000.00");
  assert.equal(result.retentionAmount, "400.00");
  assert.equal(result.vatAmount, "1200.00");
  assert.equal(result.netAmount, "8800.00");
  assert.equal(s.written().netAmount, "8800.00");
});
test("later lines add to certified previous work without charging previous work again", async () => {
  const result = await scenario("5000", "8000", "400").run();
  assert.equal(result.grossAmount, "13000.00");
  assert.equal(result.previousPaid, "8000.00");
  assert.equal(result.retentionAmount, "250.00");
  assert.equal(result.netAmount, "5500.00");
});
test("read-only detail projection fixes the display without rewriting historical data", async () => {
  const s = scenario("8000", "0", "0", false);
  assert.equal((await s.run()).netAmount, "8800.00");
  assert.equal(s.written(), null);
});
test("advance recovery uses actual posted balance and current certified value, not contract advance percentage", () => {
  const input = { enabled: true, progressPercent: "8", startProgressPercent: "0",
    advanceRecoveryPercent: "10", currentCertifiedWorkBeforeVat: "8000",
    actualAdvanceRemaining: "5000", netDue: "8740" };
  assert.equal(calculateAdvanceRecoveryCents(input).recoveryAmount, "800.00");
  assert.equal(calculateAdvanceRecoveryCents({ ...input, actualAdvanceRemaining: "0" }).recoveryAmount, "0.00");
});