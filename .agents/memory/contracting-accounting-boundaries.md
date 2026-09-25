---
name: Contracting accounting boundaries
description: Optional cost-center snapshots, legacy preservation, and planning versus posting boundaries.
---

Inclusive contracting prices describe the quotation, not an additional tax charge. Preserve the entered quotation while comparing certification, retention, recovery and contract ceilings on a net basis. Extract VAT from the extended quoted line, not a rounded net unit price multiplied by quantity. Cumulative execution must reconcile to prior frozen amounts, and change-order components retain their own quoted tax basis. Changing a later bill's mode never rewrites earlier approved evidence.

**Why:** The user explicitly approved invoice-like "السعر شامل الضريبة" on contracts, both certificate forms and taxable owner advance input, without repricing historical evidence or changing settlement methods.

**How to apply:** Snapshot price meaning on create; convert quoted inclusive amounts once at boundary, and derive period VAT only from new NET certified work. Retention/recovery operate on that NET work; taxable owner advances freeze original base/VAT/gross at invoice creation so future contract or bill mode edits do not alter recovery.

Use informational summaries and linked original recovery journals to clarify advance recovery in settlement screens and printouts; do not add the recovery again as a posting line in the cash receipt.

**Why:** The user explicitly approved keeping the already-posted recovery separate while making gross entitlement, recovered advance, net cash and remaining advance visible together. The aim is accounting clarity, not a second financial effect.

**How to apply:** Preserve existing journals and show the original recovery reference and debit/credit explanation as informational presentation, distinct from actual settlement journal lines.

Project and bill cost centers are optional. A new bill can default from its project, but its effective choice is a persisted snapshot; clearing it explicitly means no center. Reversals preserve original journal-line centers.

**Why:** The user requested optional links at both levels, without changing old postings when project settings change.

**How to apply:** Validate company ownership and active new selections; do not require a center merely because a project has one or rewrite existing ledger history.

Resources are planning records, not stock issues. Actual material movements and settlements require explicit accounting actions; never infer them from planning status.

Contracting cash allocations are optional additions to the existing multiple receipt/payment vouchers, not replacements for ordinary voucher behavior or conversions of historical settlements.

**Why:** The user approved using the cash-and-banks vouchers for owner receipts and subcontract payments, expressly requiring existing multi-voucher functionality to remain intact.

**How to apply:** Reuse the voucher's single journal when linking posted allocations into contracting balances; never post another cash journal. Preserve direct historical settlements, enforce exact party/contract links, and keep bill approval distinct from cash payment. Guard unposting of advances already consumed by later certificates.

Retention release eligibility is independent of a certificate's normal net-payment completion. A paid certificate can still have unreleased retention, but its original journal must be genuinely posted.

**Why:** Paying the net entitlement does not discharge the retained receivable/payable. Excluding paid certificates hides legitimate releases; treating legacy approved-but-unposted evidence as posted would create unsupported cash settlement.

**How to apply:** Keep ordinary payment and retention balances separate, cap all posted direct and voucher releases together, and represent multiple certificates as distinct lines in the existing multi-voucher with one cash journal.

Keep project visibility separate from contract eligibility for cash allocation.

**Why:** A project can be explicitly linked to the selected customer while lacking an eligible contract. Hiding it makes the valid customer/project link appear broken.

**How to apply:** Show explicitly linked projects in authorized scope, but require an eligible contract before posting. Only a missing contract customer may inherit the project's explicit customer; never override a different explicit contract customer or infer identity from names.

Missing contracting advance account mappings require explicit accountant setup, not automatic fallback to receivables/payables or newly created accounts.

**Why:** An owner advance is a liability and a subcontract advance is an asset; silently substituting an ordinary settlement account changes the accounting meaning.

**How to apply:** Expose the correct roles in mapping settings and direct failed saves to that setup, preserving existing tenant mappings and chart of accounts.

**Why:** Selecting an inventory item or marking a resource allocated must not silently consume stock or create costs.

**How to apply:** Use real item-owned conversion snapshots and warehouse scope. Unsupported lot/costing paths must fail clearly rather than silently substitute weighted-average costing.

Preserve legacy project customer names without automatic name matching, and extend existing bill/contract fields instead of duplicating retention, advances, or payment totals.

**Why:** The user expressly required additions without duplicated records or re-entry of auto-filled contract data.

**How to apply:** Link clients by validated IDs when explicitly selected, calculate certified amounts separately from cash paid, and use existing ledger/settlement references as authoritative.

Project-centered contracting must reuse the existing owner/subcontract split and BOQ, not introduce parallel generic contract, payment-application, or execution-item systems. A bill's mandatory contract means exactly the appropriate side's contract, belonging to its project and tenant.

Do not infer an owner contract's sale price from the execution item's estimated unit cost when suggesting BOQ lines.

**Why:** Cost and commercial price have different accounting meanings. Automatically copying a planning estimate into a contract would silently choose a sale price the user never approved.

**How to apply:** Suggest execution identity, quantity, and unit, but leave an unknown commercial price for explicit entry and explain that distinction beside the field. Never overwrite existing agreed prices.

**Why:** The user explicitly forbids duplicate screens/data while requesting strict project ownership and independent owner/subcontract prices.

**How to apply:** Keep subprojects independent for execution and posting; make parent rollups an explicit report scope. Preserve optional owner-line mapping without copying owner prices into subcontract costs.

Do not assume “test-only data” means legacy relationships can be deleted or guessed. Preserve unresolved records through an explicit server-owned legacy marker and validated compatibility checks; keep new writes and approval strict.

**Why:** Existing test certificates can have no contract candidates even when the user expects clean data. A global readiness failure would prevent the very repair needed to satisfy the new constraints.

**How to apply:** Never relink posted snapshots automatically. Keep schema reconciliation cached per active database, diagnostics read-only and tenant/branch scoped, and explicit validation separate from routine reads.

Additive table reconciliation must precede indexes, triggers, and queries that reference newly introduced columns.

**Why:** Existing agent tables survive `CREATE TABLE IF NOT EXISTS` unchanged; a later generic column pass cannot help if an earlier specialized setup fails on missing columns.

**How to apply:** Test upgrades against a legacy schema with preserved rows, not only against a newly created database. Cover both standalone-agent startup and centrally routed external-database readiness.

Avoid unvalidated CHECK constraints in the managed development schema intended for Publish.

**Why:** Publish introspection has embedded the trailing `NOT VALID` inside generated CHECK expressions, producing invalid SQL. Validating clean constraints and explicitly marking unresolved legacy records avoids that parser failure without deleting or inventing financial relationships.

**How to apply:** Inspect the actual generated publish statements, not just safety flags. Fix and validate development only; keep production read-only and let Publish apply the schema. Never accept the legacy marker from normal create/update requests.

Managed Publish needs explicit prerequisite-order review for new composite foreign keys, even when source and development schemas are correct.

**Why:** Standalone composite unique indexes were omitted from a generated diff. Attaching them as UNIQUE constraints made them visible, but Publish still placed new foreign keys before the required UNIQUE additions on existing tables.

**How to apply:** Keep declarative UNIQUE definitions matched to real database constraints and check that every referenced key is created before its FK. Do not claim publishing is fixed solely because all statements appear. Do not bypass this failure with production writes, startup migrations, or silently weakened relationships.

With explicit user approval, dependency-order failures may use two Publish stages: prerequisite keys first, then new composite relationships.

**Why:** The generated single-pass ordering could not express prerequisite-first creation. The user approved a staged release, not deletion of production data or permanent removal of relationship protection.

**How to apply:** Defer only relationships confirmed absent from production; retain application scoping and existing production protections. Before the second stage, verify the prerequisite keys in production read-only. Never mark the full migration complete after only the prerequisite release.

Audit every FK in the ordered Publish SQL against production keys plus keys created by earlier statements, not just a handwritten module-specific list.

**Why:** Customer and bank composite relationships existed in runtime DDL outside the initial contracting staging list, so a partial audit missed the next dependency failure.

**How to apply:** Include cross-module target tables, catalog-only relationships, and primary keys declared in new tables. Restart once after staging changes and confirm readiness has not recreated deferred constraints.

Release-managed application tables must be created in the shared active-database reconciliation pass before strict missing-table validation, not only during central startup or a lazy feature request.

**Why:** External-agent upgrade and request-readiness paths can validate newly exported schema tables before central-only initialization ever reaches their database.

Central startup can begin serving after its schema time budget expires, so an open port is not evidence that feature tables are ready. Read paths that require additive feature reconciliation must await the per-database readiness promise rather than assuming central startup completed it.

Do not diagnose the generic contracting schema-error banner as a missing migration without reproducing the failing SQL.

**Why:** Adding readiness checks did not fix repeated tender/guarantee failures: a shared options query itself referenced a nonexistent column. Multiple pages failing together can indicate the same bad options request, not separate table-upgrade problems.

**How to apply:** Check each required request, compare its selected fields with the real schema, and use read-only query validation before changing migrations. Keep local query verification distinct from verification of the published user flow.

**How to apply:** Cover startup, explicit upgrades and strict request readiness with the same additive table creation. Keep required tables required, and never share a successful initialization cache across tenant databases.

Contracting bills use the existing model 14 renderer, with contracting-specific labels and amounts rather than a separate look-alike template.

**Why:** The user explicitly requested the same system print model; duplicated styling drifts and can misleadingly retain tax-invoice labels.

**How to apply:** Keep shared frame/header/footer behavior consistent with model 14 and adapt document semantics without implying a progress bill is a ZATCA invoice.

Contract ceilings require both the shared adjusted-contract ceiling and the selected change order's own incremental ceiling. Never grant the base contract value separately to each change-order bucket.

**Why:** Independent buckets otherwise permit billing the same base contract multiple times.

**How to apply:** Sum certified non-reversed work across the shared base scope, and separately cap the selected order's delta. Financial report totals exclude correction-source reversals and unposted replacement drafts.

Posted correction must reverse and create the linked replacement draft in one transaction, with document-level unpost authorization as well as the correction capability.

Legacy bill approval can coexist with a draft journal; distinguish cancelling that unposted evidence from reversing a posted journal when unapproving.

**Why:** Older approval paths respected auto-post settings, leaving approved bills with draft journals. Reversing those drafts would introduce a ledger movement that never had an original posting.

**How to apply:** Preserve numbered draft evidence without creating a reversal or leaving an orphan that can later post. Keep all linked-settlement and later-certificate blockers in place; never repair historical financial records implicitly.

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

Analytical contracting cost attribution must consume existing posted source capacity, not create replacement accounting transactions. Stock capitalization and subsequent material consumption must never both become project expense.

**Why:** The full contracting enhancement explicitly forbids duplicate master data, cost and journal entries. Planned equipment hours cannot legitimately substitute for an absent posted utilization source.

**How to apply:** Require traceable posted expense sources, share allocation capacity with other consuming modules, and show incomplete coverage rather than inventing actual costs. New material postings may use the execution item's cost center; reversals must preserve the original posting snapshot.

**Why:** Separate frontend and arithmetic checks can pass while a lost-response retry still creates duplicate financial documents or an entire accounting direction remains untested.

**How to apply:** Exercise persisted replay, posting, settlements and corrections in a disposable database for each direction; use browser fixtures only for explicitly identified UI behavior, never as evidence of database correctness.