---
name: Clothing and footwear module boundary
description: Tenant gating and inventory-record ownership rules for the optional clothing-and-footwear module.
---

Clothing and footwear is an optional module: it must be disabled for every company by default and enabled per company only by a SuperAdmin through menu permissions. When disabled, existing company behavior must remain unchanged.

**Why:** The user explicitly requires the module to be opt-in and isolated from companies that do not operate this business.

**How to apply:** Keep new clothing-specific routes and navigation behind a missing-means-disabled company entitlement, separate from ordinary item permissions. Do not grant it through public registration or default-on baselines.

Represent models and their color/size combinations with the existing root-item and child-variant records. Variants are ordinary stock items and must continue through the established purchase, sale, POS, return, and stock lifecycles.

**Why:** The user wants apparel support without a parallel inventory or accounting system and without changing legacy transaction behavior.

**How to apply:** Extend existing item workflows only where needed for clothing-specific setup. Do not introduce separate stock balances, movement tables, posting paths, or broad behavior changes while the module is disabled.
