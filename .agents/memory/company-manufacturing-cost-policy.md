---
name: Company manufacturing costing policy
description: Company-wide default and stage-level posting contract for new production orders.
---

The company-level comprehensive-costing toggle must only set the resource-costing version when a new production order is first created. Editing or replaying an existing order must preserve its saved costing version and snapshots. Continue using the existing stage-resource, posted-source, WIP, and settlement paths; do not introduce parallel expense or posting behavior.

For v1 orders, the approved accounting target is to post material and resource costs to WIP as each production stage completes. Each BOM material belongs to an explicitly selected stage; stock and its cost are issued at that stage, not duplicated from an order-start issue. Payroll, depreciation, and electricity may use provisional amounts when the actual monthly source is not yet posted; when the actual source posts, clear the provisional accrual and capitalize only the actual variance. Source-period ownership follows the production period, not the journal-entry date.

For date-filled maamoul production, recipe ingredients such as flour, oil, sugar, dates, water, and salt are consumed once at the kneading stage. Freezing, date injection, baking, and packaging must not issue those same ingredient lines again. A separate packaging material may be assigned to packaging only when it exists as its own BOM line and quantity.

**Why:** The user confirmed that production must not wait for monthly payroll or depreciation journals and that stage completion should carry the full stage cost. Explicit material-to-stage links prevent guessed allocation; deferring issue prevents double capitalization.

**How to apply:** Preserve v0 behavior. In v1, coordinate stage material issue, resource posting, monthly-source settlement, capacity claims, final receipt, and cancellation/reversal as one lifecycle. Do not report stage posting as complete until every path and reversal is implemented and tested.

**Why:** The approved company policy is a prospective default. Historical orders and their accounting evidence must not change when a company enables or disables the setting.

**How to apply:** Enforce the policy server-side across every order-creation path. The UI may reflect the setting, but backend creation remains authoritative.

Employee cost category is owned by HR as employee master data; payroll snapshots freeze it for the period. Manufacturing execution records which employees worked each stage, and stage costs retain the direct/indirect split. Production supervisors are indirect labor by default and should be charged to stages/orders only when assigned there; use actual supervision time when available, otherwise a company-approved driver.

The factory's annual rent advance is part of the same lease as the monthly installments. The user confirmed that each monthly cash-expense voucher records only the remaining rent after the prepaid portion is deducted. Recognize the contract's rent once per month by combining the posted prepaid amortization with that remaining direct expense. Rent is indirect manufacturing overhead.

**Why:** The user confirmed the supervisor classification approach, that the annual payment is an advance from the same contract, and that each monthly cash-expense voucher is only the remainder after the advance.

**How to apply:** Keep HR as the source of employee classification, freeze that value in payroll snapshots, capture stage assignment in manufacturing, and allocate each month's rent once across prepaid amortization and the eligible remaining-rent cash voucher.
