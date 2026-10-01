---
name: Web sales unpost provenance
description: Invoice and return stock reversals must preserve immutable costing references and avoid reversing consumed return batches.
---

Web sale stock movements referenced by immutable production-cost attribution must not be physically deleted on unpost. Retain the original movement, remove its active-sale classification, and append a compensating adjustment; repost creates fresh movement IDs and attribution.

**Why:** The attribution FK intentionally restricts deletion and its immutable trigger prevents removing the audit snapshot. Bypassing either destroys costing provenance.

**How to apply:** Stock restoration, movement reclassification, compensation, journal reversal and draft transition belong in one transaction. Use the shared stock-balance lock namespace used by inflows, not only document-specific locks. Date the compensating movement at unpost business date so a current balance is not inserted under the old sale date. Active costing consumers must exclude historical unposted movement classifications.

The same rule applies to posted sales-return stock-ins: do not delete attributed return movements. Reclassify the original row as inactive and append a dated negative adjustment in the same transaction as the journal reversal and draft transition. Refuse the reversal when aggregate or same-batch stock is no longer available.

**Why:** Return attribution rows also hold restrictive foreign keys to stock-ledger identities. Removing a return after its batch has been consumed would either break those references or silently make inventory negative.

**How to apply:** Lock the return first, then its source invoice using the same order as return posting, and acquire shared stock-balance locks before reading and updating balances. Keep the original movement identity for audit and downstream costing history.