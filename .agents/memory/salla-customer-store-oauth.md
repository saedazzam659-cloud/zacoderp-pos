---
name: Salla customer-store OAuth boundary
description: Clarifies whose Salla account creates the platform app and which store each ERP company authorizes.
---

The Salla integration is for ERP customers to authorize their own Salla stores. The ERP vendor does not need a merchant store, but production OAuth requires one centrally owned Salla developer application and its server-side Client ID/Secret. Keep phase one read-only: connect a store and display its orders; do not create ERP/ZATCA invoices, sync stock, or process returns.

**Why:** The user clarified that the product is being prepared so any ERP customer can connect their own Salla store; the vendor's lack of a merchant account is not a blocker to the product design.

**How to apply:** Keep OAuth credentials in server-side secrets, scope every connection and order query to one ERP company, and defer any financial document creation to a separately designed issuer-safe workflow.
