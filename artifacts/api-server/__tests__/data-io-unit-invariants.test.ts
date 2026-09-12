import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSource = readFileSync(
  new URL("../src/routes/data-io.ts", import.meta.url),
  "utf8",
);

function entitySource(key: string, nextKey: string): string {
  const start = routeSource.indexOf(`  ${key}: {`);
  const end = routeSource.indexOf(`  ${nextKey}: {`, start + 1);
  assert.notEqual(start, -1, `missing entity ${key}`);
  assert.notEqual(end, -1, `missing entity boundary ${nextKey}`);
  return routeSource.slice(start, end);
}

test("generic item imports resolve a tenant-owned base unit without inventing one", () => {
  const items = entitySource("items", "itemUnitPrices");
  assert.match(items, /name: "unitCode"/);
  assert.match(items, /fkRef: "units"/);
  assert.match(items, /fkLookupBy: "code"/);
  assert.match(items, /tenant-scoped unit code/);
});

test("generic data IO exposes units and unit-price graph rows", () => {
  const units = entitySource("units", "itemUnitPrices");
  const prices = entitySource("itemUnitPrices", "warehouses");
  assert.match(units, /table: unitsTable/);
  assert.match(units, /businessKeys: \["code"\]/);
  assert.match(prices, /table: itemUnitPricesTable/);
  assert.match(prices, /name: "itemCode"/);
  assert.match(prices, /name: "unitCode"/);
  assert.match(prices, /name: "relationFactor"/);
  assert.match(prices, /name: "isBase"/);
  assert.match(prices, /businessKeyGroups: \[\["itemId", "unitId"\]\]/);
  assert.match(routeSource, /function buildBusinessKey/);
  assert.match(routeSource, /validateImportedUnitGraphs/);
  assert.match(routeSource, /resolveUnitGraph\(\{ baseUnitId: item\.unitId/);
});

test("base changes are serialized and checked against historical stock/documents", () => {
  assert.match(routeSource, /pg_advisory_xact_lock/);
  assert.match(routeSource, /hashtext\(\$\{`item-unit:\$\{mutation\.itemId\}`\}\)/);
  for (const table of [
    "item_unit_prices",
    "stock_balance",
    "stock_ledger",
    "sales_invoice_lines",
    "purchase_invoice_lines",
    "goods_receipt_lines",
    "stock_transfer_items",
  ]) {
    assert.match(routeSource, new RegExp(`FROM ${table}`));
  }
  assert.match(routeSource, /UNIT_BASE_MUTATION_BLOCKED/);
  assert.match(routeSource, /assertGenericImportUnitInvariant/);
});

test("legacy invoice rows remain out of conversion scope unless itemId exists", () => {
  const guardStart = routeSource.indexOf("async function assertItemBaseMutationSafe");
  const guardEnd = routeSource.indexOf("async function assertGenericImportUnitInvariant", guardStart);
  const guard = routeSource.slice(guardStart, guardEnd);
  assert.match(guard, /item_id = \$\{mutation\.itemId\}/);
  assert.match(routeSource, /Some legacy[\s\S]+invoice rows have no itemId/);
  assert.doesNotMatch(routeSource, /\binvoices:\s*\{/);
});
