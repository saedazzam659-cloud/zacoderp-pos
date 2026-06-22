---
name: SAP-style service-item JE routing
description: How "خدمي" (service) item type posts cost/revenue without touching stock, and the balance invariant for the sales revenue split.
---

Service items (`items.item_type='service'`) are non-stock in the ZATCA app. They must NEVER write to stock balances or the stock ledger, and they have no "nature" (طبيعة الصنف) — the UI hides that field for them.

- **Purchase post** (`purchasing.ts` post handler): service lines are exempted from the "no warehouse" guard and from the stock loop. The inventory debit is split proportionally across goods (warehouse GL accounts) + service (per-item `costAccountId`, e.g. مشاريع تحت التنفيذ) using `ratio = inventoryDebit / allCostTotal(goods+service)`. A GRN-sourced clearing debit is reduced by the service portion. Service cost accounts are pre-validated BEFORE any stock mutation (fail-fast) so a missing account never leaves partial stock movements.
- **Sales post** (`sales.ts` post handler): service lines are skipped from COGS/stock; COGS account is only required when `totalCogs > 0`. Gross revenue is split between the main `salesAccId` and each service item's own `revenueAccountId`.

**Balance invariant (the bug that was fixed):** the per-account map `serviceRevenueByAccount` is the SINGLE SOURCE OF TRUTH for the service credit lines. Do NOT clamp a separate `serviceRevenueTotal` accumulator independently of the map — that desyncs the credits from the total and unbalances the JE. Always derive `serviceRevenueTotal` from `Σ(serviceRevenueByAccount)`, trim any sub-cent overflow off the LAST account, then set `mainRevenueAmt = grossSubtotalAmt − serviceRevenueTotal`. This guarantees `mainRevenueAmt + Σ(serviceRevenueByAccount) === grossSubtotalAmt` exactly.

**Why:** service revenue is a strict subset of all invoice lines, so it can only overshoot `grossSubtotalAmt` by rounding; reconciling against the map (not a parallel sum) keeps DR==CR in every combo (goods-only, service-only, mixed, discounts).

**How to apply:** any new code that adds revenue/cost credit or debit splits to these handlers must reconcile against the authoritative per-account map and absorb the remainder into the main account, never emit an independently-rounded total.

**Enforcement:** service items require BOTH `costAccountId` and `revenueAccountId` at item-save (frontend `Items.tsx` `handleSubmit`). Backend post hard-rejects a missing service cost account; a missing service revenue account gracefully falls back to the main sales account (back-compat for legacy items).
