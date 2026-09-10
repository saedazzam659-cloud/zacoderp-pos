import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production status effects share one transaction and order lock", async () => {
  const source = await readFile(new URL("../src/routes/production.ts", import.meta.url), "utf8");
  const start = source.indexOf('router.post("/orders/:id/status"');
  const end = source.indexOf("// ORDER ITEMS", start);
  assert.ok(start > 0 && end > start, "status handler must be present");
  const handler = source.slice(start, end);

  assert.match(handler, /db\.transaction\(async \(tx\)/);
  assert.match(handler, /pg_advisory_xact_lock/);
  assert.match(handler, /lockStockBalances\([\s\S]*?, tx\)/);
  assert.doesNotMatch(handler.replace("db.transaction", ""), /\bdb\.(select|insert|update|delete|execute)\b/);
  assert.equal((handler.match(/dx: tx/g) ?? []).length, 3, "issue, receipt and reversal journals use tx");
  assert.ok((handler.match(/}, tx\);/g) ?? []).length >= 4, "stock ledger writes use tx");
  assert.match(handler, /writeEvent\([\s\S]*?false,\s*tx,/);
});

test("stock ledger and sequence helpers accept a surrounding transaction", async () => {
  const [stock, sequences] = await Promise.all([
    readFile(new URL("../src/lib/stockHelpers.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/sequences.ts", import.meta.url), "utf8"),
  ]);
  assert.match(stock, /addStockLedgerEntry\([\s\S]*?executor: any = db\)/);
  assert.match(stock, /await executor\.insert\(stockLedgerTable\)/);
  assert.match(sequences, /return dx \? issueWithin\(dx\) : db\.transaction\(issueWithin\)/);
});