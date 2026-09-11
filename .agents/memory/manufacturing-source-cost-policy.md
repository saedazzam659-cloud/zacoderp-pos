---
name: Manufacturing source cost policy
description: Single-screen wizard and accounting ownership of allocated manufacturing costs.
---
Use one invoice-style tabbed manufacturing form over the existing core, not a separate execution engine. Source linkage configuration belongs in existing assets, payroll, and prepaid-expense screens.

Simple manufacturing must remain independently activatable, default OFF at company level, with separate user grants. Its shared-core API access must be limited to explicitly supported operations, never a blanket alternative permission for advanced production.

**Why:** Small companies must use the compact module without activating or exposing advanced production screens.

The simple surface must include the full source-cost selection experience (payroll, depreciation, prepaid amortization), not just order header fields. Saved configuration templates are not material recipes; missing recipes require an inline actionable setup path.

**Why:** The user rejected a nominally complete backend whose simple UI hid the requested integrations and confused configuration templates with active BOMs.

**How to apply:** Verify all wizard lookups use the independent facade, and visually inspect an authenticated simple-only tenant rather than treating a login-page screenshot as UI verification.

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

Period-close overhead correction is a separate immutable lifecycle over the
existing actual-vs-applied report. A draft snapshots only posted
manufacturing-overhead sources, their applied allocation totals, and the
original posted debit accounts. Posting reclassifies the residual to a
tenant-selected variance account through the shared production journal helper
(so period guards, audit fields, numbering, and posting status remain
consistent); it never books another source expense. The `(company, sourceKey)`
close key and transaction advisory lock make creation idempotent. Reversal
inverts the exact journal lines and preserves the original journal posting
state.

**Why:** A close must not recompute or duplicate payroll, depreciation, or
prepaid source costs after their owning modules have posted them.

## Delegated source-cost consumption boundary

The compact `simple_manufacturing` facade may consume only the already-posted,
manufacturing-eligible aggregate source rows published by payroll, fixed
assets, and prepaid schedules. It must not require (or grant) access to those
owner modules, and it must never expose HR employee detail; owner setup and
source configuration remain protected by their own screens and permissions.
The compact wizard requires the compact module's own `post` permission, while
the advanced facade keeps its production posting permission boundary.

Source rows are visible within the caller's tenant and branch scope. Capacity
is different: `availableAmount` subtracts every non-cancelled allocation for
the same tenant/source across all branches, including shared company-wide
sources. Branch-filtering the used amount would let two branch views
over-consume one delegated source pool.