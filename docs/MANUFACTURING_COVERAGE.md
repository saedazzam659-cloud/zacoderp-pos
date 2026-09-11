# Manufacturing requirements coverage

Last audited against:

- `Pasted-Manufacturing-Wizard-1-Wizard--1789062717417_1789062717419.txt`
- `Pasted--Saed-Azzam2-314-Product-Packaging-Branding-17890626145_1789062614506.txt`
- `.agents/memory/manufacturing-source-cost-policy.md`

This is an honest implementation matrix, not a completion declaration.

## Implemented

| Area | Coverage and evidence |
|---|---|
| One-screen wizard | The existing production order screen has one six-tab invoice-style wizard for product, BOM preview, routing, resources, posted source costs, review, draft and execute. It calls the existing order/status execution routes rather than a second engine. |
| Templates / manufacture again | Configuration-only templates and manufacture-again explicitly exclude document numbers, actuals, journals, stock movements, waste results, and source allocations. |
| Pause / resume | `paused` is a core order state. Operational edits are rejected while paused; resume uses the existing status path and does not issue stock again. |
| BOM, routing, materials and packaging input | Active BOM and routing are copied as order snapshots. Direct packaging can be represented by BOM material lines; packaging treatment classification is stored in the order cost policy. |
| Posted source allocations | Payroll, fixed-asset depreciation, and prepaid amortization are loaded only from posted owning-module documents with approved denominators/rates. Immutable allocation snapshots retain source journal/account trace. Capacity and duplicate-source guards are enforced. |
| No duplicate source booking | Manufacturing reclassifies eligible posted source expense debits to WIP through their actual source accounts. Analytical operating/economic allocations do not enter financial manufacturing cost or variance and do not post a duplicate journal. |
| Cost policy | Packaging, COQ, normal/abnormal waste, rework, certification, royalty, warranty, operating and economic treatment classifications are supported. |
| Certificate lifecycle | Certificate/accreditation records now have controlled draft→active→suspended/expired/settled/cancelled transitions, effective dates, allocation method, and immutable posted-source allocation linkage on the existing order detail screen. Recognised cost is derived from the linked allocation only. The existing notification reminder engine lazily materializes deduplicated expiry/renewal alerts from effective dates, and the renewal action creates a new draft record without inventing a certificate document or cost. |
| Royalty lifecycle | Royalty/license records now support per-unit, sales percentage, manufacturing-cost percentage and tiered terms; dates, nonnegative rates/min/max, percentage caps, lifecycle state, beneficiary supplier, and posted-source allocation linkage on the existing order detail screen. Posted product-period sales/returns and order source allocations produce a traceable calculation. The explicit accrual flow snapshots eligible posted facts, validates expense/liability accounts, creates a draft, explicitly posts one JE, and reverses the exact JE lines. Settlement creates an idempotent draft in the existing supplier-settlement/payable workflow; posting that linked draft atomically debits the accrued royalty liability and credits the validated supplier AP account, never cash or a second expense. Its unpost path posts the exact inverse and permits accrual reversal only after the settlement is unposted. |
| Warranty lifecycle | Warranty records distinguish provision/estimate from actual claim methods. A provision must carry a positive, explicit approved estimate and reference; its accrual flow creates a draft, explicitly posts one expense/liability JE, and reverses the exact JE lines. An actual claim must link a posted sales return containing the manufactured product, complete immutable production-batch attribution, and warranty-classified posted source allocations before activation. Claim accruals copy only immutable source amounts/accounts, consume a locked provision cap, debit the provision liability, and credit the original source expense accounts (no duplicate expense). Repair status, technician reference, and notes are lifecycle fields. A return or allocation cannot be reused by another lifecycle record in the same order. Return value is never presented as warranty cost. |
| Traceable order cost | The order drilldown exposes materials, posted payroll/overhead allocation snapshots, stages, waste and quality counts, cost layers, standard/actual variance, and source metadata. |
| Aggregate manufacturing reports | `GET /api/production/reports/costs` aggregates order standard/actual/variance by status and product and allocated amount by source and treatment, with tenant, date, and branch scope. |
| Realized sales facts | `GET /api/production/reports/realized-product-profitability` reports posted sales/returns by product and period. Complete immutable sale/return movement snapshots now provide production cost, while operating and financing source allocations are applied by the finished-batch quantity share; incomplete legacy links remain explicitly unavailable. |
| Reporting UI/export | The existing Cost Rollup production report now has tabs for standard cost, aggregate actual/variance/source cost, and realized posted sales/returns. Aggregate tabs share date/allowed-branch filters and UTF-8 CSV export. Unavailable profitability fields are labelled explicitly in screen and export. |
| General overhead reconciliation | The existing Cost Rollup actual tab and CSV now reconcile each distinct posted `manufacturing_overhead` source amount (actual) against immutable order allocation snapshots (applied), including under/over-applied totals and source references. This is aggregate reconciliation only and does not claim product or sold-line margin attribution. |
| General overhead period close | The Cost Rollup actual tab can create an idempotent, source-snapshot-backed period-close draft for a selected variance account. Posting atomically creates one balanced journal that reclassifies only the residual between the original posted source debit accounts and the variance account, with production posting rights, fiscal-period guard, branch scope, audit event, and an idempotent reversal lifecycle. |
| Completed-order reversal | A completed tracked-batch order can transition to the distinct terminal `reversed` state. One atomic transaction locks the order and stock, rejects any later outbound batch movement, removes the exact finished batch quantity, restores raw issue-ledger snapshots, creates receipt/issue reversing journals, preserves original snapshots/journal ids, records reversal ids in metadata, and writes the audit event. |
| Security | New reads and writes use the production module gate, tenant predicates, effective branch scope, row locking for lifecycle writes, and production-post permission for lifecycle mutations. Lifecycle writes create production audit events. |
| Simple manufacturing facade | A separate `simple_manufacturing` company menu gate (default OFF) and separate regular-user action map (`view/create/edit/delete/post/unpost/export`) expose `/simple-manufacturing` only. The single screen includes order list/wizard/detail, inline product/material, BOM, routing and warehouse setup, configuration-only templates, source-cost links, lifecycle controls (including pause/resume and provenance-checked reversal), and a shared-core cost report. Order creation and lifecycle execution delegate to the existing production tables/handlers, stock ledger and GL transaction path; advanced `/production/*` routes remain behind `production` and are not aliased. |

## Partially implemented

| Area | Current limitation |
|---|---|
| Packaging architecture | Reusable per-product packaging specifications now have immutable numbered versions, material/dimension/artwork snapshots, test records, and approval gating (a passing test is required). Version metadata now records bounded pallet/container dimensions and capacities, per-material EPR declarations, and references to files in the guarded document archive. Supplier packaging-test integrations and a reusable cross-product EPR master remain outside this implementation. |
| Cost pools and drivers | Approved posted payroll/depreciation/prepaid snapshots can be classified as operating or financing and are allocated to realized batches by a source-backed finished-quantity driver. A general user-managed pool/driver/rule catalog covering every source module is not present. |
| Certificates | Operational records and source allocation linkage exist per order. The reminder is materialized when the existing notification bell is read (not an external push/email job); there is no company-level reusable certificate master, document attachment workflow, or automatic allocation over forecast validity quantity. |
| Royalties | Calculation and explicit source-keyed accrual JE lifecycle are available from posted product-period facts/order source snapshots. Exact order attribution for sales-based methods remains unavailable until sales lines retain production batch/order identity; no automatic currency conversion or external licensor integration is claimed. The linked supplier settlement posts an atomic DR accrued royalty liability / CR validated supplier AP clearing JE (never cash), and unpost creates the exact inverse. |
| Warranty | Explicit approved-estimate provision JE lifecycle and source-backed, cap-checked provision consumption are available. Actual claims still require a posted return with complete immutable production-batch attribution and source-only parts/labor/shipping details. External repair/quality systems and technician scheduling remain outside this module. |
| Profitability | Product-period gross manufacturing, operating, and final margin are shown only when sale/return batch links and source snapshots are complete; otherwise the API/UI states the exact unavailable condition rather than using current WAC or estimates. |
| Reversal | Safe completed reversal is available only where a unique produced batch proves no downstream movement. Legacy completed orders without batch provenance are deliberately blocked and require a controlled manual correction rather than consuming unrelated inventory. |
| Permissions | Module and posting permissions protect the new operations. The full fine-grained matrix (separate view-cost, waste, labor, machine, overhead, settings, report permissions) is not represented as independent permissions everywhere. |
| Simple manufacturing breadth | The facade intentionally has one compact setup form: BOM setup accepts material lines, routing setup accepts stages, and the template stores configuration only. Its explicitly mounted commercial-lifecycle endpoints reuse the core lifecycle handlers under `simple_manufacturing` view/post/unpost actions; it does not expose advanced quality, MRP, work-center, shift, downtime, or AI screens. |

## Missing / blockers for truthful completion

1. Legacy sales invoice and return lines without stamped production batch/order movements remain unavailable; new postings populate immutable line snapshots.
2. A general user-managed operating/financing pool/rule catalog and source adapters for every expense module remain unavailable; current realized allocation is limited to approved owning-module snapshots and the finished-batch quantity driver.
3. External certification, licensor, software-license, EHS, storage, logistics, R&D, repair and quality sources require integration with their owning contract/purchase/expense/maintenance/quality modules. Internal royalty facts and warranty estimates/claims may use the explicit accrual flow documented above; they must not be entered as unsupported manual manufacturing amounts.
4. Full packaging/branding scope still needs supplier test integrations and reusable pallet/container/EPR master data. Artwork references are limited to existing guarded archive rows for the exact version; local-device archive files cannot become server-side references, and arbitrary external URLs are rejected.
5. Predetermined-overhead close now supports the internal source-backed correction workflow above. Authorization remains limited to the existing production create/post/unpost rights; no external approval or period-close coordinator integration is claimed.
6. External certificate/licensor integrations, email/push delivery, currency conversion, and external warranty repair/quality integrations remain unavailable infrastructure and are deliberately not fabricated. The internal royalty and warranty provision/consumption JE lifecycles are implemented through the existing posting/period engine.

## Simple-manufacturing implementation boundary

- The company key `simple_manufacturing` is absent from both frozen default-on
  sets and therefore defaults OFF for existing and newly registered companies.
- The user key is also `simple_manufacturing`; its seven actions are evaluated
  independently from the company key. The facade never treats `production` as
  an OR permission and never enables inventory/accounting/advanced production
  APIs for a simple-only user.
- Product and warehouse pickers read the shared item/warehouse entities through
  the guarded facade. BOMs, routings, templates, orders, allocations, stock
  ledger and journals remain the existing core records.
- A simple-only company can create, execute, and use the explicitly mounted
  commercial-lifecycle endpoints only through the facade and the corresponding
  `simple_manufacturing` action grant. Direct `/api/production/*` calls still
  return the advanced company-gate denial. A company with neither gate cannot
  use either surface.
- The compact report is an order-cost report over shared standard/actual
  values; it does not claim sold-line/order attribution or profitability.
- No external production data was changed and no publish/release action is
  part of this implementation.

No external production data was changed and no release/publish action is part of this implementation.