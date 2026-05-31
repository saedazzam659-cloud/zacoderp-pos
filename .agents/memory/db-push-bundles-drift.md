---
name: db push bundles all schema drift
description: why `pnpm --filter @workspace/db run push` is risky for a single additive column, and the safe targeted alternative
---

`pnpm --filter @workspace/db run push` (drizzle-kit push) diffs the ENTIRE schema
against the live DB, not just your change. It will:
- pick up unrelated pre-existing drift (e.g. a pending UNIQUE constraint on another
  table) and try to apply it in the same run, and
- block on an INTERACTIVE prompt (e.g. "table has N rows, truncate?") that hangs a
  non-tty bash call and can abort leaving your change UNapplied.

**Rule:** for a purely additive, non-destructive column, skip the full push and apply
it with targeted SQL instead:
`psql "$DATABASE_URL" -c "ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <col> <type> NOT NULL DEFAULT '<d>';"`
then verify via `information_schema.columns`. The schema file edit still stands as the
source of truth; `ensureSchema` on api-server boot reconciles and will only warn about
genuinely-missing tables/columns.

**Why:** during the invoice print-language feature, `db run push` stalled on a
`gateway_clients_vat_number_unique` truncate prompt that had nothing to do with the new
`companies.invoice_print_language` column. Direct ALTER applied only the intended change.

**How to apply:** use direct ALTER for single additive columns; reserve full
`db run push` for when you actually intend to reconcile all outstanding drift and can
answer its prompts.
