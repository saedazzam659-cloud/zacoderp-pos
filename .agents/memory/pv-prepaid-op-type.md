---
name: Payment-voucher prepaid op type
description: سند الصرف "مصروف مقدم" per-line op type — amortization via accounting_adjustments; lifecycle invariants
---

Payment voucher lines carry `op_type` ('direct' default | 'prepaid'). A prepaid line's `accountId` = the PREPAID ASSET account (voucher JE builder stays untouched); the plan (expense acct, start/end, periodicity, optional ccSplit `{costCenterId,pct}` Σ=100) mints ONE `accounting_adjustments` row (type prepaid, sourceType `payment_voucher`) at /post, amortized by the shared engine (`runDueAdjustmentsForCompany`), exactly mirroring deferred-expense purchase-invoice lines.

**Invariants (learned via architect review — do not regress):**
- **Link reuse only on FULL plan match.** PUT wholesale-replaces lines; the old `deferred_adjustment_id` may be re-attached to a new line ONLY when account+expense acct+amount+window+periodicity+ccSplit ALL match. Partial-match reuse silently amortizes the old schedule against the new JE.
- **/post must atomically claim draft→posted** (`UPDATE … WHERE status='draft' RETURNING`) before building the JE, and roll back to draft on failure — otherwise concurrent posts double-mint JEs + adjustments. There is no other lock on this route.
- **Prepaid rejected on foreign-currency vouchers** (rate ≠ 1): adjustments have no currency and the engine posts base JEs. Explicit 400, never convert silently.
- **Unpost deletes only run-less adjustments not referenced by OTHER vouchers' lines** (no FK on deferred_adjustment_id → dangling refs). Adjustments with runs are kept: run JEs flip to draft + autoGenerate=false; repost reactivates + flips back + auto-runs; orphans (link cleared) get cancelled.
- Simple form submits prepaid as a ONE-line multi voucher (`lines:[…]`); it becomes a multi-form voucher on later edits by design.

**Why:** prepaid rides the exact purchase-invoice deferred-expense lifecycle so there is ONE amortization engine; any new voucher op type should follow the same source-linked-adjustment pattern.
