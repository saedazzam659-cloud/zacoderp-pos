---
name: Publish "conflict with existing production data" false positive
description: Replit Publish blocking on a provably-additive/backwards-compatible dev→prod schema diff; how to prove it's safe and why it recurs.
---

# Replit Publish "schema changes conflict with existing production data" — often a FALSE POSITIVE

**Rule:** Before ever treating a Publish migration block as real, diff dev vs prod at the
information_schema level (tables, columns, data_type + numeric_precision/scale, nullability,
defaults, constraints). If every difference is additive (new tables/columns) or cosmetic, the
"conflict" is a false alarm — the production data is NOT at risk. NEVER pick "Copy dev schema &
data to production" on a live tenant DB (catastrophic data loss).

**Why it recurs (the real durable trap):** the same Drizzle schema source produces DIFFERENT
stored default representations depending on the drizzle-kit version that last pushed each DB.
A numeric column declared `.default("0")` shows up as bare `0` in a recently-pushed dev DB but
as `'0'::numeric` in an older-pushed prod DB. Same type, same value — but drizzle-kit's diff
sees `0 != '0'::numeric` and regenerates ~30+ phantom `ALTER COLUMN ... SET DEFAULT` statements
on EVERY publish. This never converges: the schema source is already correct (all string-literal
defaults), so re-pushing dev can't make it match prod's old textual form, and you may not touch
prod directly.

**How to apply:**
- Prove safety with read-only `executeSql({environment})` diffs. Watch the CSV trap: `string_agg`
  wraps its whole result in double-quotes, so the FIRST/LAST element gets a spurious leading/
  trailing `"` and looks like a phantom "prod-only"/"dev-only" row. Fetch as plain rows (one
  column per line) and strip `^"|"$` before set-diffing, or you'll chase ghost drops.
- `SET DEFAULT` and adding nullable columns / new empty tables are all backwards-compatible;
  none can lose data.
- Do NOT try to "align" the numeric defaults in the schema — they're already `.default("0")`.
  The divergence is at the DB-storage layer from drizzle-kit version drift, unfixable from source
  without touching prod (forbidden) or pinning/downgrading drizzle-kit (fragile, don't).
- Forbidden fixes stay forbidden: no prod DDL, no deploy-build db:push, no new startup DDL.
- When the diff is provably additive/cosmetic but Replit still hard-pauses offering only
  copy-or-cancel, it's a platform validator false-positive → escalate to Replit support with the
  proof; do not force it through the destructive copy option.

**New-table FK to a populated table is a likely hard-block trigger:** Replit's publish validator
introspects the two LIVE databases (dev vs prod), so no schema-source edit changes the diff by
itself. A brand-new additive table whose CREATE carries FOREIGN KEYs pointing at big existing
tables (e.g. `item_brands.item_id → items`, `company_id → companies`) can be flagged as
"conflict with existing production data" even though the new table is empty and cannot lose data.
The block appears the FIRST publish after such a table is merged (matches "only started after
feature X").
- Code-side workaround (worked here): drop the DB-level FK constraints from the NEW tables —
  keep the plain `integer` columns, keep app-layer integrity (e.g. validateBrandLinesBelongToCompany),
  and keep unique/normal indexes. Remove `.references()` in the Drizzle schema AND the `REFERENCES`
  clause in the ensureSchema CREATE-TABLE DDL so the two stay in lockstep, THEN
  `ALTER TABLE ... DROP CONSTRAINT IF EXISTS <t>_<col>_fkey` on the DEV db (dev only, never prod)
  so the live dev↔prod diff becomes purely "create empty table + add nullable columns".
- Tradeoff: you lose DB-level cascade delete / referential enforcement on those tables; only do
  this for optional/additive features where app-layer validation already guards integrity.
- Nullable columns added to an existing populated table (e.g. `sales_invoice_lines.brand_id`) are
  backwards-compatible and normally NOT the trigger; leave them.
