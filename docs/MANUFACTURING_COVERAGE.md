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
| Certificate lifecycle | Certificate/accreditation records now have controlled draft→active→suspended/expired/settled/cancelled transitions, effective dates, allocation method, and immutable posted-source allocation linkage on the existing order detail screen. Recognised cost is derived from the linked allocation only. |
| Royalty lifecycle | Royalty/license records now support per-unit, sales percentage, manufacturing-cost percentage and tiered terms; dates, nonnegative rates/min/max, percentage caps, lifecycle state, and posted-source allocation linkage on the existing order detail screen. Active terms require a positive rate and valid effective period. Terms themselves do not create accounting. |
| Warranty lifecycle | Warranty records distinguish provision/estimate from actual claim methods. An actual claim must link a posted sales return containing the manufactured product and a warranty-classified posted source allocation before activation. A return or allocation cannot be reused by another lifecycle record in the same order. Return value is never presented as warranty cost. |
| Traceable order cost | The order drilldown exposes materials, posted payroll/overhead allocation snapshots, stages, waste and quality counts, cost layers, standard/actual variance, and source metadata. |
| Aggregate manufacturing reports | `GET /api/production/reports/costs` aggregates order standard/actual/variance by status and product and allocated amount by source and treatment, with tenant, date, and branch scope. |
| Realized sales facts | `GET /api/production/reports/realized-product-profitability` reports posted sales and posted returns in base currency by product and period. It explicitly leaves margin, operating cost, and financing cost unavailable rather than inventing an order/batch attribution. |
| Reporting UI/export | The existing Cost Rollup production report now has tabs for standard cost, aggregate actual/variance/source cost, and realized posted sales/returns. Aggregate tabs share date/allowed-branch filters and UTF-8 CSV export. Unavailable profitability fields are labelled explicitly in screen and export. |
| Completed-order reversal | A completed tracked-batch order can transition to the distinct terminal `reversed` state. One atomic transaction locks the order and stock, rejects any later outbound batch movement, removes the exact finished batch quantity, restores raw issue-ledger snapshots, creates receipt/issue reversing journals, preserves original snapshots/journal ids, records reversal ids in metadata, and writes the audit event. |
| Security | New reads and writes use the production module gate, tenant predicates, effective branch scope, row locking for lifecycle writes, and production-post permission for lifecycle mutations. Lifecycle writes create production audit events. |

## Partially implemented

| Area | Current limitation |
|---|---|
| Packaging architecture | Direct packaging via BOM and treatment classification exist. A full reusable packaging specification/version hierarchy, artwork approvals, supplier packaging tests, pallet/container dimensions, and packaging EPR/environmental master data are not implemented. |
| Cost pools and drivers | Existing approved source denominators and allocation snapshots cover payroll/depreciation/prepaids. A general user-managed pool/driver/rule catalog covering every source module is not present. |
| Certificates | Operational records and source allocation linkage exist per order. There is no company-level reusable certificate master, renewal reminder scheduler, document attachment workflow, or automatic allocation over forecast validity quantity. |
| Royalties | Operational terms and recognised posted-source linkage exist. The system does not accrue or settle royalties automatically from sales, tiers, currencies, or minimum commitments. |
| Warranty | Posted return validation and source-cost linkage exist. Sales lines do not yet retain production batch/order linkage, and there is no repair/parts/technician/shipping claim subledger or provision journal workflow. |
| Profitability | Actual posted net sales/returns are available at product-period level. Exact realized gross/operating/final margin is intentionally unavailable until sold lines carry batch/order cost identity and operating/financing source allocations have defensible product drivers. |
| Reversal | Safe completed reversal is available only where a unique produced batch proves no downstream movement. Legacy completed orders without batch provenance are deliberately blocked and require a controlled manual correction rather than consuming unrelated inventory. |
| Permissions | Module and posting permissions protect the new operations. The full fine-grained matrix (separate view-cost, waste, labor, machine, overhead, settings, report permissions) is not represented as independent permissions everywhere. |

## Missing / blockers for truthful completion

1. Sales invoice and return lines need immutable production batch/serial/order cost links populated by the sales stock-picking path. Without that data, exact realized product/order COGS and gross margin would be fabricated.
2. Operating and financing documents need explicit product allocation drivers and immutable source snapshots before operating profit, financing cost, economic cost, or final margin can be reported.
3. General certification, royalty, software-license, EHS, storage, logistics, R&D and warranty sources require integration with their owning contract/purchase/expense/maintenance/quality modules. They must not be entered as unsupported manual manufacturing amounts.
4. Full packaging/branding scope requires reusable packaging structures and approval/testing workflows beyond BOM lines.
5. General predetermined-overhead reconciliation (actual vs applied, under/over applied) and period-close correction authorization remain incomplete.
6. Certificate renewal jobs, automated royalty settlement, and a full warranty claim subledger remain to be implemented.

No external production data was changed and no release/publish action is part of this implementation.