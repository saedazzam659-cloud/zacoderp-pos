---
name: Manufacturing source cost policy
description: Single-screen wizard and accounting ownership of allocated manufacturing costs.
---
Stage input/output and waste may use different operational units, but every conversion must be frozen relative to the order's finished-product unit. Never infer weight-to-piece conversion from unit names; use an explicit approved factor. Convert stage waste exactly once before close/accounting, preserving additional header-only waste separately.

**Why:** A carton-based order can lose individual pieces in the oven or weight during preparation; summing raw quantities misstates both stock and waste cost. Saved execution and closure must not remain independent quantity sources.

**How to apply:** Use the final stage's converted output for routed-order closure and sum converted stage waste by classification. A pending stage may be saved before its output is known; zero-output checks belong at completion, not ordinary operational saves.

Use one invoice-style tabbed manufacturing form over the existing core, not a separate execution engine. Source linkage configuration belongs in existing assets, payroll, and prepaid-expense screens.

Remember only category selection modes as manufacturing wizard preferences, scoped to user and effective company; never carry source IDs, amounts, accounts, or periods into a new order as remembered defaults.

**Why:** The user wants the last selection remembered, but copying accounting facts can silently reuse a consumed source or charge an unrelated period.

**How to apply:** Historical completed-order review reads saved snapshots only; missing historical fields stay explicitly unavailable instead of being rebuilt from today's catalog or preferences.

Machine kWh × tariff must contribute to finished-product cost before the invoice arrives through provisional WIP absorption against an explicit accrual account, not a duplicate utility expense. Actual utility-source allocation, estimate reconciliation, and reversal must have one accounting owner. Historical evidence-only snapshots must not be reinterpreted automatically.

**Why:** The user explicitly rejected material-only receipts despite recorded operating hours. Simply displaying an estimate does not meet this requirement; charging the later invoice in full on top of the estimate would double-count. Payroll aggregate approved hours also cannot silently become person-hours for legacy orders.

**How to apply:** Version-gate new resource semantics, freeze source rates, preserve legacy operator and quantity payloads, and require end-to-end source settlement verification before enabling the new costing mode.

Actual settlement clears the original posted accrual and capitalizes only actual minus accrued. Split completed-order differences between FG and abnormal waste using the immutable original receipt allocation, including negative differences.

**Why:** Assigning all later variance to FG overvalues retained stock when completion already expensed abnormal waste; clearing a draft-only accrual creates a posted debit without a posted credit.

**How to apply:** Require posted original issue and receipt journals before completed-order settlement. Normal waste remains absorbed in good production; display its quantity even when its separate expense is zero.

Late utility settlement must not guess FG/COGS distribution after consumption. Require provably isolated, fully retained finished goods; otherwise reject explicitly. A posted WIP utility settlement must be reversed before completing, cancelling, or reversing its order until destination migration is supported.

**Why:** Reversing against the order's current destination rather than the original posting destination can strand a valid settlement or misstate inventory. An estimate alone is not an expense.

**How to apply:** Share transaction locks across settlement and order transitions. Preserve immutable historical close keys when released evidence is settled again; use a new lifecycle attempt rather than rewriting history.

Execution inputs must be directly discoverable in the compact order detail, not only in the advanced detail route. Preserve approved time-based source allocation rules when adding operational workforce fields; do not implicitly multiply existing allocations by headcount.

**Why:** The user could see only the routing preview and explicitly required per-stage employee entry while prohibiting changes to the existing linked cost calculations.

Work centers and machines are separate operational selections. Machines may reference an existing fixed asset or remain unlinked (including rented equipment); adding a machine never copies an asset or creates depreciation.

**Why:** The user approved inline resource creation with center-filtered machines and optional fixed-asset linkage, while preserving the existing source-cost ownership.

Smart Manufacturing keeps existing route and permission identities; only the displayed module name changes.

**Why:** The user requested a rename and richer execution without duplicate modules or broken existing links.

Actual stage drivers reconcile against immutable planned source allocations through delta-only accounting. Purchase industrial sources must use posting-time base-currency amounts and resolved expense accounts, not mutable line mappings.

**Why:** Recomputing purchase values ignores discounts/FX/account routing; overwriting planned allocations loses traceability and risks double capitalization.

**How to apply:** Freeze posted facts, include unreversed driver deltas in capacity and closure calculations, and reverse those deltas exactly.

Accounting verification must include failed finalization after driver reconciliation and zero-net reallocations across different source accounts.

**Why:** An HTTP error plus normal return inside a database transaction commits preceding writes; a zero total delta can still require balanced debit/credit transfers between source accounts.

**How to apply:** Require rollback on post-write validation failure, and decide whether to create a reconciliation journal from nonzero ledger lines rather than the net WIP delta alone.

Source-cost verification must generate at least one driver delta through real order finalization, not only seed reconciliation rows.

**Why:** Seeded deltas can prove capacity and closure arithmetic while masking a mismatch between the wizard's frozen formula metadata and the finalization reader that silently skips reconciliation.

**How to apply:** Create a source-linked order through the wizard, complete its stage facts, finalize through the status handler, and assert the generated delta and retry behavior alongside immutable base allocations.

Simple manufacturing must remain independently activatable, default OFF at company level, with separate user grants. Its shared-core API access must be limited to explicitly supported operations, never a blanket alternative permission for advanced production.

**Why:** Small companies must use the compact module without activating or exposing advanced production screens.

The simple surface must include the full source-cost selection experience (payroll, depreciation, prepaid amortization), not just order header fields. Saved configuration templates are not material recipes; missing recipes require an inline actionable setup path.

**Why:** The user rejected a nominally complete backend whose simple UI hid the requested integrations and confused configuration templates with active BOMs.

**How to apply:** Verify all wizard lookups use the independent facade, and visually inspect an authenticated simple-only tenant rather than treating a login-page screenshot as UI verification.

Simple manufacturing must expose its required WIP/raw/finished account defaults inside the compact flow, reusing existing company accounts. Warehouse selections belong to the order save, and draft saving must not require posting-account configuration.

**Why:** Users could select warehouses but could not discover the review-only save controls, and execution required accounts that were configurable only through advanced manufacturing.

**How to apply:** Keep save actions available across tabs. Retry a saved order after configuration errors; account-default hydration may fill only null fields while status remains pre-issue, under tenant and branch scope.

**Why:** The user explicitly chose a compact single-screen workflow and required reuse of existing modules rather than duplicated screens and accounting.

Allocated posted costs must reclassify the original expense debit accounts into WIP, not book another expense or use unrelated generic offsets. Fixed assets still own depreciation and payroll still owns salary accounting. Use approved allocation denominators/rates, not arbitrary source percentages.

Optional additional costs use one mode per category: none, linked, or manual. A positive manual actual cost requires a validated counterpart account and explanation; empty costs never block production. Do not copy actual amounts when reusing configuration.

**Why:** The user explicitly approved optional manual entry when no source is linked, without duplicate source expense or mixing estimates into capitalized cost.

**How to apply:** Manual costs debit WIP and credit the chosen counterpart through the existing production journal. Cancellation must invert original evidence rather than revalidate currently active accounts or recalculate current stock costs.

**Why:** Already-posted source costs otherwise get counted twice or leave the wrong expense accounts overstated.

**How to apply:** Preserve source/configuration snapshots, capacity caps and cancellation release together. Every production status write, stock movement, journal and number claim must share the same transaction; propagate the executor through helper calls.

Templates and manufacture-again must copy configuration only, never stock results or source allocations. Paused orders must reject operational edits and resume without issuing stock again.

The materials tab must emphasize the live planned-quantity requirement, with the immutable recipe basis shown secondarily.

**Why:** Showing only base recipe quantities made the user think changing planned production did not scale materials. Doubling planned quantity must visibly double requirements, not mutate the master recipe.

**How to apply:** Derive each displayed requirement from base line quantity × planned output ÷ recipe output; never compound from previously scaled quantities.

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