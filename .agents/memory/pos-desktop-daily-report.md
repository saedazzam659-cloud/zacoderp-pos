---
name: POS Desktop daily Z-report data source
description: Why the desktop daily report reads SQLite directly instead of calling the cloud reports API.
---

The Daily Z-Report screen in POS Desktop aggregates from the local SQLite `offline_invoices` table, NOT from any cloud `/api/reports/*` endpoint.

**Why:** the cashier must be able to close their shift and print the Z-report even when the internet is down — that is the primary "offline-first" promise of the desktop app. The cloud database doesn't see an invoice until `/api/sync/push` replays it (and pending invoices may sit on the device for hours during outages). Going to the cloud would either (a) miss those pending rows or (b) make the report unavailable offline. Local SQLite is the single source of truth for "what happened on this terminal today".

**How to apply:** new desktop-side reports/dashboards should follow the same pattern — add a thin `daily_report_*` Tauri command in `invoices.rs` (or a new module) that returns rows including `payload_json`, then aggregate in the frontend. Do not add KPI logic to the Rust side; the schema of `payload_json` evolves and SQL-side aggregation would force lock-step migrations.

**Calendar-day boundary caveat:** `offline_invoices.created_at` is stored by SQLite as UTC text (`CURRENT_TIMESTAMP`). The filter uses `substr(created_at, 1, 10) = ?` against the user's local YYYY-MM-DD. For shifts that cross UTC midnight (rare in KSA/GCC) the boundary will be off. If/when a customer hits this, switch the scope to `pos_session_id` which is semantically the correct "Z-report = this shift" key.
