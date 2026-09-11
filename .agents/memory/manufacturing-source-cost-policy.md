---
name: Manufacturing source cost policy
description: Single-screen wizard and accounting ownership of allocated manufacturing costs.
---
Use one invoice-style tabbed manufacturing form over the existing core, not a separate execution engine. Source linkage configuration belongs in existing assets, payroll, and prepaid-expense screens.

Simple manufacturing must remain independently activatable, default OFF at company level, with separate user grants. Its shared-core API access must be limited to explicitly supported operations, never a blanket alternative permission for advanced production.

**Why:** Small companies must use the compact module without activating or exposing advanced production screens.

**Why:** The user explicitly chose a compact single-screen workflow and required reuse of existing modules rather than duplicated screens and accounting.

Allocated posted costs must reclassify the original expense debit accounts into WIP, not book another expense or use unrelated generic offsets. Fixed assets still own depreciation and payroll still owns salary accounting. Use approved allocation denominators/rates, not arbitrary source percentages.

**Why:** Already-posted source costs otherwise get counted twice or leave the wrong expense accounts overstated.

**How to apply:** Preserve source/configuration snapshots, capacity caps and cancellation release together. Every production status write, stock movement, journal and number claim must share the same transaction; propagate the executor through helper calls.

Templates and manufacture-again must copy configuration only, never stock results or source allocations. Paused orders must reject operational edits and resume without issuing stock again.

**Why:** Reusing transactions as templates or re-entering the issue path on resume silently duplicates consumption.

Financial cost variance must exclude analytical layers. Any margin based on a frozen item price is simulated, not realized sales profitability.

**Why:** Mixing operating/economic treatments into manufacturing standard costs double-counts allocations and misstates variance.

Completed-order reversal must invert the original journal lines and preserve their posting state, not recompute from present settings or order totals. Require finished-batch provenance and reject later outbound consumption.

**Why:** Rounding, subsequent configuration changes and consumed output can otherwise produce incorrect reversals or negative stock.

Sales returns linked to an invoice consume the invoice's paid and free quantities
in the same base-unit cap. Posting locks the source invoice and rechecks all
posted returns before restoring stock; a linked batch-tracked return that cannot
be explained by current stamped outbound batches is rejected, never filled with
an unbatched WAC row. Return attribution must use current movement identities,
not stale snapshots left by unpost/repost.

**Why:** Free units affect stock and COGS even when they contribute no revenue.
Without the source-invoice lock, concurrent returns could each pass a stale
remaining-quantity check and over-return the invoice.