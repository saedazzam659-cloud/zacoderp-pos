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

Release-managed application tables must be created in the shared active-database reconciliation pass before strict missing-table validation, not only during central startup or a lazy feature request.

**Why:** External-agent upgrade and request-readiness paths can validate newly exported schema tables before central-only initialization ever reaches their database.

**How to apply:** Cover startup, explicit upgrades and strict request readiness with the same additive table creation. Keep required tables required, and never share a successful initialization cache across tenant databases.

Contract ceilings require both the shared adjusted-contract ceiling and the selected change order's own incremental ceiling. Never grant the base contract value separately to each change-order bucket.

**Why:** Independent buckets otherwise permit billing the same base contract multiple times.

**How to apply:** Sum certified non-reversed work across the shared base scope, and separately cap the selected order's delta. Financial report totals exclude correction-source reversals and unposted replacement drafts.

Posted correction must reverse and create the linked replacement draft in one transaction, with document-level unpost authorization as well as the correction capability.

**Why:** A separately committed reversal can leave no recoverable correction document if copying fails, and a correction permission must not bypass explicit unpost restrictions.

**How to apply:** Copy all correction detail inside the reversal transaction and preserve source links; derive paid states from posted settlements rather than manual workflow choices.

Do not widen shared inventory precision to accommodate one contracting workflow.

**Why:** Increasing fractional precision can reduce integer capacity and diverge from other stock consumers' arithmetic. Read-triggered global type changes can also lock production inventory tables.

**How to apply:** Preserve shared storage precision, validate representability explicitly, and keep higher-precision allocation snapshots local. An explicitly selected null-expiry lot is an exact lot identity, not an instruction to select any expiry.