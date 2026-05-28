---
name: POS Desktop inventory ledger invariants
description: Two non-obvious rules for the standalone SQLite inventory module — idempotent stocktake posting and strict no-row-vs-error distinction in ledger helpers.
---

# Rule 1 — stocktake post must be idempotent

`stocktake_post(id)` may be retried (UI double-click, network jitter on the
calling side, restart mid-commit). Treat "already posted" as success that
returns the existing `adjustment_id`, NOT as an error.

**Why:** an error response invites the UI to retry; if the second call ever
slipped past the status guard it would create duplicate ledger rows AND a
duplicate JE — silently doubling P&L for that stocktake.

**How to apply:** read `(status, adjustment_id)` first; if `status='posted'`
return `Ok(prior_adj.unwrap_or(0))` immediately. Only the `draft → posted`
transition writes ledger/JE/adjustment rows.

# Rule 2 — stock-ledger reads must distinguish "no row" from "DB error"

`apply_ledger_delta` and any helper that seeds `balance_after` from the
current on-hand quantity must use `.optional().map_err(...)?.unwrap_or(0.0)`,
never `.unwrap_or(0.0)` on the raw `Result`.

**Why:** `unwrap_or(0.0)` on the raw `Result` swallows real SQL errors
(disk-full, schema mismatch, lock timeout) and turns them into a silent
"qty = 0" read. The next `INSERT` then writes a wrong `balance_after` and
the ledger drifts from on-hand permanently — and since both writes happen
inside the same transaction, neither side notices.

**How to apply:** any `query_row` that genuinely tolerates "no matching row"
(stock_on_hand_local missing for a new item/warehouse pair) must explicitly
opt in via `OptionalExtension::optional()`. Counts and existence checks
should propagate errors normally (no `unwrap_or`).
