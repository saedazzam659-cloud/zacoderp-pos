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

Contracting bills use the existing model 14 renderer, with contracting-specific labels and amounts rather than a separate look-alike template.

**Why:** The user explicitly requested the same system print model; duplicated styling drifts and can misleadingly retain tax-invoice labels.

**How to apply:** Keep shared frame/header/footer behavior consistent with model 14 and adapt document semantics without implying a progress bill is a ZATCA invoice.

Contract ceilings require both the shared adjusted-contract ceiling and the selected change order's own incremental ceiling. Never grant the base contract value separately to each change-order bucket.

**Why:** Independent buckets otherwise permit billing the same base contract multiple times.

**How to apply:** Sum certified non-reversed work across the shared base scope, and separately cap the selected order's delta. Financial report totals exclude correction-source reversals and unposted replacement drafts.

Posted correction must reverse and create the linked replacement draft in one transaction, with document-level unpost authorization as well as the correction capability.

**Why:** A separately committed reversal can leave no recoverable correction document if copying fails, and a correction permission must not bypass explicit unpost restrictions.

**How to apply:** Copy all correction detail inside the reversal transaction and preserve source links; derive paid states from posted settlements rather than manual workflow choices.

Do not widen shared inventory precision to accommodate one contracting workflow.

**Why:** Increasing fractional precision can reduce integer capacity and diverge from other stock consumers' arithmetic. Read-triggered global type changes can also lock production inventory tables.

**How to apply:** Preserve shared storage precision, validate representability explicitly, and keep higher-precision allocation snapshots local. An explicitly selected null-expiry lot is an exact lot identity, not an instruction to select any expiry.

Keep cumulative certified work separate from period retention and actual settlements. Prior period retention is summed, not selected by maximum. Additions increase settlement net; ordinary deductions and penalties decrease it, while recovery is counted once as a settlement.

**Why:** Mixing cumulative and period representations over-retains on later bills; re-adding advance applications to an already projected paid total double-counts payment.

**How to apply:** Use one signed-net rule across approval, recovery, payment limits, status and reports. Cap recovery by actual posted advances for the exact contract. Serialize advance work using bill, contract, then source locks consistently.

Contract advance-recovery policy is live for unapproved bills, but approved recovery is an immutable snapshot. Contract changes affect subsequent draft calculations, never already posted applications. Recovery exceptions require exceptional authority and a recorded reason, not ordinary bill-edit rights.

**Why:** The user explicitly wants contract-owned automatic recovery rather than manually maintained per-bill settings, while retaining prior balances and preventing duplicate recovery.

**How to apply:** Refresh previews without overwriting entered quantities, re-read policy under posting locks, cap by both actual posted funds and the remaining contractual advance, and treat a reversed approval reopened for review as live again.

Contract BOQ is the commercial source of truth, while project work items are shared scope. Owner and subcontract prices stay independent; defaults belong to each new contract, not a live company-settings reference.

“Shared scope” means shared among contracts inside one project, never one execution record shared across projects. Any future general work-item catalog must create independent project-owned records.

**Why:** The user explicitly wants similarly named items in different projects to remain isolated, while avoiding repeated manual entry of the same item's descriptive data within a project.

**Why:** The user requires multiple independently priced contracts within one project and forbids old agreements changing when company defaults change.

**How to apply:** Never infer a contract when several exist or copy owner pricing to a subcontract implicitly. Validate certified quantities again inside approval, not just at draft save; several valid drafts can otherwise exceed the same remaining quantity.

Keep the progress-certificate form in the invoice-style reading order: metadata and calculation settings above line items, financial totals below, without internal form tabs.

**Why:** The user explicitly requested the familiar invoice arrangement and field scale to make certificate entry and review easier.

**How to apply:** Preserve project navigation separately. Visually distinguish current editable quantities from prior/cumulative read-only values without removing aggregate-progress behavior during cosmetic changes.

Execution and certification must remain separate ledgers of progress. Executed work not yet certified may be certified in a later period with zero new execution.

**Why:** The user confirmed that partial consultant certification must leave the uncertified portion pending, rather than consume contract quantity again or treat it as financial retention.

**How to apply:** Keep actual measured execution distinct from payable certified value. If a percentage represents partial valuation rather than physical quantity acceptance, label its quantity equivalent explicitly; do not silently turn it into new actual execution. Derive current certification from cumulative certified value minus previously certified value, with traceable pending-work references.

Zero financial certification does not mean zero physical execution. A wholly pending execution certificate may be approved without manufacturing a zero-value accounting journal, and must remain reversible subject to later dependent certificates.

**Why:** Rejecting all zero-payable certificates loses the physical quantity budget; treating cumulative previously certified value as current payment also incorrectly rejects later wholly pending work.

**How to apply:** Evaluate the current period and any financial adjustments separately from historical cumulative amounts. Preserve audit evidence for nonfinancial approval and reversal, and never use this path to bypass missing journals on genuinely financial certificates.

Runtime-created financial tables must also be represented in the exported declarative schema and development database before publishing.

**Why:** Tables existing only in production were proposed as deleted/rename candidates when a new unrelated table appeared in development. Lazy creation is not sufficient protection against schema synchronization.

**How to apply:** Restore missing definitions and apply additive development-only changes; never rename accounting/history tables into idempotency tables. Inspect the actual publish SQL, not just summary flags: the diff tool has returned `hasStructuralDataLoss: false` and empty removal lists while its statements included `DROP TABLE ... CASCADE`.

Financial release verification must distinguish real isolated database evidence from browser fixtures. A mocked successful replay cannot establish server idempotency, and a seeded subcontract does not establish its payable lifecycle.

**Why:** Separate frontend and arithmetic checks can pass while a lost-response retry still creates duplicate financial documents or an entire accounting direction remains untested.

**How to apply:** Exercise persisted replay, posting, settlements and corrections in a disposable database for each direction; use browser fixtures only for explicitly identified UI behavior, never as evidence of database correctness.