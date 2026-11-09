import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("POS Desktop sync carries the web item-card cost into local SQLite", async () => {
  const [syncRoute, apiTypes, itemSync, rustItems] = await Promise.all([
    readFile(new URL("../src/routes/pos-desktop-sync.ts", import.meta.url), "utf8"),
    readFile(new URL("../../pos-desktop/src/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../../pos-desktop/src/lib/items.ts", import.meta.url), "utf8"),
    readFile(new URL("../../pos-desktop/src-tauri/src/items.rs", import.meta.url), "utf8"),
  ]);

  assert.match(syncRoute, /costPrice:\s*itemsTable\.costPrice/);
  assert.match(apiTypes, /costPrice\?: string \| null/);
  assert.match(itemSync, /cost_price:\s*r\.costPrice/);
  assert.match(rustItems, /ALTER TABLE items_local ADD COLUMN cost_price REAL NOT NULL DEFAULT 0/);
  assert.match(rustItems, /cost_price = COALESCE\(\?8, cost_price\)/);
});

test("Windows sales COGS falls back to item-card cost only when local cost is missing", async () => {
  const accounting = await readFile(
    new URL("../../pos-desktop/src-tauri/src/accounting.rs", import.meta.url),
    "utf8",
  );

  assert.match(accounting, /fn item_card_cost_in_tx\(/);
  assert.match(accounting, /fn sales_unit_cost_in_tx\(/);
  assert.match(accounting, /item_card_cost_in_tx\(tx, item_id\)\.map_err/);
  assert.match(accounting, /let unit_cost = sales_unit_cost_in_tx\(tx, l\.item_id, line_wh\)\?/);
  assert.match(accounting, /pos_line_base_cost\(&tx, line, !is_return\)/);
});
