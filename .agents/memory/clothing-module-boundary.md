---
name: Retail variant module boundary
description: Tenant gating, generic naming, and inventory-record ownership for reusable retail color/size variants.
---

Clothing and footwear is an optional module: it must be disabled for every company by default and enabled per company only by a SuperAdmin through menu permissions. When disabled, existing company behavior must remain unchanged.

**Why:** The user explicitly requires the module to be opt-in and isolated from companies that do not operate this business.

**How to apply:** Keep new clothing-specific routes and navigation behind a missing-means-disabled company entitlement, separate from ordinary item permissions. Do not grant it through public registration or default-on baselines.

Represent models and their color/size combinations with the existing root-item and child-variant records. Variants are ordinary stock items and must continue through the established purchase, sale, POS, return, and stock lifecycles.

**Why:** The user wants apparel support without a parallel inventory or accounting system and without changing legacy transaction behavior.

**How to apply:** Extend existing item workflows only where needed for clothing-specific setup. Do not introduce separate stock balances, movement tables, posting paths, or broad behavior changes while the module is disabled.

The user approved presenting retail attributes as an optional tab in the item form while retaining a separate bulk model/variant manager. User-facing names should be generic enough for apparel, footwear, bags, accessories, and similar retail businesses; preserve the existing `clothing` gate and stored legacy model tag for compatibility.

**Why:** The user wants one reusable retail feature across sales categories without losing the efficient bulk color/size creation workflow or breaking existing company enablement and tagged items.

**How to apply:** Gate the item-form tab on the existing company toggle. Keep variants as ordinary item records, and treat display names as changeable independently from stored identifiers and routes.
