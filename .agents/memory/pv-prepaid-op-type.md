---
name: Payment-voucher per-line op types
description: سند الصرف op_type per line — prepaid amortization + fixed_asset/supplier/HR record minting; lifecycle invariants
---

Payment voucher lines carry `op_type` ('direct' default | 'prepaid'). A prepaid line's `accountId` = the PREPAID ASSET account (voucher JE builder stays untouched); the plan (expense acct, start/end, periodicity, optional ccSplit `{costCenterId,pct}` Σ=100) mints ONE `accounting_adjustments` row (type prepaid, sourceType `payment_voucher`) at /post, amortized by the shared engine (`runDueAdjustmentsForCompany`), exactly mirroring deferred-expense purchase-invoice lines.

**Invariants (learned via architect review — do not regress):**
- **Link reuse only on FULL plan match.** PUT wholesale-replaces lines; the old `deferred_adjustment_id` may be re-attached to a new line ONLY when account+expense acct+amount+window+periodicity+ccSplit ALL match. Partial-match reuse silently amortizes the old schedule against the new JE.
- **/post must atomically claim draft→posted** (`UPDATE … WHERE status='draft' RETURNING`) before building the JE, and roll back to draft on failure — otherwise concurrent posts double-mint JEs + adjustments. There is no other lock on this route.
- **Prepaid rejected on foreign-currency vouchers** (rate ≠ 1): adjustments have no currency and the engine posts base JEs. Explicit 400, never convert silently.
- **Unpost deletes only run-less adjustments not referenced by OTHER vouchers' lines** (no FK on deferred_adjustment_id → dangling refs). Adjustments with runs are kept: run JEs flip to draft + autoGenerate=false; repost reactivates + flips back + auto-runs; orphans (link cleared) get cancelled.
- Simple form submits prepaid as a ONE-line multi voucher (`lines:[…]`); it becomes a multi-form voucher on later edits by design.

**Why:** prepaid rides the exact purchase-invoice deferred-expense lifecycle so there is ONE amortization engine; any new voucher op type should follow the same source-linked-adjustment pattern.

## Phase-2 op types (fixed_asset / supplier_advance / supplier_settlement / employee_loan / employee_custody)
- The voucher JE is the ONLY journal entry — linked records are minted at /post with `skipAcquisitionJe`/`disbursementJournalId` set so their own modules never post a second debit.
- **Server resolves the line's debit account** for supplier ops (supplier.accountId ?? mapping supplier_settlement/payable) and HR ops (resolveHrAccounts employeeLoans 11081 / employeeCustody 11082) — never trust a client-picked account for a party sub-ledger; client validation relaxes account requirement for these ops only.
- Idempotency: fixed asset via `uq_fixed_assets_source` (sourceType 'payment_voucher') + pre-check, 23505→skip; loan/custody via line `op_ref_id` with INSERT+link in ONE tx (a strand-then-retry would double-mint otherwise).
- FX guard: ALL non-direct op types 400 on exchangeRate ≠ 1 (`op_type <> 'direct'` predicate).
- /unpost guards run BEFORE JE deletion: block on asset sold/scrapped or any depreciation run, loan paidAmount>0, custody settled/returned>0; otherwise delete records + clear op_ref_id so repost re-mints.
- Settlement overpayment: advisory locks must cover EVERY distinct linked invoice (sorted ids), not just the header/first line's.
- Custody RETURN (استرداد عهدة) is deliberately excluded — it's cash-in and belongs to receipt vouchers. Supplier advance = plain AP debit balance; no separate advances account.

## UI additions (Aug 2026)
- PV list: multi vouchers detected by header `accountId == null`; list endpoint backfills empty البيان from line descriptions and returns `isMulti`.
- Posted multi-PV form: lock fieldset lives INSIDE each TabsContent (tabs stay navigable read-only); links that must work when locked are `<a>` not `<button>` (fieldset disables buttons).
- Prepaid schedule preview client-side must PORT monthsBetween/installmentsBetween semantics exactly: first installment = start+1 MONTH even for quarterly/annual (grouping takes every P-th anniversary month), day-aware month count, final group partial; never step first date by P months.
