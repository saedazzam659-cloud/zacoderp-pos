---
name: Contracting accounting boundaries
description: Optional cost-center snapshots, legacy preservation, and planning versus posting boundaries.
---

Project and bill cost centers are optional. A new bill can default from its project, but its effective choice is a persisted snapshot; clearing it explicitly means no center. Reversals preserve original journal-line centers.

**Why:** The user requested optional links at both levels, without changing old postings when project settings change.

**How to apply:** Validate company ownership and active new selections; do not require a center merely because a project has one or rewrite existing ledger history.

Resources are planning records, not stock issues. Actual material movements and settlements require explicit accounting actions; never infer them from planning status.

**Why:** Selecting an inventory item or marking a resource allocated must not silently consume stock or create costs.

**How to apply:** Use real item-owned conversion snapshots and warehouse scope. Unsupported lot/costing paths must fail clearly rather than silently substitute weighted-average costing.

Preserve legacy project customer names without automatic name matching, and extend existing bill/contract fields instead of duplicating retention, advances, or payment totals.

**Why:** The user expressly required additions without duplicated records or re-entry of auto-filled contract data.

**How to apply:** Link clients by validated IDs when explicitly selected, calculate certified amounts separately from cash paid, and use existing ledger/settlement references as authoritative.