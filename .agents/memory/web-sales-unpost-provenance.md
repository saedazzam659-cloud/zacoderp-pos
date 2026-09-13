---
name: Web sales unpost provenance
description: Stock reversal must preserve immutable production-cost attribution references.
---

Web sale stock movements referenced by immutable production-cost attribution must not be physically deleted on unpost. Retain the original movement, remove its active-sale classification, and append a compensating adjustment; repost creates fresh movement IDs and attribution.

**Why:** The attribution FK intentionally restricts deletion and its immutable trigger prevents removing the audit snapshot. Bypassing either destroys costing provenance.

**How to apply:** Stock restoration, movement reclassification, compensation, journal reversal and draft transition belong in one transaction. Use the shared stock-balance lock namespace used by inflows, not only document-specific locks. Date the compensating movement at unpost business date so a current balance is not inserted under the old sale date. Active costing consumers must exclude historical unposted movement classifications.