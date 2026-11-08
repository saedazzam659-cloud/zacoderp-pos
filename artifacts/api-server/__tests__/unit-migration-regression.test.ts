import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("unit compatibility migration does not flag the selected base as an unconverted row", async () => {
  const source = await readFile(new URL("../src/lib/ensureSchema.ts", import.meta.url), "utf8");
  const migration = source.split("DO $unit_conversion_migration$")[1]?.split("$unit_conversion_migration$")[0] ?? "";
  const unresolvedRowCheck = migration.match(
    /SELECT EXISTS \(\s*SELECT 1 FROM item_unit_prices([\s\S]*?)INTO has_unmigrated_row;/,
  )?.[1];

  assert.ok(unresolvedRowCheck, "the unit migration should check for unresolved non-base roots");
  assert.match(unresolvedRowCheck, /reference_unit_id IS NULL/);
  assert.match(unresolvedRowCheck, /unit_id\s*<>\s*candidate_base/);
});
