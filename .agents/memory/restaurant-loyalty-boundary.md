---
name: Restaurant loyalty boundary
description: Product scope and accounting boundary for restaurant POS loyalty points.
---

The restaurant loyalty program is optional and configured per company. Points apply only to restaurant invoices linked to a registered customer, are earned after invoice posting, and are redeemed as a discount on that invoice. The initial defaults are one point per SAR spent and 100 points = SAR 1; earning rates, redemption value, minimum redemption, expiry, order/customer conditions, and customer tiers are configurable.

**Why:** Loyalty balances and discounts must remain tied to posted restaurant sales and a known customer, rather than creating a separate cash, invoice, or accounting flow.

**How to apply:** Keep this feature inside restaurant POS. Preserve company isolation and invoice-linked ledger entries; treat refunds/returns as an explicit reversal requirement, not as a reason to change the original posted invoice.
