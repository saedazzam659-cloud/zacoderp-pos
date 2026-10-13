---
name: Sales negative-stock precedence
description: Company, warehouse, and invoice-level precedence for negative-stock sales.
---

For sales, the company-wide setting is the master switch: off always blocks a negative result; on permits it across warehouses by default. A warehouse may explicitly block negative sales, and the invoice checkbox may override that warehouse block only while the company switch is on.

**Why:** The user requires the general setting to apply across all warehouses, with a warehouse-specific prevention option and an invoice override that cannot bypass the company-level decision.

**How to apply:** Enforce this precedence on the server wherever sales stock is posted, and keep the web controls consistent with it. The “price includes VAT” checkbox should continue remembering a user’s manual choice for subsequent new sales documents.
